/* DOS/51 - "nano"-like full screen editor (VT100).
 *
 * The text lives in a gap buffer in the TPA (8000h-F7FFh, 30K); the cut
 * buffer uses F800h-FFFFh.  Editing therefore overwrites whatever program
 * was loaded in upper RAM (like CP/M's TPA).
 */
#include "dos.h"

#define BS  ((xp)0x8000)
#define BE  ((xp)0xF800)
#define CB  ((xp)0xF800)
#define CBMAX 0x0800u

static __xdata xp gs, ge;            /* gap */
static __xdata u16 top;              /* logical offset of the top screen line */
static __xdata u16 cy, top_line;     /* cursor line, top line (0-based) */
static __xdata u8 want_col;
static __xdata u8 modified, redraw, cutting, cur_hoff, quit;
static __xdata u16 cb_len;
static __xdata char fname[FS_NAMELEN];
static __xdata char pbuf[40];
static __xdata u8 msg_shown;

#define R_NONE 0
#define R_LINE 1
#define R_ALL  2
#define R_FULL 3

static u8 rows(void) { return term_rows - 3; }

static u16 tlen(void) { return (gs - BS) + (BE - ge); }
static u16 curpos(void) { return gs - BS; }

static u8 at(u16 i)
{
    u16 a = gs - BS;
    return i < a ? BS[i] : ge[i - a];
}

/* ---- cursor/gap movement ---- */
static void move_left(void)
{
    if (gs > BS) {
        *--ge = *--gs;
        if (*ge == '\n')
            cy--;
    }
}

static void move_right(void)
{
    if (ge < BE) {
        if (*ge == '\n')
            cy++;
        *gs++ = *ge++;
    }
}

static void goto_pos(u16 p)
{
    while (curpos() > p)
        move_left();
    while (curpos() < p && ge < BE)
        move_right();
}

static u16 line_start(u16 p)
{
    while (p && at(p - 1) != '\n')
        p--;
    return p;
}

static u16 line_end(u16 p)
{
    u16 n = tlen();
    while (p < n && at(p) != '\n')
        p++;
    return p;
}

static u8 col_of(u16 ls, u16 p)
{
    u16 c = 0;
    while (ls < p) {
        if (at(ls++) == '\t')
            c = (c | 7) + 1;
        else
            c++;
        if (c > 250)
            return 250;
    }
    return c;
}

static u8 cur_col(void) { return col_of(line_start(curpos()), curpos()); }

/* move to visual column want_col within the line starting at ls */
static void to_col(u16 ls)
{
    u16 p = ls, n = tlen();
    u8 c = 0, nc;
    while (p < n && at(p) != '\n') {
        nc = at(p) == '\t' ? (c | 7) + 1 : c + 1;
        if (nc > want_col)
            break;
        c = nc;
        p++;
    }
    goto_pos(p);
}

static void line_up(void)
{
    u16 ls = line_start(curpos());
    if (!ls)
        return;
    goto_pos(line_start(ls - 1));
    to_col(curpos());
}

static void line_down(void)
{
    u16 le = line_end(curpos());
    if (le >= tlen())
        return;
    goto_pos(le + 1);
    to_col(curpos());
}

/* ---- drawing ---- */
static void draw_text_line(u16 p, u8 hoff, u8 cur)
{
    u16 n = tlen();
    u8 c = 0, w = term_cols, ch;
    (void)cur;
    while (p < n && (ch = at(p)) != '\n') {
        if (ch == '\t') {
            do {
                if (c >= hoff && c - hoff < w - 1)
                    putb(' ');
                c++;
            } while (c & 7);
        } else {
            if (c >= hoff && c - hoff < w - 1)
                putb(ch < 32 ? '?' : ch);
            c++;
        }
        p++;
        if (c - hoff >= w - 1 && c >= hoff) {
            if (p < n && at(p) != '\n')
                putb('$');
            break;
        }
    }
    vt_clreol();
}

static void draw_title(void)
{
    u8 i, l;
    vt_goto(0, 0);
    vt_inverse(1);
    puts_c("  DOS/51 nano  ");
    l = 15;
    puts_c("File: ");
    puts_x(fname);
    l += 6 + x_strlen(fname);
    if (modified) {
        puts_c("  [Modified]");
        l += 12;
    }
    for (i = l; i < term_cols; i++)
        putb(' ');
    vt_inverse(0);
}

static void draw_help(void)
{
    vt_goto(term_rows - 1, 0);
    vt_inverse(1);
    puts_c("^G");
    vt_inverse(0);
    puts_c(" Help ");
    vt_inverse(1);
    puts_c("^O");
    vt_inverse(0);
    puts_c(" Write ");
    vt_inverse(1);
    puts_c("^X");
    vt_inverse(0);
    puts_c(" Exit ");
    vt_inverse(1);
    puts_c("^K");
    vt_inverse(0);
    puts_c(" Cut ");
    vt_inverse(1);
    puts_c("^U");
    vt_inverse(0);
    puts_c(" Paste ");
    vt_inverse(1);
    puts_c("^W");
    vt_inverse(0);
    puts_c(" Find ");
    vt_inverse(1);
    puts_c("^T");
    vt_inverse(0);
    puts_c(" Line ");
    vt_inverse(1);
    puts_c("^R");
    vt_inverse(0);
    puts_c(" Read");
    vt_clreol();
}

static void status(cstr m)
{
    vt_goto(term_rows - 2, 0);
    vt_inverse(1);
    puts_c(" ");
    puts_c(m);
    puts_c(" ");
    vt_inverse(0);
    vt_clreol();
    msg_shown = 1;
}

static void clear_status(void)
{
    vt_goto(term_rows - 2, 0);
    vt_clreol();
    msg_shown = 0;
}

static void draw_all(void)
{
    u8 r;
    u16 p = top, n = tlen();
    u16 cl = line_start(curpos());
    for (r = 0; r < rows(); r++) {
        vt_goto(r + 1, 0);
        if (p > n) {
            vt_clreol();
            continue;
        }
        draw_text_line(p, p == cl ? cur_hoff : 0, p == cl);
        p = line_end(p) + 1;
    }
}

static void fix_scroll(void)
{
    u8 col = cur_col(), step = term_cols - 10, h;
    u16 p;
    h = col < term_cols - 1 ? 0 : (col / step) * step;
    if (h != cur_hoff) {
        cur_hoff = h;
        if (redraw < R_LINE)
            redraw = R_LINE;
    }
    if (cy < top_line || cy >= top_line + rows()) {
        /* centre the cursor line */
        h = rows() >> 1;
        top_line = cy > h ? cy - h : 0;
        p = line_start(curpos());
        h = cy - top_line;
        while (h--)
            p = line_start(p - 1);
        top = p;
        if (redraw < R_ALL)
            redraw = R_ALL;
    }
}

static void place_cursor(void)
{
    vt_goto(cy - top_line + 1, cur_col() - cur_hoff);
}

static void render(void)
{
    if (redraw == R_FULL) {
        vt_clear();
        draw_title();
        draw_help();
        if (msg_shown)
            clear_status();
    }
    if (redraw >= R_ALL)
        draw_all();
    else if (redraw == R_LINE) {
        vt_goto(cy - top_line + 1, 0);
        draw_text_line(line_start(curpos()), cur_hoff, 1);
    }
    redraw = R_NONE;
    place_cursor();
}

/* ---- prompt in the status line; returns length, 0xFF if cancelled ---- */
static u8 prompt(cstr label, char __xdata *buf, u8 max)
{
    u8 n = x_strlen(buf), k;
    vt_goto(term_rows - 2, 0);
    vt_inverse(1);
    puts_c(label);
    puts_x(buf);
    for (;;) {
        k = getkey();
        if (k == '\r')
            break;
        if (k == 3 || k == 27 || k == 7) {
            vt_inverse(0);
            clear_status();
            return 0xFF;
        }
        if (k == 8 && n) {
            n--;
            puts_c("\b \b");
        } else if (k >= 32 && k < 127 && n < max - 1) {
            buf[n++] = k;
            putb(k);
        }
    }
    buf[n] = 0;
    vt_inverse(0);
    clear_status();
    return n;
}

/* ---- editing ---- */
static void ins(u8 c)
{
    if (gs >= ge) {
        status("Buffer full");
        return;
    }
    *gs++ = c;
    modified = 1;
    if (c == '\n') {
        cy++;
        redraw = R_ALL;
    }
}

static u8 save_as(const char __xdata *n)
{
    u8 h = f_open(n, 'w');
    if (h == 0xFF) {
        status("Cannot write file");
        return 0;
    }
    if (f_write(h, BS, gs - BS) || f_write(h, ge, BE - ge)) {
        f_close(h);
        fs_delete(n);
        status("Disk full - not saved");
        return 0;
    }
    f_close(h);
    x_strcpy(fname, n);
    modified = 0;
    draw_title();
    vt_goto(term_rows - 2, 0);
    vt_inverse(1);
    puts_c(" Wrote ");
    put_dec(tlen());
    puts_c(" bytes ");
    vt_inverse(0);
    vt_clreol();
    msg_shown = 1;
    return 1;
}

static u8 write_out(void)
{
    x_strcpy(pbuf, fname);
    if (prompt("File Name to Write: ", pbuf, FS_NAMELEN) == 0xFF)
        return 0;
    if (!fs_name_ok(pbuf)) {
        status("Bad file name");
        return 0;
    }
    return save_as(pbuf);
}

static void cut_line(void)
{
    u16 ls = line_start(curpos()), le = line_end(curpos()), n;
    if (!cutting)
        cb_len = 0;
    if (le < tlen())
        le++;                        /* include newline */
    n = le - ls;
    if (!n)
        return;
    goto_pos(ls);
    /* gap now at line start: line text is at ge.. */
    if (cb_len + n <= CBMAX) {
        x_memmove(CB + cb_len, ge, n);
        cb_len += n;
    } else
        status("Cut buffer full");
    ge += n;
    modified = 1;
    cutting = 1;
    redraw = R_ALL;
}

static void paste(void)
{
    if (!cb_len)
        return;
    if ((u16)(ge - gs) < cb_len) {
        status("Buffer full");
        return;
    }
    {
        u16 i;
        for (i = 0; i < cb_len; i++) {
            if (CB[i] == '\n')
                cy++;
            *gs++ = CB[i];
        }
    }
    modified = 1;
    redraw = R_ALL;
}

static void find(void)
{
    static __xdata char pat[30];
    u8 pl, i;
    u16 n = tlen(), p, cnt;
    if (prompt("Search: ", pat, sizeof(pat)) == 0xFF || !pat[0])
        return;
    pl = x_strlen(pat);
    p = curpos() + 1;
    for (cnt = 0; n >= pl && cnt <= n; cnt++, p++) {
        if (p + pl > n)
            p = 0;
        for (i = 0; i < pl && at(p + i) == pat[i]; i++)
            ;
        if (i == pl) {
            goto_pos(p);
            want_col = cur_col();
            return;
        }
    }
    status("Not found");
}

static __xdata u16 gl_line;

static void goto_line(void)
{
    u16 l;
    pbuf[0] = 0;
    if (prompt("Enter line number: ", pbuf, 8) == 0xFF || !parse_num(pbuf, &gl_line))
        return;
    l = gl_line;
    if (l)
        l--;
    goto_pos(0);
    cy = 0;
    while (cy < l && ge < BE)
        move_right();
    goto_pos(line_start(curpos()));
    want_col = 0;
}

static void read_file(void)
{
    u8 h;
    u16 n, i;
    xp d;
    pbuf[0] = 0;
    if (prompt("File to insert: ", pbuf, FS_NAMELEN) == 0xFF)
        return;
    h = f_open(pbuf, 'r');
    if (h == 0xFF) {
        status("File not found");
        return;
    }
    n = f_size(h);
    d = f_data(h);
    if ((u16)(ge - gs) < n)
        status("Buffer full");
    else {
        for (i = 0; i < n; i++) {
            if (d[i] == '\n')
                cy++;
            *gs++ = d[i];
        }
        modified = 1;
        redraw = R_ALL;
    }
    f_close(h);
}

static void cur_pos(void)
{
    u16 lines = 0, i, n = tlen();
    for (i = 0; i < n; i++)
        if (at(i) == '\n')
            lines++;
    vt_goto(term_rows - 2, 0);
    vt_inverse(1);
    puts_c(" line ");
    put_dec(cy + 1);
    putb('/');
    put_dec(lines + 1);
    puts_c(", col ");
    put_dec(cur_col() + 1);
    puts_c(", char ");
    put_dec(curpos() + 1);
    putb('/');
    put_dec(n + 1);
    puts_c(", free ");
    put_dec(ge - gs);
    putb(' ');
    vt_inverse(0);
    vt_clreol();
    msg_shown = 1;
}

static void help_screen(void)
{
    vt_clear();
    puts_c("DOS/51 nano help\n\n"
           "  ^X  Exit (asks to save)        ^O  Write out (save as)\n"
           "  ^K  Cut line (repeat = more)   ^U  Paste cut lines\n"
           "  ^W  Search forward             ^T or ^_  Go to line\n"
           "  ^R  Insert a file              ^C  Show cursor position\n"
           "  ^A / Home  Start of line       ^E / End  End of line\n"
           "  ^Y / PgUp  Page up             ^V / PgDn Page down\n"
           "  ^P ^N ^B ^F or arrows  Move    ^D / Del  Delete char\n"
           "  ^H / Backspace  Delete left    ^L  Redraw screen\n"
           "  Tab inserts a TAB (shown at 8 column stops)\n\n"
           "The text buffer occupies the TPA (8000h-FFFFh): reload or\n"
           "re-assemble programs after editing.\n\n"
           "Press any key...");
    getkey();
    redraw = R_FULL;
}

static void exit_editor(void)
{
    u8 k;
    if (!modified) {
        quit = 1;
        return;
    }
    status("Save modified buffer?  Y Yes  N No  ^C Cancel");
    for (;;) {
        k = getkey();
        if (k == 'y' || k == 'Y') {
            if (fname[0] ? save_as(fname) : write_out())
                quit = 1;
            return;
        }
        if (k == 'n' || k == 'N') {
            quit = 1;
            return;
        }
        if (k == 3 || k == 27) {
            clear_status();
            return;
        }
    }
}

static void key(u8 k)
{
    u8 i;
    u16 oldy = cy;
    if (k != 11)
        cutting = 0;
    if (msg_shown && k != 3)
        clear_status();
    switch (k) {
    case K_LEFT: case 2:
        move_left();
        want_col = cur_col();
        break;
    case K_RIGHT: case 6:
        move_right();
        want_col = cur_col();
        break;
    case K_UP: case 16:
        line_up();
        break;
    case K_DOWN: case 14:
        line_down();
        break;
    case K_HOME: case 1:
        goto_pos(line_start(curpos()));
        want_col = 0;
        break;
    case K_END: case 5:
        goto_pos(line_end(curpos()));
        want_col = cur_col();
        break;
    case K_PGUP: case 25:
        for (i = 0; i < rows() - 1; i++)
            line_up();
        break;
    case K_PGDN: case 22:
        for (i = 0; i < rows() - 1; i++)
            line_down();
        break;
    case 8:                          /* backspace */
        if (gs > BS) {
            if (gs[-1] == '\n') {
                cy--;
                redraw = R_ALL;
            } else if (redraw < R_LINE)
                redraw = R_LINE;
            gs--;
            modified = 1;
        }
        want_col = cur_col();
        break;
    case K_DEL: case 4:
        if (ge < BE) {
            if (*ge == '\n')
                redraw = R_ALL;
            else if (redraw < R_LINE)
                redraw = R_LINE;
            ge++;
            modified = 1;
        }
        break;
    case '\r':
        ins('\n');
        want_col = 0;
        break;
    case '\n':
        break;                       /* ignore LF of CR/LF pairs */
    case 11:
        cut_line();
        want_col = 0;
        break;
    case 21:
        paste();
        break;
    case 23:
        find();
        break;
    case 20: case 31:
        goto_line();
        break;
    case 18:
        read_file();
        break;
    case 15:
        write_out();
        break;
    case 24:
        exit_editor();
        break;
    case 7:
        help_screen();
        break;
    case 3:
        cur_pos();
        break;
    case 12:
        redraw = R_FULL;
        break;
    case 9:
    default:
        if (k == 9 || (k >= 32 && k < 127)) {
            /* fast path: typing at the end of a short line */
            ins(k);
            if (k != 9 && redraw == R_NONE && cur_hoff == 0
                && (ge == BE || *ge == '\n') && cur_col() < term_cols - 2
                && !kbhit()) {
                vt_goto(cy - top_line + 1, cur_col() - 1);
                putb(k);
            } else if (redraw < R_LINE)
                redraw = R_LINE;
            want_col = cur_col();
        }
        break;
    }
    if (cy != oldy && cur_hoff && redraw < R_ALL)
        redraw = R_ALL;              /* previous line was scrolled */
}

void editor(const char __xdata *name)
{
    u8 h, n;
    u16 sz;
    x_strcpy(fname, name);
    gs = BS;
    ge = BE;
    h = f_open(name, 'r');
    if (h != 0xFF) {
        sz = f_size(h);
        if (sz > (u16)(BE - BS))
            sz = BE - BS;
        ge = BE - sz;
        x_memmove(ge, f_data(h), sz);
        f_close(h);
    }
    top = 0;
    cy = top_line = 0;
    want_col = 0;
    modified = cutting = cur_hoff = quit = 0;
    cb_len = 0;
    msg_shown = 0;
    redraw = R_FULL;
    render();
    if (h == 0xFF)
        status("New File");
    place_cursor();
    while (!quit) {
        n = 0;
        do {
            u8 m = modified;
            key(getkey());
            if (m != modified)
                draw_title();
        } while (!quit && kbhit() && ++n < 200);
        if (quit)
            break;
        fix_scroll();
        render();
    }
    vt_clear();
}
