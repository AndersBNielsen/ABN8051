/* DOS/51 - self-hosted two pass 8051 assembler: driver.
 *
 * The per-line work (parsing, expressions, symbols, encoding) is done by the
 * hand written core in asm51.asm.  This file reads the source (with
 * INCLUDE), prepares each line, reports errors, prints the listing and
 * writes NAME.bin.  Syntax: see README.md ("Assembler").
 *
 * Work page 1E00h-1EFFh (shared with asm51.asm):
 *   00-7F  prepared line: upper case outside quotes, TABs -> blanks, no comment
 *   80-BF  identifier / label / include name     C0-DF  state (W_*)
 * Symbol table at 0C00h: 255 entries of 16 bytes.
 */
#include "dos.h"

#define WP       ((u8 __xdata *)0x1E00)
#define UBUF     ((char __xdata *)0x1E00)
#define INCNAME  ((char __xdata *)0x1EA0)
#define W_PASS   0xC0
#define W_PC     0xC1
#define W_LS     0xC3
#define W_DONE   0xC5
#define W_NLB    0xC7
#define W_LB     0xC8
#define W_LMORE  0xCC
#define W_MIN    0xCD
#define W_MAX    0xCF
#define W_NB     0xD1
#define W_NSYM   0xD3
#define W_INC    0xD5
#define WW(o)    (*(u16 __xdata *)(WP + (o)))   /* little endian words */

#define LMAX     128
#define MAXERR   20
#define INCDEPTH 4

void asm_line(void);

typedef struct {
    xp data;
    u16 size, pos, line;
    char name[FS_NAMELEN];
} src_t;
static __xdata src_t srcs[INCDEPTH];
static __xdata u8 sdepth, errs, line_err, aflags;
static __xdata u16 lines;
static __xdata char lbuf[LMAX];

static void report(cstr msg)
{
    src_t __xdata *s = srcs + sdepth;
    line_err = 1;
    if (errs++ >= MAXERR)
        return;
    puts_x(s->name);
    putb(':');
    put_dec(s->line);
    puts_c(": ");
    puts_c(msg);
    puts_c("\n    ");
    puts_x(lbuf);
    crlf();
}

/* called by asm51.asm: errors are reported in pass 2, asm_err1 also in pass 1 */
void asm_err(cstr msg)
{
    if (!line_err && WP[W_PASS] == 2)
        report(msg);
}

void asm_err1(cstr msg)
{
    if (!line_err)
        report(msg);
}

/* next source line -> lbuf (raw) and UBUF (prepared); 0 at the end */
static u8 next_line(void)
{
    src_t __xdata *s;
    u8 n = 0, q = 0, c;
    for (;;) {
        s = srcs + sdepth;
        if (s->pos < s->size)
            break;
        if (!sdepth)
            return 0;
        sdepth--;
    }
    while (s->pos < s->size) {
        c = s->data[s->pos++];
        if (c == '\n')
            break;
        if (c != '\r' && n < LMAX - 1)
            lbuf[n++] = c;
    }
    lbuf[n] = 0;
    s->line++;
    lines++;
    for (n = 0; (c = lbuf[n]); n++) {
        if (q) {
            if (c == q)
                q = 0;
        } else if (c == '\'' || c == '"')
            q = c;
        else if (c == ';')
            break;
        else if (c == '\t')
            c = ' ';
        else
            c = upcase(c);
        UBUF[n] = c;
    }
    UBUF[n] = 0;
    return 1;
}

static void list_line(void)
{
    u8 i, nb = WP[W_NLB];
    u16 ls = WW(W_LS);
    if (nb || ls != WW(W_PC)) {
        put_hex16(ls);
        putb(' ');
    } else
        puts_c("     ");
    for (i = 0; i < 4; i++) {
        if (i < nb)
            put_hex8(WP[W_LB + i]);
        else
            puts_c("  ");
    }
    putb(WP[W_LMORE] ? '+' : ' ');
    putb(' ');
    puts_x(lbuf);
    crlf();
}

static void open_src(u8 d, const char __xdata *name)
{
    u8 h = f_open(name, 'r');
    src_t __xdata *s = srcs + d;
    x_strncpy(s->name, name, FS_NAMELEN);
    s->data = f_data(h);
    s->size = f_size(h);
    s->pos = s->line = 0;
    f_close(h);
}

static u8 run_pass(const char __xdata *name, u8 pass)
{
    WP[W_PASS] = pass;
    WW(W_PC) = TPA_BASE;
    WP[W_DONE] = 0;
    sdepth = 0;
    lines = 0;
    open_src(0, name);
    brk_flag = 0;
    while (!WP[W_DONE] && next_line()) {
        line_err = 0;
        WP[W_NLB] = WP[W_LMORE] = WP[W_INC] = 0;
        asm_line();
        if (WP[W_INC]) {
            if (fs_find(INCNAME) < 0)
                asm_err1("include file not found");
            else if (sdepth + 1 >= INCDEPTH)
                asm_err1("includes nested too deeply");
            else
                open_src(++sdepth, INCNAME);
        }
        if (pass == 2 && (aflags & ASM_LIST))
            list_line();
        if (brk_flag || errs >= MAXERR)
            return 0;
    }
    return 1;
}

static __code const char s_errs[] = " error(s)\n";

u8 assemble(const char __xdata *name, u8 fl)
{
    u8 h, i;
    u16 min, len;
    if (fs_find(name) < 0) {
        puts_c("asm: no such file\n");
        return 0;
    }
    aflags = fl;
    errs = 0;
    WP[W_NSYM] = 0;
    WW(W_MIN) = 0xFFFF;
    WW(W_MAX) = 0;
    WW(W_NB) = 0;
    puts_c("pass 1\n");
    if (!run_pass(name, 1) || errs)
        goto fail;
    puts_c("pass 2\n");
    /* clear the image so gaps (DS) are deterministic */
    min = WW(W_MIN);
    if (WW(W_MAX) >= min && min >= TPA_BASE)
        x_memset((xp)TPA_BASE, 0, WW(W_MAX) - TPA_BASE + 1);
    /* the source must not move: nothing writes to the disk meanwhile */
    run_pass(name, 2);
    put_dec(lines);
    puts_c(" lines, ");
    put_dec(WP[W_NSYM]);
    puts_c(" symbols, ");
    put_dec(errs);
    puts_c(s_errs);
    if (errs || brk_flag)
        return 0;
    if (!WW(W_NB)) {
        puts_c("no code generated\n");
        return 0;
    }
    puts_c("code ");
    put_hex16(min);
    puts_c("h-");
    put_hex16(WW(W_MAX));
    puts_c("h, ");
    put_dec(WW(W_NB));
    puts_c(" bytes\n");
    if (fl & ASM_NOSAVE)
        return 1;
    /* NAME.asm -> NAME.bin: image from 8000h */
    for (i = 0; name[i] && name[i] != '.' && i < FS_NAMELEN - 5; i++)
        lbuf[i] = name[i];
    lbuf[i++] = '.';
    lbuf[i++] = 'b';
    lbuf[i++] = 'i';
    lbuf[i++] = 'n';
    lbuf[i] = 0;
    len = WW(W_MAX) - TPA_BASE + 1;
    h = f_open(lbuf, 'w');
    if (h == 0xFF || f_write(h, (xp)TPA_BASE, len)) {
        f_close(h);
        fs_delete(lbuf);
        puts_c("cannot write ");
        puts_x(lbuf);
        crlf();
        return 1;
    }
    f_close(h);
    puts_c("wrote ");
    puts_x(lbuf);
    puts_c(" (");
    put_dec(len);
    puts_c(" bytes, load at 8000h)\n");
    return 1;
fail:
    put_dec(errs);
    puts_c(s_errs);
    return 0;
}
