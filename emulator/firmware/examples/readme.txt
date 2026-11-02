Welcome to DOS/51
=================
Try:   ls -l              list files
       cat hello.asm      show a file
       nano hello.asm     edit it (^O save, ^X exit, ^G help)
       asm hello.asm      assemble -> hello.bin in upper RAM
       hello World        run hello.bin with arguments
       asm -l -r blink.asm   listing + run straight away

Examples: hello blink timer button upper primes files (.asm)
Programs start at 8000h and return to DOS with RET or LJMP EXIT.
System calls (LCALL): PUTC GETC KBHIT PUTS PUTSI PUTHEX PUTHEX16
  PUTDEC CRLF GETLINE DELAY ARGS FOPEN FGETC FPUTC FCLOSE GETKEY PUTB
  SDINIT SDREAD SDWRITE (512-byte sectors on the SD card)
Interrupt vectors are forwarded to 8003h 800Bh 8013h 801Bh.
Free internal RAM for programs: 08h-2Fh.  ^C aborts a running program.
Transfer files with XMODEM: rx NAME (upload), sx NAME (download).
SD card (FAT16/FAT32 root directory): sdls, sdget, sdput, sdrm.
P1.0-P1.3 are free for LEDs; P1.4-P1.7 are the SD card's SPI lines.
`examples -f` restores these files.
