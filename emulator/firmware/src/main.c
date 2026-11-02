/* DOS/51 - a small serial DOS for an 80C31 board with 32K ROM and 2x32K RAM */
#include "dos.h"

__xdata u8 term_rows = 24, term_cols = 80;

void ser_init(void)
{
    ES = 0;
    rx_head = rx_tail = 0;
    tx_ready = 1;
    TMOD = (TMOD & 0x0F) | 0x20;     /* T1 mode 2, 8-bit auto reload */
    TH1 = 0xFF;                      /* 57600 baud with SMOD=1 @ 11.0592 MHz */
    TL1 = 0xFF;
    PCON |= 0x80;                    /* SMOD */
    SCON = 0x50;                     /* mode 1, REN */
    TR1 = 1;
    ES = 1;
    EA = 1;
}

/* Called by the SDCC startup code before RAM initialisation: move the stack
 * above the resident variables (3Bh-7Fh, see dos.h), keep RAM contents. */
unsigned char __sdcc_external_startup(void) __naked
{
    __asm
        pop     dph
        pop     dpl
        mov     sp, #0x3A
        push    dpl
        push    dph
        mov     dpl, #0
        ret
    __endasm;
}

void fs_init(void)
{
    f_closeall();
    if (!fs_valid()) {
        puts_c("Formatting RAM disk... ");
        fs_format();
        examples_install(1);
        puts_c("done\n");
    }
}

void main(void)
{
    P2 = PDATA_PAGE;                 /* MOVX @Ri page for pdata locals */
    IE = 0;
    IP = 0;
    P1 = 0xDF;                       /* LEDs off; SD card: /CS high, SCK low */
    user_running = 0;
    ser_init();
    delay_ms(20);
    puts_c("\x1b[0m\r\n"
           "DOS/51 " DOS_VERSION "  -  80C31 @ 11.0592 MHz, 32K ROM, 64K RAM\r\n");
    fs_init();
    puts_c("RAM disk: ");
    put_dec(fs_count());
    puts_c(" files, ");
    put_dec(fs_free());
    puts_c(" bytes free.  TPA 8000h-FFFFh.  Type 'help'.\n\n");
    shell();
}
