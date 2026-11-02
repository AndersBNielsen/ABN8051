; hello.asm - the first DOS/51 program
;   asm hello.asm      assemble into upper RAM, writes hello.bin
;   hello Anders       run it (arguments are optional)
        ORG     8000h           ; programs load and start at 8000h
start:  LCALL   PUTSI           ; print the string that follows
        DB      "Hello from the 80C31!", 10, 0
        LCALL   ARGS            ; DPTR -> command line arguments
        MOVX    A, @DPTR
        JZ      done
        LCALL   PUTSI
        DB      "You said: ", 0
        LCALL   PUTS            ; print string at DPTR
        LCALL   CRLF
done:   RET                     ; return to DOS
