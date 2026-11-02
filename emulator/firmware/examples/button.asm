; button.asm - count presses of a button on /INT0 (P3.2), edge triggered
; ROM vector 0003h is forwarded to 8003h.
COUNT   DATA    20h

        ORG     8000h
        LJMP    start
        ORG     8003h           ; external interrupt 0
        LJMP    int0isr

        ORG     8020h
start:  MOV     COUNT, #0
        MOV     R7, #0FFh       ; force a first display
        SETB    IT0             ; falling edge
        SETB    EX0
        LCALL   PUTSI
        DB      "Press the INT0 button (P3.2). Any key quits.", 10, 0
loop:   MOV     A, COUNT
        XRL     A, R7
        JZ      chk
        MOV     R7, COUNT
        LCALL   PUTSI
        DB      13, "Presses: ", 0
        MOV     DPH, #0
        MOV     DPL, R7
        LCALL   PUTDEC
        ORL     P1, #0Fh        ; binary count on the 4 LEDs (P1.0-P1.3),
        MOV     A, R7           ; P1.4-P1.7 (SD card) unchanged
        CPL     A
        ORL     A, #0F0h
        ANL     P1, A
chk:    LCALL   KBHIT
        JNC     loop
        LCALL   GETC
        CLR     EX0
        LCALL   CRLF
        RET

int0isr:
        INC     COUNT
        RETI
