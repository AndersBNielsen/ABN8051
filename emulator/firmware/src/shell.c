/* DOS/51 - command shell */
#include "dos.h"

#define LINEMAX 80
#define MAXARGS 10
#define NHIST   8

__xdata char line[LINEMAX];            /* also used by shell51.asm */
__xdata char hist[NHIST * LINEMAX];

__xdata u8 hist_n;
char __xdata * __xdata argv[MAXARGS];     /* also used by sd51.asm */
__xdata u8 argc;
__xdata char user_args[80];

void err(cstr what, const char __xdata *arg)
{
    puts_c(what);
    if (arg) {
        puts_c(": ");
        puts_x(arg);
    }
    crlf();
}

/* shell51.asm */
extern __code const char s_cant[], s_nofile[];
static void err_nf(const char __xdata *n) { err(s_nofile, n); }
void cmd_echo(void);
void cmd_grep(void);
void cmd_ls(void);
void cmd_wc(void);
void cmd_paste(void);
void read_line(void);
void tokenize(void);
u8 complete(u8 n);
void dump(u16 a, u16 len, u8 code);

/* ---------------- line input with history and tab completion -------- */

u8 complete(u8 n)
{
    u8 s = n, i, j, hits = 0, best = 0, pl;
    dirent_t __xdata *d, *first = 0;
    while (s && line[s - 1] != ' ')
        s--;
    pl = n - s;
    for (i = 0; i < FS_NDIR; i++) {
        d = fs_dir(i);
        if (!d)
            continue;
        for (j = 0; j < pl && d->name[j] == line[s + j]; j++)
            ;
        if (j < pl)
            continue;
        if (!hits) {
            first = d;
            best = x_strlen(d->name);
        } else {
            /* common prefix length */
            for (j = pl; j < best && first->name[j] == d->name[j]; j++)
                ;
            best = j;
        }
        hits++;
    }
    if (!hits)
        return n;
    for (j = pl; j < best && n < LINEMAX - 2; j++) {
        line[n++] = first->name[j];
        putb(first->name[j]);
    }
    if (hits == 1 && n < LINEMAX - 2) {
        line[n++] = ' ';
        putb(' ');
    }
    return n;
}



/* ---------------- commands ---------------- */

static void cmd_help(void)
{
    puts_c(
        "Files:   ls [-l]  cat F..  rm F..  mv A B  cp A B  touch F  wc F\n"
        "         grep PAT F  hexdump F  df  format  examples\n"
        "Edit:    nano F (alias edit)\n"
        "Build:   asm [-l] [-n] [-r] F.asm   (assembles into upper RAM 8000h+)\n"
        "Run:     run [F.bin] [args]  run (TPA)  go ADDR  NAME [args]\n"
        "SD card: sdls  sdget NAME [F]  sdput F [NAME]  sdrm NAME\n"
        "Serial:  rx F (XMODEM receive)  sx F (XMODEM send)  paste F (text, ^D ends)\n"
        "Memory:  mem [-c] ADDR [LEN]  poke ADDR B..  free\n"
        "Other:   echo TEXT [> F]  clear  stty [ROWS COLS]  ver  reboot  help\n"
        "Keys:    Up/Down history, Tab completes file names, ^C aborts programs\n");
}


static void cmd_df(void)
{
    puts_c("Filesystem  Size   Used   Free  Files\nramdisk    ");
    put_dec_w(DISK_END - DISK_BASE, 5);
    put_dec_w(fs_used(), 7);
    put_dec_w(fs_free(), 7);
    put_dec_w(fs_count(), 4);
    puts_c("/32\n");
}

static void cmd_free(void)
{
    puts_c("0000-7FFF ROM    DOS/51 (code)\n"
           "0000-1FFF RAM0   DOS work area\n"
           "2000-7FFF RAM0   RAM disk, ");
    put_dec(fs_free());
    puts_c(" bytes free\n"
           "8000-FFFF RAM1   TPA, code+data, 32768 bytes\n"
           "IRAM 08-2F free for programs (banks 1-3, bits), stack shared\n");
}

static void cat_file(const char __xdata *n)
{
    u8 h = f_open(n, 'r');
    int c;
    if (h == 0xFF) {
        err_nf(n);
        return;
    }
    brk_flag = 0;
    while ((c = f_getc(h)) >= 0 && !brk_flag)
        putch(c);
    f_close(h);
}

static void cmd_cat(void)
{
    u8 i;
    for (i = 1; i < argc; i++)
        cat_file(argv[i]);
}

static void cmd_rm(void)
{
    u8 i;
    for (i = 1; i < argc; i++)
        if (fs_delete(argv[i]))
            err_nf(argv[i]);
}

static void cmd_cp(void)
{
    u8 h, w;
    if (argc != 3) {
        err("usage: cp FROM TO", 0);
        return;
    }
    if (!x_strcmp(argv[1], argv[2]))
        return;
    h = f_open(argv[1], 'r');
    if (h == 0xFF) {
        err_nf(argv[1]);
        return;
    }
    w = f_open(argv[2], 'w');
    if (w == 0xFF) {
        f_close(h);
        err(s_cant, argv[2]);
        return;
    }
    /* source may have moved when an old destination was deleted */
    if (f_write(w, f_data(h), f_size(h)))
        puts_c(fs_err_full);
    f_close(w);
    f_close(h);
}

static void cmd_mv(void)
{
    u8 r;
    if (argc != 3) {
        err("usage: mv FROM TO", 0);
        return;
    }
    r = fs_rename(argv[1], argv[2]);
    if (r == 1)
        err_nf(argv[1]);
    else if (r)
        err("bad name", argv[2]);
}

static void cmd_touch(void)
{
    u8 h;
    if (argc < 2 || fs_find(argv[1]) >= 0)
        return;
    h = f_open(argv[1], 'w');
    if (h == 0xFF)
        err(s_cant, argv[1]);
    f_close(h);
}




static void cmd_hexdump(void)
{
    u8 h;
    if (argc < 2 || (h = f_open(argv[1], 'r')) == 0xFF) {
        err_nf(argc > 1 ? argv[1] : 0);
        return;
    }
    dump((u16)f_data(h), f_size(h), 0);
    f_close(h);
}

static __xdata u16 num1, num2;

static void cmd_mem(void)
{
    u8 i = 1, code = 0;
    if (argc > 1 && x_streq_c(argv[1], "-c")) {
        code = 1;
        i++;
    }
    if (argc <= i || !parse_num(argv[i], &num1)) {
        err("usage: mem [-c] ADDR [LEN]", 0);
        return;
    }
    num2 = 128;
    if (argc > i + 1)
        parse_num(argv[i + 1], &num2);
    dump(num1, num2, code);
}

static void cmd_poke(void)
{
    u8 i;
    if (argc < 3 || !parse_num(argv[1], &num1)) {
        err("usage: poke ADDR BYTE..", 0);
        return;
    }
    for (i = 2; i < argc; i++) {
        if (!parse_num(argv[i], &num2)) {
            err("bad number", argv[i]);
            return;
        }
        *(xp)num1++ = num2;
    }
}



static void cmd_stty(void)
{
    if (argc == 3 && parse_num(argv[1], &num1) && parse_num(argv[2], &num2)
        && num1 >= 8 && num1 <= 100 && num2 >= 32 && num2 <= 200) {
        term_rows = num1;
        term_cols = num2;
    }
    puts_c("rows ");
    put_dec(term_rows);
    puts_c(" cols ");
    put_dec(term_cols);
    puts_c(" 19200 8N1\n");
}

static void cmd_ver(void)
{
    puts_c("DOS/51 " DOS_VERSION " for 80C31 @ 11.0592 MHz, 32K ROM, 2x32K RAM\n");
}

static u8 confirm(cstr q)
{
    u8 c;
    puts_c(q);
    puts_c(" [y/N] ");
    c = getch();
    putb(c >= 32 ? c : ' ');
    crlf();
    return c == 'y' || c == 'Y';
}

/* ---------------- running programs ---------------- */

void sys_restore(void)
{
    EA = 0;
    P2 = PDATA_PAGE;
    IE = 0x10;                       /* ES only */
    IP = 0;
    PSW = 0;
    TR0 = 0;
    TMOD = (TMOD & 0x0F) | 0x20;
    TH1 = 0xFD;
    PCON |= 0x80;
    SCON = (SCON & 0x03) | 0x50;
    TR1 = 1;
    EA = 1;
    f_closeall();
}

static void exec_at(u16 a)
{
    u8 r;
    r = run_user(a);
    sys_restore();
    if (r)
        puts_c("\n^C - program aborted\n");
}

static u8 has_ext(const char __xdata *n, cstr ext)
{
    u8 l = x_strlen(n), e = 0;
    while (ext[e])
        e++;
    if (l <= e)
        return 0;
    return x_streq_c(n + l - e, ext);
}

/* load NAME into the TPA and run; 0 if the file does not exist */
static u8 run_file(const char __xdata *n)
{
    u8 h;
    u16 sz;
    h = f_open(n, 'r');
    if (h == 0xFF)
        return 0;
    sz = f_size(h);
    x_memmove((xp)TPA_BASE, f_data(h), sz);
    f_close(h);
    exec_at(TPA_BASE);
    return 1;
}

/* drop the first word of user_args ("run F args" -> "args") */
static void shift_args(void)
{
    char __xdata *p = user_args;
    while (*p && *p != ' ')
        p++;
    while (*p == ' ')
        p++;
    x_strcpy(user_args, p);
}

static void cmd_run(void)
{
    if (argc < 2) {
        exec_at(TPA_BASE);
        return;
    }
    shift_args();
    if (!run_file(argv[1]))
        err_nf(argv[1]);
}

static void cmd_go(void)
{
    if (argc < 2 || !parse_num(argv[1], &num1)) {
        err("usage: go ADDR", 0);
        return;
    }
    shift_args();
    exec_at(num1);
}

static void cmd_asm(void)
{
    u8 i, fl = 0;
    const char __xdata *f = 0;
    for (i = 1; i < argc; i++) {
        if (x_streq_c(argv[i], "-l"))
            fl |= ASM_LIST;
        else if (x_streq_c(argv[i], "-n"))
            fl |= ASM_NOSAVE;
        else if (x_streq_c(argv[i], "-r"))
            fl |= ASM_RUN;
        else
            f = argv[i];
    }
    if (!f) {
        err("usage: asm [-l] [-n] [-r] FILE.asm", 0);
        return;
    }
    user_args[0] = 0;
    if (assemble(f, fl) && (fl & ASM_RUN))
        exec_at(TPA_BASE);
}

typedef void (*cmdfn)(void);
typedef struct {
    cstr name;
    cmdfn fn;
} cmd_t;

static void cmd_clear(void) { vt_clear(); }
static void cmd_edit(void)
{
    if (argc < 2 || !fs_name_ok(argv[1])) {
        err("usage: nano FILE", 0);
        return;
    }
    editor(argv[1]);
}
static void cmd_rx(void)
{
    if (argc < 2 || !fs_name_ok(argv[1])) {
        err("usage: rx FILE", 0);
        return;
    }
    xmodem_recv(argv[1]);
}
static void cmd_sx(void)
{
    if (argc < 2 || fs_find(argv[1]) < 0) {
        err_nf(argc > 1 ? argv[1] : 0);
        return;
    }
    xmodem_send(argv[1]);
}
static void cmd_format(void)
{
    if (confirm("Erase all files?")) {
        fs_format();
        puts_c("formatted\n");
    }
}
static void cmd_examples(void) { examples_install(argc > 1 && x_streq_c(argv[1], "-f")); }
static void cmd_reboot(void)
{
    EA = 0;
    __asm
        mov     sp, #7
        ljmp    0
    __endasm;
}

static __code const cmd_t cmds[] = {
    {"help", cmd_help},       {"?", cmd_help},
    {"ls", cmd_ls},           {"dir", cmd_ls},
    {"cat", cmd_cat},         {"type", cmd_cat},
    {"rm", cmd_rm},           {"del", cmd_rm},
    {"cp", cmd_cp},           {"mv", cmd_mv},
    {"touch", cmd_touch},     {"wc", cmd_wc},
    {"grep", cmd_grep},       {"hexdump", cmd_hexdump},
    {"df", cmd_df},           {"free", cmd_free},
    {"mem", cmd_mem},         {"poke", cmd_poke},
    {"echo", cmd_echo},       {"paste", cmd_paste},
    {"nano", cmd_edit},       {"edit", cmd_edit},
    {"asm", cmd_asm},         {"run", cmd_run},
    {"go", cmd_go},           {"rx", cmd_rx},
    {"sx", cmd_sx},           {"clear", cmd_clear},
    {"cls", cmd_clear},       {"stty", cmd_stty},
    {"ver", cmd_ver},         {"uname", cmd_ver},
    {"format", cmd_format},   {"examples", cmd_examples},
    {"reboot", cmd_reboot},
    {"sdls", sd_ls},         {"sdget", sd_get},
    {"sdput", sd_put},       {"sdrm", sd_rm},
};

__xdata char ex_name[FS_NAMELEN + 4];

static u8 try_ext(cstr ext)
{
    u8 l;
    x_strcpy(ex_name, argv[0]);
    l = x_strlen(ex_name);
    while ((ex_name[l++] = *ext++))
        ;
    return run_file(ex_name);
}

static void execute(void)
{
    u8 i;
    cmd_t __code *c;
    tokenize();
    if (!argc)
        return;
    for (i = 0, c = cmds; i < sizeof(cmds) / sizeof(cmds[0]); i++, c++) {
        if (x_streq_c(argv[0], c->name)) {
            c->fn();
            return;
        }
    }
    /* program by name: NAME.bin or NAME */
    if (x_strlen(argv[0]) < FS_NAMELEN) {
        if (fs_find(argv[0]) >= 0 && has_ext(argv[0], ".bin")) {
            run_file(argv[0]);
            return;
        }
        if (x_strlen(argv[0]) + 4 < FS_NAMELEN) {
            if (try_ext(".bin"))
                return;
        }
    }
    puts_x(argv[0]);
    puts_c(": command not found (try help)\n");
}

void shell(void)
{
    for (;;) {
        read_line();
        execute();
    }
}
