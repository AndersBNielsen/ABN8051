; timer.asm - Timer 0 interrupt every 50 ms, counts seconds, toggles P1.0
; The ROM forwards interrupt vectors to upper RAM: 000Bh -> 800Bh.
TICKS   DATA    20h             ; internal RAM 08h-2Fh is free for programs
SECS    DATA    21h
NEWSEC  BIT     22h.0           ; byte.bit notation
RELOAD  EQU     65536 - 46080   ; 50 ms at 921600 machine cycles/s

        ORG     8000h
        LJMP    start
        ORG     800Bh           ; Timer 0 vector
        LJMP    t0isr

        ORG     8030h
start:  MOV     TICKS, #20
        MOV     SECS, #0
        CLR     NEWSEC
        ANL     TMOD, #0F0h     ; keep Timer 1, it makes the baud rate
        ORL     TMOD, #01h      ; Timer 0 mode 1 (16 bit)
        MOV     TH0, #HIGH(RELOAD)
        MOV     TL0, #LOW(RELOAD)
        SETB    ET0
        SETB    TR0
        LCALL   PUTSI
        DB      "Timer 0 interrupt demo. Any key stops.", 10, 0
main:   JNB     NEWSEC, chk
        CLR     NEWSEC
        LCALL   PUTSI
        DB      13, "Seconds: ", 0
        MOV     DPH, #0
        MOV     DPL, SECS
        LCALL   PUTDEC
chk:    LCALL   KBHIT
        JNC     main
        LCALL   GETC
        CLR     TR0
        CLR     ET0
        LCALL   CRLF
        RET

t0isr:  PUSH    PSW
        PUSH    ACC
        MOV     TH0, #HIGH(RELOAD)
        MOV     TL0, #LOW(RELOAD)
        DJNZ    TICKS, t0x
        MOV     TICKS, #20
        INC     SECS
        SETB    NEWSEC
        CPL     P1.0
t0x:    POP     ACC
        POP     PSW
        RETI
