// Headless test harness around Board: type into the serial port, wait for
// output, and move files with XMODEM. Synchronous: everything runs in
// emulated time, as fast as the host allows.
import { Board, MC_PER_SEC } from './board.js';
import { XmodemSender, XmodemReceiver, stripPadding } from './xmodem.js';

const SLICE = 2000; // machine cycles per emulation slice while waiting

// createHarness({ romPath | romBytes, seed = 1, rxPacing = 'flow' }) -> Harness.
// romBytes may be a Uint8Array (raw image) or an Intel HEX string. romPath
// (Node only) reads a .ihx/.hex file as Intel HEX, anything else as raw bytes.
export function createHarness(opts = {}) {
  let rom = opts.romBytes ?? opts.rom;
  if (rom === undefined && opts.romPath) {
    const fs = globalThis.process?.getBuiltinModule?.('node:fs');
    if (!fs) throw new Error('romPath needs Node >= 20.16; pass romBytes instead');
    rom = /\.(ihx|hex)$/i.test(opts.romPath) ? fs.readFileSync(opts.romPath, 'latin1') : new Uint8Array(fs.readFileSync(opts.romPath));
  }
  return new Harness({ ...opts, rom });
}

export class Harness {
  constructor({ rom, seed = 1, rxPacing = 'flow', board } = {}) {
    this.board = board || new Board({ seed });
    if (rom !== undefined) { this.board.loadRom(rom); this.board.reset(); }
    this.board.rxPacing = rxPacing;
    this.output = '';
    this.mark = 0;          // waitFor() searches output from here
    this._sink = null;      // when set, serial TX goes here instead of output
    this.board.onTx = (b) => {
      if (this._sink) this._sink(b);
      else this.output += String.fromCharCode(b);
    };
  }

  get cycles() { return this.board.cycles; }

  // Queue text (UTF-8) or bytes into the serial input.
  send(data) { this.board.serialInput(data); return this; }

  clearOutput() { this.output = ''; this.mark = 0; }

  run(cycles) { return this.board.run(cycles); }
  runMs(ms) { return this.board.run(Math.round(ms * MC_PER_SEC / 1000)); }

  // Run until the output after the last match contains `pattern` (string or
  // RegExp). Returns the output from the previous mark up to the end of the
  // match and advances the mark. Throws on timeout (default 10 emulated s).
  waitFor(pattern, { timeoutCycles = 10 * MC_PER_SEC } = {}) {
    const end = this.board.cycles + timeoutCycles;
    for (;;) {
      const hay = this.output.slice(this.mark);
      let idx = -1, len = 0;
      if (typeof pattern === 'string') { idx = hay.indexOf(pattern); len = pattern.length; }
      else { const m = pattern.exec(hay); if (m) { idx = m.index; len = m[0].length; } }
      if (idx >= 0) {
        const out = hay.slice(0, idx + len);
        this.mark += idx + len;
        return out;
      }
      if (this.board.cycles >= end) {
        const tail = this.output.slice(Math.max(this.mark, this.output.length - 400));
        throw new Error(`waitFor(${pattern}) timed out after ${timeoutCycles} cycles; output tail: ${JSON.stringify(tail)}`);
      }
      this.board.run(SLICE);
    }
  }

  // Send `data` to the emulator with XMODEM (the DOS receive command must
  // already be running). Returns { ok, error, cycles }.
  xmodemSend(data, { timeoutCycles = 120 * MC_PER_SEC, ...xopts } = {}) {
    if (typeof data === 'string') data = new TextEncoder().encode(data);
    let result = null;
    const tx = new XmodemSender(data, {
      ...xopts,
      send: (bytes) => this.board.serialInput(bytes),
      onDone: () => { result = { ok: true }; },
      onError: (e) => { result = { ok: false, error: e }; },
    });
    return this._transfer(tx, () => result, timeoutCycles);
  }

  // Receive a file from the emulator with XMODEM (the DOS send command must
  // already be running). Returns { ok, data (padding stripped), raw, error }.
  xmodemReceive({ timeoutCycles = 120 * MC_PER_SEC, strip = true, ...xopts } = {}) {
    let result = null;
    const rx = new XmodemReceiver({
      ...xopts,
      send: (bytes) => this.board.serialInput(bytes),
      onDone: (d) => { result = { ok: true, raw: d, data: strip ? stripPadding(d) : d }; },
      onError: (e) => { result = { ok: false, error: e }; },
    });
    rx.start();
    return this._transfer(rx, () => result, timeoutCycles);
  }

  _transfer(sm, getResult, timeoutCycles) {
    const start = this.board.cycles;
    const prevPacing = this.board.rxPacing;
    this.board.rxPacing = 'wire'; // XMODEM is self-paced; behave like a real line
    this._sink = (b) => sm.feed(b);
    try {
      while (!getResult()) {
        if (this.board.cycles - start > timeoutCycles) { sm.cancel(); break; }
        const n = this.board.run(SLICE);
        sm.tick((n * 1000) / MC_PER_SEC);
      }
    } finally {
      this._sink = null;
      this.board.rxPacing = prevPacing;
    }
    const r = getResult() || { ok: false, error: 'timeout' };
    r.cycles = this.board.cycles - start;
    return r;
  }
}
