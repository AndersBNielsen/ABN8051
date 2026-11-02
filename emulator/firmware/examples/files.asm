; files.asm - write a file on the RAM disk and read it back
        ORG     8000h
start:  MOV     DPTR, #name
        MOV     A, #'w'
        LCALL   FOPEN           ; A = handle, carry = error
        JC      err
        MOV     R6, A
        MOV     DPTR, #text
wr:     MOVX    A, @DPTR
        JZ      wdone
        MOV     B, R6           ; B = handle, A = byte
        LCALL   FPUTC
        JC      err
        INC     DPTR
        SJMP    wr
wdone:  MOV     A, R6
        LCALL   FCLOSE
        LCALL   PUTSI
        DB      "Wrote hello.txt, reading it back:", 10, 0
        MOV     DPTR, #name
        MOV     A, #'r'
        LCALL   FOPEN
        JC      err
        MOV     R6, A
rd:     MOV     A, R6
        LCALL   FGETC           ; carry = end of file
        JC      rdone
        LCALL   PUTC
        SJMP    rd
rdone:  MOV     A, R6
        LCALL   FCLOSE
        RET
err:    LCALL   PUTSI
        DB      "file error", 10, 0
        RET

name:   DB      "hello.txt", 0
text:   DB      "This file was written by an 8051 program.\n", 0
