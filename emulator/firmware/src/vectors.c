/* DOS/51 - interrupt vectors, serial ISR, user program trampoline.
 *
 * Interrupts other than the serial port are forwarded to upper RAM at the
 * standard 8051 vector offsets + 0x8000, so a user program assembled at
 * ORG 8000h can place its handlers exactly as on a bare 8051:
 *     8003h INT0   800Bh T0   8013h INT1   801Bh T1
 */
#include "dos.h"


void int0_vec(void) __interrupt(0) __naked { __asm ljmp 0x8003 __endasm; }
void t0_vec(void)   __interrupt(1) __naked { __asm ljmp 0x800B __endasm; }
void int1_vec(void) __interrupt(2) __naked { __asm ljmp 0x8013 __endasm; }
void t1_vec(void)   __interrupt(3) __naked { __asm ljmp 0x801B __endasm; }

/* Serial interrupt: receive into the 256 byte ring at RXBUF_ADDR, flag TX
 * completion.  ^C while a user program runs aborts it back to the shell. */
void ser_isr(void) __interrupt(4) __naked
{
    __asm
        push    acc
        push    psw
        jnb     _RI, 00010$
        clr     _RI
        mov     a, _SBUF
        cjne    a, #3, 00002$
        mov     _brk_flag, #1
        mov     a, _user_running
        jnz     00090$
        mov     a, #3
00002$:
        push    dpl
        push    dph
        mov     dph, #0x1F      ; RXBUF_ADDR >> 8
        mov     dpl, _rx_head
        movx    @dptr, a
        mov     a, _rx_head
        inc     a
        cjne    a, _rx_tail, 00003$
        sjmp    00004$          ; buffer full: drop byte
00003$:
        mov     _rx_head, a
00004$:
        pop     dph
        pop     dpl
00010$:
        jnb     _TI, 00011$
        clr     _TI
        mov     _tx_ready, #1
00011$:
        pop     psw
        pop     acc
        reti
        ; ---- ^C abort of a user program ----
00090$:
        mov     _user_running, #0
        mov     sp, _saved_sp
        mov     a, #<00091$
        push    acc
        mov     a, #>00091$
        push    acc
        reti
00091$:
        ; a second RETI clears a low-priority in-progress level if the
        ; abort happened inside a user interrupt handler (else = RET)
        mov     a, #<00092$
        push    acc
        mov     a, #>00092$
        push    acc
        reti
00092$:
        mov     psw, #0
        mov     0xa0, #0x1D       ; PDATA_PAGE
        mov     dpl, #1
        ret
    __endasm;
}

/* u8 run_user(u16 addr) - call user code, return 0 when it RETs or calls EXIT */
u8 run_user(u16 addr) __naked
{
    (void)addr;
    __asm
        mov     _saved_sp, sp
        mov     a, #<00020$
        push    acc
        mov     a, #>00020$
        push    acc
        push    dpl
        push    dph
        mov     _brk_flag, #0
        mov     _user_running, #1
        mov     psw, #0
        clr     a
        mov     b, a
        ret                      ; "return" into the user program
00020$:
        mov     _user_running, #0
        mov     sp, _saved_sp
        mov     psw, #0
        mov     0xa0, #0x1D       ; PDATA_PAGE
        mov     dpl, #0
        ret
    __endasm;
}

/* Syscall EXIT: unwind the user stack and return to the shell */
void sys_exit(void) __naked
{
    __asm
        clr     ea
        mov     _user_running, #0
        mov     sp, _saved_sp
        mov     psw, #0
        mov     0xa0, #0x1D       ; PDATA_PAGE
        setb    ea
        mov     dpl, #0
        ret
    __endasm;
}
