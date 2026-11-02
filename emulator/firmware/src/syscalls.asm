;--------------------------------------------------------------------------
; DOS/51 - system call jump table at 7F00h (stable ABI for user programs)
;
; All calls preserve R0-R7 (any bank), B, DPTR and the register bank
; selection unless a result is returned there.  Results: A, carry flag.
; Interrupts (EA, ES) must stay enabled for console I/O.
;--------------------------------------------------------------------------
        .module syscalls

        .globl  _sys_exit, _user_args, _put_dec

        ; resident temporaries (internal RAM map: see vectors.c)
        t_a     = 0x36
        t_r7    = 0x37
        t_dpl   = 0x38
        t_dph   = 0x39
        t_x     = 0x3A
        .globl  _f_open, _f_open_PARM_2, _f_getc, _f_putc, _f_putc_PARM_2
        .globl  _f_close
        .globl  putb_a, putc_a, puts_cd, puts_xd, crlf_r, hex8_a, hex16_dp
        .globl  getch_a, kbhit_a, getkey_a, getline_a, delay_dp
        .globl  sd_init, sd_read, sd_write

        .area   SYSJT   (ABS,CODE)
        .org    0x7F00
        ljmp    _sys_exit       ; 7F00 EXIT     back to the shell
        ljmp    putc_a          ; 7F03 PUTC     A = char (LF -> CR LF)
        ljmp    getch_a         ; 7F06 GETC     -> A, waits
        ljmp    kbhit_a         ; 7F09 KBHIT    -> A=1/C=1 if a key is waiting
        ljmp    s_puts          ; 7F0C PUTS     DPTR = 0-terminated string (XDATA)
        ljmp    hex8_a          ; 7F0F PUTHEX   A as 2 hex digits
        ljmp    hex16_dp        ; 7F12 PUTHEX16 DPTR as 4 hex digits
        ljmp    s_putdec        ; 7F15 PUTDEC   DPTR unsigned decimal
        ljmp    crlf_r          ; 7F18 CRLF
        ljmp    s_getline       ; 7F1B GETLINE  DPTR = buffer, R7 = size -> A = length
        ljmp    s_delay         ; 7F1E DELAY    DPTR = milliseconds
        ljmp    s_args          ; 7F21 ARGS     -> DPTR = command line arguments
        ljmp    s_fopen         ; 7F24 FOPEN    DPTR = name, A = 'r'/'w' -> A = handle, C = error
        ljmp    s_fgetc         ; 7F27 FGETC    A = handle -> A = byte, C = end of file
        ljmp    s_fputc         ; 7F2A FPUTC    A = byte, B = handle -> C = error
        ljmp    s_fclose        ; 7F2D FCLOSE   A = handle
        ljmp    s_putsi         ; 7F30 PUTSI    print the 0-terminated string after the LCALL
        ljmp    s_getkey        ; 7F33 GETKEY   -> A, arrows etc. decoded (80h-89h)
        ljmp    putb_a          ; 7F36 PUTB     A = raw byte, no translation
        ljmp    s_sdinit        ; 7F39 SDINIT   -> A = 1 SDSC, 2 SDHC; C = no card
        ljmp    s_sdread        ; 7F3C SDREAD   R7:R6:R5:R4 = sector, DPTR = buffer -> C = error
        ljmp    s_sdwrite       ; 7F3F SDWRITE  R7:R6:R5:R4 = sector, DPTR = buffer -> C = error

        .area   CSEG    (CODE)

; SD card calls: the driver (sd51.asm) works in any register bank and
; preserves R4-R7 and DPTR; sdsv saves what it clobbers on the caller's
; stack, runs the rest of the wrapper and restores B and R0-R3.
s_sdinit:
        lcall   sdsv
        ljmp    sd_init
s_sdread:
        lcall   sdsv
        ljmp    sd_read
s_sdwrite:
        lcall   sdsv
        ljmp    sd_write

sdsv:   mov     t_a, a
        pop     t_dph                   ; continuation
        pop     t_dpl
        push    b
        mov     a, r0
        push    acc
        mov     a, r1
        push    acc
        mov     a, r2
        push    acc
        mov     a, r3
        push    acc
        mov     a, #<sdrs
        push    acc
        mov     a, #>sdrs
        push    acc
        push    t_dpl
        push    t_dph
        mov     a, t_a
        ret
sdrs:   mov     t_a, a
        pop     acc
        mov     r3, a
        pop     acc
        mov     r2, a
        pop     acc
        mov     r1, a
        pop     acc
        mov     r0, a
        pop     b
        mov     a, t_a
        ret

s_puts: push    dpl
        push    dph
        lcall   puts_xd
        pop     dph
        pop     dpl
        ret

s_args: mov     dptr, #_user_args
        ret

; PUTSI: the string follows the LCALL; return after its terminator
s_putsi:
        mov     t_dpl, dpl
        mov     t_dph, dph
        pop     dph
        pop     dpl
        lcall   puts_cd
        push    dpl
        push    dph
        mov     dpl, t_dpl
        mov     dph, t_dph
        ret

; ---- wrappers: "lcall s_save" first, then the body runs with the caller's
; A, B and DPTR, register bank 0 selected and R7 = the caller's R7.  The
; body returns A and CY; everything else is restored.  Registers are saved
; in XDATA (not on the user's stack), so these calls must not be nested:
; interrupt handlers may only use PUTC, PUTB, GETC, KBHIT, PUTS, PUTHEX,
; PUTHEX16 and CRLF.
s_getline:
        lcall   s_save
        mov     b, r7
        ljmp    getline_a

s_getkey:
        lcall   s_save
        ljmp    getkey_a

s_putdec:
        lcall   s_save
        push    acc
        lcall   _put_dec
        pop     acc
        ret

s_delay:
        lcall   s_save
        push    acc
        lcall   delay_dp
        pop     acc
        ret

s_fopen:
        lcall   s_save
        push    dpl
        push    dph
        orl     a, #0x20
        cjne    a, #0x77, 00001$        ; 'w' writes, anything else reads
        sjmp    00002$
00001$: mov     a, #0x72
00002$: mov     dptr, #_f_open_PARM_2
        movx    @dptr, a
        pop     dph
        pop     dpl
        lcall   _f_open
        mov     a, dpl
        cjne    a, #0xFF, 00003$
        setb    c
        ret
00003$: clr     c
        ret

s_fgetc:
        lcall   s_save
        mov     dpl, a
        lcall   _f_getc
        mov     a, dph                  ; -1 = end of file
        add     a, #0xFF
        mov     a, dpl
        ret

s_fputc:
        lcall   s_save
        push    acc
        mov     dptr, #_f_putc_PARM_2
        movx    @dptr, a
        mov     dpl, b
        lcall   _f_putc
        mov     a, dpl                  ; nonzero = error
        add     a, #0xFF
        pop     acc
        ret

s_fclose:
        lcall   s_save
        push    acc
        mov     dpl, a
        lcall   _f_close
        pop     acc
        clr     c
        ret

; s_save: stack on entry: ... user return, wrapper continuation
s_save: mov     t_dpl, dpl
        mov     t_dph, dph
        mov     t_a, a
        mov     t_r7, r7                ; caller's bank
        mov     dptr, #sysave
        mov     a, psw
        movx    @dptr, a
        inc     dptr
        mov     psw, #0
        mov     a, b
        movx    @dptr, a
        inc     dptr
        mov     a, r0
        movx    @dptr, a
        inc     dptr
        mov     a, r1
        movx    @dptr, a
        inc     dptr
        mov     a, r2
        movx    @dptr, a
        inc     dptr
        mov     a, r3
        movx    @dptr, a
        inc     dptr
        mov     a, r4
        movx    @dptr, a
        inc     dptr
        mov     a, r5
        movx    @dptr, a
        inc     dptr
        mov     a, r6
        movx    @dptr, a
        inc     dptr
        mov     a, r7
        movx    @dptr, a
        pop     dph                     ; continuation
        pop     dpl
        mov     a, #<s_rest             ; the body returns to s_rest
        push    acc
        mov     a, #>s_rest
        push    acc
        push    dpl
        push    dph
        mov     r7, t_r7
        mov     dpl, t_dpl
        mov     dph, t_dph
        mov     a, t_a
        ret
s_rest: mov     t_a, a
        mov     t_r7, psw               ; carry of the body
        mov     dptr, #sysave
        movx    a, @dptr
        mov     t_x, a                  ; caller's PSW
        inc     dptr
        movx    a, @dptr
        mov     b, a
        inc     dptr
        movx    a, @dptr
        mov     r0, a
        inc     dptr
        movx    a, @dptr
        mov     r1, a
        inc     dptr
        movx    a, @dptr
        mov     r2, a
        inc     dptr
        movx    a, @dptr
        mov     r3, a
        inc     dptr
        movx    a, @dptr
        mov     r4, a
        inc     dptr
        movx    a, @dptr
        mov     r5, a
        inc     dptr
        movx    a, @dptr
        mov     r6, a
        inc     dptr
        movx    a, @dptr
        mov     r7, a
        mov     dpl, t_dpl
        mov     dph, t_dph
        mov     a, t_r7
        anl     a, #0x80
        xch     a, t_x
        anl     a, #0x7F
        orl     a, t_x
        mov     psw, a
        mov     a, t_a
        ret

        .area   XSEG    (XDATA)
sysave: .ds     10
