;--------------------------------------------------------------------------
; DOS/51 - console and string primitives, hand written for size.
;
; C entry points follow the SDCC --model-large convention: the first
; argument is in DPL/DPH, further arguments in _fn_PARM_n (XDATA), results
; in DPL (u8) or DPL/DPH (u16).  Internal entry points (no leading '_')
; take A or DPTR and preserve every register except where noted; the
; system call table in syscalls.asm uses them directly.
;--------------------------------------------------------------------------
        .module lib51

        .globl  _putb, _putch, _puts_c, _puts_x, _crlf, _put_hex8, _put_hex16
        .globl  _put_dec, _put_dec_w, _put_dec_w_PARM_2
        .globl  _kbhit, _getch, _getch_to, _delay_ms, _rx_flush
        .globl  _x_strlen, _x_streq_c, _x_streq_c_PARM_2
        .globl  _x_strcmp, _x_strcmp_PARM_2
        .globl  _x_strcpy, _x_strcpy_PARM_2, _x_strcpy_c, _x_strcpy_c_PARM_2
        .globl  _x_strncpy, _x_strncpy_PARM_2, _x_strncpy_PARM_3
        .globl  _x_memmove, _x_memmove_PARM_2, _x_memmove_PARM_3
        .globl  _x_memset, _x_memset_PARM_2, _x_memset_PARM_3
        .globl  _upcase, _unlz, _unlz_dst, _unlz_len
        .globl  _getkey, _getline_x, _getline_x_PARM_2, _parse_num, _parse_num_PARM_2
        .globl  _vt_goto, _vt_goto_PARM_2, _vt_clear, _vt_clreol, _vt_inverse
        .globl  gto, getkey_a, getline_a
        .globl  putb_a, putc_a, puts_cd, puts_xd, crlf_r, hex8_a, hex16_dp
        .globl  dec_dp, getch_a, kbhit_a, delay_dp, strcmp_dr, cpyx, ldp2, decdp

        _rx_head  = 0x30        ; resident state (see dos.h)
        _rx_tail  = 0x31
        _tx_ready = 0x32

        SBUFR   = 0x99
        TIB     = 0x99
        ESB     = 0xAC
        RXPAGE  = 0x1F          ; receive ring buffer at 1F00h

        .area   XSEG    (XDATA)
_unlz_dst:              .ds 2
_unlz_len:              .ds 2

        .area   PSEG    (PAG,XDATA)     ; SDCC medium model parameters
_put_dec_w_PARM_2:      .ds 1
_x_streq_c_PARM_2:      .ds 2
_x_strcmp_PARM_2:       .ds 2
_x_strcpy_PARM_2:       .ds 2
_x_strcpy_c_PARM_2:     .ds 2
_x_strncpy_PARM_2:      .ds 2
_x_strncpy_PARM_3:      .ds 1
_x_memmove_PARM_2:      .ds 2
_x_memmove_PARM_3:      .ds 2
_x_memset_PARM_2:       .ds 1
_x_memset_PARM_3:       .ds 2
_getline_x_PARM_2:      .ds 1
_parse_num_PARM_2:      .ds 2
_vt_goto_PARM_2:        .ds 1

        .area   CSEG    (CODE)

;---------------------------------------------------------------- output
_putb:  mov     a, dpl
; putb_a: send A as is.  Works with interrupts enabled (ISR sets tx_ready)
; or disabled (polls TI).
putb_a: push    acc
00001$: mov     a, _tx_ready
        jnz     00002$
        jbc     TIB, 00002$
        sjmp    00001$
00002$: mov     _tx_ready, #0
        pop     acc
        mov     SBUFR, a
        ret

_putch: mov     a, dpl
; putc_a: send A, LF becomes CR LF
putc_a: cjne    a, #0x0A, putb_a
_crlf:
crlf_r: push    acc
        mov     a, #0x0D
        lcall   putb_a
        mov     a, #0x0A
        lcall   putb_a
        pop     acc
        ret

; puts_cd: DPTR = string in CODE.  Preserves A, DPTR advances past it.
_puts_c:
puts_cd:
        push    acc
00001$: clr     a
        movc    a, @a+dptr
        inc     dptr
        jz      00002$
        lcall   putc_a
        sjmp    00001$
00002$: pop     acc
        ret

; puts_xd: DPTR = string in XDATA.  Preserves A, DPTR advances past it.
_puts_x:
puts_xd:
        push    acc
00001$: movx    a, @dptr
        inc     dptr
        jz      00002$
        lcall   putc_a
        sjmp    00001$
00002$: pop     acc
        ret

_put_hex8:
        mov     a, dpl
hex8_a: push    acc
        swap    a
        lcall   00001$
        pop     acc
        push    acc
        lcall   00001$
        pop     acc
        ret
00001$: anl     a, #0x0F
        add     a, #0x90
        da      a
        addc    a, #0x40
        da      a
        sjmp    putb_a

_put_hex16:
hex16_dp:
        push    acc
        mov     a, dph
        lcall   hex8_a
        mov     a, dpl
        lcall   hex8_a
        pop     acc
        ret

; R3:R2 /= 10, A = remainder.  Uses R4, R5.
div10:  clr     a
        mov     r4, #16
00001$: mov     r5, a
        mov     a, r2
        add     a, r2
        mov     r2, a
        mov     a, r3
        rlc     a
        mov     r3, a
        mov     a, r5
        rlc     a
        cjne    a, #10, 00002$
00002$: jc      00003$
        subb    a, #10
        inc     r2
00003$: djnz    r4, 00001$
        ret

; dec_dp: DPTR as unsigned decimal; preserves all registers
dec_dp: push    acc
        push    2
        push    3
        push    4
        push    5
        push    6
        push    7
        lcall   _put_dec
        pop     7
        pop     6
        pop     5
        pop     4
        pop     3
        pop     2
        pop     acc
        ret

_put_dec:
        mov     r6, #0
        sjmp    pdec
_put_dec_w:
        mov     r2, dpl
        mov     r3, dph
        mov     dptr, #_put_dec_w_PARM_2
        movx    a, @dptr
        mov     r6, a
        mov     dpl, r2
        mov     dph, r3
pdec:   mov     r2, dpl
        mov     r3, dph
        mov     r7, #0
00001$: lcall   div10
        add     a, #0x30
        push    acc
        inc     r7
        mov     a, r2
        orl     a, r3
        jnz     00001$
00002$: mov     a, r7
        clr     c
        subb    a, r6
        jnc     00003$
        mov     a, #0x20
        lcall   putb_a
        dec     r6
        sjmp    00002$
00003$: pop     acc
        lcall   putb_a
        djnz    r7, 00003$
        ret

;---------------------------------------------------------------- input
_kbhit: lcall   kbhit_a
        mov     dpl, a
        ret
; kbhit_a: A = 1 and C = 1 if a byte is waiting, else A = 0, C = 0
kbhit_a:
        mov     a, _rx_head
        clr     c
        subb    a, _rx_tail
        jz      00001$
        mov     a, #1
        setb    c
00001$: ret

_getch: lcall   getch_a
        mov     dpl, a
        ret
; getch_a: wait for a byte -> A.  Preserves DPTR.
getch_a:
        push    dpl
        push    dph
00001$: mov     a, _rx_head
        cjne    a, _rx_tail, 00002$
        sjmp    00001$
00002$: mov     dph, #RXPAGE
        mov     dpl, _rx_tail
        movx    a, @dptr
        inc     _rx_tail
        pop     dph
        pop     dpl
        ret

_rx_flush:
        clr     ESB
        mov     _rx_tail, _rx_head
        setb    ESB
        ret

; int getch_to(u16 ms): byte, or -1 after ms milliseconds
_getch_to:
        lcall   gto
        jc      00001$
        mov     dpl, a
        mov     dph, #0
        ret
00001$: mov     dptr, #0xFFFF
        ret

; gto: wait up to DPTR ms for a byte -> A, C = 0; C = 1 on timeout.
; Destroys DPTR only (bank independent: safe inside system calls).
gto:    push    b
00001$: lcall   kbhit_a
        jc      00003$
        mov     a, dpl
        orl     a, dph
        jz      00004$
        lcall   ms1
        lcall   decdp
        sjmp    00001$
00003$: lcall   getch_a
        clr     c
        sjmp    00005$
00004$: setb    c
00005$: pop     b
        ret

; about 1 ms (921.6 machine cycles) including the call; destroys B
ms1:    mov     b, #227
00001$: nop
        nop
        djnz    b, 00001$
        ret

; DPTR-- ; preserves A
decdp:  xch     a, dpl
        jnz     00001$
        dec     dph
00001$: dec     a
        xch     a, dpl
        ret

; delay_dp: about DPTR milliseconds at 11.0592 MHz.  Destroys DPTR, A, B.
_delay_ms:
delay_dp:
00001$: mov     a, dpl
        orl     a, dph
        jz      00009$
        lcall   ms1
        lcall   decdp
        sjmp    00001$
00009$: ret

;---------------------------------------------------------------- strings
; exchange DPTR and R3:R2 (A preserved)
swp23:  xch     a, r2
        xch     a, dpl
        xch     a, r2
        xch     a, r3
        xch     a, dph
        xch     a, r3
        ret

; load R3:R2 from the parameter at DPTR (2 bytes, little endian)
ldp2:   movx    a, @dptr
        mov     r2, a
        inc     dptr
        movx    a, @dptr
        mov     r3, a
        ret

; u8 x_strlen(xdata s)
_x_strlen:
        mov     r7, #0
00001$: movx    a, @dptr
        jz      00002$
        inc     dptr
        inc     r7
        sjmp    00001$
00002$: mov     dpl, r7
        ret

; u8 x_streq_c(xdata a, code b): 1 if equal
_x_streq_c:
        lcall   ldprm2s
        .db     >_x_streq_c_PARM_2, <_x_streq_c_PARM_2
00001$: movx    a, @dptr                ; a: DPTR, b: R3:R2
        inc     dptr
        mov     r7, a
        lcall   swp23
        clr     a
        movc    a, @a+dptr
        inc     dptr
        lcall   swp23
        xrl     a, r7
        jnz     00002$
        mov     a, r7
        jnz     00001$
        mov     dpl, #1
        ret
00002$: mov     dpl, #0
        ret

; ldprm2s: R3:R2 = 16-bit parameter whose address follows the ACALL as .dw
; (big endian, as emitted by .dw); DPTR (first argument) is preserved.
ldprm2s:
        mov     r2, dpl
        mov     r3, dph
        pop     dph                     ; return address -> inline .dw
        pop     dpl
        clr     a
        movc    a, @a+dptr
        mov     r6, a
        mov     a, #1
        movc    a, @a+dptr
        inc     dptr
        inc     dptr
        push    dpl
        push    dph
        mov     dpl, a
        mov     dph, r6
        push    2
        push    3
        lcall   ldp2
        pop     dph
        pop     dpl
        ret

; u8 x_strcmp(xdata a, xdata b): 0 if equal
_x_strcmp:
        lcall   ldprm2s
        .db     >_x_strcmp_PARM_2, <_x_strcmp_PARM_2
; strcmp_dr: compare XDATA strings at DPTR and R3:R2 -> DPL = A = 0 if equal
strcmp_dr:
00001$: movx    a, @dptr
        inc     dptr
        mov     r7, a
        lcall   swp23
        movx    a, @dptr
        inc     dptr
        lcall   swp23
        xrl     a, r7
        jnz     00002$
        mov     a, r7
        jnz     00001$
        mov     dpl, a
        ret
00002$: mov     a, #1
        mov     dpl, a
        ret

; void x_strcpy(xdata d, xdata s)
_x_strcpy:
        lcall   ldprm2s
        .db     >_x_strcpy_PARM_2, <_x_strcpy_PARM_2
        mov     r7, #0                  ; no length limit
        sjmp    cpyx

; void x_strncpy(xdata d, xdata s, u8 n): at most n-1 characters + 0
_x_strncpy:
        lcall   ldprm2s
        .db     >_x_strncpy_PARM_2, <_x_strncpy_PARM_2
        push    dpl
        push    dph
        mov     dptr, #_x_strncpy_PARM_3
        movx    a, @dptr
        pop     dph
        pop     dpl
        mov     r7, a
        jz      00002$
        djnz    r7, cpyx
00002$: clr     a
        movx    @dptr, a
        ret
; copy from R3:R2 to DPTR, R7 = max characters (0 = unlimited)
cpyx:   lcall   swp23
        movx    a, @dptr
        inc     dptr
        lcall   swp23
        movx    @dptr, a
        jz      00002$
        inc     dptr
        mov     a, r7
        jz      cpyx
        djnz    r7, cpyx
        clr     a
        movx    @dptr, a
00002$: ret

; void x_strcpy_c(xdata d, code s)
_x_strcpy_c:
        lcall   ldprm2s
        .db     >_x_strcpy_c_PARM_2, <_x_strcpy_c_PARM_2
00001$: lcall   swp23
        clr     a
        movc    a, @a+dptr
        inc     dptr
        lcall   swp23
        movx    @dptr, a
        inc     dptr
        jnz     00001$
        ret

; void x_memset(xdata d, u8 v, u16 n)
_x_memset:
        mov     r2, dpl
        mov     r3, dph
        mov     dptr, #_x_memset_PARM_2
        movx    a, @dptr
        mov     r7, a
        inc     dptr
        movx    a, @dptr
        mov     r4, a
        inc     dptr
        movx    a, @dptr
        mov     r5, a
        mov     dpl, r2
        mov     dph, r3
        inc     r5                      ; outer loop count (R4 == 0 handled)
        mov     a, r4
        jz      00002$
00001$: mov     a, r7
        movx    @dptr, a
        inc     dptr
        djnz    r4, 00001$
00002$: djnz    r5, 00001$
        ret

; void x_memmove(xdata d, xdata s, u16 n) - overlapping regions allowed
_x_memmove:
        mov     r4, dpl                 ; R5:R4 = d
        mov     r5, dph
        mov     dptr, #_x_memmove_PARM_2
        lcall   ldp2                    ; R3:R2 = s
        inc     dptr
        movx    a, @dptr
        mov     r6, a                   ; R7:R6 = n
        inc     dptr
        movx    a, @dptr
        mov     r7, a
        orl     a, r6
        jz      00009$
        clr     c                       ; d < s: copy upwards
        mov     a, r4
        subb    a, r2
        mov     a, r5
        subb    a, r3
        jc      00001$
        mov     a, r4                   ; d == s: nothing
        xrl     a, r2
        mov     b, a
        mov     a, r5
        xrl     a, r3
        orl     a, b
        jz      00009$
        mov     a, r2                   ; copy downwards from the end
        add     a, r6
        mov     r2, a
        mov     a, r3
        addc    a, r7
        mov     r3, a
        mov     a, r4
        add     a, r6
        mov     r4, a
        mov     a, r5
        addc    a, r7
        mov     r5, a
        inc     r7
        mov     a, r6
        jz      00004$
00003$: mov     dpl, r2                 ; --s
        mov     dph, r3
        lcall   decdp
        mov     r2, dpl
        mov     r3, dph
        movx    a, @dptr
        mov     dpl, r4                 ; --d
        mov     dph, r5
        lcall   decdp
        mov     r4, dpl
        mov     r5, dph
        movx    @dptr, a
        djnz    r6, 00003$
00004$: djnz    r7, 00003$
00009$: ret
00001$: inc     r7                      ; upwards
        mov     a, r6
        jz      00006$
00005$: mov     dpl, r2
        mov     dph, r3
        movx    a, @dptr
        inc     dptr
        mov     r2, dpl
        mov     r3, dph
        mov     dpl, r4
        mov     dph, r5
        movx    @dptr, a
        inc     dptr
        mov     r4, dpl
        mov     r5, dph
        djnz    r6, 00005$
00006$: djnz    r7, 00005$
        ret

; char upcase(char c)
_upcase:
        mov     a, dpl
        add     a, #-0x61
        add     a, #-26
        jc      00001$
        mov     a, dpl
        anl     a, #0xDF
        mov     dpl, a
00001$: ret

;---------------------------------------------------------------- keys
; getkey_a: next key -> A; VT100/xterm sequences become K_UP 80h, K_DOWN
; 81h, K_LEFT 82h, K_RIGHT 83h, K_HOME 84h, K_END 85h, K_PGUP 86h,
; K_PGDN 87h, K_DEL 88h, K_INS 89h; DEL (7Fh) becomes backspace (8).
; Preserves everything except A.
_getkey:
        lcall   getkey_a
        mov     dpl, a
        ret
getkey_a:
        push    dpl
        push    dph
        push    b
        lcall   getch_a
        cjne    a, #27, gk_plain
        lcall   to40
        jc      gk_esc
        cjne    a, #0x4F, 00001$        ; ESC O x
        lcall   to40
        jc      gk_zero
        sjmp    gk_final
00001$: cjne    a, #0x5B, gk_zero       ; ESC [ n ; n x
        mov     b, #0
00002$: lcall   to40
        jc      gk_zero
        cjne    a, #0x3B, 00003$        ; ';'
        sjmp    00002$
00003$: push    acc
        add     a, #-0x30
        add     a, #-10
        pop     acc
        jc      gk_final
        add     a, #-0x30               ; n = n * 10 + digit
        push    acc
        mov     a, b
        mov     b, #10
        mul     ab
        mov     b, a
        pop     acc
        add     a, b
        mov     b, a
        sjmp    00002$
gk_final:
        cjne    a, #0x7E, 00004$        ; '~': by number
        mov     a, b
        mov     dptr, #ktilde
        sjmp    00005$
00004$: mov     dptr, #kfinal
00005$: mov     b, a
00006$: clr     a
        movc    a, @a+dptr
        jz      gk_ret
        inc     dptr
        cjne    a, b, 00007$
        clr     a
        movc    a, @a+dptr
        sjmp    gk_ret
00007$: inc     dptr
        sjmp    00006$
gk_plain:
        cjne    a, #127, gk_ret
        mov     a, #8
        sjmp    gk_ret
gk_esc: mov     a, #27
        sjmp    gk_ret
gk_zero:
        clr     a
gk_ret: pop     b
        pop     dph
        pop     dpl
        ret
to40:   mov     dptr, #40
        ljmp    gto

;---------------------------------------------------------------- line input
; u8 getline_x(xdata buf, u8 max): edit a line (BS, ^U, ^C), echo; the
; result is 0-terminated, at most max-1 characters.  Returns the length.
_getline_x:
        push    dpl
        push    dph
        mov     dptr, #_getline_x_PARM_2
        movx    a, @dptr
        mov     b, a
        pop     dph
        pop     dpl
        lcall   getline_a
        mov     dpl, a
        ret
; getline_a: DPTR = buffer, B = size -> A = length.  Uses R3-R7, DPTR.
getline_a:
        mov     r6, dpl
        mov     r7, dph
        mov     r5, b
        mov     r4, #0
00001$: lcall   getch_a
        cjne    a, #13, 00002$
        sjmp    00009$
00002$: cjne    a, #10, 00003$
        sjmp    00009$
00003$: cjne    a, #8, 00004$
        sjmp    00005$
00004$: cjne    a, #127, 00006$
00005$: mov     a, r4                   ; backspace
        jz      00001$
        dec     r4
        lcall   bsp
        sjmp    00001$
00006$: cjne    a, #21, 00008$          ; ^U
00007$: mov     a, r4
        jz      00001$
        dec     r4
        lcall   bsp
        sjmp    00007$
00008$: cjne    a, #3, 00010$           ; ^C: empty line
        mov     r4, #0
00009$: lcall   lpos
        clr     a
        movx    @dptr, a
        lcall   crlf_r
        mov     a, r4
        ret
00010$: cjne    a, #32, 00011$
00011$: jc      00001$
        cjne    a, #127, 00012$
00012$: jnc     00001$
        mov     r3, a
        mov     a, r4                   ; room?  n + 1 < size
        inc     a
        clr     c
        subb    a, r5
        jnc     00001$
        lcall   lpos
        mov     a, r3
        movx    @dptr, a
        inc     r4
        lcall   putb_a
        sjmp    00001$
lpos:   mov     a, r6
        add     a, r4
        mov     dpl, a
        clr     a
        addc    a, r7
        mov     dph, a
        ret
bsp:    mov     a, #8
        lcall   putb_a
        mov     a, #32
        lcall   putb_a
        mov     a, #8
        ljmp    putb_a

;---------------------------------------------------------------- numbers
; u8 parse_num(xdata s, xdata u16 *out): decimal, 0x1F, $1F or 1Fh -> 1
_parse_num:
        mov     r6, dpl
        mov     r7, dph
        mov     r5, #10
        movx    a, @dptr
        cjne    a, #0x24, 00001$        ; $1F
        inc     dptr
        sjmp    00004$
00001$: cjne    a, #0x30, 00003$        ; 0x1F
        inc     dptr
        movx    a, @dptr
        orl     a, #0x20
        cjne    a, #0x78, 00002$
        inc     dptr
00010$: mov     r5, #16
        sjmp    00005$
00004$: sjmp    00010$
00002$: mov     dpl, r6
        mov     dph, r7
00003$: push    dpl                     ; 1Fh: last character
        push    dph
        mov     r4, #0
00011$: movx    a, @dptr
        jz      00012$
        mov     r4, a
        inc     dptr
        sjmp    00011$
00012$: pop     dph
        pop     dpl
        mov     a, r4
        orl     a, #0x20
        cjne    a, #0x68, 00005$
        mov     r5, #16
00005$: mov     r2, #0
        mov     r3, #0
        mov     r1, #0
00006$: movx    a, @dptr
        jz      00009$
        inc     dptr
        mov     r4, a
        orl     a, #0x20
        cjne    a, #0x68, 00007$        ; 'h' only as the last character
        movx    a, @dptr
        jz      00009$
        sjmp    pn_bad
00007$: mov     a, r4
        lcall   hexdig
        mov     r0, a
        clr     c
        subb    a, r5
        jnc     pn_bad
        mov     a, r2                   ; value = value * base + digit
        mov     b, r5
        mul     ab
        add     a, r0
        mov     r2, a
        clr     a
        addc    a, b
        xch     a, r3
        mov     b, r5
        mul     ab
        add     a, r3
        mov     r3, a
        inc     r1
        sjmp    00006$
00009$: mov     a, r1
        jz      pn_bad
        mov     dptr, #_parse_num_PARM_2
        movx    a, @dptr
        mov     r0, a
        inc     dptr
        movx    a, @dptr
        mov     dph, a
        mov     dpl, r0
        mov     a, r2
        movx    @dptr, a
        inc     dptr
        mov     a, r3
        movx    @dptr, a
        mov     dpl, #1
        ret
pn_bad: mov     dpl, #0
        ret

; A = value of hex digit A (either case), or FFh
hexdig: orl     a, #0x20
        add     a, #-0x30
        cjne    a, #10, 00001$
00001$: jc      00003$
        add     a, #-0x31
        cjne    a, #6, 00002$
00002$: jnc     00004$
        add     a, #10
00003$: ret
00004$: mov     a, #0xFF
        ret

;---------------------------------------------------------------- VT100
; void vt_goto(u8 row, u8 col): 0-based
_vt_goto:
        mov     a, dpl
        push    acc
        mov     a, #27
        lcall   putb_a
        mov     a, #0x5B
        lcall   putb_a
        pop     acc
        lcall   vtnum
        mov     a, #0x3B
        lcall   putb_a
        mov     dptr, #_vt_goto_PARM_2
        movx    a, @dptr
        lcall   vtnum
        mov     a, #0x48
        ljmp    putb_a
vtnum:  inc     a
        mov     dpl, a
        mov     dph, #0
        ljmp    _put_dec

_vt_clear:
        mov     dptr, #s_clear
        ljmp    puts_cd
_vt_clreol:
        mov     dptr, #s_clreol
        ljmp    puts_cd
_vt_inverse:
        mov     a, dpl
        mov     dptr, #s_inv
        jnz     00001$
        mov     dptr, #s_norm
00001$: ljmp    puts_cd

        .area   CONST   (CODE)
kfinal: .db     0x41, 0x80, 0x42, 0x81, 0x43, 0x83, 0x44, 0x82
        .db     0x48, 0x84, 0x46, 0x85, 0
ktilde: .db     1, 0x84, 7, 0x84, 4, 0x85, 8, 0x85
        .db     2, 0x89, 3, 0x88, 5, 0x86, 6, 0x87, 0
s_clear:
        .db     27
        .ascii  "[H"
        .db     27
        .ascii  "[2J"
        .db     0
s_clreol:
        .db     27
        .ascii  "[K"
        .db     0
s_inv:  .db     27
        .ascii  "[7m"
        .db     0
s_norm: .db     27
        .ascii  "[0m"
        .db     0

        .area   CSEG    (CODE)

;---------------------------------------------------------------- LZSS
; void unlz(code src): decode _unlz_len bytes to _unlz_dst (see
; scripts/gen_examples.py for the format)
_unlz:  mov     r2, dpl                 ; R3:R2 = src
        mov     r3, dph
        mov     dptr, #_unlz_dst
        movx    a, @dptr
        mov     r4, a                   ; R5:R4 = dst
        inc     dptr
        movx    a, @dptr
        mov     r5, a
        inc     dptr
        movx    a, @dptr
        mov     r6, a                   ; R7:R6 = bytes left
        inc     dptr
        movx    a, @dptr
        mov     r7, a
00001$: lcall   lzget                   ; control byte
        mov     b, a
        mov     r1, #8
00002$: mov     a, r6
        orl     a, r7
        jz      00009$
        mov     a, b
        rrc     a
        mov     b, a
        jnc     00003$
        lcall   lzget                   ; literal
        lcall   lzput
        sjmp    00005$
00003$: lcall   lzget                   ; reference: distance, length
        mov     r0, a
        lcall   lzget
        push    acc
        clr     c                       ; DPTR = dst - distance
        mov     a, r4
        subb    a, r0
        mov     dpl, a
        pop     acc
        push    acc
        swap    a
        anl     a, #0x0F
        mov     r0, a
        mov     a, r5
        subb    a, r0
        mov     dph, a
        pop     acc
        anl     a, #0x0F
        add     a, #3
        mov     r0, a
00004$: movx    a, @dptr
        inc     dptr
        push    dpl
        push    dph
        lcall   lzput
        pop     dph
        pop     dpl
        mov     a, r6
        orl     a, r7
        jz      00009$
        djnz    r0, 00004$
00005$: djnz    r1, 00002$
        sjmp    00001$
00009$: ret

lzget:  mov     dpl, r2
        mov     dph, r3
        clr     a
        movc    a, @a+dptr
        inc     dptr
        mov     r2, dpl
        mov     r3, dph
        ret

lzput:  mov     dpl, r4
        mov     dph, r5
        movx    @dptr, a
        inc     dptr
        mov     r4, dpl
        mov     r5, dph
        dec     r6                      ; one byte less to go
        cjne    r6, #0xFF, 00001$
        dec     r7
00001$: ret
