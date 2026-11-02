; upper.asm - line input and string handling in upper RAM
BUF     EQU     9000h

        ORG     8000h
start:  LCALL   PUTSI
        DB      "Type lines, they come back in upper case. Empty line quits.", 10, 0
loop:   LCALL   PUTSI
        DB      "> ", 0
        MOV     DPTR, #BUF
        MOV     R7, #80         ; buffer size
        LCALL   GETLINE         ; A = length
        JZ      quit
up:     MOVX    A, @DPTR
        JZ      show
        CJNE    A, #'a', $+3    ; carry = A < 'a'
        JC      next
        CJNE    A, #'z'+1, $+3
        JNC     next
        ADD     A, #-32
        MOVX    @DPTR, A
next:   INC     DPTR
        SJMP    up
show:   MOV     DPTR, #BUF
        LCALL   PUTS
        LCALL   CRLF
        SJMP    loop
quit:   RET
