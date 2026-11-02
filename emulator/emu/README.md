# DOS/51 board emulator (emu/)

Plain ES modules with no dependencies. They run unmodified in Node >= 18 and in browsers.
`devtools.js` is the exception: it is a Node-only helper for the tests.
The memory map, clock and serial setup follow `docs/HARDWARE.md`.

| Module | Purpose |
|---|---|
| `cpu8051.js` | MCS-51 core: all 256 opcodes, timers 0/1, interrupts, PCON idle/power-down |
| `board.js` | `Board`: ROM, RAM0, RAM1 and the UART model, plus ports, timing and state |
| `ihex.js` | Intel HEX `parseIntelHex`, `hexToImage`, `emitIntelHex` |
| `sdcard.js` | `SDCard`: SPI-mode SD card on P1.4–P1.7, `cmdFrame`, `crc7`, `crc16` |
| `fatfmt.js` | `formatCard(bytes, { fat: 16\|32, mbr })`: blank FAT16/FAT32 card images |
| `xmodem.js` | `XmodemSender` and `XmodemReceiver` state machines, `stripPadding`, `crc16xmodem` |
| `harness.js` | `createHarness()`: a headless driver for end-to-end tests |
| `devtools.js` | Node-only: `sdccBuild`, `runS51` and `s51SerialRun` for tests |

## Board

```js
import { Board, CLOCK_HZ, MC_PER_SEC } from './emu/board.js';   // 11059200, 921600
const b = new Board({ rom: ihxStringOrBytes, seed: 1, rxPacing: 'wire' });
b.onTx = (byte, ninthBit) => term.write(byte);  // fires when a frame is complete
b.onPortWrite = (port, latch) => {};            // port 0..3, on every SFR write
b.serialInput('dir\r');                         // string (UTF-8), Uint8Array or byte array
b.runFor(16.7);                                 // emulated ms (overshoot carried over)
b.run(921600);                                  // machine cycles -> cycles actually executed
b.cycles;                                       // total machine cycles
b.setPin('P3.2', 0); b.getPin('P1.0'); b.portLatch(1); b.portPins(1);
b.reset();                                      // keeps RAM0/RAM1/IRAM
b.powerCycle(seed?);                            // fills RAM with PRNG bytes, then resets
b.loadRom(bytes | ihxString);                   // HEX data >= 0x8000 goes into RAM1
b.rxPacing = 'flow';                            // 'wire' (default) | 'flow'
b.rxPending; b.rxOverruns; b.baud; b.frameCycles(); b.bitCycles();
b.runUntilPC(addr, maxCycles) -> boolean;       // breakpoint helper
b.getState() / b.setState(s);                   // {version:1, ram0, ram1} as base64 (battery SRAM)
b.rom, b.ram0, b.ram1                           // Uint8Array(32768) views; b.code = 64K CODE image
b.cpu                                           // CPU8051 (see below)
```

* CODE 0x8000–0xFFFF and XDATA 0x8000–0xFFFF share one buffer (`ram1`), so MOVX writes are executable straight away.
* UART mode 1 uses the Timer 1 auto-reload overflow rate. With TH1=0xFD and SMOD=1 that gives 19200 baud and a 480-cycle frame. TI rises on the 10th bit tick after the SBUF write: every 16th (SMOD=1) or 32nd Timer 1 overflow, so 478–480 cycles. This matches ucsim cycle for cycle. If Timer 1 is not running, transmission stalls until it starts.
* RX timing: a host byte enters SBUF one frame after it starts, but only while REN=1. RI and RB8 are set at that point.
  * In `'wire'` mode bytes arrive back to back. A byte that arrives while RI=1 is lost and counted in `rxOverruns`.
  * In `'flow'` mode the next byte waits until software clears RI.
* Idle (PCON.IDL) fast-forwards to the next timer overflow or UART event. Power-down stops the board until `reset()`.

## SD card

```js
import { SDCard } from './emu/sdcard.js';
import { formatCard } from './emu/fatfmt.js';
const card = new SDCard({ image: formatCard(32 << 20), sdhc: true,   // false: SDSC, byte addresses
  onWrite: (offset, length) => {} }).attach(board);                // after every block write
card.image; card.stats;      // { cmds, reads, writes, crcErrors }; card.powerCycle()
```

* Pins: P1.4 /CS, P1.5 SCK, P1.6 MOSI (board to card), P1.7 MISO. SPI mode 0: the card samples MOSI on the rising SCK edge and shifts MISO after the falling edge; MISO reads 1 while /CS is high. `board.powerCycle()` powers the card down too, `reset()` does not.
* After power-up the card is in SD mode and only accepts CMD0 with a valid CRC (and /CS low). In SPI mode CRC7 is checked for CMD0 and CMD8 only, unless CMD59 turns checking on (then data CRC16 is checked on writes as well). A bad CRC answers R1 with the CRC error bit.
* Commands: CMD0, CMD1 (SDSC only), CMD8 (R7; version 1 cards answer illegal), CMD55 + ACMD41 (`readyAfter` polls; an SDHC card never leaves idle without HCS), ACMD13, CMD58 (R3 with CCS), CMD59, CMD13, CMD16 (SDSC), CMD17 (token FEh, 512 bytes, CRC16), CMD24 (data response 05h then `busyBytes` of busy). Data commands in idle state are illegal; out-of-range addresses give a parameter error, misaligned SDSC addresses an address error. Multi-block commands are not modelled.
* `card.xfer(byte)` exchanges one byte directly (unit tests), `card.pins(cs, sck, mosi)` drives the pins.

## CPU8051

`new CPU8051({code, xlo, xhi})`. Main API: `reset()`, `step()` (returns the cycles used), `run(untilCycle)`, `pc`, `sp`, `acc`, `psw`, `dptr`, `regs`, `iram` (Uint8Array 128), `sfr` (raw), `readSfr(a)`/`writeSfr(a,v)`, `sfrReadHooks[a-0x80]`, `sfrWriteHooks[a-0x80]`, `trace(pc, op, cpu)`, `breakAt`, `disasm(addr)`, `idle`, `pd`, `cycles`. The tables `OPLEN`, `OPCYC` and `MNEMONIC` are exported.

Modelling choices:
* PSW.P is always the live parity of ACC.
* 0xA5 executes as a 1-cycle NOP.
* Indirect, PUSH/POP and CALL/RET accesses to 0x80–0xFF read 0xFF and ignore writes, because the 80C31 has only 128 bytes of IRAM.
* Unimplemented SFRs read 0xFF and ignore writes.
* Interrupts follow the datasheet:
  * flags are polled after every instruction;
  * entry is a 2-cycle LCALL;
  * one more instruction runs after RETI or after any write to IE or IP;
  * IE0/IE1 are cleared on vector only in edge mode, and level mode follows the pin;
  * TF0/TF1 are cleared on vector, RI/TI are not.
* Timer clocking is per instruction: overflow flags are set at instruction granularity.
* Counter inputs count every falling edge given to `setPin`. Real silicon needs 2 cycles per edge, and the emulator does not enforce that limit.
* Writing SBUF while a frame is in flight restarts the frame with the new byte.

## Harness (end-to-end tests)

```js
import { createHarness } from './emu/harness.js';
const h = createHarness({ romPath: 'firmware/build/dos51.ihx' }); // or { romBytes }, seed, rxPacing ('flow' default)
h.waitFor('A>');                  // runs until the output after the last match contains it; returns that text
h.send('dir\r');
const listing = h.waitFor(/A>\s*$/, { timeoutCycles: 5 * 921600 });
h.send('rx hello.txt\r');         // DOS receive command
h.xmodemSend(bytes);              // -> { ok, error, cycles }
h.send('sx hello.txt\r');
const { ok, data, raw } = h.xmodemReceive();   // data has 0x1A padding stripped
h.output; h.clearOutput(); h.board; h.run(cycles); h.runMs(ms);
```

## CLI

`node bin/dos51.js [--rom firmware/build/dos51.ihx] [--baud-pacing wire|flow] [--tcp PORT] [--state file.json] [--seed N] [--sd card.img [--sd-size MiB] [--sd-fat 16|32] [--sdsc]]`.
Press Ctrl-] to open the command prompt. The commands are `u <file>` (XMODEM upload), `d <file>` (download), `r`, `p`, `x` (toggle flow pacing) and `q`.
In `--tcp` mode the commands are read from stdin. To get a pty, run `socat pty,link=/tmp/ttyDOS51,raw,echo=0 tcp:localhost:PORT`.
