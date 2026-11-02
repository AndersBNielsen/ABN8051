;--------------------------------------------------------------------------
; DOS/51 - XMODEM file transfer, hand written for size.
;
;   u8 xmodem_recv(name)  receive (CRC-16 or checksum, 128 and 1K blocks)
;   u8 xmodem_send(name)  send 128 byte blocks (CRC-16 or checksum)
; Both return 1 on success.  Internal RAM 08h-1Fh is used as scratch (no
; user program runs during a transfer).
;--------------------------------------------------------------------------
        .module xm51

        .globl  _xmodem_recv, _xmodem_send
        .globl  _f_open, _f_open_PARM_2, _f_close, _f_tail, _f_tail_PARM_2
        .globl  _f_commit, _f_commit_PARM_2, _f_trunc, _f_trunc_PARM_2
        .globl  _f_size, _f_data, _fs_delete, _fs_err_full, _rx_flush
        .globl  putb_a, puts_cd, crlf_r, kbhit_a, getch_a, delay_dp, _put_dec

        SOH     = 0x01
        STX     = 0x02
        EOT     = 0x04
        ACK     = 0x06
        NAK     = 0x15
        CAN     = 0x18
        SUB     = 0x1A

        hnd     = 0x08          ; file handle
        blk     = 0x09          ; expected block number
        tries   = 0x0A
        crcm    = 0x0B          ; 1 = CRC-16, 0 = checksum
        crcl    = 0x0C
        crch    = 0x0D
        lenl    = 0x0E          ; block length
        lenh    = 0x0F
        ptl     = 0x10          ; block buffer / data pointer
        pth     = 0x11
        cnl     = 0x12          ; counters
        cnh     = 0x13
        szl     = 0x14          ; file size (send)
        szh     = 0x15
        rblk    = 0x16          ; received block number
        nbyte   = 0x17          ; bytes of real data in this block (send)
        namel   = 0x18
        nameh   = 0x19

        .area   XSEG    (XDATA)
avail:  .ds     2

        .area   CSEG    (CODE)

;---------------------------------------------------------------- helpers
; gto: wait up to DPTR ms for a byte -> A, C = 0; C = 1 on timeout.
; Preserves R0-R7.
gto:    push    6
        push    7
00001$: lcall   kbhit_a
        jc      00003$
        mov     a, dpl
        orl     a, dph
        jz      00004$
        mov     r7, #2
00002$: mov     r6, #228
        djnz    r6, .
        djnz    r7, 00002$
        mov     a, dpl
        jnz     00005$
        dec     dph
00005$: dec     dpl
        sjmp    00001$
00003$: lcall   getch_a
        clr     c
        sjmp    00006$
00004$: setb    c
00006$: pop     7
        pop     6
        ret

g1s:    mov     dptr, #1000
        sjmp    gto

; CRC-16/XMODEM update with A
crcup:  xrl     a, crch
        mov     crch, a
        mov     r7, #8
00001$: clr     c
        mov     a, crcl
        rlc     a
        mov     crcl, a
        mov     a, crch
        rlc     a
        mov     crch, a
        jnc     00002$
        xrl     crch, #0x10
        xrl     crcl, #0x21
00002$: djnz    r7, 00001$
        ret

; account byte A in CRC or checksum (crcl), A preserved
csum:   push    acc
        mov     r6, a
        mov     a, crcm
        jz      00001$
        mov     a, r6
        lcall   crcup
        sjmp    00002$
00001$: mov     a, r6
        add     a, crcl
        mov     crcl, a
00002$: pop     acc
        ret

; discard input until the line is quiet for 300 ms
purge:  mov     dptr, #300
        lcall   gto
        jnc     purge
        ret

cancel: mov     a, #CAN
        lcall   putb_a
        lcall   putb_a
        ljmp    putb_a

; report: DPTR = message, R7:R6 = byte count
report: push    dpl
        push    dph
        push    6
        push    7
        mov     dptr, #500
        lcall   delay_dp
        lcall   _rx_flush
        lcall   crlf_r
        pop     7
        pop     6
        pop     dph
        pop     dpl
        lcall   puts_cd
        mov     dpl, r6
        mov     dph, r7
        lcall   _put_dec
        mov     dptr, #s_bytes
        ljmp    puts_cd

; announce: open file, A = mode, DPTR = name -> hnd, C = 1 if it failed
xopen:  mov     namel, dpl
        mov     nameh, dph
        mov     dptr, #_f_open_PARM_2
        movx    @dptr, a
        mov     dpl, namel
        mov     dph, nameh
        lcall   _f_open
        mov     a, dpl
        mov     hnd, a
        cjne    a, #0xFF, 00001$
        setb    c
        ret
00001$: clr     c
        ret

;---------------------------------------------------------------- receive
_xmodem_recv:
        mov     a, #0x77                ; 'w'
        lcall   xopen
        jnc     00001$
        mov     dptr, #s_create
        lcall   puts_cd
        mov     dpl, #0
        ret
00001$: mov     dptr, #s_recv
        lcall   puts_cd
        lcall   _rx_flush
        mov     crcm, #1
        mov     tries, #0
00002$: mov     a, tries                ; ask for CRC 10 times, then checksum
        cjne    a, #10, 00003$
        mov     crcm, #0
00003$: cjne    a, #21, 00004$
        lcall   cancel
        ljmp    r_fail
00004$: mov     a, crcm
        jz      00040$
        mov     a, #0x43                ; 'C'
        sjmp    00005$
00040$: mov     a, #NAK
00005$: lcall   putb_a
        inc     tries
        mov     dptr, #3000
        lcall   gto
        jc      00002$
        cjne    a, #SOH, 00006$
        sjmp    r_got
00006$: cjne    a, #STX, 00007$
        sjmp    r_got
00007$: cjne    a, #EOT, 00008$
        sjmp    r_got
00008$: cjne    a, #CAN, 00009$
        ljmp    r_fail
00009$: cjne    a, #3, 00002$
        ljmp    r_fail
r_nk:   ljmp    r_nak
r_got:  mov     blk, #1
        mov     tries, #0
r_blk:  cjne    a, #EOT, 00010$         ; A = first byte of a block
        mov     a, #ACK
        lcall   putb_a
        ljmp    r_done
00010$: cjne    a, #CAN, 00011$
        lcall   g1s
        jc      r_nk
        cjne    a, #CAN, r_nk
        ljmp    r_fail
00011$: mov     lenl, #128
        mov     lenh, #0
        cjne    a, #SOH, 00012$
        sjmp    00013$
00012$: cjne    a, #STX, r_nk
        mov     lenl, #0
        mov     lenh, #4
00013$: mov     dptr, #_f_tail_PARM_2   ; room for the block?
        mov     a, #<avail
        movx    @dptr, a
        inc     dptr
        mov     a, #>avail
        movx    @dptr, a
        mov     dpl, hnd
        lcall   _f_tail
        mov     ptl, dpl
        mov     pth, dph
        mov     dptr, #avail
        movx    a, @dptr
        clr     c
        subb    a, lenl
        inc     dptr
        movx    a, @dptr
        subb    a, lenh
        jnc     00014$
        lcall   cancel
        lcall   purge
        mov     dptr, #_fs_err_full
        lcall   puts_cd
        ljmp    r_fail
00014$: lcall   g1s                     ; block number and complement
        jc      r_nk
        mov     rblk, a
        lcall   g1s
        jc      r_nk
        cpl     a
        xrl     a, rblk
        jnz     00032$
        mov     cnl, lenl
        mov     cnh, lenh
        mov     r0, ptl                 ; R1:R0 = write pointer
        mov     r1, pth
00015$: lcall   g1s                     ; store only: at 57600 baud a byte
        jc      00032$                  ; arrives every 160 cycles, too
        mov     dpl, r0                 ; little time for a bitwise CRC
        mov     dph, r1
        movx    @dptr, a
        inc     dptr
        mov     r0, dpl
        mov     r1, dph
        lcall   cntdn
        jnz     00015$
        lcall   g1s                     ; check value
        jc      00032$
        mov     r2, a
        mov     r3, #0
        mov     a, crcm
        jz      00030$
        lcall   g1s                     ; CRC: high byte first
        jc      00032$
        mov     r3, a
        sjmp    00030$
00032$: ljmp    r_nak
00030$: mov     crcl, #0                ; sender now waits for our reply,
        mov     crch, #0                ; so check the stored block
        mov     cnl, lenl
        mov     cnh, lenh
        mov     dpl, ptl
        mov     dph, pth
00031$: movx    a, @dptr
        lcall   csum
        inc     dptr
        lcall   cntdn
        jnz     00031$
        mov     a, crcm
        jz      00016$
        mov     a, r3
        xrl     a, crcl
        mov     r3, a
        mov     a, r2
        xrl     a, crch
        orl     a, r3
        jnz     r_nak
        sjmp    00017$
00016$: mov     a, r2
        xrl     a, crcl
        jnz     r_nak
00017$: mov     a, rblk                 ; new block, or a repeat of the last?
        cjne    a, blk, 00018$
        mov     dptr, #_f_commit_PARM_2
        mov     a, lenl
        movx    @dptr, a
        inc     dptr
        mov     a, lenh
        movx    @dptr, a
        mov     dpl, hnd
        lcall   _f_commit
        inc     blk
        sjmp    00019$
00018$: inc     a
        cjne    a, blk, 00020$
00019$: mov     tries, #0
        mov     a, #ACK
        lcall   putb_a
        mov     dptr, #10000
        lcall   gto
        jc      r_nak
        ljmp    r_blk
00020$: lcall   cancel                  ; out of sequence
        ljmp    r_fail
r_nak:  lcall   purge
        inc     tries
        mov     a, tries
        cjne    a, #11, 00021$
        lcall   cancel
        sjmp    r_fail
00021$: mov     a, #NAK
        lcall   putb_a
        mov     dptr, #5000
        lcall   gto
        jc      r_nak
        ljmp    r_blk

r_done: mov     dpl, hnd                ; strip the SUB padding
        lcall   _f_data
        mov     r0, dpl
        mov     r1, dph
        mov     dpl, hnd
        lcall   _f_size
        mov     r6, dpl
        mov     r7, dph
        mov     a, r0                   ; R1:R0 = end of data
        add     a, r6
        mov     r0, a
        mov     a, r1
        addc    a, r7
        mov     r1, a
        mov     r2, #0                  ; R3:R2 = padding bytes
        mov     r3, #0
00030$: mov     a, r6
        orl     a, r7
        jz      00031$
        mov     dpl, r0
        mov     dph, r1
        lcall   decp
        movx    a, @dptr
        cjne    a, #SUB, 00031$
        mov     r0, dpl
        mov     r1, dph
        inc     r2
        cjne    r2, #0, 00032$
        inc     r3
00032$: mov     dpl, r6
        mov     dph, r7
        lcall   decp
        mov     r6, dpl
        mov     r7, dph
        sjmp    00030$
00031$: mov     dptr, #_f_trunc_PARM_2
        mov     a, r2
        movx    @dptr, a
        inc     dptr
        mov     a, r3
        movx    @dptr, a
        mov     dpl, hnd
        push    6
        push    7
        lcall   _f_trunc
        mov     dpl, hnd
        lcall   _f_close
        pop     7
        pop     6
        mov     dptr, #s_recvd
        lcall   report
        mov     dpl, #1
        ret
r_fail: mov     dpl, hnd
        lcall   _f_close
        mov     dpl, namel
        mov     dph, nameh
        lcall   _fs_delete
x_fail: mov     dptr, #s_failed
        mov     r6, #0
        mov     r7, #0
        lcall   report
        mov     dpl, #0
        ret

; DPTR-- (A destroyed)
decp:   mov     a, dpl
        jnz     00001$
        dec     dph
00001$: dec     dpl
        ret

; cnh:cnl -= 1, A = 0 (Z) when it reaches zero
cntdn:  mov     a, cnl
        jnz     00001$
        dec     cnh
00001$: dec     cnl
        mov     a, cnl
        orl     a, cnh
        ret

;---------------------------------------------------------------- send
_xmodem_send:
        mov     a, #0x72                ; 'r'
        lcall   xopen
        jc      x_fail
        mov     dpl, hnd
        lcall   _f_size
        mov     szl, dpl
        mov     szh, dph
        mov     dpl, hnd
        lcall   _f_data
        mov     ptl, dpl
        mov     pth, dph
        mov     dptr, #s_send
        lcall   puts_cd
        lcall   _rx_flush
        mov     tries, #0               ; wait up to 60 s for 'C' or NAK
00001$: lcall   g1s
        jc      00002$
        mov     crcm, #1
        cjne    a, #0x43, 00003$
        sjmp    s_go
00003$: mov     crcm, #0
        cjne    a, #NAK, 00004$
        sjmp    s_go
00004$: cjne    a, #CAN, 00005$
        sjmp    s_fail
00005$: cjne    a, #3, 00002$
        sjmp    s_fail
00002$: inc     tries
        mov     a, tries
        cjne    a, #61, 00001$
s_fail: mov     dpl, hnd
        lcall   _f_close
        sjmp    x_fail
s_go:   mov     blk, #1
        mov     cnl, szl                ; bytes left
        mov     cnh, szh
s_next: mov     a, cnl
        orl     a, cnh
        jnz     00041$
        ljmp    s_eot
00041$:
        mov     nbyte, #128             ; n = min(128, left)
        mov     a, cnh
        jnz     00010$
        mov     a, cnl
        cjne    a, #128, 00011$
00011$: jnc     00010$
        mov     nbyte, a
00010$: mov     tries, #0
s_try:  mov     a, tries
        cjne    a, #11, 00012$
        lcall   cancel
        sjmp    s_fail
00012$: inc     tries
        mov     a, #SOH
        lcall   putb_a
        mov     a, blk
        lcall   putb_a
        cpl     a
        lcall   putb_a
        mov     crcl, #0
        mov     crch, #0
        mov     r0, #0                  ; R0 = index in block
        mov     dpl, ptl
        mov     dph, pth
00013$: mov     a, #SUB
        mov     r1, a
        mov     a, r0
        clr     c
        subb    a, nbyte
        mov     a, r1
        jnc     00014$
        movx    a, @dptr
        inc     dptr
00014$: lcall   putb_a
        push    dpl
        push    dph
        lcall   csum
        pop     dph
        pop     dpl
        inc     r0
        cjne    r0, #128, 00013$
        mov     a, crcm
        jz      00015$
        mov     a, crch
        lcall   putb_a
00015$: mov     a, crcl
        lcall   putb_a
        mov     dptr, #10000
        lcall   gto
        jc      s_try
        cjne    a, #ACK, 00016$
        mov     a, ptl                  ; next block
        add     a, nbyte
        mov     ptl, a
        clr     a
        addc    a, pth
        mov     pth, a
        clr     c
        mov     a, cnl
        subb    a, nbyte
        mov     cnl, a
        mov     a, cnh
        subb    a, #0
        mov     cnh, a
        inc     blk
        ljmp    s_next
00016$: cjne    a, #CAN, s_try
        ljmp    s_fail
s_eot:  mov     tries, #10
00020$: mov     a, #EOT
        lcall   putb_a
        mov     dptr, #3000
        lcall   gto
        jc      00021$
        cjne    a, #ACK, 00021$
        sjmp    00022$
00021$: djnz    tries, 00020$
00022$: mov     dpl, hnd
        lcall   _f_close
        mov     r6, szl
        mov     r7, szh
        mov     dptr, #s_sent
        lcall   report
        mov     dpl, #1
        ret

        .area   CONST   (CODE)
s_create:
        .asciz  "cannot create file\n"
s_recv: .asciz  "XMODEM receive: start the upload now (^X^X cancels)\n"
s_send: .asciz  "XMODEM send: start the download now (^X^X cancels)\n"
s_recvd:
        .asciz  "received "
s_sent: .asciz  "sent "
s_failed:
        .asciz  "transfer failed, "
s_bytes:
        .asciz  " bytes\n"
