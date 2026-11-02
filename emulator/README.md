# DOS/51

A serial DOS and 80C31 emulator for a ROM-less 8051 board with an 11.0592 MHz crystal, one 32 KiB ROM and two 32 KiB RAM chips. The upper RAM is mapped into both XDATA and CODE, so DOS/51 can assemble, load and execute programs there. The firmware is built with SDCC 4.x; its size-critical file system, assembler, XMODEM and runtime code is in 8051 assembly.

## Build and run

Requirements: Node.js 20+, Python 3, GNU Make, SDCC 4.x (`sdcc`, `sdas8051`).

```sh
make -C firmware                 # firmware/build/dos51.ihx and dos51.bin (32,768 bytes)
npm test                         # emulator, SD card model, firmware and end-to-end tests
node bin/dos51.js                # VT100 serial console, 57600 baud
node bin/dos51.js --sd card.img  # ... with an SD card image (created blank if missing)
```

The CLI loads `firmware/build/dos51.ihx` by default; `--rom FILE` accepts Intel HEX or a raw binary. `--state FILE` persists both RAM chips between runs, `--baud-pacing flow` helps with bulk pasted text, and `--tcp PORT` exposes the serial console on localhost. The CLI runs the board at real-time speed. Type DOS commands directly. Press **Ctrl-]** for host commands: `u HOSTFILE` (XMODEM upload), `d HOSTFILE` (XMODEM download, stripping trailing CPM padding), `d! HOSTFILE` (keep padding), `r` (reset), `p` (power-cycle/clear RAM), `x` (toggle input pacing), `q` (quit). For example, type `rx foo.asm` at the DOS prompt, then Ctrl-] and `u foo.asm`. To download, type `sx foo.asm`, then Ctrl-] and `d foo.asm`.

`--sd FILE` attaches an SD card on P1.4–P1.7. The image is loaded into memory and every sector the board writes goes straight back to FILE, so it can be inspected with mtools, a loop mount or `scripts/fatimg.py` (see below). A missing FILE is created as a blank card: FAT16 in one MBR partition of `--sd-size` MiB (default 32), or FAT32 with `--sd-fat 32` (at least 33 MiB). `--sdsc` emulates a byte-addressed standard capacity card instead of SDHC.

For a TCP-backed pseudo-terminal, run `node bin/dos51.js --tcp 8051` and connect with `socat pty,link=/tmp/ttyDOS51,raw,echo=0 tcp:localhost:8051`. The `--state` file is a host-side emulator snapshot, not a disk image for physical hardware.

## DOS commands

| Task | Commands |
| --- | --- |
| Files | `ls [-l]`, `cat FILE...`, `touch FILE`, `cp SRC DST`, `mv SRC DST`, `rm FILE...`, `wc FILE`, `grep PAT FILE`, `hexdump FILE`, `df` |
| Text | `echo TEXT [> FILE]`, `paste FILE` (finish with Ctrl-D), `nano FILE` / `edit FILE` |
| Build/run | `asm [-l] [-n] [-r] FILE.asm`, `run [FILE.bin] [args]`, `go ADDRESS`, `NAME [args]` (loads `NAME.bin`) |
| Memory | `mem [-c] ADDRESS [LENGTH]` (`-c` reads CODE), `poke ADDRESS BYTE...` (XDATA), `free` |
| System | `help`, `ver`, `clear`, `stty [ROWS COLS]`, `examples [-f]`, `format`, `reboot` |
| Transfer | `rx FILE` (XMODEM receive), `sx FILE` (XMODEM send) |
| SD card | `sdls`, `sdget NAME [FILE]`, `sdput FILE [NAME]`, `sdrm NAME` (FAT16/FAT32 root directory) |

`asm` is two-pass and assembles into executable upper RAM starting at 8000h. By default it also saves the image as a `.bin` file; `-l` prints a source/hex listing, `-n` skips saving, and `-r` runs after success. `run` with no file restarts the image already in upper RAM. `format` erases the RAM disk; `examples -f` reinstalls the bundled examples (they are stored compressed; if the RAM disk has less than about 8.7 KB free, `examples` unpacks them in upper RAM, replacing the loaded program). File names are at most 11 characters (including extension). RAM survives reset, but not power loss unless battery-backed or saved with the emulator's `--state` option. Ctrl-C aborts a running program.

## SD card

The board has an SD card socket on P1.4–P1.7 (bit-banged SPI, see [`docs/HARDWARE.md`](docs/HARDWARE.md)). DOS/51 reads and writes the root directory of a FAT16 or FAT32 volume, so cards move between the board and a PC. The volume is the first partition of an MBR partition table, or a "superfloppy" volume starting at sector 0. SDSC (byte addressed) and SDHC/SDXC (block addressed) cards both work; exFAT, the usual format of new SDXC cards above 32 GB, does not, so format such cards FAT32.

| Command | Action |
| --- | --- |
| `sdls` | list the root directory: 8.3 names in lower case and sizes; `<DIR>` marks subdirectories |
| `sdget NAME [FILE]` | copy card file NAME into the RAM disk as FILE (default: NAME as typed) |
| `sdput FILE [NAME]` | copy RAM disk FILE to the card as NAME (default: FILE), replacing an older NAME |
| `sdrm NAME` | delete card file NAME |

Name conversion: a card name is written `BASE.EXT` with 1–8 characters before the dot and 0–3 after it; letters are converted to upper case for the card and matching is case-insensitive. `sdls` shows names in lower case. DOS/51 names (up to 11 characters of `A-Z a-z 0-9 . _ -`) that fit this pattern, such as `hello.asm`, are used unchanged; others need the explicit second argument: `sdput longnamex.s long.s`. In the other direction a card name is used as the RAM disk name unless FILE is given, so a card name that is not a valid DOS/51 name (`readme~1.txt`) needs one: `sdget readme~1.txt readme.txt`.

The card is mounted afresh by every command, so cards can be swapped at the prompt. `sdput` allocates clusters first-fit, updates every FAT copy, zero-pads the last sector and writes the directory entry last; if the card fills up it frees what it allocated and reports `card full`. Limitations: root directory only (no subdirectories, which are listed but cannot be copied or deleted; a full FAT32 root cluster chain is not extended), long file names are ignored and not created, FAT12 volumes (cards below about 8 MB) are refused, files are dated 1980-01-01, read-only attributes are not honoured, and FAT32 writes mark the FSInfo free-cluster count as unknown instead of updating it. Files larger than the free RAM disk space cannot be fetched. Transfer speed at 11.0592 MHz is about 8 KiB/s for `sdput` and 6 KiB/s for `sdget` (FAT16, 2 KiB clusters; one block is read or written in about 45 ms).

Programs can use the card through the `SDINIT`, `SDREAD` and `SDWRITE` system calls (raw 512-byte sectors; see the ABI table). `scripts/fatimg.py IMAGE ls|get|put|rm|check` reads and writes card images on the host without mtools, and `check` verifies both FATs, cluster chains and lost clusters.

## Editor

`nano FILE` opens a full-screen VT100 editor. Text is kept in a gap buffer in upper RAM, so opening the editor replaces the currently loaded program. Cursor keys or Ctrl-P/N/B/F move; Home/End or Ctrl-A/E go to line ends; Page Up/Down or Ctrl-Y/V scroll. Ctrl-O writes out, Ctrl-X exits (asks to save if modified), Ctrl-K cuts lines, Ctrl-U pastes, Ctrl-W searches, Ctrl-T or Ctrl-_ goes to a line, Ctrl-R inserts another file, Ctrl-C shows position, Ctrl-L redraws and Ctrl-G shows help. Backspace and Ctrl-D/Delete remove characters. Set terminal dimensions with `stty ROWS COLS` if needed.

## Self-hosted assembler

Source files are plain text in the RAM disk. The assembler accepts the standard 8051 instruction set, labels (`name:`), forward references, decimal and `0x`/`$`/`h` hex, `b` binary and `o` octal numbers, character and quoted strings, and `;` comments. It is case-insensitive outside strings. Expressions support parentheses, unary minus and `NOT`/`~`, `HIGH`/`LOW`, arithmetic, shifts, bitwise operators, and `byte.bit` notation. `$` is the current location. `JMP` and `CALL` are long jumps/calls; use explicit `SJMP`, `AJMP` or `ACALL` when those encodings are wanted.

Directives include `ORG`, `DB`/`DW` (and `DEFB`/`DEFW`), `DS`, `EQU`, `SET` or `=`, `DATA`, `IDATA`, `XDATA`, `CODE`, `BIT`, `REG`, `INCLUDE "file"` (up to four source levels), and `END`. `MODULE`, `TITLE`, `LIST`, `NOLIST`, `USING`, `CSEG` and `AREA` are accepted compatibility directives. The symbol table holds 255 names; source lines are limited to 127 characters. Errors include file name, line number and source line. Code must fit 8000h–FFFFh. `DS` gaps are zero-filled in the saved image; `.bin` always starts at 8000h, so an `ORG` above that creates a leading gap.

The ROM installs `hello.asm`, `blink.asm`, `timer.asm`, `button.asm`, `upper.asm`, `primes.asm`, `files.asm` and `readme.txt` when it first formats RAM. Try `asm -r hello.asm`; inspect source with `cat hello.asm`. All seven assembly examples are assembled and executed in the end-to-end tests, including serial output, GPIO/interrupts and file I/O. `blink` and `button` drive four LEDs on P1.0–P1.3 and leave P1.4–P1.7 (the SD card) alone.

### DropBlocks (separate SD-card game)

[`games/dropblk.asm`](games/dropblk.asm) is a 10×20 VT100/ANSI DropBlocks game for the self-hosted assembler. It is **not stored in the 32 KiB ROM**. New browser visitors get `dropblk.asm` on their virtual FAT16 SD card; returning visitors can use **Add DropBlocks to SD**, which leaves existing card files untouched and will not overwrite an existing `dropblk.asm`. On DOS/51, run:

```text
sdget dropblk.asm
asm -r dropblk.asm
```

The source also works on a real DOS/51 board: copy it to a FAT16 card, or upload it to the RAM disk with `rx dropblk.asm`/the browser’s **Upload file…** control. The RAM disk has room for the 9.1 KiB source and 1373-byte assembled program on a freshly formatted machine. `sdput dropblk.asm` saves an uploaded copy to the SD card. The browser page also offers a direct source download.

Controls: arrows or A/D for left/right, W/Up rotate, S/Down soft drop, Space hard drop, P pause, Q or Esc quit. H/J/K/L also work as movement alternatives. Pieces use coloured `[]` blocks; gravity accelerates with level, and score/lines/next piece are shown alongside the board.

## Program ABI and memory

A user program starts at 8000h and can end with `RET` or `LJMP 7F00h` (`EXIT`). `run FILE.bin` copies the file to 8000h before starting it. The ROM forwards hardware interrupt vectors to 8003h (INT0), 800Bh (Timer 0), 8013h (INT1), and 801Bh (Timer 1); put jumps there if the program uses them. Keep Timer 1 configured for the serial baud clock and leave serial interrupts enabled for console I/O. User internal RAM is 08h–2Fh; DOS keeps 30h–3Ah and uses the stack above 3Ah. Programs may use upper XDATA beyond their code, but should avoid overwriting live instructions.

System calls are `LCALL` targets in the fixed ROM jump table. Except for documented results, calls preserve R0–R7 (including register-bank selection), B and DPTR. Most preserve A; read the return convention below. File-call wrappers use shared DOS scratch and must not be called recursively or from an interrupt handler. Simple console calls may be used in handlers. See [`firmware/src/syscalls.asm`](firmware/src/syscalls.asm) and the examples for exact usage.

| Address | Name | Input / result |
| --- | --- | --- |
| 7F00h | EXIT | Return to DOS |
| 7F03h | PUTC | A = character (LF expands to CR LF) |
| 7F06h | GETC | Wait for key, A = character |
| 7F09h | KBHIT | A = 1, C = 1 if key waiting |
| 7F0Ch | PUTS | DPTR = NUL-terminated XDATA string |
| 7F0Fh | PUTHEX | A = byte to print as hex |
| 7F12h | PUTHEX16 | DPTR = word to print as hex |
| 7F15h | PUTDEC | DPTR = unsigned word to print as decimal |
| 7F18h | CRLF | Print newline |
| 7F1Bh | GETLINE | DPTR = XDATA buffer, R7 = size; A = length |
| 7F1Eh | DELAY | DPTR = milliseconds |
| 7F21h | ARGS | DPTR = XDATA command-line arguments |
| 7F24h | FOPEN | DPTR = XDATA name, A = `r`/`w`; A = handle, C = error |
| 7F27h | FGETC | A = handle; A = byte, C = EOF |
| 7F2Ah | FPUTC | A = byte, B = handle; C = error |
| 7F2Dh | FCLOSE | A = handle |
| 7F30h | PUTSI | Inline NUL string immediately after `LCALL PUTSI` |
| 7F33h | GETKEY | A = decoded key (arrows 80h–89h) |
| 7F36h | PUTB | A = raw byte, no newline translation |
| 7F39h | SDINIT | Initialise the SD card; A = 1 (SDSC) or 2 (SDHC/SDXC), C = no card |
| 7F3Ch | SDREAD | R7:R6:R5:R4 = sector number (R4 lowest), DPTR = 512-byte XDATA buffer; C = error |
| 7F3Fh | SDWRITE | Same registers; writes the buffer to the sector; C = error |

`PUTSI` example: `LCALL PUTSI` followed by `DB "Hello", 10, 0`; execution resumes after the zero byte.

The SD calls work in any register bank, preserve R0–R7, B and DPTR (A and the flags carry the result) and address raw card sectors; the FAT volume, if any, is the program's business. Call `SDINIT` after a reset or a card change; it also selects byte or block addressing for that card. The buffer may be anywhere in XDATA, including upper RAM. The calls may be used while a file is open, but not from an interrupt handler. A 512-byte transfer takes about 45 ms (11 KiB/s).

| Address | Device / use |
| --- | --- |
| CODE 0000h–7FFFh | 32 KiB 27C256/28C256 ROM; jump table at 7F00h |
| CODE 8000h–FFFFh | Upper 32 KiB RAM, executable transient program area |
| XDATA 0000h–09FFh | DOS variables |
| XDATA 0A00h–0BFFh | SD card sector buffer |
| XDATA 0C00h–1BFFh | Assembler symbol table |
| XDATA 1D00h–1FFFh | Runtime/assembler workspace and UART ring buffer |
| XDATA 2000h–7FFFh | RAM disk (directory plus file data) |
| XDATA 8000h–FFFFh | The same upper RAM chip as CODE 8000h–FFFFh |

See [`docs/HARDWARE.md`](docs/HARDWARE.md) for decoding and GPIO details. RAM0 and RAM1 are 62256-compatible SRAMs. The board uses an 80C31 with EA low, a 74HC573 address latch for P0/ALE, and address decoding that selects the 27C256/28C256 for `/PSEN` at A15=0, RAM0 for `/RD` or `/WR` at A15=0, and RAM1 for `/PSEN`, `/RD` or `/WR` at A15=1. Burn `firmware/build/dos51.bin` directly into a 27C256 or compatible 28C256; it is exactly 32768 bytes. Connect RxD=P3.0 and TxD=P3.1 crossed to a 57600 8N1 serial adapter with common ground. Use a TTL-level adapter at the MCU pins; an RS-232 port requires a MAX232-level converter. P1.0–P1.3 are available for GPIO and P1.4–P1.7 carry the SD card (/CS, SCK, MOSI, MISO); P0/P2 are consumed by the external bus.
