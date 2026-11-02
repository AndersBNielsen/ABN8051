; primes.asm - sieve of Eratosthenes, flag array in upper RAM (MOVX)
N       EQU     2000
SIEVE   EQU     9000h

        ORG     8000h
start:  LCALL   PUTSI
        DB      "Primes below 2000:", 10, 0
        MOV     DPTR, #SIEVE    ; SIEVE[0..N-1] = 1
        MOV     R6, #HIGH(N)
        MOV     R7, #LOW(N)
fill:   MOV     A, #1
        MOVX    @DPTR, A
        INC     DPTR
        ACALL   dec67
        JNZ     fill
        MOV     R4, #0          ; R4:R5 = i = 2
        MOV     R5, #2
        MOV     R2, #0          ; R2:R3 = number of primes
        MOV     R3, #0
next:   CLR     C               ; i >= N ?
        MOV     A, R5
        SUBB    A, #LOW(N)
        MOV     A, R4
        SUBB    A, #HIGH(N)
        JNC     finish
        MOV     A, R5           ; DPTR = SIEVE + i
        ADD     A, #LOW(SIEVE)
        MOV     DPL, A
        MOV     A, R4
        ADDC    A, #HIGH(SIEVE)
        MOV     DPH, A
        MOVX    A, @DPTR
        JZ      skip
        MOV     DPH, R4         ; prime: print it
        MOV     DPL, R5
        LCALL   PUTDEC
        MOV     A, #' '
        LCALL   PUTC
        INC     R3
        CJNE    R3, #0, cnt
        INC     R2
cnt:    MOV     A, R5           ; R0:R1 = j = 2 * i
        ADD     A, R5
        MOV     R1, A
        MOV     A, R4
        ADDC    A, R4
        MOV     R0, A
mark:   CLR     C               ; while j < N: SIEVE[j] = 0, j += i
        MOV     A, R1
        SUBB    A, #LOW(N)
        MOV     A, R0
        SUBB    A, #HIGH(N)
        JNC     skip
        MOV     A, R1
        ADD     A, #LOW(SIEVE)
        MOV     DPL, A
        MOV     A, R0
        ADDC    A, #HIGH(SIEVE)
        MOV     DPH, A
        CLR     A
        MOVX    @DPTR, A
        MOV     A, R1
        ADD     A, R5
        MOV     R1, A
        MOV     A, R0
        ADDC    A, R4
        MOV     R0, A
        SJMP    mark
skip:   INC     R5
        CJNE    R5, #0, next
        INC     R4
        SJMP    next
finish: LCALL   CRLF
        MOV     DPH, R2
        MOV     DPL, R3
        LCALL   PUTDEC
        LCALL   PUTSI
        DB      " primes found", 10, 0
        RET

dec67:  MOV     A, R7           ; R6:R7 -= 1, A = 0 when it reaches zero
        JNZ     d1
        DEC     R6
d1:     DEC     R7
        MOV     A, R7
        ORL     A, R6
        RET
