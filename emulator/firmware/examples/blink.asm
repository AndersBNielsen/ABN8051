; blink.asm - running light on P1.0-P1.3 (LEDs active low), any key stops
; P1.4-P1.7 are the SD card lines: change only the low nibble (ORL/ANL).
        ORG     8000h
start:  LCALL   PUTSI
        DB      "Running light on P1.0-P1.3 - press any key to stop", 10, 0
        MOV     R7, #0EEh       ; one LED on in each nibble
loop:   ORL     P1, #0Fh        ; LEDs off
        MOV     A, R7
        ORL     A, #0F0h        ; keep P1.4-P1.7
        ANL     P1, A           ; one LED on
        MOV     DPTR, #120      ; 120 ms
        LCALL   DELAY
        MOV     A, R7
        RL      A
        MOV     R7, A
        LCALL   KBHIT           ; carry set when a key is waiting
        JNC     loop
        LCALL   GETC            ; swallow the key
        ORL     P1, #0Fh        ; all LEDs off
        RET
