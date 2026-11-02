;--------------------------------------------------------------------------
; DOS/51 - assembler core, hand written for size.
;
; void asm_line(void)
;   Assembles the prepared line in UBUF (XDATA 1E00h: upper case outside
;   quotes, tabs -> spaces, comment stripped).  Pass, location counter and
;   statistics live in the work page 1E00h-1EFFh shared with asm.c and are
;   reached with MOVX @Ri while P2 = 1Eh.  Symbols: 255 x 16 bytes at 0C00h.
;   Internal RAM 08h-21h is used as scratch (user programs are not running).
;--------------------------------------------------------------------------
        .module asm51
        .globl  _asm_line, _asm_err, _asm_err1

        P2R     = 0xA0
        PG      = 0x1E
        IDENT   = 0x80          ; 13 bytes, 0 padded
        LABEL   = 0x90
        INCNAME = 0xA0
        S_PASS  = 0xC0
        S_PCL   = 0xC1
        S_PCH   = 0xC2
        S_LSL   = 0xC3
        S_LSH   = 0xC4
        S_DONE  = 0xC5
        S_NLB   = 0xC7
        S_LB    = 0xC8
        S_LMORE = 0xCC
        S_MINL  = 0xCD
        S_MINH  = 0xCE
        S_MAXL  = 0xCF
        S_MAXH  = 0xD0
        S_NBL   = 0xD1
        S_NBH   = 0xD2
        S_NSYM  = 0xD3
        S_LERR  = 0xD4
        S_INC   = 0xD5
        VSTK    = 0xE0          ; value stack, 6 words
        VEND    = 0xEC
        OSTK    = 0xF0          ; operator stack, 8 bytes
        OEND    = 0xF8
        SYMTAB  = 0x0C00
        MAXSYM  = 255

        pcl     = 0x08
        pch     = 0x09
        lsl     = 0x0A
        lsh     = 0x0B
        pass    = 0x0C
        undef   = 0x0D
        vsp     = 0x0E
        osp     = 0x0F
        nops    = 0x10
        ocls    = 0x11          ; 3 bytes
        oreg    = 0x14          ; 3 bytes
        ovl     = 0x17          ; 3 bytes
        ovh     = 0x1A          ; 3 bytes
        mnem    = 0x1D
        nameoff = 0x1E
        isize   = 0x1F
        aflags  = 0x2F          ; bit addressable: bits 78h-7Fh
        savp2   = 0x2E          ; caller's P2 (SDCC pdata page)
        F_LAB   = 0x78
        F_DOT   = 0x79
        F_WANT  = 0x7A
        F_WORD  = 0x7B

        ; symbol flags
        SF_DEF1 = 1
        SF_DEF2 = 2
        SF_SET  = 4
        SF_LAB  = 8

        ; operand kinds
        K_NONE  = 0
        K_A     = 1
        K_AB    = 2
        K_C     = 3
        K_DPTR  = 4
        K_ATDPTR = 5
        K_ATADPTR = 6
        K_ATAPC = 7
        K_RN    = 8
        K_ATRI  = 9
        K_IMM   = 10
        K_IMM16 = 11
        K_DIR   = 12
        K_BIT   = 13
        K_NBIT  = 14
        K_REL   = 15
        K_A11   = 16
        K_A16   = 17
        C_EXPR  = 20

        ; expression operators
        O_LP    = 1
        O_NEG   = 2
        O_NOT   = 3
        O_HIGH  = 4
        O_LOW   = 5
        O_DOT   = 6
        O_MUL   = 7
        O_DIV   = 8
        O_MOD   = 9
        O_ADD   = 10
        O_SUB   = 11
        O_SHL   = 12
        O_SHR   = 13
        O_AND   = 14
        O_XOR   = 15
        O_OR    = 16

        .area   CSEG    (CODE)

;==========================================================================
; entry
;==========================================================================
_asm_line:
        mov     savp2, P2R
        mov     P2R, #PG
        mov     r1, #S_PASS
        movx    a, @r1
        mov     pass, a
        mov     r1, #S_PCL
        movx    a, @r1
        mov     pcl, a
        mov     lsl, a
        inc     r1
        movx    a, @r1
        mov     pch, a
        mov     lsh, a
        mov     aflags, #0
        mov     undef, #0
        mov     r0, #0
        lcall   do_line
        mov     P2R, #PG
        mov     r1, #S_PCL
        mov     a, pcl
        movx    @r1, a
        inc     r1
        mov     a, pch
        movx    @r1, a
        inc     r1
        mov     a, lsl
        movx    @r1, a
        inc     r1
        mov     a, lsh
        movx    @r1, a
        mov     P2R, savp2
        ret

;==========================================================================
; errors: DPTR = message in ROM.  All registers are preserved.
;==========================================================================
err:    push    acc
        mov     a, #0
        sjmp    err_c
err1:   push    acc
        mov     a, #1
err_c:  push    0
        push    1
        push    2
        push    3
        push    4
        push    5
        push    6
        push    7
        mov     P2R, savp2
        jnz     00001$
        lcall   _asm_err
        sjmp    00002$
00001$: lcall   _asm_err1
00002$: mov     P2R, #PG
        pop     7
        pop     6
        pop     5
        pop     4
        pop     3
        pop     2
        pop     1
        pop     0
        pop     acc
        ret

e_syntax:
        mov     dptr, #m_syntax
        sjmp    err

;==========================================================================
; lexical helpers (R0 = line pointer)
;==========================================================================
; skipws: skip blanks, A = current character (Z when end of line)
skipws: movx    a, @r0
        cjne    a, #0x20, 00001$
        inc     r0
        sjmp    skipws
00001$: jz      00002$
00002$: ret

; carry = A is a letter, '_' or '?'
isid0:  cjne    a, #0x5F, 00001$        ; '_'
        sjmp    yes
00001$: cjne    a, #0x3F, 00002$        ; '?'
        sjmp    yes
00002$: cjne    a, #0x41, 00003$        ; 'A'
00003$: jc      no
        cjne    a, #0x5B, 00004$        ; 'Z'+1
00004$: ret
yes:    setb    c
        ret
no:     clr     c
        ret

isidc:  lcall   isid0
        jc      yes
; carry = A is '0'..'9'
isdig:  cjne    a, #0x30, 00001$
00001$: jc      no
        cjne    a, #0x3A, 00002$
00002$: ret

; A = hex digit value, carry clear if not a digit 0-9A-F
hexval: lcall   isdig
        jnc     00001$
        clr     c
        subb    a, #0x30
        setb    c
        ret
00001$: cjne    a, #0x41, 00002$
00002$: jc      no
        cjne    a, #0x47, 00003$
00003$: jnc     no
        clr     c
        subb    a, #0x37
        setb    c
        ret

; get_ident: identifier at R0 -> IDENT (12 significant chars, 0 padded)
; carry = got one.  Uses R1, R2.
get_ident:
        movx    a, @r0
        lcall   isid0
        jnc     00005$
        mov     r1, #IDENT
        mov     r2, #12
00001$: movx    a, @r0
        lcall   isidc
        jnc     00003$
        inc     r0
        cjne    r2, #0, 00002$
        sjmp    00001$
00002$: movx    @r1, a
        inc     r1
        dec     r2
        sjmp    00001$
00003$: inc     r2              ; pad to 13 bytes with 0
        clr     a
00004$: movx    @r1, a
        inc     r1
        djnz    r2, 00004$
        setb    c
00005$: ret

; lookup IDENT in a ROM word list at DPTR (0 separated, 0 0 ends)
; -> A = index, carry = found.  Uses R1, R3, R4.
lookup: mov     r4, #0
00001$: clr     a
        movc    a, @a+dptr
        jz      no
        mov     r1, #IDENT
00002$: clr     a
        movc    a, @a+dptr
        inc     dptr
        mov     r3, a
        movx    a, @r1
        inc     r1
        xrl     a, r3
        jnz     00003$
        mov     a, r3
        jnz     00002$
        mov     a, r4
        setb    c
        ret
00003$: mov     a, r3
        jz      00005$
00004$: clr     a
        movc    a, @a+dptr
        inc     dptr
        jnz     00004$
00005$: inc     r4
        sjmp    00001$

; copy 13 bytes in the work page: R1 = source, R4 = destination
copy13: push    0
        mov     a, r4
        mov     r0, a
        mov     r2, #13
00001$: movx    a, @r1
        movx    @r0, a
        inc     r0
        inc     r1
        djnz    r2, 00001$
        pop     0
        ret

lab2id: mov     r1, #LABEL
        mov     r4, #IDENT
        sjmp    copy13
id2lab: mov     r1, #IDENT
        mov     r4, #LABEL
        sjmp    copy13

;==========================================================================
; numbers: R0 at first character ('$' or digit) -> R3:R2, R0 advanced
;==========================================================================
get_number:
        mov     r5, #16                 ; base
        movx    a, @r0
        cjne    a, #0x24, 00001$        ; '$'
        inc     r0
        mov     a, r0
        mov     r6, a                   ; digits start
        lcall   hexrun
        sjmp    convert
00001$: mov     a, r0
        mov     r6, a
        lcall   hexrun                  ; R7 = end of [0-9A-F] run, A = char there
        cjne    a, #0x48, 00002$        ; 'H'
        inc     r0
        sjmp    convert
00002$: cjne    a, #0x58, 00003$        ; 'X' after a single "0"
        mov     a, r7
        clr     c
        subb    a, r6
        cjne    a, #1, 00003$
        inc     r0
        mov     a, r0
        mov     r6, a
        lcall   hexrun
        sjmp    convert
00003$: mov     r5, #8
        cjne    a, #0x4F, 00004$        ; 'O'
        inc     r0
        sjmp    convert
00004$: cjne    a, #0x51, 00005$        ; 'Q'
        inc     r0
        sjmp    convert
00005$: mov     r5, #2                  ; 0B1010 ?
        mov     a, r6
        mov     r1, a
        movx    a, @r1
        cjne    a, #0x30, 00006$
        inc     r1
        movx    a, @r1
        cjne    a, #0x42, 00006$
        inc     r1
        movx    a, @r1
        anl     a, #0xFE
        cjne    a, #0x30, 00006$
        mov     a, r6
        add     a, #2
        mov     r6, a
        sjmp    convert
00006$: mov     a, r7                   ; suffix B or D inside the run
        dec     a
        mov     r1, a
        movx    a, @r1
        cjne    a, #0x42, 00007$        ; 'B'
        dec     r7
        sjmp    convert
00007$: mov     r5, #10
        cjne    a, #0x44, convert       ; 'D'
        dec     r7
; convert digits [R6, R7) in base R5 -> R3:R2
convert:
        mov     r2, #0
        mov     r3, #0
        mov     a, r6
        mov     r1, a
00010$: mov     a, r1
        xrl     a, r7
        jz      00012$
        movx    a, @r1
        inc     r1
        lcall   hexval
        mov     r4, a
        clr     c
        subb    a, r5
        jc      00011$
        mov     dptr, #m_number
        lcall   err
        mov     r4, #0
00011$: mov     a, r2                   ; value = value * base + digit
        mov     b, r5
        mul     ab
        add     a, r4
        mov     r2, a
        clr     a
        addc    a, b
        xch     a, r3
        mov     b, r5
        mul     ab
        add     a, r3
        mov     r3, a
        sjmp    00010$
00012$: ret

; R0 = R7 = end of the hex digit run starting at R0, A = character there
hexrun: movx    a, @r0
        mov     r4, a
        lcall   hexval
        mov     a, r4
        jnc     00001$
        inc     r0
        sjmp    hexrun
00001$: mov     a, r0
        mov     r7, a
        mov     a, r4
        ret

;==========================================================================
; symbols
;==========================================================================
; sfind: name at work page offset nameoff -> DPTR = entry, carry = found
; (if not found DPTR = first free entry).  Uses R1, R4, R5, R7 (R2, R3, R6 are preserved).
sfind:  mov     dptr, #SYMTAB
        mov     r1, #S_NSYM
        movx    a, @r1
        mov     r4, a
00001$: mov     a, r4
        jz      sf_no
        mov     r1, nameoff
        mov     r7, #12
        push    dpl
        push    dph
00002$: movx    a, @dptr
        mov     r5, a
        movx    a, @r1
        xrl     a, r5
        jnz     00003$
        inc     dptr
        inc     r1
        djnz    r7, 00002$
        pop     dph
        pop     dpl
        setb    c
        ret
00003$: pop     dph
        pop     dpl
        mov     a, dpl
        add     a, #16
        mov     dpl, a
        jnc     00004$
        inc     dph
00004$: dec     r4
        sjmp    00001$
sf_no:  clr     c
        ret

; DPTR += A
dpadd:  add     a, dpl
        mov     dpl, a
        jnc     00001$
        inc     dph
00001$: ret

; symval: IDENT -> R3:R2, carry = known (user symbol or predefined)
symval: mov     nameoff, #IDENT
        lcall   sfind
        jnc     00002$
        push    dpl
        push    dph
        mov     a, #12
        lcall   dpadd
        movx    a, @dptr                ; flags
        mov     r4, a
        mov     a, pass
        cjne    a, #1, 00001$
        mov     a, r4
        anl     a, #SF_DEF1
        sjmp    00003$
00001$: mov     a, r4
        anl     a, #SF_DEF1 | SF_DEF2
00003$: jz      00004$
        inc     dptr
        movx    a, @dptr
        mov     r2, a
        inc     dptr
        movx    a, @dptr
        mov     r3, a
        pop     dph
        pop     dpl
        setb    c
        ret
00004$: pop     dph
        pop     dpl
00002$: mov     dptr, #builtins         ; name 0 lo hi ... 0
00005$: clr     a
        movc    a, @a+dptr
        jz      sv_no
        mov     r1, #IDENT
00006$: clr     a
        movc    a, @a+dptr
        inc     dptr
        mov     r3, a
        movx    a, @r1
        inc     r1
        xrl     a, r3
        jnz     00007$
        mov     a, r3
        jnz     00006$
        clr     a
        movc    a, @a+dptr
        mov     r2, a
        mov     a, #1
        movc    a, @a+dptr
        mov     r3, a
        setb    c
        ret
00007$: mov     a, r3
        jz      00009$
00008$: clr     a
        movc    a, @a+dptr
        inc     dptr
        jnz     00008$
00009$: inc     dptr
        inc     dptr
        sjmp    00005$
sv_no:  clr     c
        ret

; sdefine: name at nameoff, value R3:R2, kind R6 (SF_SET / SF_LAB)
sdefine:
        lcall   sfind
        jc      00010$
        mov     a, pass                 ; new symbol
        cjne    a, #2, 00001$
        mov     a, r6
        jnb     acc.3, 00001$           ; labels must exist from pass 1
        mov     dptr, #m_phase
        ljmp    err
00001$: mov     r1, #S_NSYM
        movx    a, @r1
        cjne    a, #MAXSYM, 00002$
        mov     dptr, #m_symfull
        ljmp    err1
00002$: inc     a
        movx    @r1, a
        mov     r1, nameoff
        mov     r4, #12
00003$: movx    a, @r1
        movx    @dptr, a
        inc     r1
        inc     dptr
        djnz    r4, 00003$
        mov     a, pass                 ; flags = kind | DEFn
        orl     a, r6
        movx    @dptr, a
        sjmp    00020$
00010$: mov     a, #12
        lcall   dpadd
        movx    a, @dptr
        mov     r4, a                   ; old flags
        mov     a, pass
        cjne    a, #1, 00012$
        mov     a, r4                   ; pass 1
        jnb     acc.0, 00011$
        jb      acc.2, 00011$
        ret                             ; redefinition: reported in pass 2
00011$: orl     a, #SF_DEF1
        orl     a, r6
        movx    @dptr, a
        sjmp    00020$
00012$: mov     a, r4                   ; pass 2
        jb      acc.1, 00014$
        jnb     acc.3, 00013$           ; label: must not move
        push    dpl
        push    dph
        inc     dptr
        movx    a, @dptr
        xrl     a, r2
        mov     r5, a
        inc     dptr
        movx    a, @dptr
        xrl     a, r3
        orl     a, r5
        pop     dph
        pop     dpl
        jz      00013$
        mov     dptr, #m_phase
        ljmp    err
00013$: mov     a, r4
        orl     a, #SF_DEF2
        movx    @dptr, a
        sjmp    00020$
00014$: jb      acc.2, 00013$           ; SET may change
        mov     dptr, #m_redef
        ljmp    err
00020$: inc     dptr                    ; store the value
        mov     a, r2
        movx    @dptr, a
        inc     dptr
        mov     a, r3
        movx    @dptr, a
        ret

deflabel:
        mov     nameoff, #LABEL
        mov     r2, pcl
        mov     r3, pch
        mov     r6, #SF_LAB
        ljmp    sdefine

;==========================================================================
; output
;==========================================================================
; emit A at the location counter; preserves all registers
emit:   push    acc
        push    dpl
        push    dph
        push    1
        push    acc
        mov     a, pass
        cjne    a, #2, 00005$
        mov     a, pch                  ; pass 2
        jb      acc.7, 00001$
        mov     dptr, #m_tpa
        lcall   err
        sjmp    00002$
00001$: mov     dpl, pcl
        mov     dph, pch
        pop     acc
        push    acc
        movx    @dptr, a
        mov     r1, #S_NBL
        movx    a, @r1
        add     a, #1
        movx    @r1, a
        inc     r1
        movx    a, @r1
        addc    a, #0
        movx    @r1, a
00002$: mov     r1, #S_NLB              ; listing bytes
        movx    a, @r1
        cjne    a, #4, 00003$
        mov     r1, #S_LMORE
        mov     a, #1
        movx    @r1, a
        sjmp    00008$
00003$: inc     a
        movx    @r1, a
        add     a, #S_LB - 1
        mov     r1, a
        pop     acc
        push    acc
        movx    @r1, a
        sjmp    00008$
00005$: mov     r1, #S_MINL             ; pass 1: track min/max address
        clr     c
        movx    a, @r1
        subb    a, pcl
        inc     r1
        movx    a, @r1
        subb    a, pch
        jc      00006$
        mov     r1, #S_MINL
        mov     a, pcl
        movx    @r1, a
        inc     r1
        mov     a, pch
        movx    @r1, a
00006$: mov     r1, #S_MAXL
        clr     c
        mov     a, pcl
        movx    a, @r1
        clr     c
        mov     a, pcl
        push    acc
        movx    a, @r1
        mov     dpl, a
        pop     acc
        subb    a, dpl
        inc     r1
        movx    a, @r1
        mov     dpl, a
        mov     a, pch
        subb    a, dpl
        jc      00008$
        mov     r1, #S_MAXL
        mov     a, pcl
        movx    @r1, a
        inc     r1
        mov     a, pch
        movx    @r1, a
00008$: pop     acc
        inc     pcl
        mov     a, pcl
        jnz     00009$
        inc     pch
00009$: pop     1
        pop     dph
        pop     dpl
        pop     acc
        ret

;==========================================================================
; expression evaluator (operator precedence, no recursion)
; R0 = text.  Result R3:R2.  undef = 1 if an undefined symbol was used.
;==========================================================================
vpush:  mov     a, vsp
        cjne    a, #VEND, 00001$
        sjmp    e_complex
00001$: mov     r1, a
        mov     a, r2
        movx    @r1, a
        inc     r1
        mov     a, r3
        movx    @r1, a
        inc     r1
        mov     vsp, r1
        ret

e_complex:
        mov     dptr, #m_complex
        ljmp    err

; push operator A, applying stacked operators of higher precedence
push_op:
        mov     r5, a
        mov     dptr, #prec
        movc    a, @a+dptr
        mov     r6, a                   ; precedence of the new operator
00001$: mov     a, osp
        cjne    a, #OSTK, 00002$
        sjmp    00005$
00002$: dec     a
        mov     r1, a
        movx    a, @r1                  ; top operator
        cjne    a, #O_LP, 00003$
        sjmp    00005$
00003$: mov     r7, a
        movc    a, @a+dptr
        mov     b, a                    ; precedence of top
        mov     a, r5                   ; unary operators associate right
        add     a, #-O_NEG
        add     a, #-(O_LOW - O_NEG + 1)
        jc      00004$
        mov     a, r6                   ; unary: apply while prec(top) > p
        clr     c
        subb    a, b
        jnc     00005$
        sjmp    00006$
00004$: mov     a, b                    ; binary: apply while prec(top) >= p
        clr     c
        subb    a, r6
        jc      00005$
00006$: dec     osp
        mov     a, r7
        push    5
        push    6
        lcall   apply
        pop     6
        pop     5
        mov     dptr, #prec
        sjmp    00001$
00005$: mov     a, r5
opush:  mov     r5, a
        mov     a, osp
        cjne    a, #OEND, 00007$
        sjmp    e_complex
00007$: mov     r1, a
        mov     a, r5
        movx    @r1, a
        inc     osp
        ret

; apply operator A to the value stack
apply:  mov     r5, a
        mov     a, vsp
        add     a, #-VSTK
        jz      00001$
        cjne    r5, #O_DOT, 00002$
00002$: jnc     binop                   ; operator >= O_DOT is binary
        mov     a, vsp                  ; unary on the top value
        add     a, #-2
        mov     r1, a
        cjne    r5, #O_NEG, ap_not
        sjmp    neg
00001$: ljmp    e_expr
neg:    ; R1 -> lo
        movx    a, @r1
        cpl     a
        add     a, #1
        movx    @r1, a
        inc     r1
        movx    a, @r1
        cpl     a
        addc    a, #0
        movx    @r1, a
        ret
ap_not: cjne    r5, #O_NOT, ap_hi
        movx    a, @r1
        cpl     a
        movx    @r1, a
        inc     r1
        movx    a, @r1
        cpl     a
        movx    @r1, a
        ret
ap_hi:  cjne    r5, #O_HIGH, ap_lo
        inc     r1
        movx    a, @r1
        dec     r1
        movx    @r1, a
ap_lo:  inc     r1                      ; HIGH and LOW clear the high byte
        clr     a
        movx    @r1, a
        ret

binop:  ; b = pop (R7:R6), a = top (R3:R2), result -> top
        mov     a, vsp
        add     a, #-VSTK
        clr     c
        subb    a, #4
        jc      00001$
        mov     a, vsp
        add     a, #-1
        mov     r1, a
        movx    a, @r1
        mov     r7, a
        dec     r1
        movx    a, @r1
        mov     r6, a
        mov     vsp, r1
        dec     r1
        movx    a, @r1
        mov     r3, a
        dec     r1
        movx    a, @r1
        mov     r2, a
        mov     a, r5
        add     a, #-O_DOT
        mov     b, #3
        mul     ab
        mov     dptr, #00002$
        jmp     @a+dptr
00001$: ljmp    e_expr
00002$: ljmp    o_dot
        ljmp    o_mul
        ljmp    o_div
        ljmp    o_mod
        ljmp    o_add
        ljmp    o_sub
        ljmp    o_shl
        ljmp    o_shr
        ljmp    o_and
        ljmp    o_xor
        ljmp    o_or

o_add:  mov     a, r2
        add     a, r6
        mov     r2, a
        mov     a, r3
        addc    a, r7
        sjmp    store3
o_sub:  clr     c
        mov     a, r2
        subb    a, r6
        mov     r2, a
        mov     a, r3
        subb    a, r7
        sjmp    store3
o_and:  mov     a, r2
        anl     a, r6
        mov     r2, a
        mov     a, r3
        anl     a, r7
        sjmp    store3
o_or:   mov     a, r2
        orl     a, r6
        mov     r2, a
        mov     a, r3
        orl     a, r7
        sjmp    store3
o_xor:  mov     a, r2
        xrl     a, r6
        mov     r2, a
        mov     a, r3
        xrl     a, r7
store3: mov     r3, a
store:  mov     r1, vsp                 ; top = R3:R2
        dec     r1
        mov     a, r3
        movx    @r1, a
        dec     r1
        mov     a, r2
        movx    @r1, a
        ret
o_shl:  mov     a, r7
        jnz     zero
        mov     a, r6
        jz      store
        mov     r4, a
00001$: mov     a, r2
        add     a, r2
        mov     r2, a
        mov     a, r3
        rlc     a
        mov     r3, a
        djnz    r4, 00001$
        sjmp    store
o_shr:  mov     a, r7
        jnz     zero
        mov     a, r6
        jz      store
        mov     r4, a
00002$: clr     c
        mov     a, r3
        rrc     a
        mov     r3, a
        mov     a, r2
        rrc     a
        mov     r2, a
        djnz    r4, 00002$
        sjmp    store
zero:   mov     r2, #0
        mov     r3, #0
        sjmp    store
o_mul:  mov     a, r2                   ; (r3:r2 * r7:r6) mod 65536
        mov     b, r7
        mul     ab
        mov     r4, a
        mov     a, r3
        mov     b, r6
        mul     ab
        add     a, r4
        mov     r4, a
        mov     a, r2
        mov     b, r6
        mul     ab
        mov     r2, a
        mov     a, b
        add     a, r4
        sjmp    store3
o_div:  lcall   div16
        sjmp    store
o_mod:  lcall   div16
        mov     a, r4
        mov     r2, a
        mov     a, r5
        sjmp    store3
; R3:R2 / R7:R6 -> quotient R3:R2, remainder R5:R4
div16:  mov     a, r6
        orl     a, r7
        jnz     00001$
        mov     a, undef
        jnz     00004$
        mov     dptr, #m_div0
        lcall   err
00004$: mov     r2, #0
        mov     r3, #0
        mov     r4, #0
        mov     r5, #0
        ret
00001$: mov     r4, #0
        mov     r5, #0
        mov     b, #16
00002$: mov     a, r2                   ; shift dividend into remainder
        add     a, r2
        mov     r2, a
        mov     a, r3
        rlc     a
        mov     r3, a
        mov     a, r4
        rlc     a
        mov     r4, a
        mov     a, r5
        rlc     a
        mov     r5, a
        clr     c
        mov     a, r4
        subb    a, r6
        mov     dpl, a
        mov     a, r5
        subb    a, r7
        jc      00003$
        mov     r5, a
        mov     r4, dpl
        inc     r2                      ; quotient bit
00003$: djnz    b, 00002$
        ret
o_dot:  mov     a, undef                ; byte.bit -> bit address
        jnz     zero
        mov     a, r7
        jnz     00002$
        mov     a, r6
        clr     c
        subb    a, #8
        jnc     00002$
        mov     a, r3
        jnz     00003$
        mov     a, r2
        add     a, #-0x20
        clr     c
        subb    a, #0x10
        jnc     00001$
        mov     a, r2                   ; 20h-2Fh: (byte-20h)*8 + bit
        add     a, #-0x20
        rl      a
        rl      a
        rl      a
        orl     a, r6
        mov     r2, a
        ljmp    store
00001$: mov     a, r2                   ; SFR at a multiple of 8
        jnb     acc.7, 00003$
        anl     a, #7
        jnz     00003$
        mov     a, r2
        orl     a, r6
        mov     r2, a
        ljmp    store
00002$: mov     dptr, #m_bitnum
        sjmp    00004$
00003$: mov     dptr, #m_bitaddr
00004$: lcall   err
        ljmp    zero

e_expr: mov     dptr, #m_expr
        ljmp    err

; ---- the parser ----
expr:   mov     vsp, #VSTK
        mov     osp, #OSTK
        setb    F_WANT
x_loop: lcall   skipws
        jb      F_WANT, 00001$
        ljmp    x_oper
00001$: cjne    a, #0x28, 00002$        ; '('
        inc     r0
        mov     a, #O_LP
        lcall   opush
        sjmp    x_loop
00002$: cjne    a, #0x2D, 00003$        ; '-'
        inc     r0
        mov     a, #O_NEG
        sjmp    x_unary
00003$: cjne    a, #0x7E, 00004$        ; '~'
        sjmp    00005$
00004$: cjne    a, #0x21, x_l6          ; '!'
00005$: inc     r0
        mov     a, #O_NOT
x_unary:
        lcall   push_op
        sjmp    x_loop
x_l6:   cjne    a, #0x2B, 00007$        ; '+'
        inc     r0
        sjmp    x_loop
00007$: cjne    a, #0x27, 00008$        ; quote
        sjmp    00009$
00008$: cjne    a, #0x22, 00011$
00009$: mov     r4, a                   ; character constant 'c'
        mov     a, r0
        add     a, #2
        mov     r1, a
        movx    a, @r1
        xrl     a, r4
        jz      00010$
        mov     dptr, #m_char
        lcall   err
        ljmp    x_fail
00010$: dec     r1
        movx    a, @r1
        mov     r2, a
        mov     r3, #0
        inc     r0
        inc     r0
        inc     r0
        sjmp    x_value
00011$: cjne    a, #0x24, 00013$        ; '$'
        inc     r0
        movx    a, @r0
        dec     r0
        lcall   hexval
        jc      00014$
        inc     r0                      ; $ = location counter
        mov     r2, lsl
        mov     r3, lsh
        sjmp    x_value
00013$: lcall   isdig
        jnc     00015$
00014$: lcall   get_number
        sjmp    x_value
00015$: lcall   get_ident
        jc      00016$
        ljmp    x_syntax
00016$: mov     dptr, #kw_unary
        lcall   lookup
        jnc     00017$
        add     a, #O_NOT               ; NOT HIGH LOW
        sjmp    x_unary
00017$: lcall   symval
        jc      x_value
        mov     undef, #1
        mov     a, pass
        cjne    a, #2, 00018$
        mov     dptr, #m_undef
        lcall   err
00018$: mov     r2, #0
        mov     r3, #0
x_value:
        lcall   vpush
        clr     F_WANT
        ljmp    x_loop

x_oper: cjne    a, #0x29, 00020$        ; ')'
        inc     r0
00021$: mov     a, osp
        cjne    a, #OSTK, 00022$
        mov     dptr, #m_rparen
        lcall   err
        ljmp    x_fail
00022$: dec     a
        mov     osp, a
        mov     r1, a
        movx    a, @r1
        cjne    a, #O_LP, 00023$
        ljmp    x_loop
00023$: lcall   apply
        sjmp    00021$
00020$: mov     r4, a
        inc     r0
        movx    a, @r0
        xch     a, r4                   ; A = char, R4 = next char
        cjne    a, #0x3C, 00024$        ; '<<'
        cjne    r4, #0x3C, x_word
        mov     a, #O_SHL
        sjmp    00026$
00024$: cjne    a, #0x3E, 00025$        ; '>>'
        cjne    r4, #0x3E, x_word
        mov     a, #O_SHR
00026$: inc     r0
        sjmp    x_binary
00025$: mov     dptr, #opchars          ; single character operators
        mov     r5, a
        mov     r4, #0
00027$: mov     a, r4
        movc    a, @a+dptr
        jz      x_word
        xrl     a, r5
        jz      00028$
        inc     r4
        sjmp    00027$
00028$: mov     a, r4
        mov     dptr, #opcodes
        movc    a, @a+dptr
x_binary:
        lcall   push_op
        setb    F_WANT
        ljmp    x_loop
x_word: dec     r0                      ; not a symbol operator: word?
        movx    a, @r0
        lcall   isid0
        jnc     x_end
        mov     a, r0
        push    acc
        lcall   get_ident
        mov     dptr, #kw_binop
        lcall   lookup
        jnc     00031$
        mov     dptr, #binopc
        movc    a, @a+dptr
        dec     sp
        sjmp    x_binary
00031$: pop     acc
        mov     r0, a
x_end:  jb      F_WANT, x_syntax
00040$: mov     a, osp
        cjne    a, #OSTK, 00041$
        mov     a, vsp
        cjne    a, #VSTK + 2, 00043$
        mov     r1, #VSTK
        movx    a, @r1
        mov     r2, a
        inc     r1
        movx    a, @r1
        mov     r3, a
        ret
00041$: dec     a
        mov     osp, a
        mov     r1, a
        movx    a, @r1
        cjne    a, #O_LP, 00042$
        mov     dptr, #m_lparen
        lcall   err
        sjmp    x_fail
00042$: lcall   apply
        sjmp    00040$
00043$: lcall   e_expr
        sjmp    x_fail
x_syntax:
        mov     dptr, #m_expr
        lcall   err
x_fail: mov     r2, #0
        mov     r3, #0
        ret

;==========================================================================
; line parser
;==========================================================================
do_line:
        lcall   skipws
        jnz     00001$
        ret
00001$: cjne    a, #0x2E, 00002$        ; '.'
        inc     r0
        setb    F_DOT
00002$: lcall   get_ident
        jc      00003$
        ljmp    e_syntax
00003$: lcall   skipws
        jb      F_DOT, word
        cjne    a, #0x3A, 00010$        ; ':' -> label
        inc     r0
        lcall   id2lab
        setb    F_LAB
        lcall   skipws
        jnz     00004$
        ljmp    deflabel
00004$: cjne    a, #0x2E, 00005$
        inc     r0
        setb    F_DOT
00005$: lcall   get_ident
        jc      word
        ljmp    e_syntax
00010$: lcall   id2lab                  ; NAME = expr / NAME EQU expr ?
        movx    a, @r0
        cjne    a, #0x3D, 00011$        ; '='
        inc     r0
        mov     r6, #0
        sjmp    00013$
00011$: mov     a, r0
        push    acc
        lcall   get_ident
        jnc     00012$
        mov     dptr, #kw_equ
        lcall   lookup
        jnc     00012$
        dec     sp
        mov     r6, #0
        jnz     00013$                  ; index 0 is SET
        mov     r6, #SF_SET
00013$: push    6
        lcall   expr
        pop     6
        mov     a, undef                ; unknown in pass 1: define in pass 2
        jz      00014$
        mov     a, pass
        cjne    a, #2, 00015$
00014$: mov     nameoff, #LABEL
        ljmp    sdefine
00015$: ret
00012$: pop     acc                     ; first word is the mnemonic
        mov     r0, a
        lcall   lab2id
; IDENT = directive or mnemonic, R0 after it
word:   jnb     F_LAB, 00020$
        mov     dptr, #kw_dir           ; label on ORG gets the new address
        lcall   lookup
        jnc     00019$
        jz      00020$
00019$: push    0
        lcall   deflabel
        pop     0
00020$: mov     dptr, #kw_dir
        lcall   lookup
        jnc     00030$
        mov     b, #3
        mul     ab
        mov     dptr, #00021$
        jmp     @a+dptr
00021$: ljmp    d_org
        ljmp    d_db
        ljmp    d_db
        ljmp    d_db
        ljmp    d_db
        ljmp    d_dw
        ljmp    d_dw
        ljmp    d_dw
        ljmp    d_ds
        ljmp    d_ds
        ljmp    d_ds
        ljmp    d_ds
        ljmp    d_end
        ljmp    d_include
        ljmp    d_ignore
        ljmp    d_ignore
        ljmp    d_ignore
        ljmp    d_ignore
        ljmp    d_ignore
        ljmp    d_ignore
        ljmp    d_ignore
00030$: jb      F_DOT, 00031$
        mov     dptr, #mnames
        lcall   lookup
        jnc     00032$
        ljmp    instruction
00031$: mov     dptr, #m_unkdir
        ljmp    err
00032$: mov     dptr, #kw_equ
        lcall   lookup
        mov     dptr, #m_noname
        jc      00033$
        mov     dptr, #m_unknown
00033$: ljmp    err

d_ignore:
        ret

d_end:  mov     r1, #S_DONE
        mov     a, #1
        movx    @r1, a
        ret

d_org:  lcall   expr
        mov     a, undef
        jz      00001$
        mov     dptr, #m_known
        ljmp    err1
00001$: mov     pcl, r2
        mov     pch, r3
        mov     lsl, r2
        mov     lsh, r3
        jnb     F_LAB, 00002$
        ljmp    deflabel
00002$: ret

d_ds:   lcall   expr
        mov     a, undef
        jz      00001$
        mov     dptr, #m_known
        ljmp    err1
00001$: mov     a, pcl
        add     a, r2
        mov     pcl, a
        mov     a, pch
        addc    a, r3
        mov     pch, a
        ret

d_include:
        lcall   skipws
        mov     r1, #INCNAME
        mov     r2, #12
        mov     r4, #0x20               ; terminator: blank
        cjne    a, #0x22, 00001$
        sjmp    00002$
00001$: cjne    a, #0x27, 00003$
00002$: mov     r4, a                   ; quoted name
        inc     r0
00003$: movx    a, @r0
        jz      00005$
        xrl     a, r4
        jz      00005$
        xrl     a, r4
        cjne    r4, #0x20, 00004$       ; unquoted: lower case
        lcall   isid0
        jnc     00004$
        cjne    a, #0x5F, 00006$
        sjmp    00004$
00006$: orl     a, #0x20
00004$: movx    @r1, a
        inc     r1
        inc     r0
        djnz    r2, 00003$
00005$: clr     a
        movx    @r1, a
        mov     r1, #S_INC
        inc     a
        movx    @r1, a
        ret

d_dw:   setb    F_WORD
d_db:   lcall   skipws
        jnz     00001$
        mov     dptr, #m_operand
        ljmp    err
00001$: cjne    a, #0x27, 00002$
        sjmp    00003$
00002$: cjne    a, #0x22, d_dbexpr
00003$: jb      F_WORD, d_dbexpr
        mov     r4, a                   ; possible string: find closing quote
        mov     a, r0
        mov     r1, a
00004$: inc     r1
        movx    a, @r1
        jz      d_dbexpr
        xrl     a, r4
        jnz     00004$
        mov     a, r1                   ; R5 = closing quote
        mov     r5, a
00005$: inc     r1                      ; must be followed by , or end
        movx    a, @r1
        cjne    a, #0x20, 00006$
        sjmp    00005$
00006$: jz      00007$
        cjne    a, #0x2C, d_dbexpr
00007$: inc     r0                      ; emit the string
00008$: mov     a, r0
        xrl     a, r5
        jz      00012$
        movx    a, @r0
        inc     r0
        cjne    r4, #0x22, 00011$       ; "..." understands \n \r \t \0 \e \\ \"
        cjne    a, #0x5C, 00011$
        mov     a, r0
        xrl     a, r5
        jz      00011$
        movx    a, @r0
        inc     r0
        mov     dptr, #escin
        mov     r6, a
        mov     r7, #0
00009$: mov     a, r7
        movc    a, @a+dptr
        jz      00010$
        xrl     a, r6
        jz      00013$
        inc     r7
        sjmp    00009$
00013$: mov     a, r7
        mov     dptr, #escout
        movc    a, @a+dptr
        sjmp    00011$
00010$: mov     a, r6
00011$: lcall   emit
        sjmp    00008$
00012$: inc     r0                      ; skip closing quote
        sjmp    d_dbnext
d_dbexpr:
        lcall   expr
        jnb     F_WORD, 00020$
        mov     a, r3
        lcall   emit
        sjmp    00021$
00020$: lcall   chkbyte
00021$: mov     a, r2
        lcall   emit
d_dbnext:
        lcall   skipws
        jz      00030$
        cjne    a, #0x2C, 00031$
        inc     r0
        ljmp    d_db
00030$: ret
00031$: ljmp    e_syntax

; pass 2: error if R3:R2 does not fit in a byte (-128..255)
chkbyte:
        mov     a, pass
        cjne    a, #2, 00002$
        mov     a, r3
        jz      00002$
        inc     a
        jnz     00001$
        mov     a, r2
        jb      acc.7, 00002$
00001$: push    dpl                     ; keep the table pointer
        push    dph
        mov     dptr, #m_range
        lcall   err
        pop     dph
        pop     dpl
00002$: ret

;==========================================================================
; instructions
;==========================================================================
instruction:
        mov     mnem, a
        mov     nops, #0
        lcall   skipws
        jz      i_match
00001$: lcall   classify
        lcall   skipws
        jz      i_match
        cjne    a, #0x2C, 00002$
        inc     r0
        mov     a, nops
        cjne    a, #3, 00001$
        mov     dptr, #m_toomany
        ljmp    err
00002$: ljmp    e_syntax

i_match:
        mov     dptr, #itab
00001$: clr     a
        movc    a, @a+dptr
        cjne    a, #0xFF, 00002$
        mov     dptr, #m_operands
        ljmp    err
00002$: cjne    a, mnem, 00006$
        mov     r1, #ocls
        mov     r5, #1
00003$: mov     a, r5
        movc    a, @a+dptr
        mov     r4, a                   ; kind from the table
        mov     a, r5
        dec     a
        clr     c
        subb    a, nops
        jc      00004$
        mov     a, r4                   ; no operand: kind must be none
        jnz     00006$
        sjmp    00005$
00004$: mov     a, @r1                  ; operand class
        lcall   kindok
        jnc     00006$
00005$: inc     r1
        inc     r5
        cjne    r5, #4, 00003$
        sjmp    i_found
00006$: mov     a, #5
        lcall   dpadd
        sjmp    00001$

; carry = operand class A fits kind R4
kindok: xrl     a, r4
        jz      00002$
        xrl     a, r4
        cjne    a, #K_IMM, 00001$
        cjne    r4, #K_IMM16, 00003$
        sjmp    00002$
00001$: cjne    a, #C_EXPR, 00003$
        mov     a, r4
        cjne    a, #K_DIR, 00004$
00004$: jc      00003$
        cjne    a, #K_NBIT, 00002$
00003$: clr     c
        ret
00002$: setb    c
        ret

i_found:
        ; size = 1 + operand bytes
        mov     isize, #1
        mov     r5, #0
00001$: mov     a, r5
        cjne    a, nops, 00002$
        sjmp    00003$
00002$: inc     a
        movc    a, @a+dptr
        push    dpl
        push    dph
        mov     dptr, #opsz
        movc    a, @a+dptr
        pop     dph
        pop     dpl
        add     a, isize
        mov     isize, a
        inc     r5
        sjmp    00001$
00003$: mov     a, #4                   ; opcode, add register numbers
        movc    a, @a+dptr
        mov     r7, a
        mov     r5, #0
00004$: mov     a, r5
        cjne    a, nops, 00005$
        sjmp    00010$
00005$: lcall   kindof
        cjne    a, #K_RN, 00006$
        sjmp    00007$
00006$: cjne    a, #K_ATRI, 00008$
00007$: mov     a, #oreg
        add     a, r5
        mov     r1, a
        mov     a, @r1
        add     a, r7
        mov     r7, a
        sjmp    00009$
00008$: cjne    a, #K_A11, 00009$
        mov     a, #ovh                 ; ACALL/AJMP page bits
        add     a, r5
        mov     r1, a
        mov     a, @r1
        swap    a
        rl      a
        anl     a, #0xE0
        orl     a, r7
        mov     r7, a
        lcall   chkpage
00009$: inc     r5
        sjmp    00004$
00010$: mov     a, r7
        lcall   emit
        mov     a, #4
        movc    a, @a+dptr
        cjne    a, #0x85, 00011$
        mov     r5, #1                  ; MOV dir,dir: source first
        lcall   oper
        mov     r5, #0
        ljmp    oper
00011$: mov     r5, #0
00012$: mov     a, r5
        cjne    a, nops, 00013$
        ret
00013$: lcall   oper
        inc     r5
        sjmp    00012$

; A = table kind of operand R5 (DPTR = table entry)
kindof: mov     a, r5
        inc     a
        movc    a, @a+dptr
        ret

; R3:R2 = value of operand R5
opval:  mov     a, #ovl
        add     a, r5
        mov     r1, a
        mov     a, @r1
        mov     r2, a
        mov     a, #ovh
        add     a, r5
        mov     r1, a
        mov     a, @r1
        mov     r3, a
        ret

; emit the bytes of operand R5
oper:   lcall   opval
        lcall   kindof
        cjne    a, #K_IMM, 00001$
        lcall   chkbyte
        sjmp    lo
00001$: cjne    a, #K_IMM16, 00002$
        sjmp    hilo
00002$: cjne    a, #K_A16, op_a11
hilo:   mov     a, r3
        lcall   emit
lo:     mov     a, r2
        ljmp    emit
op_a11: cjne    a, #K_A11, 00004$
        sjmp    lo
00004$: cjne    a, #K_REL, 00005$
        mov     a, lsl                  ; rel = target - (line start + size)
        add     a, isize
        mov     r6, a
        clr     a
        addc    a, lsh
        mov     r7, a
        clr     c
        mov     a, r2
        subb    a, r6
        mov     r2, a
        mov     a, r3
        subb    a, r7
        mov     r3, a
        mov     a, pass
        cjne    a, #2, lo
        mov     a, r2                   ; -128..127: high byte = sign of low
        rlc     a
        clr     a
        subb    a, #0                   ; A = 0 or FFh from the sign bit
        xrl     a, r3
        jz      lo
        push    dpl                     ; keep the table pointer
        push    dph
        mov     dptr, #m_rel
        lcall   err
        pop     dph
        pop     dpl
        sjmp    lo
00005$: cjne    a, #K_DIR, 00006$
        sjmp    00007$
00006$: cjne    a, #K_BIT, 00008$
        sjmp    00007$
00008$: cjne    a, #K_NBIT, 00009$
00007$: mov     a, pass                 ; 8 bit address
        cjne    a, #2, lo
        mov     a, r3
        jz      lo
        push    dpl                     ; keep the table pointer
        push    dph
        mov     dptr, #m_addr
        lcall   err
        pop     dph
        pop     dpl
        sjmp    lo
00009$: ret

; ACALL/AJMP: target must be in the 2K block of the next instruction
chkpage:
        mov     a, pass
        cjne    a, #2, 00001$
        mov     a, lsl
        add     a, #2
        clr     a
        addc    a, lsh
        xrl     a, @r1
        anl     a, #0xF8
        jz      00001$
        push    dpl                     ; keep the table pointer
        push    dph
        mov     dptr, #m_page
        lcall   err
        pop     dph
        pop     dpl
00001$: ret

; classify operand number nops at R0, store class/reg/value, nops++
classify:
        mov     a, #ocls
        add     a, nops
        mov     r1, a
        push    1
        lcall   skipws
        mov     r7, #K_IMM
        cjne    a, #0x23, 00001$        ; '#'
        sjmp    00002$
00001$: mov     r7, #K_NBIT
        cjne    a, #0x2F, 00003$        ; '/'
00002$: inc     r0
        sjmp    c_expr2
00003$: cjne    a, #0x40, cl_reg        ; '@'
        inc     r0
        lcall   get_ident
        jnc     c_bad
        mov     dptr, #kw_at
        lcall   lookup
        jnc     c_bad
        mov     r6, a                   ; 0 R0  1 R1  2 DPTR  3 A
        mov     r7, #K_ATRI
        clr     c
        subb    a, #2
        jc      c_reg
        mov     r6, #0
        mov     r7, #K_ATDPTR
        jz      c_reg
        movx    a, @r0                  ; @A+DPTR / @A+PC
        cjne    a, #0x2B, c_bad
        inc     r0
        lcall   get_ident
        jnc     c_bad
        mov     r7, #K_ATADPTR
        mov     dptr, #kw_dptr
        lcall   kwcmp
        jc      c_reg
        mov     r7, #K_ATAPC
        mov     dptr, #kw_pc
        lcall   kwcmp
        jc      c_reg
c_bad:  pop     1
        mov     dptr, #m_badop
        lcall   err
        mov     a, #0xFE                ; matches nothing
        sjmp    c_store
cl_reg: mov     a, r0                   ; register name?
        mov     r5, a
        lcall   get_ident
        jnc     00012$
        lcall   skipws
        jz      00011$
        cjne    a, #0x2C, 00012$
00011$: mov     dptr, #kw_reg           ; A AB C DPTR R0..R7
        lcall   lookup
        jnc     00012$
        mov     r7, a
        inc     r7                      ; K_A..K_DPTR = 1..4
        mov     r6, #0
        clr     c
        subb    a, #4
        jc      c_reg
        mov     r6, a
        mov     r7, #K_RN
        sjmp    c_reg
00012$: mov     a, r5                   ; expression
        mov     r0, a
        mov     r7, #C_EXPR
c_expr2:
        push    7
        mov     undef, #0
        lcall   expr
        pop     7
        mov     r6, #0
        sjmp    c_val
c_reg:  mov     r2, #0
        mov     r3, #0
c_val:  pop     1
        mov     a, #oreg - ocls         ; register number
        add     a, r1
        xch     a, r1
        push    acc
        mov     a, r6
        mov     @r1, a
        mov     a, r1
        add     a, #ovl - oreg
        mov     r1, a
        mov     a, r2
        mov     @r1, a
        mov     a, r1
        add     a, #ovh - ovl
        mov     r1, a
        mov     a, r3
        mov     @r1, a
        pop     1
        mov     a, r7
c_store:
        mov     @r1, a
        inc     nops
        ret

; IDENT == ROM string at DPTR ?  carry = equal
kwcmp:  mov     r1, #IDENT
00001$: clr     a
        movc    a, @a+dptr
        mov     r3, a
        movx    a, @r1
        xrl     a, r3
        jnz     00002$
        mov     a, r3
        jz      00003$
        inc     dptr
        inc     r1
        sjmp    00001$
00002$: clr     c
        ret
00003$: setb    c
        ret

;==========================================================================
; tables
;==========================================================================
        .area   CONST   (CODE)

; precedence by operator number
prec:   .db     0, 0, 9, 9, 9, 9, 10, 8, 8, 8, 7, 7, 6, 6, 5, 4, 3
opchars: .ascii "*/%+-&^|."
        .db     0
opcodes: .db    O_MUL, O_DIV, O_MOD, O_ADD, O_SUB, O_AND, O_XOR, O_OR, O_DOT
escin:  .ascii  "nrt0e"
        .db     0
escout: .db     10, 13, 9, 0, 27
; operand byte size by kind
opsz:   .db     0,0,0,0,0,0,0,0,0,0, 1,2,1,1,1,1,1,2

kw_unary: .ascii "NOT"
        .db     0
        .ascii  "HIGH"
        .db     0
        .ascii  "LOW"
        .db     0, 0
kw_binop: .ascii "AND"
        .db     0
        .ascii  "OR"
        .db     0
        .ascii  "XOR"
        .db     0
        .ascii  "MOD"
        .db     0
        .ascii  "SHL"
        .db     0
        .ascii  "SHR"
        .db     0, 0
binopc: .db     O_AND, O_OR, O_XOR, O_MOD, O_SHL, O_SHR
kw_equ: .ascii  "SET"
        .db     0
        .ascii  "EQU"
        .db     0
        .ascii  "DATA"
        .db     0
        .ascii  "IDATA"
        .db     0
        .ascii  "XDATA"
        .db     0
        .ascii  "CODE"
        .db     0
        .ascii  "BIT"
        .db     0
        .ascii  "REG"
        .db     0, 0
kw_dir: .ascii  "ORG"
        .db     0
        .ascii  "DB"
        .db     0
        .ascii  "DEFB"
        .db     0
        .ascii  "BYTE"
        .db     0
        .ascii  "DM"
        .db     0
        .ascii  "DW"
        .db     0
        .ascii  "DEFW"
        .db     0
        .ascii  "WORD"
        .db     0
        .ascii  "DS"
        .db     0
        .ascii  "DEFS"
        .db     0
        .ascii  "RMB"
        .db     0
        .ascii  "BLKB"
        .db     0
        .ascii  "END"
        .db     0
        .ascii  "INCLUDE"
        .db     0
        .ascii  "MODULE"
        .db     0
        .ascii  "TITLE"
        .db     0
        .ascii  "LIST"
        .db     0
        .ascii  "NOLIST"
        .db     0
        .ascii  "USING"
        .db     0
        .ascii  "CSEG"
        .db     0
        .ascii  "AREA"
        .db     0, 0
kw_reg: .ascii  "A"
        .db     0
        .ascii  "AB"
        .db     0
        .ascii  "C"
        .db     0
        .ascii  "DPTR"
        .db     0
        .ascii  "R0"
        .db     0
        .ascii  "R1"
        .db     0
        .ascii  "R2"
        .db     0
        .ascii  "R3"
        .db     0
        .ascii  "R4"
        .db     0
        .ascii  "R5"
        .db     0
        .ascii  "R6"
        .db     0
        .ascii  "R7"
        .db     0, 0
kw_at:  .ascii  "R0"
        .db     0
        .ascii  "R1"
        .db     0
kw_dptr: .ascii "DPTR"
        .db     0
        .ascii  "A"
        .db     0, 0
kw_pc:  .ascii  "PC"
        .db     0

mnames: .ascii  "ACALL"
        .db     0
        .ascii  "ADD"
        .db     0
        .ascii  "ADDC"
        .db     0
        .ascii  "AJMP"
        .db     0
        .ascii  "ANL"
        .db     0
        .ascii  "CJNE"
        .db     0
        .ascii  "CLR"
        .db     0
        .ascii  "CPL"
        .db     0
        .ascii  "DA"
        .db     0
        .ascii  "DEC"
        .db     0
        .ascii  "DIV"
        .db     0
        .ascii  "DJNZ"
        .db     0
        .ascii  "INC"
        .db     0
        .ascii  "JB"
        .db     0
        .ascii  "JBC"
        .db     0
        .ascii  "JC"
        .db     0
        .ascii  "JMP"
        .db     0
        .ascii  "JNB"
        .db     0
        .ascii  "JNC"
        .db     0
        .ascii  "JNZ"
        .db     0
        .ascii  "JZ"
        .db     0
        .ascii  "LCALL"
        .db     0
        .ascii  "LJMP"
        .db     0
        .ascii  "MOV"
        .db     0
        .ascii  "MOVC"
        .db     0
        .ascii  "MOVX"
        .db     0
        .ascii  "MUL"
        .db     0
        .ascii  "NOP"
        .db     0
        .ascii  "ORL"
        .db     0
        .ascii  "POP"
        .db     0
        .ascii  "PUSH"
        .db     0
        .ascii  "RET"
        .db     0
        .ascii  "RETI"
        .db     0
        .ascii  "RL"
        .db     0
        .ascii  "RLC"
        .db     0
        .ascii  "RR"
        .db     0
        .ascii  "RRC"
        .db     0
        .ascii  "SETB"
        .db     0
        .ascii  "SJMP"
        .db     0
        .ascii  "SUBB"
        .db     0
        .ascii  "SWAP"
        .db     0
        .ascii  "XCH"
        .db     0
        .ascii  "XCHD"
        .db     0
        .ascii  "XRL"
        .db     0
        .ascii  "CALL"
        .db     0, 0

        M_ACALL = 0
        M_ADD   = 1
        M_ADDC  = 2
        M_AJMP  = 3
        M_ANL   = 4
        M_CJNE  = 5
        M_CLR   = 6
        M_CPL   = 7
        M_DA    = 8
        M_DEC   = 9
        M_DIV   = 10
        M_DJNZ  = 11
        M_INC   = 12
        M_JB    = 13
        M_JBC   = 14
        M_JC    = 15
        M_JMP   = 16
        M_JNB   = 17
        M_JNC   = 18
        M_JNZ   = 19
        M_JZ    = 20
        M_LCALL = 21
        M_LJMP  = 22
        M_MOV   = 23
        M_MOVC  = 24
        M_MOVX  = 25
        M_MUL   = 26
        M_NOP   = 27
        M_ORL   = 28
        M_POP   = 29
        M_PUSH  = 30
        M_RET   = 31
        M_RETI  = 32
        M_RL    = 33
        M_RLC   = 34
        M_RR    = 35
        M_RRC   = 36
        M_SETB  = 37
        M_SJMP  = 38
        M_SUBB  = 39
        M_SWAP  = 40
        M_XCH   = 41
        M_XCHD  = 42
        M_XRL   = 43
        M_CALL  = 44

        .macro  ARITH m, b
        .db     m, K_A, K_RN, 0, b+8
        .db     m, K_A, K_DIR, 0, b+5
        .db     m, K_A, K_ATRI, 0, b+6
        .db     m, K_A, K_IMM, 0, b+4
        .endm
        .macro  LOGIC m, b
        ARITH   m, b
        .db     m, K_DIR, K_A, 0, b+2
        .db     m, K_DIR, K_IMM, 0, b+3
        .endm

; mnemonic, operand kinds, opcode
itab:   .db     M_ACALL, K_A11, 0, 0, 0x11
        ARITH   M_ADD, 0x20
        ARITH   M_ADDC, 0x30
        .db     M_AJMP, K_A11, 0, 0, 0x01
        LOGIC   M_ANL, 0x50
        .db     M_ANL, K_C, K_BIT, 0, 0x82
        .db     M_ANL, K_C, K_NBIT, 0, 0xB0
        .db     M_CJNE, K_A, K_DIR, K_REL, 0xB5
        .db     M_CJNE, K_A, K_IMM, K_REL, 0xB4
        .db     M_CJNE, K_RN, K_IMM, K_REL, 0xB8
        .db     M_CJNE, K_ATRI, K_IMM, K_REL, 0xB6
        .db     M_CLR, K_A, 0, 0, 0xE4
        .db     M_CLR, K_C, 0, 0, 0xC3
        .db     M_CLR, K_BIT, 0, 0, 0xC2
        .db     M_CPL, K_A, 0, 0, 0xF4
        .db     M_CPL, K_C, 0, 0, 0xB3
        .db     M_CPL, K_BIT, 0, 0, 0xB2
        .db     M_DA, K_A, 0, 0, 0xD4
        .db     M_DEC, K_A, 0, 0, 0x14
        .db     M_DEC, K_RN, 0, 0, 0x18
        .db     M_DEC, K_DIR, 0, 0, 0x15
        .db     M_DEC, K_ATRI, 0, 0, 0x16
        .db     M_DIV, K_AB, 0, 0, 0x84
        .db     M_DJNZ, K_RN, K_REL, 0, 0xD8
        .db     M_DJNZ, K_DIR, K_REL, 0, 0xD5
        .db     M_INC, K_A, 0, 0, 0x04
        .db     M_INC, K_RN, 0, 0, 0x08
        .db     M_INC, K_DIR, 0, 0, 0x05
        .db     M_INC, K_ATRI, 0, 0, 0x06
        .db     M_INC, K_DPTR, 0, 0, 0xA3
        .db     M_JB, K_BIT, K_REL, 0, 0x20
        .db     M_JBC, K_BIT, K_REL, 0, 0x10
        .db     M_JC, K_REL, 0, 0, 0x40
        .db     M_JMP, K_ATADPTR, 0, 0, 0x73
        .db     M_JMP, K_A16, 0, 0, 0x02
        .db     M_JNB, K_BIT, K_REL, 0, 0x30
        .db     M_JNC, K_REL, 0, 0, 0x50
        .db     M_JNZ, K_REL, 0, 0, 0x70
        .db     M_JZ, K_REL, 0, 0, 0x60
        .db     M_LCALL, K_A16, 0, 0, 0x12
        .db     M_LJMP, K_A16, 0, 0, 0x02
        .db     M_MOV, K_A, K_RN, 0, 0xE8
        .db     M_MOV, K_A, K_DIR, 0, 0xE5
        .db     M_MOV, K_A, K_ATRI, 0, 0xE6
        .db     M_MOV, K_A, K_IMM, 0, 0x74
        .db     M_MOV, K_RN, K_A, 0, 0xF8
        .db     M_MOV, K_RN, K_DIR, 0, 0xA8
        .db     M_MOV, K_RN, K_IMM, 0, 0x78
        .db     M_MOV, K_DIR, K_A, 0, 0xF5
        .db     M_MOV, K_DIR, K_RN, 0, 0x88
        .db     M_MOV, K_DIR, K_DIR, 0, 0x85
        .db     M_MOV, K_DIR, K_ATRI, 0, 0x86
        .db     M_MOV, K_DIR, K_IMM, 0, 0x75
        .db     M_MOV, K_ATRI, K_A, 0, 0xF6
        .db     M_MOV, K_ATRI, K_DIR, 0, 0xA6
        .db     M_MOV, K_ATRI, K_IMM, 0, 0x76
        .db     M_MOV, K_C, K_BIT, 0, 0xA2
        .db     M_MOV, K_BIT, K_C, 0, 0x92
        .db     M_MOV, K_DPTR, K_IMM16, 0, 0x90
        .db     M_MOVC, K_A, K_ATADPTR, 0, 0x93
        .db     M_MOVC, K_A, K_ATAPC, 0, 0x83
        .db     M_MOVX, K_A, K_ATRI, 0, 0xE2
        .db     M_MOVX, K_A, K_ATDPTR, 0, 0xE0
        .db     M_MOVX, K_ATRI, K_A, 0, 0xF2
        .db     M_MOVX, K_ATDPTR, K_A, 0, 0xF0
        .db     M_MUL, K_AB, 0, 0, 0xA4
        .db     M_NOP, 0, 0, 0, 0x00
        LOGIC   M_ORL, 0x40
        .db     M_ORL, K_C, K_BIT, 0, 0x72
        .db     M_ORL, K_C, K_NBIT, 0, 0xA0
        .db     M_POP, K_DIR, 0, 0, 0xD0
        .db     M_PUSH, K_DIR, 0, 0, 0xC0
        .db     M_RET, 0, 0, 0, 0x22
        .db     M_RETI, 0, 0, 0, 0x32
        .db     M_RL, K_A, 0, 0, 0x23
        .db     M_RLC, K_A, 0, 0, 0x33
        .db     M_RR, K_A, 0, 0, 0x03
        .db     M_RRC, K_A, 0, 0, 0x13
        .db     M_SETB, K_C, 0, 0, 0xD3
        .db     M_SETB, K_BIT, 0, 0, 0xD2
        .db     M_SJMP, K_REL, 0, 0, 0x80
        ARITH   M_SUBB, 0x90
        .db     M_SWAP, K_A, 0, 0, 0xC4
        .db     M_XCH, K_A, K_RN, 0, 0xC8
        .db     M_XCH, K_A, K_DIR, 0, 0xC5
        .db     M_XCH, K_A, K_ATRI, 0, 0xC6
        .db     M_XCHD, K_A, K_ATRI, 0, 0xD6
        LOGIC   M_XRL, 0x60
        .db     M_CALL, K_A16, 0, 0, 0x12
        .db     0xFF

; predefined symbols: name 0 value(lo,hi)
        .macro  SYM name, val
        .ascii  name
        .db     0, <val, >val
        .endm
builtins:
        SYM     "P0", 0x80
        SYM     "SP", 0x81
        SYM     "DPL", 0x82
        SYM     "DPH", 0x83
        SYM     "PCON", 0x87
        SYM     "TCON", 0x88
        SYM     "TMOD", 0x89
        SYM     "TL0", 0x8A
        SYM     "TL1", 0x8B
        SYM     "TH0", 0x8C
        SYM     "TH1", 0x8D
        SYM     "P1", 0x90
        SYM     "SCON", 0x98
        SYM     "SBUF", 0x99
        SYM     "P2", 0xA0
        SYM     "IE", 0xA8
        SYM     "P3", 0xB0
        SYM     "IP", 0xB8
        SYM     "PSW", 0xD0
        SYM     "ACC", 0xE0
        SYM     "B", 0xF0
        SYM     "IT0", 0x88
        SYM     "IE0", 0x89
        SYM     "IT1", 0x8A
        SYM     "IE1", 0x8B
        SYM     "TR0", 0x8C
        SYM     "TF0", 0x8D
        SYM     "TR1", 0x8E
        SYM     "TF1", 0x8F
        SYM     "RI", 0x98
        SYM     "TI", 0x99
        SYM     "RB8", 0x9A
        SYM     "TB8", 0x9B
        SYM     "REN", 0x9C
        SYM     "SM2", 0x9D
        SYM     "SM1", 0x9E
        SYM     "SM0", 0x9F
        SYM     "EX0", 0xA8
        SYM     "ET0", 0xA9
        SYM     "EX1", 0xAA
        SYM     "ET1", 0xAB
        SYM     "ES", 0xAC
        SYM     "EA", 0xAF
        SYM     "RXD", 0xB0
        SYM     "TXD", 0xB1
        SYM     "INT0", 0xB2
        SYM     "INT1", 0xB3
        SYM     "T0", 0xB4
        SYM     "T1", 0xB5
        SYM     "WR", 0xB6
        SYM     "RD", 0xB7
        SYM     "PX0", 0xB8
        SYM     "PT0", 0xB9
        SYM     "PX1", 0xBA
        SYM     "PT1", 0xBB
        SYM     "PS", 0xBC
        SYM     "P", 0xD0
        SYM     "OV", 0xD2
        SYM     "RS0", 0xD3
        SYM     "RS1", 0xD4
        SYM     "F0", 0xD5
        SYM     "AC", 0xD6
        SYM     "CY", 0xD7
        SYM     "EXIT", 0x7F00
        SYM     "PUTC", 0x7F03
        SYM     "GETC", 0x7F06
        SYM     "KBHIT", 0x7F09
        SYM     "PUTS", 0x7F0C
        SYM     "PUTHEX", 0x7F0F
        SYM     "PUTHEX16", 0x7F12
        SYM     "PUTDEC", 0x7F15
        SYM     "CRLF", 0x7F18
        SYM     "GETLINE", 0x7F1B
        SYM     "DELAY", 0x7F1E
        SYM     "ARGS", 0x7F21
        SYM     "FOPEN", 0x7F24
        SYM     "FGETC", 0x7F27
        SYM     "FPUTC", 0x7F2A
        SYM     "FCLOSE", 0x7F2D
        SYM     "PUTSI", 0x7F30
        SYM     "GETKEY", 0x7F33
        SYM     "PUTB", 0x7F36
        SYM     "SDINIT", 0x7F39
        SYM     "SDREAD", 0x7F3C
        SYM     "SDWRITE", 0x7F3F
        SYM     "TPA", 0x8000
        .db     0

m_syntax:   .asciz  "syntax error"
m_number:   .asciz  "bad digit in number"
m_phase:    .asciz  "phase error (label moved)"
m_symfull:  .asciz  "symbol table full (255)"
m_redef:    .asciz  "symbol redefined"
m_tpa:      .asciz  "code outside TPA (8000h-FFFFh)"
m_complex:  .asciz  "expression too complex"
m_expr:     .asciz  "bad expression"
m_div0:     .asciz  "division by zero"
m_bitnum:   .asciz  "bit number > 7"
m_bitaddr:  .asciz  "not bit addressable"
m_char:     .asciz  "bad character constant"
m_undef:    .asciz  "undefined symbol"
m_rparen:   .asciz  "unbalanced )"
m_lparen:   .asciz  "unbalanced ("
m_unkdir:   .asciz  "unknown directive"
m_noname:   .asciz  "definition needs a name"
m_unknown:  .asciz  "unknown instruction (labels need a ':')"
m_known:    .asciz  "value must be known in pass 1"
m_operand:  .asciz  "missing operand"
m_range:    .asciz  "byte value out of range"
m_toomany:  .asciz  "too many operands"
m_operands: .asciz  "invalid operand combination"
m_rel:      .asciz  "relative jump out of range"
m_addr:     .asciz  "address out of range (> 0FFh)"
m_page:     .asciz  "AJMP/ACALL target not in same 2K page"
m_badop:    .asciz  "bad operand"
