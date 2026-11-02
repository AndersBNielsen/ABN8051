;--------------------------------------------------------------------------
; DOS/51 - SD card: bit-banged SPI driver and a FAT16/FAT32 root directory
; file tool (sdls, sdget, sdput, sdrm).  Hand written for size.
;
; Wiring (docs/HARDWARE.md): P1.4 /CS, P1.5 SCK, P1.6 MOSI, P1.7 MISO,
; SPI mode 0 at about 115 kHz (fine for initialisation, < 400 kHz).
;
; Driver entry points (also system calls SDINIT/SDREAD/SDWRITE, see
; syscalls.asm): register bank independent, clobber A, B, R0-R3 and the
; carry flag; R4-R7 and DPTR are preserved.
;   sd_init    -> C = 1 if no card answers; A = 1 SDSC, 2 SDHC/SDXC
;   sd_read    R7:R6:R5:R4 = sector (LBA), DPTR = 512-byte XDATA buffer
;   sd_write   same; C = 1 on error
;
; The file tool keeps its state in the shell's pdata page (MOVX @Ri with
; P2 = 1Dh), uses the sector buffer at 0A00h-0BFFh and register bank 0.
; R7:R6:R5:R4 is the 32-bit accumulator (R4 = least significant byte).
; Any error unwinds the stack to the shell through sdfail.
;--------------------------------------------------------------------------
        .module sd51

        .globl  sd_init, sd_read, sd_write, sd_off
        .globl  _sd_ls, _sd_get, _sd_put, _sd_rm
        .globl  _argc, _argv, _fs_free, _fs_err_full
        .globl  _f_open, _f_open_PARM_2, _f_write, _f_write_PARM_2
        .globl  _f_write_PARM_3, _f_close, _f_closeall, _f_size, _f_data
        .globl  puts_cd, putb_a, putc_a, crlf_r

        CS      = 0x94          ; P1.4
        SCK     = 0x95          ; P1.5
        MOSI    = 0x96          ; P1.6
        MISO    = 0x97          ; P1.7
        P1      = 0x90
        F0      = 0xD5          ; PSW.5: fatent writes
        F1      = 0xD1          ; PSW.1: dfind looks for a free slot
        SECBUF  = 0x0A00        ; 512-byte sector buffer (DOS XDATA)
        ar3 = 3
        ar4 = 4
        ar5 = 5
        ar6 = 6
        ar7 = 7

        .area   XSEG    (XDATA)
sd_hc:  .ds     1               ; 40h: block addressed (SDHC/SDXC)

        .area   PSEG    (PAG,XDATA)
v_part: .ds     4               ; volume start sector
v_fat:  .ds     4               ; first FAT sector
v_fsz:  .ds     4               ; sectors per FAT
v_root: .ds     4               ; FAT16: root directory sector, FAT32: cluster
v_data: .ds     4               ; sector of cluster 2
v_ncl:  .ds     4               ; clusters + 2 (first invalid number)
v_spc:  .ds     1               ; sectors per cluster
v_shift: .ds    1               ; log2(sectors per cluster)
v_nfat: .ds     1
v_rsec: .ds     1               ; FAT16 root directory sectors
c_lba:  .ds     4               ; sector in SECBUF
c_dirty: .ds    1               ; 1 = modified, 3 = modified FAT sector
d_lba:  .ds     4               ; directory walk: sector,
d_clus: .ds     4               ; cluster (FAT32),
d_left: .ds     1               ; sectors left in the run,
d_idx:  .ds     1               ; entry 0-15 in the sector
fnew:   .ds     4               ; value for fatput
f_clus: .ds     4               ; file transfer: cluster,
f_first: .ds    4               ; first cluster (sdput)
f_prev: .ds     4               ; previous cluster (sdput)
f_ptr:  .ds     2               ; RAM disk data (sdput)
f_left: .ds     2               ; bytes still to go
f_size: .ds     2
f_cnt:  .ds     1               ; sectors left in the cluster
f_h:    .ds     1               ; RAM disk handle
n83:    .ds     11              ; name in directory format
abort_sp: .ds   1
v_fsi:  .ds     4               ; FAT32 FSInfo sector (0: none)

        .area   BSEG    (BIT)
f32:    .ds     1               ; volume is FAT32

        .area   CSEG    (CODE)

;================================================================ SPI / SD
spi_ff: mov     a, #0xFF
; spi: send A, return the received byte in A (MSB first).  Uses B.
spi:    mov     b, #8
00001$: rlc     a
        mov     MOSI, c
        setb    SCK
        mov     c, MISO
        clr     SCK
        djnz    b, 00001$
        rlc     a
        ret

; deselect the card and give it 8 clocks to release MISO
sd_off: setb    CS
        sjmp    spi_ff

; sd_cmd: A = command index, R3:R2:R1:R0 = argument -> A = R1 response
; (bit 7 set: no answer).  Leaves the card selected.  Uses B, R0.
sd_cmd: push    acc
        lcall   sd_off
        clr     CS
        lcall   spi_ff
        pop     acc
        push    acc
        orl     a, #0x40
        lcall   spi
        mov     a, r3
        lcall   spi
        mov     a, r2
        lcall   spi
        mov     a, r1
        lcall   spi
        mov     a, r0
        lcall   spi
        pop     acc
        jz      00001$
        mov     a, #0x87                ; CRC of CMD8 1AAh; others ignore it
        sjmp    00002$
00001$: mov     a, #0x95                ; CRC of CMD0
00002$: lcall   spi
        mov     r0, #10
00003$: lcall   spi_ff
        jnb     acc.7, 00004$
        djnz    r0, 00003$
00004$: ret

arg0:   clr     a
        mov     r0, a
        mov     r1, a
        mov     r2, a
        mov     r3, a
        ret

sd_init:
        orl     P1, #0xD0               ; /CS, MOSI and the MISO latch high
        anl     P1, #0xDF               ; SCK low
        mov     r0, #10                 ; 80 clocks with /CS high
00001$: lcall   spi_ff
        djnz    r0, 00001$
        push    dpl
        push    dph
        mov     dpl, #16
00002$: lcall   arg0                    ; CMD0: go idle, SPI mode
        lcall   sd_cmd
        cjne    a, #1, 00003$
        sjmp    00004$
00003$: djnz    dpl, 00002$
        ljmp    in_err
00004$: lcall   arg0                    ; CMD8 1AAh: version 2 card?
        mov     r1, #1
        mov     r0, #0xAA
        mov     a, #8
        lcall   sd_cmd
        mov     dph, #4                 ; DPH: HCS flag 40h + retry count
        cjne    a, #1, 00006$           ; illegal command: version 1
        lcall   spi_ff
        lcall   spi_ff
        lcall   spi_ff
        lcall   spi_ff
        cjne    a, #0xAA, in_err
        mov     dph, #0x44
00006$: lcall   arg0                    ; ACMD41 until ready (about 1.5 s)
        mov     a, #55
        lcall   sd_cmd
        lcall   arg0
        mov     a, dph
        anl     a, #0x40
        mov     r3, a
        mov     a, #41
        lcall   sd_cmd
        jz      00007$
        djnz    dpl, 00006$
        dec     dph
        mov     a, dph
        anl     a, #0x3F
        jnz     00006$
        sjmp    in_err
00007$: mov     a, dph
        anl     a, #0x40
        jz      00008$
        lcall   arg0                    ; CMD58: CCS bit = block addressing
        mov     a, #58
        lcall   sd_cmd
        jnz     in_err
        lcall   spi_ff
        anl     a, #0x40
        push    acc
        lcall   spi_ff
        lcall   spi_ff
        lcall   spi_ff
        pop     acc
        jnz     00009$
00008$: lcall   arg0                    ; CMD16 512 for byte addressed cards
        mov     r1, #2
        mov     a, #16
        lcall   sd_cmd
        jnz     in_err
00009$: mov     dptr, #sd_hc
        movx    @dptr, a
        pop     dph
        pop     dpl
        add     a, #0xC0                ; 40h -> 2 (SDHC), 0 -> 1 (SDSC)
        clr     a
        addc    a, #1
        push    acc
        lcall   sd_off
        pop     acc
        clr     c
        ret
in_err: pop     dph
        pop     dpl
sd_err: lcall   sd_off
        setb    c
        ret
sd_ok:  lcall   sd_off
        clr     c
        ret

; R3:R2:R1:R0 = card address of sector R7:R6:R5:R4
sdaddr: push    dpl
        push    dph
        mov     dptr, #sd_hc
        movx    a, @dptr
        pop     dph
        pop     dpl
        jz      00001$
        mov     a, r4
        mov     r0, a
        mov     a, r5
        mov     r1, a
        mov     a, r6
        mov     r2, a
        mov     a, r7
        mov     r3, a
        ret
00001$: mov     r0, #0                  ; byte address = sector * 512
        mov     a, r4
        add     a, r4
        mov     r1, a
        mov     a, r5
        rlc     a
        mov     r2, a
        mov     a, r6
        rlc     a
        mov     r3, a
        ret

sd_read:
        lcall   sdaddr
        mov     a, #17
        lcall   sd_cmd
        jnz     sd_err
        mov     r1, #16                 ; wait for the data token
00001$: lcall   spi_ff
        cjne    a, #0xFE, 00002$
        sjmp    00003$
00002$: inc     a
        jnz     sd_err                  ; error token
        djnz    r0, 00001$
        djnz    r1, 00001$
        sjmp    sd_err
00003$: lcall   blk
00004$: lcall   spi_ff
        movx    @dptr, a
        inc     dptr
        djnz    r0, 00004$
        djnz    r1, 00004$
        lcall   blkend
        sjmp    sd_ok

; push DPTR under the return address, R1:R0 = 512 byte loop counter
blk:    pop     acc
        pop     b
        push    dpl
        push    dph
        push    b
        push    acc
        mov     r0, #0
        mov     r1, #2
        ret

; drop the DPTR saved by blk (it sits under the return address), skip CRC
blkend: pop     acc
        pop     b
        pop     dph
        pop     dpl
        push    b
        push    acc
        lcall   spi_ff
        ljmp    spi_ff

sd_write:
        lcall   sdaddr
        mov     a, #24
        lcall   sd_cmd
        jz     00614$
        ljmp    sd_err
00614$:
        lcall   spi_ff
        mov     a, #0xFE                ; start token
        lcall   spi
        lcall   blk
00001$: movx    a, @dptr
        inc     dptr
        lcall   spi
        djnz    r0, 00001$
        djnz    r1, 00001$
        lcall   blkend
        lcall   spi_ff                  ; data response xxx00101: accepted
        anl     a, #0x1F
        cjne    a, #5, 00613$
        sjmp    00713$
00613$:     ljmp    sd_err
00713$:
        mov     r1, #0                  ; busy (MISO low) for up to ~5 s
00002$: lcall   spi_ff
        jz     00612$
        ljmp    sd_ok
00612$:
        djnz    r0, 00002$
        djnz    r1, 00002$
        ljmp    sd_err

;================================================================ 32 bit
; R7:R6:R5:R4 (op)= 4 pdata bytes at @R1.  Use R0, R2 (and R1 advances).
ld32:   mov     r0, #4
        mov     r2, #4
00001$: movx    a, @r1
        mov     @r0, a
        inc     r0
        inc     r1
        djnz    r2, 00001$
        ret

st32:   mov     r0, #4
        mov     r2, #4
00001$: mov     a, @r0
        movx    @r1, a
        inc     r0
        inc     r1
        djnz    r2, 00001$
        ret

add32:  clr     c
        mov     r0, #4
        mov     r2, #4
00001$: movx    a, @r1
        addc    a, @r0
        mov     @r0, a
        inc     r0
        inc     r1
        djnz    r2, 00001$
        ret

; R7:R6:R5:R4 - @R1 -> C = borrow; F0 = 1 also stores the difference
sub32:  clr     c
        mov     r0, #4
        mov     r2, #4
00001$: movx    a, @r1
        mov     b, a
        mov     a, @r0
        subb    a, b
        jnb     F0, 00002$
        mov     @r0, a
00002$: inc     r0
        inc     r1
        djnz    r2, 00001$
        ret

inc32:  mov     a, #1
; R7:R6:R5:R4 += A
adda32: clr     c
        mov     r0, #4
        mov     r2, #4
00001$: addc    a, @r0
        mov     @r0, a
        clr     a
        inc     r0
        djnz    r2, 00001$
        ret

dec32:  mov     r0, #4
00001$: dec     @r0
        cjne    @r0, #0xFF, 00002$
        inc     r0
        cjne    r0, #8, 00001$
00002$: ret

shl32:  clr     c
        mov     r0, #4
        mov     r2, #4
00001$: mov     a, @r0
        rlc     a
        mov     @r0, a
        inc     r0
        djnz    r2, 00001$
        ret

clr32:  clr     a
        mov     r4, a
        mov     r5, a
        mov     r6, a
        mov     r7, a
        ret

; R7:R6:R5:R4 = 4 bytes at DPTR (XDATA)
ldd32:  mov     r0, #4
        mov     r2, #4
00001$: movx    a, @dptr
        mov     @r0, a
        inc     dptr
        inc     r0
        djnz    r2, 00001$
        ret

; boot sector field at SECBUF + A: bp32 32 bits, bp16 16 bits; bpalt: the
; 16-bit field A, or the 32-bit field B when that is zero
bpalt:  push    b
        lcall   bp16
        pop     b
        mov     a, r4
        orl     a, r5
        jnz     bpret
        mov     a, b
bp32:   mov     dpl, a
        mov     dph, #>SECBUF
        sjmp    ldd32
bp16:   lcall   bp32
        mov     r6, #0
        mov     r7, #0
bpret:  ret

;================================================================ cache
; rdsec: sector R7:R6:R5:R4 into SECBUF (cached) -> DPTR = SECBUF
rdsec:  mov     r1, #c_lba
        mov     r0, #4
        mov     r2, #4
00001$: movx    a, @r1
        xrl     a, @r0
        jnz     00002$
        inc     r0
        inc     r1
        djnz    r2, 00001$
        sjmp    00003$
00002$: lcall   flush
        mov     r1, #c_lba
        lcall   st32
        mov     dptr, #SECBUF
        lcall   sd_read
        jc      ioerr
00003$: mov     dptr, #SECBUF
        ret

; write SECBUF back if modified; FAT sectors go to every FAT copy
flush:  mov     r1, #c_dirty
        movx    a, @r1
        jz      00003$
        mov     r3, #1
        jnb     acc.1, 00001$
        mov     r1, #v_nfat
        movx    a, @r1
        mov     r3, a
00001$: clr     a
        mov     r1, #c_dirty
        movx    @r1, a
        push    ar4
        push    ar5
        push    ar6
        push    ar7
        mov     r1, #c_lba
        lcall   ld32
00002$: push    ar3
        mov     dptr, #SECBUF
        lcall   sd_write
        jc      ioerr
        mov     r1, #v_fsz
        lcall   add32
        pop     ar3
        djnz    r3, 00002$
        pop     ar7
        pop     ar6
        pop     ar5
        pop     ar4
00003$: ret

;================================================================ errors
ioerr:  mov     dptr, #m_io
; sdfail: print the message at DPTR and return to the shell
sdfail: mov     r0, #abort_sp
        movx    a, @r0
        mov     sp, a
        lcall   puts_cd
        lcall   sd_off
        ljmp    _f_closeall

; sdbegin: first call of every command: remember where to unwind to
sdbegin:
        mov     r0, #abort_sp
        mov     a, sp
        add     a, #-2
        movx    @r0, a
        ret

;================================================================ volume
mount:  lcall   sd_init
        mov     dptr, #m_nocard
        jc      sdfail
        mov     r1, #c_dirty            ; empty cache: c_lba = FFFFFFFFh
        clr     a
        movx    @r1, a
        mov     r1, #c_lba
        mov     r2, #4
        dec     a
00001$: movx    @r1, a
        inc     r1
        djnz    r2, 00001$
        lcall   clr32                   ; sector 0: boot sector or MBR
        lcall   rdsec
        lcall   isbpb
        jz      00002$
        mov     dptr, #SECBUF + 0x1C6   ; first partition's start
        lcall   ldd32
        lcall   rdsec
        lcall   isbpb
        jz     00611$
        ljmp    nofat
00611$:
00002$: mov     r1, #v_part
        lcall   st32
        mov     dptr, #SECBUF + 13      ; sectors per cluster, log2
        movx    a, @dptr
        jnz     00610$
        ljmp    nofat
00610$:
        mov     r1, #v_spc
        movx    @r1, a
        mov     r3, #0
00003$: rrc     a
        jc      00004$
        inc     r3
        sjmp    00003$
00004$: mov     a, r3
        inc     r1
        movx    @r1, a                  ; v_shift
        inc     dptr
        inc     dptr
        inc     dptr
        movx    a, @dptr                ; number of FATs
        inc     r1
        movx    @r1, a                  ; v_nfat
        inc     dptr
        movx    a, @dptr                ; root entries / 16
        swap    a
        anl     a, #0x0F
        mov     r2, a
        inc     dptr
        movx    a, @dptr
        swap    a
        anl     a, #0xF0
        orl     a, r2
        inc     r1
        movx    @r1, a                  ; v_rsec
        clr     f32
        jnz     00005$
        setb    f32                     ; no fixed root directory: FAT32
00005$: mov     a, #14                  ; FAT = start + reserved sectors
        lcall   bp16
        mov     r1, #v_part
        lcall   add32
        mov     r1, #v_fat
        lcall   st32
        mov     a, #22                  ; FAT size
        mov     b, #36
        lcall   bpalt
        mov     r1, #v_fsz
        lcall   st32
        mov     r1, #v_fat              ; root = FAT + nfat * FAT size
        lcall   ld32
        mov     r1, #v_nfat
        movx    a, @r1
        mov     r3, a
00006$: mov     r1, #v_fsz
        lcall   add32
        djnz    r3, 00006$
        mov     r1, #v_root
        lcall   st32
        mov     r1, #v_rsec             ; data = root + root sectors
        movx    a, @r1
        lcall   adda32
        mov     r1, #v_data
        lcall   st32
        mov     a, #19                  ; clusters = (total - (data - start))
        mov     b, #32                  ;            >> shift
        lcall   bpalt
        setb    F0
        mov     r1, #v_data
        lcall   sub32
        mov     r1, #v_part
        lcall   add32
        mov     r1, #v_shift
        movx    a, @r1
        jz      00008$
        mov     r3, a
00007$: clr     c                       ; R7:R6:R5:R4 >>= 1
        mov     r0, #7
        mov     r2, #4
00010$: mov     a, @r0
        rrc     a
        mov     @r0, a
        dec     r0
        djnz    r2, 00010$
        djnz    r3, 00007$
00008$: mov     a, #2
        lcall   adda32
        mov     r1, #v_ncl
        lcall   st32
        jb      f32, 00009$
        mov     a, r7                   ; FAT16 needs >= 4085 clusters
        orl     a, r6
        jnz     00011$
        clr     c
        mov     a, r4
        subb    a, #0xF7
        mov     a, r5
        subb    a, #0x0F
        jc      nofat
00011$: ret
00009$: mov     a, #48                  ; FAT32 FSInfo sector
        lcall   bp16
        mov     r1, #v_part
        lcall   add32
        mov     r1, #v_fsi
        lcall   st32
        mov     a, #44                  ; root directory cluster
        lcall   bp32
        mov     r1, #v_root
        ljmp    st32
nofat:  mov     dptr, #m_nofat
        ljmp    sdfail

; A = 0 if SECBUF holds a FAT boot sector (512 bytes/sector, 55AAh)
isbpb:  mov     dptr, #SECBUF + 11
        movx    a, @dptr
        jnz     00001$
        inc     dptr
        movx    a, @dptr
        xrl     a, #2
        jnz     00001$
        mov     dptr, #SECBUF + 510
        movx    a, @dptr
        xrl     a, #0x55
        jnz     00001$
        inc     dptr
        movx    a, @dptr
        xrl     a, #0xAA
00001$: ret

;================================================================ clusters
; C = 1 if R7:R6:R5:R4 is a data cluster (2 <= n < clusters + 2)
clok:   mov     a, r7
        orl     a, r6
        orl     a, r5
        jnz     00001$
        mov     a, r4
        anl     a, #0xFE
        jz      00002$
00001$: clr     F0
        mov     r1, #v_ncl
        ljmp    sub32
00002$: clr     c
        ret

; cluster R7:R6:R5:R4 -> its first sector
clba:   lcall   dec32
        lcall   dec32
        mov     r1, #v_shift
        movx    a, @r1
        jz      00002$
        mov     r3, a
00001$: lcall   shl32
        djnz    r3, 00001$
00002$: mov     r1, #v_data
        ljmp    add32

; fatget: R7:R6:R5:R4 = FAT entry of cluster R7:R6:R5:R4
; fatput: the same, and the entry is replaced by fnew
fatget: clr     F0
        sjmp    fatent
fatput: setb    F0
fatent: mov     a, r4
        push    acc
        jnb     f32, 00001$
        lcall   shl32                   ; FAT32: sector = cluster >> 7
00001$: mov     a, r5                   ; FAT16: sector = cluster >> 8
        mov     r4, a
        mov     a, r6
        mov     r5, a
        mov     a, r7
        mov     r6, a
        mov     r7, #0
        mov     r1, #v_fat
        lcall   add32
        lcall   rdsec
        pop     acc
        mov     r3, #2
        jnb     f32, 00002$
        mov     r3, #4
        anl     a, #0x7F
        rl      a
00002$: add     a, acc
        mov     dpl, a
        clr     a
        addc    a, #>SECBUF
        mov     dph, a
        push    dpl
        push    dph
        mov     r6, #0
        mov     r7, #0
        mov     r0, #4
        mov     a, r3
        mov     r2, a
00003$: movx    a, @dptr
        mov     @r0, a
        inc     dptr
        inc     r0
        djnz    r2, 00003$
        mov     a, r7
        anl     a, #0x0F
        mov     r7, a
        pop     dph
        pop     dpl
        jnb     F0, 00005$
        mov     r1, #fnew
00004$: movx    a, @r1
        movx    @dptr, a
        inc     r1
        inc     dptr
        djnz    r3, 00004$
        mov     r1, #c_dirty
        mov     a, #3
        movx    @r1, a
00005$: ret

; fnew = R7:R6:R5:R4
setnew: mov     r1, #fnew
        ljmp    st32

;================================================================ directory
dfirst: mov     r1, #v_root
        lcall   ld32
        jb      f32, 00001$
        mov     r1, #d_lba
        lcall   st32
        mov     r1, #v_rsec
        movx    a, @r1
        sjmp    00002$
00001$: lcall   dclus
00002$: mov     r1, #d_left
        movx    @r1, a
        inc     r1
        clr     a
        movx    @r1, a                  ; d_idx
        ret

; d_clus = R7:R6:R5:R4, d_lba = its first sector -> A = sectors per cluster
dclus:  mov     r1, #d_clus
        lcall   st32
        lcall   clba
        mov     r1, #d_lba
        lcall   st32
        mov     r1, #v_spc
        movx    a, @r1
        ret

; DPTR = current directory entry
dent:   mov     r1, #d_lba
        lcall   ld32
        lcall   rdsec
        mov     r1, #d_idx
        movx    a, @r1
        mov     b, #32
        mul     ab
        mov     dpl, a
        mov     a, b
        add     a, #>SECBUF
        mov     dph, a
        ret

; next entry -> C = 1 at the end of the directory
dnext:  mov     r1, #d_idx
        movx    a, @r1
        inc     a
        anl     a, #15
        movx    @r1, a
        jnz     00002$
        mov     r1, #d_lba
        lcall   ld32
        lcall   inc32
        mov     r1, #d_lba
        lcall   st32
        mov     r1, #d_left
        movx    a, @r1
        dec     a
        movx    @r1, a
        jnz     00002$
        jnb     f32, 00001$
        mov     r1, #d_clus
        lcall   ld32
        lcall   fatget
        lcall   clok
        jnc     00001$
        lcall   dclus
        mov     r1, #d_left
        movx    @r1, a
00002$: clr     c
        ret
00001$: setb    c
        ret

; dfind: F1 = 0: the file named n83, F1 = 1: a free slot.  C = 1 if found,
; DPTR = entry (and d_* point at it).
dfind:  lcall   dfirst
00001$: lcall   dent
        movx    a, @dptr
        jb      F1, 00005$
        jz      00007$
        cjne    a, #0xE5, 00002$
        sjmp    00006$
00002$: mov     a, dpl                  ; skip volume labels and long names
        add     a, #11
        mov     r0, a
        lcall   dfld
        jb      acc.3, 00006$
        mov     r0, #n83
        mov     r2, #11
        push    dpl
        push    dph
00003$: movx    a, @r0
        mov     b, a
        movx    a, @dptr
        cjne    a, b, 00004$
        inc     r0
        inc     dptr
        djnz    r2, 00003$
00004$: pop     dph
        pop     dpl
        mov     a, r2
        jnz     00006$
        setb    c
        ret
00005$: jz      00008$
        cjne    a, #0xE5, 00006$
00008$: setb    c
        ret
00006$: lcall   dnext
        jnc     00001$
00007$: clr     c
        ret

; findf: find the file n83 -> C = 1, DPTR = entry; a directory is refused
findf:  clr     F1
        lcall   dfind
        jnc     00001$
        mov     a, dpl
        add     a, #11
        mov     r0, a
        lcall   dfld
        jnb     acc.4, 00002$
        mov     dptr, #m_dirent
        ljmp    sdfail
00002$: setb    c
00001$: ret

; wrprep: before changing a FAT32 volume, mark the FSInfo free count and
; next free hint unknown (FFFFFFFFh) as this tool does not track them
wrprep: jnb     f32, 00001$
        mov     r1, #v_fsi
        lcall   ld32
        lcall   rdsec
        mov     dptr, #SECBUF + 484     ; "rrAa"
        movx    a, @dptr
        cjne    a, #0x72, 00001$
        mov     dptr, #SECBUF + 488
        mov     a, #0xFF
        mov     r2, #8
00002$: movx    @dptr, a
        inc     dptr
        djnz    r2, 00002$
        mov     r1, #c_dirty
        mov     a, #1
        movx    @r1, a
00001$: ret

; A = byte at offset R0 of the 32-byte aligned entry at DPTR (DPTR kept)
dfld:   push    dpl
        mov     dpl, r0
        movx    a, @dptr
        pop     dpl
        ret

; R7:R6:R5:R4 = first cluster of the entry at DPTR
entclus:
        lcall   clr32
        mov     a, dpl
        add     a, #26
        mov     r0, a
        lcall   dfld
        mov     r4, a
        inc     r0
        lcall   dfld
        mov     r5, a
        jnb     f32, 00001$
        mov     a, r0
        add     a, #-7
        mov     r0, a
        lcall   dfld
        mov     r6, a
        inc     r0
        lcall   dfld
        mov     r7, a
00001$: ret

; delete the file n83: C = 0 if there is none
rment:  lcall   findf
        jnc     00001$
        mov     a, #0xE5
        movx    @dptr, a
        mov     r1, #c_dirty
        mov     a, #1
        movx    @r1, a
        lcall   entclus
        lcall   freech
        setb    c
00001$: ret

; free the cluster chain starting at R7:R6:R5:R4 (0: none)
freech:
        mov     a, r4
        orl     a, r5
        orl     a, r6
        orl     a, r7
        jz      00001$
        push    ar4
        push    ar5
        push    ar6
        push    ar7
        lcall   clr32
        lcall   setnew
        pop     ar7
        pop     ar6
        pop     ar5
        pop     ar4
00002$: lcall   clok
        jnc     00001$
        lcall   fatput
        sjmp    00002$
00001$: ret

;================================================================ names
; to83: DPTR = DOS/51 name -> n83 (upper case, blank padded).  C = 1 if it
; is not NAME[.EXT] with 1-8 and 0-3 characters.
to83:   mov     r0, #n83
        mov     r2, #11
        mov     a, #0x20
00001$: movx    @r0, a
        inc     r0
        djnz    r2, 00001$
        mov     r0, #n83
        mov     r2, #9                  ; room + 1
        mov     r3, #0                  ; extension seen
00002$: movx    a, @dptr
        inc     dptr
        jz      00005$
        cjne    a, #0x2E, 00003$
        cjne    r0, #n83, 00006$        ; '.' needs a base name
        sjmp    00007$
00006$: mov     a, r3
        jnz     00007$
        inc     r3
        mov     r0, #n83 + 8
        mov     r2, #4
        sjmp    00002$
00003$: djnz    r2, 00004$
        sjmp    00007$
00004$: cjne    a, #0x61, 00008$        ; upper case
00008$: jc      00009$
        cjne    a, #0x7B, 00010$
00010$: jnc     00009$
        anl     a, #0xDF
00009$: movx    @r0, a
        inc     r0
        sjmp    00002$
00005$: cjne    r0, #n83, 00011$
00007$: setb    c
        ret
00011$: clr     c
        ret

; argument A -> DPTR (C = 1 if missing)
argn:   mov     r2, a
        mov     dptr, #_argc
        movx    a, @dptr
        setb    c
        subb    a, r2                   ; C = argc <= n
        jc      00001$
        mov     a, r2
        add     a, r2
        add     a, #<_argv
        mov     dpl, a
        clr     a
        addc    a, #>_argv
        mov     dph, a
        movx    a, @dptr
        mov     r2, a
        inc     dptr
        movx    a, @dptr
        mov     dph, a
        mov     dpl, r2
        clr     c
00001$: ret

; card name for sdget/sdrm (argument 1) or sdput (argument A) -> n83
cardname:
        lcall   argn
        jc      usage
        lcall   to83
        mov     dptr, #m_name
        jnc     00609$
        ljmp    sdfail
00609$:
        ret
usage:  mov     dptr, #m_usage
        ljmp    sdfail

;================================================================ commands
; sdls: root directory listing
_sd_ls: lcall   sdbegin
        lcall   mount
        lcall   dfirst
00001$: lcall   dent
        movx    a, @dptr
        jz      00009$
        cjne    a, #0xE5, 00002$
        sjmp    00008$
00002$: mov     a, dpl
        add     a, #11
        mov     r0, a
        lcall   dfld
        mov     r3, a                   ; attributes
        jb      acc.3, 00008$
        push    ar3
        mov     r3, #0                  ; name, lower case
        mov     r2, #0
00003$: cjne    r2, #8, 00004$
        movx    a, @dptr
        cjne    a, #0x20, 00010$
        sjmp    00006$
00010$: mov     a, #0x2E
        lcall   pcnt
00004$: movx    a, @dptr
        inc     dptr
        cjne    a, #0x20, 00011$
        sjmp    00005$
00011$: cjne    a, #0x41, 00012$
00012$: jc      00013$
        cjne    a, #0x5B, 00014$
00014$: jnc     00013$
        orl     a, #0x20
00013$: lcall   pcnt
00005$: inc     r2
        cjne    r2, #11, 00003$
00006$: mov     a, #0x20
        lcall   pcnt
        cjne    r3, #14, 00006$
        pop     ar3
        mov     a, r3
        mov     dptr, #m_dir
        jb      acc.4, 00007$
        lcall   dent                    ; size
        mov     a, dpl
        add     a, #28
        mov     dpl, a
        lcall   ldd32
        lcall   pdec32
        sjmp    00015$
00007$: lcall   puts_cd
00015$: lcall   crlf_r
00008$: lcall   dnext
        jnc     00001$
00009$: ret

pcnt:   inc     r3
        ljmp    putb_a

; print R7:R6:R5:R4 in decimal
pdec32: mov     r3, #0
00001$: mov     r1, #32                 ; R7:R6:R5:R4 /= 10, A = remainder
        clr     a
00002$: mov     b, a
        lcall   shl32
        mov     a, b
        rlc     a
        cjne    a, #10, 00003$
00003$: jc      00004$
        subb    a, #10
        inc     r4
00004$: djnz    r1, 00002$
        add     a, #0x30
        push    acc
        inc     r3
        mov     a, r4
        orl     a, r5
        orl     a, r6
        orl     a, r7
        jnz     00001$
00005$: pop     acc
        lcall   putb_a
        djnz    r3, 00005$
        ret

; sdrm NAME
_sd_rm: lcall   sdbegin
        mov     a, #1
        lcall   cardname
        lcall   mount
        lcall   wrprep
        lcall   rment
        jnc     notfnd
        ljmp    flush
notfnd: mov     dptr, #m_nf
        ljmp    sdfail

; sdget NAME [LOCAL]: card -> RAM disk
_sd_get:
        lcall   sdbegin
        mov     a, #1
        lcall   cardname
        lcall   mount
        lcall   findf
        jnc     notfnd
        lcall   entclus
        mov     r1, #f_clus
        lcall   st32
        mov     a, dpl                  ; size: must fit the RAM disk
        add     a, #28
        mov     dpl, a
        lcall   ldd32
        mov     r1, #f_left
        lcall   st32                    ; (f_left, f_size)
        lcall   _fs_free
        mov     a, r7
        orl     a, r6
        jz     00608$
        ljmp    00009$
00608$:
        clr     c
        mov     a, dpl
        subb    a, r4
        mov     a, dph
        subb    a, r5
        jnc     00607$
        ljmp    00009$
00607$:
        mov     a, #2                   ; open LOCAL (or NAME) for writing
        lcall   argn
        jnc     00001$
        mov     a, #1
        lcall   argn
00001$: mov     r0, #_f_open_PARM_2
        mov     a, #0x77
        movx    @r0, a
        lcall   _f_open
        mov     a, dpl
        mov     r1, #f_h
        movx    @r1, a
        inc     a
        mov     dptr, #m_create
        jnz     00606$
        ljmp    sdfail2
00606$:
00002$: mov     r1, #f_left             ; cluster by cluster
        movx    a, @r1
        inc     r1
        mov     r2, a
        movx    a, @r1
        orl     a, r2
        jnz     00620$
        ljmp    00008$
00620$:
        mov     r1, #f_clus
        lcall   ld32
        lcall   clok
        jc     00605$
        ljmp    ioerr2
00605$:
        lcall   clba
        mov     r1, #v_spc
        movx    a, @r1
        mov     r1, #f_cnt
        movx    @r1, a
00003$: mov     r1, #f_left
        movx    a, @r1
        inc     r1
        mov     r2, a
        movx    a, @r1
        orl     a, r2
        jz      00008$
        lcall   rdsec                   ; sector -> RAM disk
        mov     r0, #_f_write_PARM_2
        mov     a, #<SECBUF
        movx    @r0, a
        inc     r0
        mov     a, #>SECBUF
        movx    @r0, a
        inc     r0                      ; _f_write_PARM_3 = min(512, left)
        mov     r1, #f_left
        movx    a, @r1
        mov     r2, a
        inc     r1
        movx    a, @r1
        mov     r3, a
        clr     c
        subb    a, #2
        jc      00004$
        mov     r2, #0
        mov     r3, #2
00004$: mov     a, r2
        movx    @r0, a
        inc     r0
        mov     a, r3
        movx    @r0, a
        mov     r1, #f_left             ; f_left -= n
        clr     c
        movx    a, @r1
        subb    a, r2
        movx    @r1, a
        inc     r1
        movx    a, @r1
        subb    a, r3
        movx    @r1, a
        push    ar4
        push    ar5
        push    ar6
        push    ar7
        mov     r1, #f_h
        movx    a, @r1
        mov     dpl, a
        lcall   _f_write
        pop     ar7
        pop     ar6
        pop     ar5
        pop     ar4
        mov     a, dpl
        jnz     00009$
        lcall   inc32
        mov     r1, #f_cnt
        movx    a, @r1
        dec     a
        movx    @r1, a
        jnz     00003$
        mov     r1, #f_clus             ; next cluster
        lcall   ld32
        lcall   fatget
        mov     r1, #f_clus
        lcall   st32
        ljmp    00002$
00008$: mov     r1, #f_h
        movx    a, @r1
        mov     dpl, a
        ljmp    _f_close
00009$: mov     dptr, #_fs_err_full
sdfail2:
        ljmp    sdfail
ioerr2: ljmp    ioerr

; sdput LOCAL [NAME]: RAM disk -> card root directory
_sd_put:
        lcall   sdbegin
        mov     a, #1
        lcall   argn
        jnc     00604$
        ljmp    usage
00604$:
        mov     r0, #_f_open_PARM_2
        mov     a, #0x72
        movx    @r0, a
        lcall   _f_open
        mov     a, dpl
        mov     r1, #f_h
        movx    @r1, a
        inc     a
        mov     dptr, #m_nf
        jz      sdfail2
        mov     a, #2
        lcall   argn
        mov     a, #2
        jnc     00001$
        dec     a
00001$: lcall   cardname
        mov     r1, #f_h                ; data pointer and size, then close:
        movx    a, @r1                  ; the RAM disk does not change
        mov     dpl, a
        lcall   _f_data
        mov     r1, #f_ptr
        mov     a, dpl
        movx    @r1, a
        inc     r1
        mov     a, dph
        movx    @r1, a
        mov     r1, #f_h
        movx    a, @r1
        mov     dpl, a
        lcall   _f_size
        mov     r1, #f_left
        mov     a, dpl
        movx    @r1, a
        inc     r1
        mov     a, dph
        movx    @r1, a
        inc     r1
        mov     a, dpl
        movx    @r1, a                  ; f_size
        inc     r1
        mov     a, dph
        movx    @r1, a
        mov     r1, #f_h
        movx    a, @r1
        mov     dpl, a
        lcall   _f_close
        lcall   mount
        lcall   wrprep
        lcall   rment                   ; replace an old file
        setb    F1
        lcall   dfind                   ; free directory slot
        mov     dptr, #m_full
        jnc     sdfail2
        lcall   clr32
        mov     r1, #f_first
        lcall   st32
        mov     r1, #f_prev
        lcall   st32
        mov     r4, #2                  ; search from cluster 2
        mov     r1, #f_clus
        lcall   st32
00002$: mov     r1, #f_left             ; next cluster
        movx    a, @r1
        inc     r1
        mov     r2, a
        movx    a, @r1
        orl     a, r2
        jnz     00603$
        ljmp    00009$
00603$:
        mov     r1, #f_clus
        lcall   ld32
00003$: lcall   clok                    ; find a free one
        jc     00602$
        ljmp    00010$
00602$:
        mov     r1, #f_clus
        lcall   st32
        lcall   fatget
        mov     a, r4
        orl     a, r5
        orl     a, r6
        orl     a, r7
        jz      00004$
        mov     r1, #f_clus
        lcall   ld32
        lcall   inc32
        sjmp    00003$
00004$: mov     r4, #0xFF               ; FAT[c] = end of chain
        mov     r5, #0xFF
        mov     r6, #0xFF
        mov     r7, #0x0F
        lcall   setnew
        lcall   ldclus
        lcall   fatput
        lcall   ldclus                  ; FAT[prev] = c, or first = c
        lcall   setnew
        mov     r1, #f_prev
        lcall   ld32
        mov     a, r4
        orl     a, r5
        orl     a, r6
        orl     a, r7
        jz      00005$
        lcall   fatput
        sjmp    00006$
00005$: lcall   ldclus
        mov     r1, #f_first
        lcall   st32
00006$: lcall   ldclus
        mov     r1, #f_prev
        lcall   st32
        lcall   clba                    ; write the cluster's sectors
        mov     r1, #v_spc
        movx    a, @r1
        mov     r1, #f_cnt
        movx    @r1, a
00007$: mov     r1, #f_ptr
        movx    a, @r1
        mov     dpl, a
        inc     r1
        movx    a, @r1
        mov     dph, a
        add     a, #2                   ; f_ptr += 512
        movx    @r1, a
        mov     r1, #f_left + 1
        movx    a, @r1
        clr     c
        subb    a, #2
        jnc     00014$
        lcall   tail                    ; last, partial sector
        sjmp    00015$
00014$: lcall   sd_write
        jnc     01101$
        ljmp    ioerr2
01101$:
00015$:
        lcall   inc32
        mov     r1, #f_left + 1         ; f_left -= min(512, f_left)
        movx    a, @r1
        clr     c
        subb    a, #2
        jnc     00008$
        clr     a
        movx    @r1, a
        dec     r1
00008$: movx    @r1, a
        mov     r1, #f_left
        movx    a, @r1
        inc     r1
        mov     r2, a
        movx    a, @r1
        orl     a, r2
        jz      00011$
        mov     r1, #f_cnt
        movx    a, @r1
        dec     a
        movx    @r1, a
        jnz     00007$
00011$: lcall   ldclus                  ; continue the search after c
        lcall   inc32
        mov     r1, #f_clus
        lcall   st32
        ljmp    00002$
00009$: lcall   dent                    ; directory entry
        mov     r0, #n83
        mov     r2, #11
00012$: movx    a, @r0
        movx    @dptr, a
        inc     r0
        inc     dptr
        djnz    r2, 00012$
        mov     a, #0x20                ; archive
        movx    @dptr, a
        inc     dptr
        clr     a
        mov     r2, #4
00013$: movx    @dptr, a
        inc     dptr
        djnz    r2, 00013$
        lcall   date
        lcall   date
        mov     r1, #f_first
        lcall   ld32
        mov     a, r6
        movx    @dptr, a
        inc     dptr
        mov     a, r7
        movx    @dptr, a
        inc     dptr
        clr     a
        movx    @dptr, a
        inc     dptr
        movx    @dptr, a
        inc     dptr
        lcall   date
        mov     a, r4
        movx    @dptr, a
        inc     dptr
        mov     a, r5
        movx    @dptr, a
        inc     dptr
        mov     r1, #f_size
        movx    a, @r1
        movx    @dptr, a
        inc     dptr
        inc     r1
        movx    a, @r1
        movx    @dptr, a
        inc     dptr
        clr     a
        movx    @dptr, a
        inc     dptr
        movx    @dptr, a
        mov     r1, #c_dirty
        inc     a
        movx    @r1, a
        ljmp    flush
00010$: mov     r1, #f_first            ; card full: undo
        lcall   ld32
        lcall   freech
        lcall   flush
        mov     dptr, #m_full
        ljmp    sdfail

ldclus: mov     r1, #f_clus
        ljmp    ld32

; tail: the last f_left (< 512) bytes at DPTR become sector R7:R6:R5:R4 in
; the cache, zero padded; it is written by the next flush
tail:   push    dpl
        push    dph
        lcall   flush
        mov     r1, #c_lba
        lcall   st32
        mov     r1, #c_dirty
        mov     a, #1
        movx    @r1, a
        mov     dptr, #SECBUF
        clr     a
        mov     r2, a
00001$: movx    @dptr, a
        inc     dptr
        movx    @dptr, a
        inc     dptr
        djnz    r2, 00001$
        pop     dph
        pop     dpl
        mov     r2, #<SECBUF            ; copy f_left bytes: DPTR -> R3:R2
        mov     r3, #>SECBUF
        mov     r1, #f_left + 1         ; R0:R1 = f_left (< 512)
        movx    a, @r1
        mov     r0, a
        inc     r0
        dec     r1
        movx    a, @r1
        mov     r1, a
        jz      00003$
00002$: movx    a, @dptr
        inc     dptr
        lcall   swpdp
        movx    @dptr, a
        inc     dptr
        lcall   swpdp
        djnz    r1, 00002$
00003$: djnz    r0, 00002$
        ret

; exchange DPTR and R3:R2
swpdp:  xch     a, r2
        xch     a, dpl
        xch     a, r2
        xch     a, r3
        xch     a, dph
        xch     a, r3
        ret

; 1980-01-01 (no clock on the board)
date:   mov     a, #0x21
        movx    @dptr, a
        inc     dptr
        clr     a
        movx    @dptr, a
        inc     dptr
        ret

        .area   CONST   (CODE)
m_nocard: .asciz "no SD card\n"
m_nofat: .asciz "no FAT16/32 volume\n"
m_io:   .asciz  "SD card error\n"
m_nf:   .asciz  "not found\n"
m_name: .asciz  "bad 8.3 name\n"
m_full: .asciz  "card full\n"
m_create: .asciz "cannot create\n"
m_usage: .asciz "usage: sdget NAME [LOCAL], sdput LOCAL [NAME], sdrm NAME\n"
m_dir:  .asciz  "<DIR>"
m_dirent: .asciz "is a directory\n"
