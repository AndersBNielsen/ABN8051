/* DOS/51 - common declarations.  Target: 80C31, 11.0592 MHz, SDCC --model-medium */
#ifndef DOS_H
#define DOS_H

#include <8051.h>
#include <stdint.h>

#define DOS_VERSION "1.0"

typedef unsigned char u8;
typedef unsigned int u16;
typedef unsigned long u32;
typedef u8 __xdata *xp;              /* 16-bit pointer into XDATA */
typedef const char __code *cstr;     /* string in ROM */

/* ---- memory map (see docs/HARDWARE.md) ---- */
#define DOS_XRAM_BASE   0x0000u      /* DOS variables (SDCC xram, 0000h-0BFFh) */
#define SYMTAB_ADDR     0x0C00u      /* assembler symbols, 255 x 16 bytes */
#define PDATA_PAGE      0x1D         /* SDCC --model-medium pdata (P2 page) */
#define ASMWORK_ADDR    0x1E00u      /* assembler line and state page */
#define RXBUF_ADDR      0x1F00u      /* 256 byte serial ring buffer */
#define DISK_BASE       0x2000u      /* RAM disk in lower RAM */
#define DISK_END        0x8000u
#define TPA_BASE        0x8000u      /* transient program area, executable */
#define TPA_END         0xFFFFu

/* ---- serial (serial.c + asm ISR in vectors.c) ---- */
void ser_init(void);
void putch(char c);
void puts_c(cstr s);                 /* ROM string */
void puts_x(const char __xdata *s);  /* XDATA string */
void crlf(void);
void put_hex8(u8 v);
void put_hex16(u16 v);
void put_dec(u16 v);
void put_dec_w(u16 v, u8 width);
u8 kbhit(void);
u8 getch(void);
int getch_to(u16 ms);                /* -1 on timeout */
void delay_ms(u16 ms);
void rx_flush(void);
u8 getline_x(char __xdata *buf, u8 max);

/* interrupt handlers (vectors.c); declared here so that SDCC emits the
 * vector table in main.c */
void int0_vec(void) __interrupt(0) __naked;
void t0_vec(void) __interrupt(1) __naked;
void int1_vec(void) __interrupt(2) __naked;
void t1_vec(void) __interrupt(3) __naked;
void ser_isr(void) __interrupt(4) __naked;

/* Resident state at fixed internal RAM addresses (36h-3Ah: syscalls.asm,
 * 30h-32h also in lib51.asm).  Internal RAM map:
 *   00-07 bank 0   08-1F C temporaries, free while a user program runs
 *   20-2F bit area (user programs)   30-3A DOS resident   3B-7F stack */
__data __at(0x30) volatile u8 rx_head;
__data __at(0x31) volatile u8 rx_tail;
__data __at(0x32) volatile u8 tx_ready;
__data __at(0x33) volatile u8 user_running;
__data __at(0x34) volatile u8 brk_flag;  /* set by ^C while DOS is running */
__data __at(0x35) u8 saved_sp;

/* ---- key decoding (serial.c) ---- */
#define K_UP     0x80
#define K_DOWN   0x81
#define K_LEFT   0x82
#define K_RIGHT  0x83
#define K_HOME   0x84
#define K_END    0x85
#define K_PGUP   0x86
#define K_PGDN   0x87
#define K_DEL    0x88
#define K_INS    0x89
u8 getkey(void);

/* ---- terminal ---- */
extern __xdata u8 term_rows, term_cols;
void vt_goto(u8 row, u8 col);        /* 0-based */
void vt_clear(void);
void vt_clreol(void);
void vt_inverse(u8 on);

/* ---- string helpers ---- */
u8 x_strlen(const char __xdata *s);
u8 x_streq_c(const char __xdata *a, cstr b);
void x_strcpy(char __xdata *d, const char __xdata *s);
void x_strcpy_c(char __xdata *d, cstr s);
void x_strncpy(char __xdata *d, const char __xdata *s, u8 n);
u8 x_strcmp(const char __xdata *a, const char __xdata *b);
void x_memmove(u8 __xdata *d, const u8 __xdata *s, u16 n);
void x_memset(u8 __xdata *d, u8 v, u16 n);
u8 parse_num(const char __xdata *s, u16 __xdata *out);
char upcase(char c);

/* ---- file system (fs.c) ---- */
#define FS_NAMELEN 12                /* including terminating 0 */
#define FS_NDIR    32
typedef struct {
    char name[FS_NAMELEN];
    u16 start;                       /* absolute XDATA address of data */
    u16 size;
} dirent_t;

#define FS_MAXH 4
#define FH_FREE  0
#define FH_READ  1
#define FH_WRITE 2

void fs_init(void);                  /* mount or format */
void fs_format(void);
u8 fs_valid(void);
dirent_t __xdata *fs_dir(u8 i);      /* entry i or 0 if empty */
int fs_find(const char __xdata *name);
u8 fs_delete(const char __xdata *name);
u8 fs_rename(const char __xdata *from, const char __xdata *to);
u16 fs_free(void);
u16 fs_used(void);
u8 fs_count(void);
u8 fs_name_ok(const char __xdata *name);
/* streaming */
u8 f_open(const char __xdata *name, u8 mode); /* returns handle or 0xFF */
int f_getc(u8 h);                    /* -1 at EOF */
u8 f_putc(u8 h, u8 c);               /* 0 ok, 1 disk full */
u8 f_write(u8 h, const u8 __xdata *p, u16 n);
void f_close(u8 h);
xp f_tail(u8 h, u16 __xdata *avail);
void f_commit(u8 h, u16 n);
void f_trunc(u8 h, u16 n);
void putb(u8 c);
void f_closeall(void);
u16 f_size(u8 h);
xp f_data(u8 h);                     /* start address of an open file */
extern __code const char fs_err_full[];

/* install examples from ROM (LZSS, see scripts/gen_examples.py) */
void examples_install(u8 overwrite);
void unlz(const u8 __code *src);
extern __xdata xp unlz_dst;
extern __xdata u16 unlz_len;
extern __xdata char ex_name[FS_NAMELEN + 4];

/* ---- programs ---- */
u8 run_user(u16 addr);               /* asm trampoline; 0 = ok, 1 = ^C abort */
extern __xdata char user_args[80];
void sys_restore(void);              /* restore hw after a user program */

/* ---- subsystems ---- */
void shell(void);
void editor(const char __xdata *name);
u8 assemble(const char __xdata *name, u8 flags);
#define ASM_LIST   1
#define ASM_NOSAVE 2
#define ASM_RUN    4
u8 xmodem_recv(const char __xdata *name);
u8 xmodem_send(const char __xdata *name);
void sd_ls(void);                    /* SD card FAT tool (sd51.asm) */
void sd_get(void);
void sd_put(void);
void sd_rm(void);

#endif
