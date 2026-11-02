;--------------------------------------------------------------------------
; DOS/51 - shell commands and helpers hand written in assembler for size
; (behaviour identical to the C versions they replace): echo, grep, ls,
; the hex dump used by hexdump and mem, the examples installer and argv
; access.  SDCC --model-medium calling convention; pdata via MOVX @Ri
; (P2 = 1Dh while DOS runs).
;--------------------------------------------------------------------------
        .module shell51

        .globl  _cmd_echo, _cmd_grep, _cmd_ls, _cmd_wc, _cmd_paste, _dump, _dump_PARM_2
        .globl  _dump_PARM_3, _examples_install, argn, _s_cant, _s_nofile
        .globl  _argc, _argv, _err, _err_PARM_2, _ex_name
        .globl  _f_open, _f_open_PARM_2, _f_write, _f_write_PARM_2
        .globl  _f_write_PARM_3, _f_putc, _f_putc_PARM_2, _f_close
        .globl  _f_size, _f_data, _fs_dir, _fs_find, _fs_count, _fs_used
        .globl  _fs_free, _x_strlen, _put_dec, _put_dec_w, _put_dec_w_PARM_2
        .globl  _unlz, _unlz_dst, _unlz_len, _ex_lz, _ex_dir, _ex_total
        .globl  getch_a, _fs_err_full, getkey_a, cpyx, strcmp_dr
        .globl  _read_line, _tokenize, _line, _hist, _hist_n, _complete, _user_args
        .globl  puts_cd, puts_xd, putb_a, putc_a, crlf_r, hex8_a, hex16_dp

        _brk_flag = 0x34
        F0      = 0xD5
        ar2     = 2
        ar3     = 3
        ar4     = 4
        ar5     = 5
        ar6     = 6
        ar7     = 7

        .area   PSEG    (PAG,XDATA)
_dump_PARM_2:   .ds 2
_dump_PARM_3:   .ds 1
s_i:    .ds     1               ; scratch shared by the commands
s_j:    .ds     1
s_h:    .ds     1
s_ln:   .ds     2
s_ls:   .ds     2
s_end:  .ds     2
s_pat:  .ds     2
s_pl:   .ds     1

        .area   CONST   (CODE)
_s_cant: .asciz "cannot create"
_s_nofile: .asciz "no such file"
s_grepu: .asciz "usage: grep PATTERN FILE"
s_rw:   .asciz  "-rw-  "
s_files: .asciz " files, "
s_used: .asciz  " bytes used, "
s_free: .asciz  " free\n"
s_pasteu: .asciz "usage: paste FILE"
s_prompt: .asciz "dos51$ "
s_bs:   .db     8, 0x20, 8, 0
s_paste: .asciz "Paste/type text, end with ^D on an empty line\n"
s_ctlc: .asciz  "^C\n"
s_saved: .asciz " bytes saved\n"

        .area   CSEG    (CODE)

; argument A -> DPTR = argv[A]; C = 1 if A >= argc.  Uses R2.
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

; err(code string DPTR, xdata argument R3:R2 or 0)
err23:  mov     r0, #_err_PARM_2
        mov     a, r2
        movx    @r0, a
        inc     r0
        mov     a, r3
        movx    @r0, a
        ljmp    _err
err0:   mov     r2, #0
        mov     r3, #0
        sjmp    err23
; err("no such file", DPTR)
errnf:  mov     r2, dpl
        mov     r3, dph
        mov     dptr, #_s_nofile
        sjmp    err23

; open argv[A] (C = 1: missing) for reading -> A = handle, s_h; reports a
; missing file and returns to the command's caller
openr:  lcall   argn
        jc      00001$
        push    dpl
        push    dph
        mov     r0, #_f_open_PARM_2
        mov     a, #0x72
        movx    @r0, a
        lcall   _f_open
        mov     a, dpl
        pop     dph
        pop     dpl
        cjne    a, #0xFF, 00002$
        pop     acc                     ; drop our return address
        pop     acc
        sjmp    errnf
00002$: mov     r0, #s_h
        movx    @r0, a
        ret
00001$: pop     acc
        pop     acc
        mov     dptr, #0
        sjmp    errnf

; DPL = s_h (for the f_ calls)
dplh:   mov     r0, #s_h
        movx    a, @r0
        mov     dpl, a
        ret

;---------------------------------------------------------------- line input
; void read_line(void): edit line[] with history (Up/Down), Tab completion
; (complete() in shell.c), backspace, ^U and ^C.  R7 = length, R6 = the
; history position, R5 = the old length for redraw.
_read_line:
        lcall   prompt
        mov     r7, #0
        lcall   histn
        mov     r6, a
00001$: lcall   getkey_a
        cjne    a, #13, 00002$
        ljmp    00020$
00002$: cjne    a, #10, 00003$
        ljmp    00020$
00003$: cjne    a, #8, 00004$
        mov     a, r7
        jz      00001$
        dec     r7
        mov     dptr, #s_bs
        lcall   puts_cd
        sjmp    00001$
00004$: cjne    a, #3, 00005$
        mov     dptr, #s_ctlc
        lcall   puts_cd                 ; "^C" + CR LF
        mov     r7, #0
        ljmp    00021$
00005$: cjne    a, #21, 00006$
        mov     a, r7
        mov     r5, a
        mov     r7, #0
        lcall   redraw
        sjmp    00001$
00006$: cjne    a, #9, 00007$
        push    ar6
        mov     dpl, r7
        lcall   _complete
        mov     r7, dpl
        pop     ar6
        sjmp    00001$
00007$: cjne    a, #0x80, 00009$        ; Up: older entry (at most 8 back)
        mov     a, r6
        jz      00001$
        lcall   histn
        clr     c
        subb    a, r6
        cjne    a, #8, 00008$
00008$: jnc     00001$
        dec     r6
        sjmp    00013$
00009$: cjne    a, #0x81, 00010$        ; Down: newer entry
        lcall   histn
        mov     r2, a
        mov     a, r6
        clr     c
        subb    a, r2
        jnc     00001$
        inc     r6
        sjmp    00013$
00010$: cjne    a, #32, 00011$          ; printable, room left
00011$: jc      00001$
        cjne    a, #127, 00012$
00012$: jnc     00001$
        cjne    r7, #79, 00019$
00019$: jnc     00001$
        lcall   lpos
        movx    @dptr, a
        inc     r7
        lcall   putb_a
        ljmp    00001$
00013$: mov     a, r7                   ; show history entry R6
        mov     r5, a
        lcall   histn
        xrl     a, r6
        mov     r7, a
        jz      00014$                  ; the newest: empty line
        mov     a, r6
        lcall   hslot
        mov     r2, dpl
        mov     r3, dph
        mov     dptr, #_line
        mov     r7, #0
        lcall   cpyx
        mov     dptr, #_line
        lcall   _x_strlen
        mov     r7, dpl
00014$: lcall   redraw
        ljmp    00001$
00020$: lcall   crlf_r
00021$: lcall   lpos
        clr     a
        movx    @dptr, a
        mov     a, r7                   ; remember a new, different line
        jz      00023$
        lcall   histn
        jz      00022$
        dec     a
        lcall   hslot
        lcall   lineref
        lcall   strcmp_dr
        jz      00023$
00022$: lcall   histn
        lcall   hslot
        lcall   lineref
        mov     r7, #0
        lcall   cpyx
        lcall   histn
        inc     a
        cjne    a, #200, 00024$         ; keep it congruent modulo 8
00024$: jc      00025$
        add     a, #-192
00025$: movx    @dptr, a
00023$: ret

lineref:
        mov     r2, #<_line
        mov     r3, #>_line
        ret

; A = hist_n, DPTR = &hist_n
histn:  mov     dptr, #_hist_n
        movx    a, @dptr
        ret

; DPTR = history slot A (mod 8)
hslot:  anl     a, #7
        mov     b, #80
        mul     ab
        add     a, #<_hist
        mov     dpl, a
        mov     a, b
        addc    a, #>_hist
        mov     dph, a
        ret

; DPTR = &line[R7]
lpos:   push    acc
        mov     a, r7
        add     a, #<_line
        mov     dpl, a
        clr     a
        addc    a, #>_line
        mov     dph, a
        pop     acc
        ret

prompt: mov     dptr, #s_prompt
        ljmp    puts_cd

; reprint the prompt and line[0..R7), blank out up to the old length R5
redraw: mov     a, #13
        lcall   putb_a
        lcall   prompt
        mov     dptr, #_line
        mov     a, r7
        jz      00002$
        mov     r2, a
00001$: movx    a, @dptr
        inc     dptr
        lcall   putb_a
        djnz    r2, 00001$
00002$: mov     a, r5
        clr     c
        subb    a, r7
        jc      00005$
        jz      00005$
        mov     r2, a
        mov     r3, a
00003$: lcall   blank
        djnz    r2, 00003$
00004$: mov     a, #8
        lcall   putb_a
        djnz    r3, 00004$
00005$: ret

; void tokenize(void): user_args = line after the command word; split
; line[] into argv[] (at most 10, "quoted" arguments keep blanks)
_tokenize:
        mov     dptr, #_line
00001$: lcall   skipbl
00002$: movx    a, @dptr
        jz      00003$
        cjne    a, #0x20, 00010$
        sjmp    00003$
00010$: inc     dptr
        sjmp    00002$
00003$: lcall   skipbl
        mov     r2, dpl
        mov     r3, dph
        mov     dptr, #_user_args
        mov     r7, #79
        lcall   cpyx
        mov     dptr, #_argc
        clr     a
        movx    @dptr, a
        mov     dptr, #_line
00004$: lcall   skipbl
        jz      00009$
        mov     r6, #0x20               ; R6 = the terminator
        cjne    a, #0x22, 00005$
        mov     r6, a
        inc     dptr
00005$: mov     r4, dpl                 ; argv[argc++] = DPTR
        mov     r5, dph
        mov     dptr, #_argc
        movx    a, @dptr
        inc     a
        movx    @dptr, a
        dec     a
        add     a, acc
        add     a, #<_argv
        mov     dpl, a
        clr     a
        addc    a, #>_argv
        mov     dph, a
        mov     a, r4
        movx    @dptr, a
        inc     dptr
        mov     a, r5
        movx    @dptr, a
        mov     dpl, r4
        mov     dph, r5
00006$: movx    a, @dptr
        jz      00009$
        xrl     a, r6
        jz      00007$
        inc     dptr
        sjmp    00006$
00007$: movx    @dptr, a
        inc     dptr
        push    dpl
        push    dph
        mov     dptr, #_argc
        movx    a, @dptr
        pop     dph
        pop     dpl
        cjne    a, #10, 00004$
00009$: ret

; skip blanks at DPTR -> A = next character
skipbl: movx    a, @dptr
        cjne    a, #0x20, 00001$
        inc     dptr
        sjmp    skipbl
00001$: ret

;---------------------------------------------------------------- echo
_cmd_echo:
        mov     r6, #0                  ; last ">" argument
        mov     r5, #1
00001$: mov     a, r5
        lcall   argn
        jc      00003$
        movx    a, @dptr
        cjne    a, #0x3E, 00002$
        inc     dptr
        movx    a, @dptr
        jnz     00002$
        mov     a, r5
        mov     r6, a
00002$: inc     r5
        sjmp    00001$
00003$: mov     a, r6
        jnz     00006$
        mov     r5, #1                  ; to the console: words + blanks
00004$: mov     a, r5
        lcall   argn
        jc      00005$
        lcall   puts_xd
        mov     a, #0x20
        lcall   putb_a
        inc     r5
        sjmp    00004$
00005$: ljmp    crlf_r
00006$: mov     r0, #s_j                ; to the file after ">"
        movx    @r0, a
        inc     a
        lcall   argn
        jnc     00007$
        mov     r2, #0
        mov     r3, #0
        sjmp    00008$
00007$: mov     r2, dpl
        mov     r3, dph
        mov     r0, #_f_open_PARM_2
        mov     a, #0x77
        movx    @r0, a
        push    ar2
        push    ar3
        lcall   _f_open
        pop     ar3
        pop     ar2
        mov     a, dpl
        cjne    a, #0xFF, 00009$
00008$: mov     dptr, #_s_cant
        ljmp    err23
00009$: mov     r0, #s_h
        movx    @r0, a
        mov     r0, #s_i
        mov     a, #1
        movx    @r0, a
00010$: mov     r0, #s_i                ; words 1 .. j-1
        movx    a, @r0
        mov     r2, a
        mov     r0, #s_j
        movx    a, @r0
        clr     c
        subb    a, r2
        jz      00012$
        mov     r3, a                   ; 1: the last word
        mov     a, r2
        lcall   argn
        push    ar3
        mov     r0, #_f_write_PARM_2
        mov     a, dpl
        movx    @r0, a
        inc     r0
        mov     a, dph
        movx    @r0, a
        lcall   _x_strlen
        mov     r0, #_f_write_PARM_3
        mov     a, dpl
        movx    @r0, a
        inc     r0
        clr     a
        movx    @r0, a
        lcall   dplh
        lcall   _f_write
        pop     ar3
        mov     a, #0x20
        djnz    r3, 00011$
        mov     a, #0x0A
00011$: mov     r0, #_f_putc_PARM_2
        movx    @r0, a
        lcall   dplh
        lcall   _f_putc
        mov     r0, #s_i
        movx    a, @r0
        inc     a
        movx    @r0, a
        sjmp    00010$
00012$: lcall   dplh
        ljmp    _f_close

;---------------------------------------------------------------- grep
_cmd_grep:
        mov     a, #2
        lcall   argn
        jnc     00001$
        mov     dptr, #s_grepu
        ljmp    err0
00001$: mov     a, #2
        lcall   openr
        lcall   dplh
        lcall   _f_size
        push    dpl
        push    dph
        lcall   dplh
        lcall   _f_data
        mov     r0, #s_ls               ; line start = data
        mov     a, dpl
        movx    @r0, a
        inc     r0
        mov     a, dph
        movx    @r0, a
        pop     acc                     ; end = data + size
        pop     b
        xch     a, b
        add     a, dpl
        inc     r0
        movx    @r0, a
        mov     a, b
        addc    a, dph
        inc     r0
        movx    @r0, a
        push    dpl
        push    dph
        mov     a, #1                   ; pattern and its length
        lcall   argn
        mov     r0, #s_pat
        mov     a, dpl
        movx    @r0, a
        inc     r0
        mov     a, dph
        movx    @r0, a
        lcall   _x_strlen
        mov     r0, #s_pl
        mov     a, dpl
        movx    @r0, a
        mov     r0, #s_ln               ; line 1
        mov     a, #1
        movx    @r0, a
        inc     r0
        clr     a
        movx    @r0, a
        mov     _brk_flag, a
        pop     dph
        pop     dpl
00002$: mov     a, _brk_flag            ; DPTR scans the file
        jz     00805$
        ljmp    00009$
00805$:
        lcall   atend
        jz      00003$
        movx    a, @dptr
        cjne    a, #0x0A, 00803$
        sjmp    00804$
00803$:     ljmp    00008$
00804$:
00003$: push    dpl                     ; line [s_ls, DPTR)
        push    dph
        mov     r6, dpl
        mov     r7, dph
        mov     r0, #s_ls
        movx    a, @r0
        mov     r4, a
        inc     r0
        movx    a, @r0
        mov     r5, a
00004$: mov     r0, #s_pl               ; while q + pl <= end of line
        movx    a, @r0
        add     a, r4
        mov     r2, a
        clr     a
        addc    a, r5
        mov     r3, a
        clr     c
        mov     a, r6
        subb    a, r2
        mov     a, r7
        subb    a, r3
        jc      00007$
        mov     r1, #0
00005$: mov     r0, #s_pl               ; compare pattern at q
        movx    a, @r0
        xrl     a, r1
        jz      00010$
        mov     a, r4
        add     a, r1
        mov     dpl, a
        clr     a
        addc    a, r5
        mov     dph, a
        movx    a, @dptr
        mov     b, a
        mov     r0, #s_pat
        movx    a, @r0
        add     a, r1
        mov     dpl, a
        inc     r0
        movx    a, @r0
        addc    a, #0
        mov     dph, a
        movx    a, @dptr
        cjne    a, b, 00006$
        inc     r1
        sjmp    00005$
00006$: inc     r4
        cjne    r4, #0, 00004$
        inc     r5
        sjmp    00004$
00010$: mov     r0, #s_ln               ; match: number and line
        movx    a, @r0
        mov     dpl, a
        inc     r0
        movx    a, @r0
        mov     dph, a
        mov     r0, #_put_dec_w_PARM_2
        mov     a, #4
        movx    @r0, a
        lcall   _put_dec_w
        mov     a, #0x3A
        lcall   putb_a
        mov     a, #0x20
        lcall   putb_a
        mov     r0, #s_ls
        movx    a, @r0
        mov     dpl, a
        inc     r0
        movx    a, @r0
        mov     dph, a
        pop     ar7                     ; end of line
        pop     ar6
        push    ar6
        push    ar7
00011$: mov     a, dpl
        xrl     a, r6
        jnz     00012$
        mov     a, dph
        xrl     a, r7
        jz      00013$
00012$: movx    a, @dptr
        lcall   putc_a
        inc     dptr
        sjmp    00011$
00013$: lcall   crlf_r
00007$: pop     dph
        pop     dpl
        mov     r0, #s_ln               ; next line
        movx    a, @r0
        add     a, #1
        movx    @r0, a
        inc     r0
        movx    a, @r0
        addc    a, #0
        movx    @r0, a
        mov     r0, #s_ls
        mov     a, dpl
        add     a, #1
        movx    @r0, a
        inc     r0
        mov     a, dph
        addc    a, #0
        movx    @r0, a
        lcall   atend
        jz      00009$
00008$: inc     dptr
        ljmp    00002$
00009$: lcall   dplh
        ljmp    _f_close

; A = 0 if DPTR = s_end
atend:  mov     r0, #s_end
        movx    a, @r0
        xrl     a, dpl
        mov     r2, a
        inc     r0
        movx    a, @r0
        xrl     a, dph
        orl     a, r2
        ret

;---------------------------------------------------------------- wc
_cmd_wc:
        mov     a, #1
        lcall   openr
        lcall   dplh
        lcall   _f_size
        mov     r0, #s_end
        lcall   stdp
        lcall   dplh
        lcall   _f_data
        mov     r0, #s_end              ; R7:R6 = bytes to go
        movx    a, @r0
        mov     r6, a
        inc     r0
        movx    a, @r0
        mov     r7, a
        clr     a                       ; R3:R2 lines, R5:R4 words
        mov     r2, a
        mov     r3, a
        mov     r4, a
        mov     r5, a
        clr     F0                      ; in a word
00001$: mov     a, r6
        orl     a, r7
        jz      00006$
        movx    a, @dptr
        inc     dptr
        dec     r6
        cjne    r6, #0xFF, 00002$
        dec     r7
00002$: cjne    a, #0x0A, 00003$
        inc     r2
        cjne    r2, #0, 00004$
        inc     r3
        sjmp    00004$
00003$: cjne    a, #0x20, 00007$
        sjmp    00004$
00007$: cjne    a, #0x09, 00005$
00004$: clr     F0
        sjmp    00001$
00005$: jb      F0, 00001$
        setb    F0
        inc     r4
        cjne    r4, #0, 00001$
        inc     r5
        sjmp    00001$
00006$: push    ar4
        push    ar5
        push    ar2
        push    ar3
        lcall   dplh
        lcall   _f_close
        pop     dph
        pop     dpl
        mov     a, #6
        lcall   pdw
        pop     dph
        pop     dpl
        mov     a, #7
        lcall   pdw
        mov     r0, #s_end
        movx    a, @r0
        mov     dpl, a
        inc     r0
        movx    a, @r0
        mov     dph, a
        mov     a, #7
        lcall   pdw
        lcall   blank
        mov     a, #1
        lcall   argn
        lcall   puts_xd
        ljmp    crlf_r

; put_dec_w(DPTR, A)
pdw:    mov     r0, #_put_dec_w_PARM_2
        movx    @r0, a
        ljmp    _put_dec_w

; @R0 = DPTR (2 bytes)
stdp:   mov     a, dpl
        movx    @r0, a
        inc     r0
        mov     a, dph
        movx    @r0, a
        ret

;---------------------------------------------------------------- paste
_cmd_paste:
        mov     a, #1
        lcall   argn
        jnc     00001$
        mov     dptr, #s_pasteu
        ljmp    err0
00001$: mov     r2, dpl
        mov     r3, dph
        push    ar2
        push    ar3
        mov     r0, #_f_open_PARM_2
        mov     a, #0x77
        movx    @r0, a
        lcall   _f_open
        pop     ar3
        pop     ar2
        mov     a, dpl
        cjne    a, #0xFF, 00002$
        mov     dptr, #_s_cant
        ljmp    err23
00002$: mov     r0, #s_h
        movx    @r0, a
        clr     a
        mov     r0, #s_ln               ; bytes saved
        movx    @r0, a
        inc     r0
        movx    @r0, a
        inc     r0
        movx    @r0, a                  ; s_ls: last character
        mov     dptr, #s_paste
        lcall   puts_cd
00003$: lcall   getch_a
        cjne    a, #4, 00004$
        sjmp    00010$
00004$: cjne    a, #26, 00005$
        sjmp    00010$
00005$: cjne    a, #3, 00006$
        mov     dptr, #s_ctlc
        lcall   puts_cd
        sjmp    00010$
00006$: mov     r0, #s_ls               ; LF after CR: skip
        xch     a, r2
        movx    a, @r0
        xch     a, r2
        movx    @r0, a
        cjne    a, #0x0A, 00007$
        cjne    r2, #0x0D, 00007$
        sjmp    00003$
00007$: cjne    a, #0x0D, 00008$
        mov     a, #0x0A
00008$: cjne    a, #8, 00011$
        sjmp    00003$
00011$: cjne    a, #127, 00012$
        sjmp    00003$
00012$: push    acc
        mov     r0, #_f_putc_PARM_2
        movx    @r0, a
        lcall   dplh
        lcall   _f_putc
        pop     acc
        xch     a, dpl
        jz      00013$
        mov     dptr, #_fs_err_full
        lcall   puts_cd
        sjmp    00010$
00013$: xch     a, dpl
        lcall   putc_a
        mov     r0, #s_ln
        movx    a, @r0
        add     a, #1
        movx    @r0, a
        inc     r0
        movx    a, @r0
        addc    a, #0
        movx    @r0, a
        sjmp    00003$
00010$: lcall   dplh
        lcall   _f_close
        lcall   crlf_r
        mov     r0, #s_ln
        movx    a, @r0
        mov     dpl, a
        inc     r0
        movx    a, @r0
        mov     dph, a
        lcall   _put_dec
        mov     dptr, #s_saved
        ljmp    puts_cd

;---------------------------------------------------------------- dump
; void dump(u16 addr, u16 len, u8 code): hex + ASCII, 16 bytes per line
_dump:  mov     r0, #_dump_PARM_3
        movx    a, @r0
        add     a, #0xFF
        mov     F0, c                   ; CODE instead of XDATA
        mov     r0, #_dump_PARM_2
        movx    a, @r0
        mov     r6, a
        inc     r0
        movx    a, @r0
        mov     r7, a
        mov     _brk_flag, #0
00001$: mov     a, r6
        orl     a, r7
        jnz     00604$
        ljmp    00010$
00604$:
        mov     a, _brk_flag
        jz     00801$
        ljmp    00010$
00801$:
        lcall   hex16_dp
        mov     a, #0x3A
        lcall   putb_a
        lcall   blank
        mov     r3, #16                 ; R3 = bytes on this line
        mov     a, r7
        jnz     00002$
        mov     a, r6
        cjne    a, #16, 00011$
00011$: jnc     00002$
        mov     r3, a
00002$: push    dpl
        push    dph
        mov     r2, #0
00003$: mov     a, r2
        clr     c
        subb    a, r3
        jnc     00004$
        lcall   rdb
        lcall   hex8_a
        lcall   blank
        sjmp    00005$
00004$: lcall   blank
        lcall   blank
        lcall   blank
00005$: inc     dptr
        inc     r2
        cjne    r2, #16, 00003$
        pop     dph
        pop     dpl
        lcall   blank
        push    dpl
        push    dph
        mov     a, r3
        mov     r2, a
00006$: lcall   rdb
        cjne    a, #0x20, 00012$
00012$: jc      00007$
        cjne    a, #0x7F, 00013$
00013$: jc      00008$
00007$: mov     a, #0x2E
00008$: lcall   putb_a
        inc     dptr
        djnz    r2, 00006$
        pop     dph
        pop     dpl
        lcall   crlf_r
        cjne    r3, #16, 00010$
        mov     a, r6                   ; len -= 16, addr += 16
        add     a, #-16
        mov     r6, a
        mov     a, r7
        addc    a, #0xFF
        mov     r7, a
        mov     a, dpl
        add     a, #16
        mov     dpl, a
        clr     a
        addc    a, dph
        mov     dph, a
        orl     a, dpl
        jz     00603$
        ljmp    00001$
00603$:
00010$: ret

rdb:    jb      F0, 00001$
        movx    a, @dptr
        ret
00001$: clr     a
        movc    a, @a+dptr
        ret

blank:  mov     a, #0x20
        ljmp    putb_a

;---------------------------------------------------------------- ls
_cmd_ls:
        clr     F0                      ; -l ?
        mov     a, #1
        lcall   argn
        jc      00001$
        movx    a, @dptr
        cjne    a, #0x2D, 00001$
        inc     dptr
        movx    a, @dptr
        cjne    a, #0x6C, 00001$
        inc     dptr
        movx    a, @dptr
        jnz     00001$
        setb    F0
00001$: mov     r1, #0                  ; R1 = entry, B = column
        mov     b, #0
00002$: mov     dpl, r1
        lcall   _fs_dir
        mov     a, dpl
        orl     a, dph
        jz      00006$
        jnb     F0, 00004$
        push    dpl
        push    dph
        mov     dptr, #s_rw
        lcall   puts_cd
        pop     dph
        pop     dpl
        push    dpl
        push    dph
        mov     a, dpl                  ; size (5 wide)
        add     a, #12
        mov     dpl, a
        movx    a, @dptr
        mov     r2, a                   ; start
        inc     dptr
        movx    a, @dptr
        mov     r3, a
        inc     dptr
        movx    a, @dptr
        mov     r4, a
        inc     dptr
        movx    a, @dptr
        mov     dph, a
        mov     dpl, r4
        push    ar2
        push    ar3
        mov     r0, #_put_dec_w_PARM_2
        mov     a, #5
        movx    @r0, a
        push    b
        lcall   _put_dec_w
        pop     b
        lcall   blank
        lcall   blank
        pop     dph
        pop     dpl
        lcall   hex16_dp
        lcall   blank
        lcall   blank
        pop     dph
        pop     dpl
        lcall   puts_xd
        lcall   crlf_r
        sjmp    00006$
00004$: mov     r2, dpl                 ; short: 5 names per line
        lcall   puts_xd
        mov     a, dpl
        clr     c
        subb    a, r2
        mov     r2, a                   ; length + 1
        inc     b
        mov     a, b
        cjne    a, #5, 00005$
        lcall   crlf_r
        mov     b, #0
        sjmp    00006$
00005$: lcall   blank
        inc     r2
        cjne    r2, #15, 00005$
00006$: inc     r1
        cjne    r1, #32, 00602$
        sjmp    00702$
00602$:     ljmp    00002$
00702$:
        mov     a, b
        jz      00007$
        lcall   crlf_r
00007$: jnb     F0, 00008$
        lcall   _fs_count
        mov     dph, #0
        lcall   _put_dec
        mov     dptr, #s_files
        lcall   puts_cd
        lcall   _fs_used
        lcall   _put_dec
        mov     dptr, #s_used
        lcall   puts_cd
        lcall   _fs_free
        lcall   _put_dec
        mov     dptr, #s_free
        ljmp    puts_cd
00008$: ret

;---------------------------------------------------------------- examples
; void examples_install(u8 overwrite): decode the example stream into free
; RAM disk space (or the TPA when the disk is too full), create the files.
; _ex_dir: { name, 0, length (LE) }..., 0   (build/exdata.asm)
_examples_install:
        mov     r0, #s_j
        mov     a, dpl
        movx    @r0, a
        lcall   _fs_free
        mov     r2, dpl
        mov     r3, dph
        mov     a, #0                   ; start = 8000h - free
        clr     c
        subb    a, r2
        mov     r4, a
        mov     a, #0x80
        subb    a, r3
        mov     r5, a
        clr     c                       ; free < total: use the TPA
        mov     a, r2
        subb    a, #<_ex_total
        mov     a, r3
        subb    a, #>_ex_total
        jnc     00001$
        mov     r4, #0
        mov     r5, #0x80
00001$: mov     r0, #s_ls
        mov     a, r4
        movx    @r0, a
        inc     r0
        mov     a, r5
        movx    @r0, a
        mov     dptr, #_unlz_dst
        mov     a, r4
        movx    @dptr, a
        inc     dptr
        mov     a, r5
        movx    @dptr, a
        inc     dptr
        mov     a, #<_ex_total
        movx    @dptr, a
        inc     dptr
        mov     a, #>_ex_total
        movx    @dptr, a
        mov     dptr, #_ex_lz
        lcall   _unlz
        mov     dptr, #_ex_dir
00002$: mov     r2, dpl                 ; name -> ex_name
        mov     r3, dph
        clr     a
        movc    a, @a+dptr
        jz      00006$
        mov     r4, #0
00003$: mov     dpl, r2
        mov     dph, r3
        mov     a, r4
        movc    a, @a+dptr
        mov     r5, a
        mov     a, r4
        add     a, #<_ex_name
        mov     dpl, a
        clr     a
        addc    a, #>_ex_name
        mov     dph, a
        mov     a, r5
        movx    @dptr, a
        inc     r4
        jnz     00003$
        mov     a, r4                   ; DPTR = length field
        add     a, r2
        mov     dpl, a
        clr     a
        addc    a, r3
        mov     dph, a
        push    dpl
        push    dph
        mov     r0, #s_j
        movx    a, @r0
        jnz     00004$
        mov     dptr, #_ex_name
        lcall   _fs_find
        mov     a, dph
        jnb     acc.7, 00005$           ; exists: skip it
00004$: mov     dptr, #_ex_name
        mov     r0, #_f_open_PARM_2
        mov     a, #0x77
        movx    @r0, a
        lcall   _f_open
        mov     r0, #s_h
        mov     a, dpl
        movx    @r0, a
        pop     dph
        pop     dpl
        push    dpl
        push    dph
        mov     r0, #_f_write_PARM_2    ; f_write(h, p, length)
        lcall   cpp
        clr     a
        movc    a, @a+dptr
        movx    @r0, a
        inc     r0
        mov     a, #1
        movc    a, @a+dptr
        movx    @r0, a
        lcall   dplh
        lcall   _f_write
        lcall   dplh
        lcall   _f_close
00005$: pop     dph
        pop     dpl
        mov     r0, #s_ls               ; p += length
        clr     a
        movc    a, @a+dptr
        mov     r2, a
        movx    a, @r0
        add     a, r2
        movx    @r0, a
        inc     r0
        mov     a, #1
        movc    a, @a+dptr
        mov     r2, a
        movx    a, @r0
        addc    a, r2
        movx    @r0, a
        inc     dptr
        inc     dptr
        ljmp    00002$
00006$: ret

; copy s_ls (2 bytes) to @R0, R0 advances
cpp:    mov     r1, #s_ls
        movx    a, @r1
        movx    @r0, a
        inc     r0
        inc     r1
        movx    a, @r1
        movx    @r0, a
        inc     r0
        ret
