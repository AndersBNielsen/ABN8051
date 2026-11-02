;--------------------------------------------------------------------------
; DOS/51 - RAM disk in lower RAM (2000h-7FFFh), hand written for size.
;
; Layout:  2000h  header: "DOS51FS1", used_end (LE), ~used_end, 4 spare
;          2010h  32 directory entries of 16 bytes: name[12], start, size
;          2210h  file data, stored contiguously in directory order of
;                 creation; deleting a file compacts the data area.
; Files are therefore always one linear byte range (the editor and the
; assembler read them in place).  Only one file can be open for writing and
; it is always the last one on the disk.  SRAM keeps the disk over a reset;
; fs_valid() checks it at boot.
;
; C prototypes are in dos.h (SDCC --model-large calling convention).
;--------------------------------------------------------------------------
        .module fs51

        .globl  _fs_format, _fs_valid, _fs_dir, _fs_find, _fs_delete
        .globl  _fs_rename, _fs_rename_PARM_2, _fs_free, _fs_used, _fs_count
        .globl  _fs_name_ok, _f_closeall, _f_open, _f_open_PARM_2, _f_getc
        .globl  _f_putc, _f_putc_PARM_2, _f_write, _f_write_PARM_2
        .globl  _f_write_PARM_3, _f_close, _f_tail, _f_tail_PARM_2
        .globl  _f_commit, _f_commit_PARM_2, _f_trunc, _f_trunc_PARM_2
        .globl  _f_size, _f_data, _fs_err_full
        .globl  strcmp_dr, cpyx, ldp2, _x_memmove, _x_memmove_PARM_2

        DISK    = 0x2000
        HEND    = 0x2008
        DIRB    = 0x2010
        DATA0   = 0x2210
        DEND    = 0x8000
        NDIR    = 32
        NH      = 4
        FH_READ = 1
        FH_WRITE = 2

        .area   XSEG    (XDATA)
fh:     .ds     4 * NH          ; mode, entry, pos (LE)

        .area   PSEG    (PAG,XDATA)     ; SDCC medium model parameters
_fs_rename_PARM_2:      .ds 2
_f_open_PARM_2:         .ds 1
_f_putc_PARM_2:         .ds 1
_f_write_PARM_2:        .ds 2
_f_write_PARM_3:        .ds 2
_f_tail_PARM_2:         .ds 2
_f_commit_PARM_2:       .ds 2
_f_trunc_PARM_2:        .ds 2

        .area   CONST   (CODE)
magic:  .ascii  "DOS51FS1"
_fs_err_full:
        .asciz  "disk full\n"

        .area   CSEG    (CODE)

;---------------------------------------------------------------- helpers
; DPTR = directory entry A (A preserved)
dirp:   push    acc
        swap    a
        mov     dph, a
        anl     a, #0xF0
        add     a, #<DIRB
        mov     dpl, a
        mov     a, dph
        anl     a, #0x0F
        addc    a, #>DIRB
        mov     dph, a
        pop     acc
        ret

; DPTR = field at offset A of the entry DPTR points into (entries are
; 16-byte aligned)
field:  xch     a, dpl
        anl     a, #0xF0
        orl     a, dpl
        mov     dpl, a
        ret

; DPTR = file handle A
fhp:    rl      a
        rl      a
        add     a, #<fh
        mov     dpl, a
        clr     a
        addc    a, #>fh
        mov     dph, a
        ret

; R3:R2 = used_end
getend: mov     dptr, #HEND
        ljmp    ldp2

; used_end = R3:R2 (with check word)
setend: mov     dptr, #HEND
        mov     a, r2
        movx    @dptr, a
        inc     dptr
        mov     a, r3
        movx    @dptr, a
        inc     dptr
        mov     a, r2
        cpl     a
        movx    @dptr, a
        inc     dptr
        mov     a, r3
        cpl     a
        movx    @dptr, a
        ret

; R1:R0 = DEND - used_end, R3:R2 = used_end
getfree:
        lcall   getend
        clr     c
        clr     a
        subb    a, r2
        mov     r0, a
        mov     a, #>DEND
        subb    a, r3
        mov     r1, a
        ret

; A = handle -> DPTR = fh entry, R6 = mode, R2 = entry, R5:R4 = pos.
; C = 1 if the handle number is invalid.
fhget:  cjne    a, #NH, 00001$
00001$: cpl     c
        jc      00002$
        lcall   fhp
        push    dpl
        push    dph
        movx    a, @dptr
        mov     r6, a
        inc     dptr
        movx    a, @dptr
        mov     r2, a
        inc     dptr
        movx    a, @dptr
        mov     r4, a
        inc     dptr
        movx    a, @dptr
        mov     r5, a
        pop     dph
        pop     dpl
        clr     c
00002$: ret

; C = 1 if directory entry A is open in any handle.  Uses R6, R7, DPTR.
isopen: mov     r6, a
        mov     dptr, #fh
        mov     r7, #NH
00001$: movx    a, @dptr
        inc     dptr
        jz      00002$
        movx    a, @dptr
        xrl     a, r6
        jz      00003$
00002$: inc     dptr
        inc     dptr
        inc     dptr
        djnz    r7, 00001$
        clr     c
        ret
00003$: setb    c
        ret

; find: DPTR = name -> A = entry, C = 1 if found.  Uses R1-R7, DPTR.
find:   mov     r4, dpl
        mov     r5, dph
        mov     r1, #0
00001$: mov     a, r1
        lcall   dirp
        movx    a, @dptr
        jz      00002$
        mov     a, r4
        mov     r2, a
        mov     a, r5
        mov     r3, a
        lcall   strcmp_dr
        jz      00003$
00002$: inc     r1
        cjne    r1, #NDIR, 00001$
        clr     c
        ret
00003$: mov     a, r1
        setb    c
        ret

; delete directory entry A and compact the data area
del_ent:
        lcall   dirp
        push    dpl
        push    dph
        mov     a, #12
        lcall   field
        lcall   ldp2                    ; R3:R2 = start
        mov     a, r2
        mov     r4, a
        mov     a, r3
        mov     r5, a
        inc     dptr
        lcall   ldp2                    ; R3:R2 = size
        mov     a, r2
        mov     r6, a
        mov     a, r3
        mov     r7, a
        push    4
        push    5
        push    6
        push    7
        lcall   getend                  ; memmove(s, s + n, end - (s + n))
        mov     dptr, #_x_memmove_PARM_2
        mov     a, r4
        add     a, r6
        mov     r0, a
        movx    @dptr, a
        inc     dptr
        mov     a, r5
        addc    a, r7
        mov     r1, a
        movx    @dptr, a
        inc     dptr
        clr     c
        mov     a, r2
        subb    a, r0
        movx    @dptr, a
        inc     dptr
        mov     a, r3
        subb    a, r1
        movx    @dptr, a
        mov     dpl, r4
        mov     dph, r5
        lcall   _x_memmove
        pop     7
        pop     6
        pop     5
        pop     4
        mov     r1, #0                  ; files behind it move down by n
00001$: mov     a, r1
        lcall   dirp
        movx    a, @dptr
        jz      00002$
        mov     a, #12
        lcall   field
        movx    a, @dptr
        mov     r2, a
        inc     dptr
        movx    a, @dptr
        mov     r3, a
        clr     c                       ; start > s ?
        mov     a, r4
        subb    a, r2
        mov     a, r5
        subb    a, r3
        jnc     00002$
        mov     a, #12
        lcall   field
        clr     c
        mov     a, r2
        subb    a, r6
        movx    @dptr, a
        inc     dptr
        mov     a, r3
        subb    a, r7
        movx    @dptr, a
00002$: inc     r1
        cjne    r1, #NDIR, 00001$
        pop     dph                     ; clear the entry
        pop     dpl
        clr     a
        mov     r1, #16
00003$: movx    @dptr, a
        inc     dptr
        djnz    r1, 00003$
        lcall   getend                  ; end -= n
        clr     c
        mov     a, r2
        subb    a, r6
        mov     r2, a
        mov     a, r3
        subb    a, r7
        mov     r3, a
        ljmp    setend

;---------------------------------------------------------------- volume
_fs_format:
        mov     dptr, #DISK             ; clear header + directory (210h)
        clr     a
        mov     r7, #0x10
        mov     r6, #3
00001$: movx    @dptr, a
        inc     dptr
        djnz    r7, 00001$
        djnz    r6, 00001$
        mov     r7, #0
00002$: mov     a, r7
        mov     dptr, #magic
        movc    a, @a+dptr
        mov     dpl, r7
        mov     dph, #>DISK
        movx    @dptr, a
        inc     r7
        cjne    r7, #8, 00002$
        mov     r2, #<DATA0
        mov     r3, #>DATA0
        lcall   setend
_f_closeall:
        mov     dptr, #fh
        mov     r7, #4 * NH
        clr     a
00003$: movx    @dptr, a
        inc     dptr
        djnz    r7, 00003$
        ret

; u8 fs_valid(void): 1 if the header and directory are consistent
_fs_valid:
        mov     r7, #0
00001$: mov     a, r7
        mov     dptr, #magic
        movc    a, @a+dptr
        mov     r6, a
        mov     dpl, r7
        mov     dph, #>DISK
        movx    a, @dptr
        xrl     a, r6
        jnz     fv_bad
        inc     r7
        cjne    r7, #8, 00001$
        lcall   getend                  ; check word
        inc     dptr
        movx    a, @dptr
        cpl     a
        xrl     a, r2
        jnz     fv_bad
        inc     dptr
        movx    a, @dptr
        cpl     a
        xrl     a, r3
        jnz     fv_bad
        clr     c                       ; DATA0 <= end <= DEND
        mov     a, r2
        subb    a, #<DATA0
        mov     a, r3
        subb    a, #>DATA0
        jc      fv_bad
        clr     c
        clr     a
        subb    a, r2
        mov     a, #>DEND
        subb    a, r3
        jc      fv_bad
        mov     r4, #0                  ; R5:R4 = total of file sizes
        mov     r5, #0
        mov     r1, #0
00002$: mov     a, r1
        lcall   dirp
        movx    a, @dptr
        jz      00003$
        mov     a, #11                  ; name must be terminated
        lcall   field
        movx    a, @dptr
        jnz     fv_bad
        inc     dptr
        movx    a, @dptr                ; R7:R6 = start
        mov     r6, a
        inc     dptr
        movx    a, @dptr
        mov     r7, a
        clr     c
        mov     a, r6
        subb    a, #<DATA0
        mov     a, r7
        subb    a, #>DATA0
        jc      fv_bad
        inc     dptr
        movx    a, @dptr                ; size: total += size
        mov     b, a
        add     a, r4
        mov     r4, a
        inc     dptr
        movx    a, @dptr
        mov     r0, a
        addc    a, r5
        mov     r5, a
        mov     a, r6                   ; start + size <= end, no wrap
        add     a, b
        mov     r6, a
        mov     a, r7
        addc    a, r0
        mov     r7, a
        jc      fv_bad
        clr     c
        mov     a, r2
        subb    a, r6
        mov     a, r3
        subb    a, r7
        jc      fv_bad
00003$: inc     r1
        cjne    r1, #NDIR, 00002$
        clr     c                       ; total == end - DATA0
        mov     a, r2
        subb    a, #<DATA0
        xrl     a, r4
        mov     r6, a
        mov     a, r3
        subb    a, #>DATA0
        xrl     a, r5
        orl     a, r6
        jnz     fv_bad
        mov     dpl, #1
        ret
fv_bad: mov     dpl, #0
        ret

; dirent_t *fs_dir(u8 i): entry i, or 0 if unused
_fs_dir:
        mov     a, dpl
        lcall   dirp
        movx    a, @dptr
        jnz     00001$
        mov     dptr, #0
00001$: ret

; int fs_find(name): entry number or -1
_fs_find:
        lcall   find
        mov     dpl, a
        mov     dph, #0
        jc      00001$
        mov     dptr, #0xFFFF
00001$: ret

; u8 fs_delete(name): 0 ok, 1 not found, 2 open
_fs_delete:
        lcall   find
        mov     dpl, #1
        jnc     00001$
        push    acc
        lcall   isopen
        pop     acc
        mov     dpl, #2
        jc      00001$
        lcall   del_ent
        mov     dpl, #0
00001$: ret

; u8 fs_rename(from, to): 0 ok, 1 not found, 2 bad name.  An existing
; file called "to" is replaced; "from" and "to" must differ.
_fs_rename:
        push    dpl
        push    dph
        lcall   find
        jnc     00008$
        lcall   ldto
        lcall   _fs_name_ok
        mov     a, dpl
        jz      00007$
        lcall   ldto
        lcall   _fs_delete
        pop     dph
        pop     dpl
        lcall   find
        jnc     00009$
        lcall   dirp
        push    dpl
        push    dph
        mov     dptr, #_fs_rename_PARM_2
        lcall   ldp2
        pop     dph
        pop     dpl
        mov     r7, #0
        lcall   cpyx
        mov     dpl, #0
        ret
00007$: pop     acc
        pop     acc
        mov     dpl, #2
        ret
00008$: pop     acc
        pop     acc
00009$: mov     dpl, #1
        ret
ldto:   mov     dptr, #_fs_rename_PARM_2
        lcall   ldp2
        mov     dpl, r2
        mov     dph, r3
        ret

; u16 fs_free(void)
_fs_free:
        lcall   getfree
        mov     dpl, r0
        mov     dph, r1
        ret

; u16 fs_used(void)
_fs_used:
        lcall   getend
        clr     c
        mov     a, r2
        subb    a, #<DATA0
        mov     dpl, a
        mov     a, r3
        subb    a, #>DATA0
        mov     dph, a
        ret

; u8 fs_count(void)
_fs_count:
        mov     r1, #0
        mov     r7, #0
00001$: mov     a, r1
        lcall   dirp
        movx    a, @dptr
        jz      00002$
        inc     r7
00002$: inc     r1
        cjne    r1, #NDIR, 00001$
        mov     dpl, r7
        ret

; u8 fs_name_ok(name): 1..11 characters of A-Z a-z 0-9 . _ -
_fs_name_ok:
        mov     r7, #0
00001$: movx    a, @dptr
        jz      00004$
        inc     dptr
        inc     r7
        cjne    r7, #12, 00002$
        sjmp    00005$
00002$: mov     r6, a
        add     a, #-0x30               ; digit?
        add     a, #-10
        jnc     00001$
        mov     a, r6                   ; letter?
        orl     a, #0x20
        add     a, #-0x61
        add     a, #-26
        jnc     00001$
        mov     a, r6
        cjne    a, #0x2E, 00003$        ; .
        sjmp    00001$
00003$: cjne    a, #0x5F, 00006$        ; _
        sjmp    00001$
00006$: cjne    a, #0x2D, 00005$        ; -
        sjmp    00001$
00004$: mov     a, r7
        jz      00005$
        mov     dpl, #1
        ret
00005$: mov     dpl, #0
        ret

;---------------------------------------------------------------- files
; u8 f_open(name, mode): handle, or 0xFF.  mode 'r' (or 1) reads; anything
; else creates/replaces the file for writing.
_f_open:
        mov     r4, dpl
        mov     r5, dph
        mov     dptr, #fh               ; free handle -> R1
        mov     r1, #0
00001$: movx    a, @dptr
        jz      00002$
        inc     dptr
        inc     dptr
        inc     dptr
        inc     dptr
        inc     r1
        cjne    r1, #NH, 00001$
        sjmp    fo_fail
00002$: mov     dptr, #_f_open_PARM_2
        movx    a, @dptr
        cjne    a, #0x72, 00003$        ; 'r'
        sjmp    00004$
00003$: cjne    a, #FH_READ, fo_write
00004$: mov     dpl, r4
        mov     dph, r5
        push    1
        lcall   find
        pop     1
        jnc     fo_fail
        mov     r2, a
        mov     r3, #FH_READ
        ljmp    fo_set
fo_fail:
        mov     dpl, #0xFF
        ret
fo_write:
        push    1
        mov     dpl, r4
        mov     dph, r5
        lcall   _fs_name_ok
        pop     1
        mov     a, dpl
        jz      fo_fail
        mov     dptr, #fh               ; only one writer
        mov     r7, #NH
00005$: movx    a, @dptr
        cjne    a, #FH_WRITE, 00006$
        sjmp    fo_fail
00006$: inc     dptr
        inc     dptr
        inc     dptr
        inc     dptr
        djnz    r7, 00005$
        mov     dpl, r4                 ; replace an existing file
        mov     dph, r5
        push    1
        lcall   find
        pop     1
        jnc     00007$
        push    acc
        lcall   isopen
        pop     acc
        jc      fo_fail
        push    1
        push    4
        push    5
        lcall   del_ent
        pop     5
        pop     4
        pop     1
00007$: mov     r6, #0                  ; free directory slot -> R6
00008$: mov     a, r6
        lcall   dirp
        movx    a, @dptr
        jz      00009$
        inc     r6
        cjne    r6, #NDIR, 00008$
        sjmp    fo_fail
00009$: mov     a, r4                   ; name
        mov     r2, a
        mov     a, r5
        mov     r3, a
        mov     r7, #0
        push    dpl
        push    dph
        lcall   cpyx
        pop     dph
        pop     dpl
        mov     a, #12                  ; start = end, size = 0
        lcall   field
        push    dpl
        push    dph
        lcall   getend
        pop     dph
        pop     dpl
        mov     a, r2
        movx    @dptr, a
        inc     dptr
        mov     a, r3
        movx    @dptr, a
        inc     dptr
        clr     a
        movx    @dptr, a
        inc     dptr
        movx    @dptr, a
        mov     a, r6
        mov     r2, a
        mov     r3, #FH_WRITE
fo_set: mov     a, r1                   ; handle R1 = mode R3, entry R2, pos 0
        lcall   fhp
        mov     a, r3
        movx    @dptr, a
        inc     dptr
        mov     a, r2
        movx    @dptr, a
        inc     dptr
        clr     a
        movx    @dptr, a
        inc     dptr
        movx    @dptr, a
        mov     dpl, r1
        ret

; int f_getc(u8 h): next byte or -1
_f_getc:
        mov     a, dpl
        lcall   fhget
        jc      00002$
        cjne    r6, #FH_READ, 00002$
        push    dpl
        push    dph
        mov     a, r2
        lcall   dirp
        mov     a, #12
        lcall   field
        lcall   ldp2                    ; R3:R2 = start
        inc     dptr
        movx    a, @dptr                ; R7:R6 = size
        mov     r6, a
        inc     dptr
        movx    a, @dptr
        mov     r7, a
        clr     c                       ; pos < size ?
        mov     a, r4
        subb    a, r6
        mov     a, r5
        subb    a, r7
        jnc     00001$
        mov     a, r2
        add     a, r4
        mov     dpl, a
        mov     a, r3
        addc    a, r5
        mov     dph, a
        movx    a, @dptr
        mov     r0, a
        pop     dph                     ; pos++
        pop     dpl
        inc     dptr
        inc     dptr
        mov     a, r4
        add     a, #1
        movx    @dptr, a
        inc     dptr
        mov     a, r5
        addc    a, #0
        movx    @dptr, a
        mov     dpl, r0
        mov     dph, #0
        ret
00001$: pop     acc
        pop     acc
00002$: mov     dptr, #0xFFFF
        ret

; u8 f_putc(u8 h, u8 c): 0 ok, 1 error (disk full)
_f_putc:
        mov     r0, dpl
        mov     dptr, #_f_write_PARM_2
        mov     a, #<_f_putc_PARM_2
        movx    @dptr, a
        inc     dptr
        mov     a, #>_f_putc_PARM_2
        movx    @dptr, a
        inc     dptr
        mov     a, #1
        movx    @dptr, a
        inc     dptr
        clr     a
        movx    @dptr, a
        mov     dpl, r0
; u8 f_write(u8 h, xdata p, u16 n): append; 0 ok, 1 error
_f_write:
        mov     a, dpl
        lcall   fhget
        jc      00002$
        cjne    r6, #FH_WRITE, 00002$
        push    dpl
        push    dph
        mov     dptr, #_f_write_PARM_3
        lcall   ldp2
        mov     a, r2
        mov     r6, a
        mov     a, r3
        mov     r7, a
        lcall   getfree                 ; n <= free ?
        clr     c
        mov     a, r0
        subb    a, r6
        mov     a, r1
        subb    a, r7
        jc      00001$
        mov     dptr, #_f_write_PARM_2
        movx    a, @dptr
        mov     r0, a
        inc     dptr
        movx    a, @dptr
        mov     r1, a
        mov     dptr, #_x_memmove_PARM_2
        mov     a, r0
        movx    @dptr, a
        inc     dptr
        mov     a, r1
        movx    @dptr, a
        inc     dptr
        mov     a, r6
        movx    @dptr, a
        inc     dptr
        mov     a, r7
        movx    @dptr, a
        mov     dpl, r2
        mov     dph, r3
        push    6
        push    7
        lcall   _x_memmove
        pop     7
        pop     6
        pop     dph
        pop     dpl
        lcall   commit
        mov     dpl, #0
        ret
00001$: pop     acc
        pop     acc
00002$: mov     dpl, #1
        ret

; commit: DPTR = handle, R7:R6 = n (two's complement to shrink):
; pos += n, size += n, used_end += n
commit: inc     dptr
        movx    a, @dptr
        mov     r2, a
        inc     dptr
        movx    a, @dptr
        add     a, r6
        movx    @dptr, a
        inc     dptr
        movx    a, @dptr
        addc    a, r7
        movx    @dptr, a
        mov     a, r2
        lcall   dirp
        mov     a, #14
        lcall   field
        movx    a, @dptr
        add     a, r6
        movx    @dptr, a
        inc     dptr
        movx    a, @dptr
        addc    a, r7
        movx    @dptr, a
        lcall   getend
        mov     a, r2
        add     a, r6
        mov     r2, a
        mov     a, r3
        addc    a, r7
        mov     r3, a
        ljmp    setend

; void f_commit(u8 h, u16 n): n bytes were written at f_tail()
_f_commit:
        mov     a, dpl
        lcall   fhp
        push    dpl
        push    dph
        mov     dptr, #_f_commit_PARM_2
        lcall   ldp2
        mov     a, r2
        mov     r6, a
        mov     a, r3
        mov     r7, a
        pop     dph
        pop     dpl
        sjmp    commit

; void f_trunc(u8 h, u16 n): drop the last n bytes (n <= size)
_f_trunc:
        mov     a, dpl
        lcall   fhp
        push    dpl
        push    dph
        mov     dptr, #_f_trunc_PARM_2
        lcall   ldp2
        clr     c
        clr     a
        subb    a, r2
        mov     r6, a
        clr     a
        subb    a, r3
        mov     r7, a
        pop     dph
        pop     dpl
        sjmp    commit

; xdata f_tail(u8 h, u16 *avail): where to append, *avail = free bytes
_f_tail:
        mov     a, dpl
        lcall   fhget
        mov     r0, #0
        mov     r1, #0
        mov     r2, #0
        mov     r3, #0
        jc      00001$
        cjne    r6, #FH_WRITE, 00001$
        lcall   getfree
00001$: mov     dptr, #_f_tail_PARM_2
        movx    a, @dptr
        mov     r4, a
        inc     dptr
        movx    a, @dptr
        mov     dph, a
        mov     dpl, r4
        mov     a, r0
        movx    @dptr, a
        inc     dptr
        mov     a, r1
        movx    @dptr, a
        mov     dpl, r2
        mov     dph, r3
        ret

; void f_close(u8 h)
_f_close:
        mov     a, dpl
        lcall   fhget
        jc      00001$
        clr     a
        movx    @dptr, a
00001$: ret

; u16 f_size(u8 h) / xdata f_data(u8 h) of an open file
_f_size:
        mov     r7, #14
        sjmp    fsd
_f_data:
        mov     r7, #12
fsd:    mov     a, dpl
        lcall   fhp
        inc     dptr
        movx    a, @dptr
        lcall   dirp
        mov     a, r7
        lcall   field
        lcall   ldp2
        mov     dpl, r2
        mov     dph, r3
        ret
