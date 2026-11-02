// DOS/51 target board: 80C31 + 32K ROM + RAM0/RAM1 + on-chip UART model.
// See docs/HARDWARE.md for the memory map.
import { CPU8051 } from './cpu8051.js';
import { parseIntelHex } from './ihex.js';

export const CLOCK_HZ = 11059200;
export const MC_PER_SEC = CLOCK_HZ / 12; // 921600

const SCON = 0x98, TCON = 0x88, TMOD = 0x89, TH1 = 0x8D, PCON = 0x87;

// Deterministic PRNG (mulberry32).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  };
}

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

export class Board {
  static CLOCK_HZ = CLOCK_HZ;
  static MC_PER_SEC = MC_PER_SEC;

  constructor(opts = {}) {
    // One 64K CODE image: 0x0000-0x7FFF ROM, 0x8000-0xFFFF RAM1 (shared with XDATA).
    this.code = new Uint8Array(65536);
    this.rom = this.code.subarray(0, 0x8000);
    this.ram1 = this.code.subarray(0x8000, 0x10000);
    this.ram0 = new Uint8Array(0x8000);
    this.rom.fill(0xFF);
    this.cpu = new CPU8051({ code: this.code, xlo: this.ram0, xhi: this.ram1 });

    this.onTx = null;        // (byte, ninthBit) when a transmitted frame completes
    this.onPortWrite = null; // (port 'P0'..'P3' index 0..3, latch value)
    this.rxPacing = opts.rxPacing || 'wire'; // 'wire' | 'flow'
    this.rxQueue = [];
    this.rxHead = 0;
    this.rxOverruns = 0;
    this.txBytes = 0;
    this.rxBytes = 0;
    this._timeTarget = 0;
    this._resetUart();

    const cpu = this.cpu;
    cpu.onSbufWrite = (v) => this._startTx(v);
    cpu.onSconWrite = () => this._scheduleRx();
    cpu.onTimerControl = () => { if (this.txEnd === Infinity && this.txBusy) this._retimeTx(); this._scheduleRx(); };
    cpu.onPortWrite = (p, v) => {
      if (p === 1 && this.sd) this.sd.update(v);
      if (this.onPortWrite) this.onPortWrite(p, v);
    };
    this.sd = null;          // { card, update } set by SDCard.attach()

    if (opts.rom) this.loadRom(opts.rom);
    this.powerCycle(opts.seed);
  }

  get cycles() { return this.cpu.cycles; }
  get CLOCK_HZ() { return CLOCK_HZ; }
  get MC_PER_SEC() { return MC_PER_SEC; }
  get idle() { return this.cpu.idle; }

  _resetUart() {
    this.txBusy = false;
    this.txEnd = Infinity;
    this.txByte = 0;
    this.txBit9 = 0;
    this.rxBusy = false;
    this.rxEnd = Infinity;
    this.rxByte = 0;
  }

  // Load ROM from bytes (offset 0) or an Intel HEX string. HEX data at
  // 0x8000-0xFFFF is written into RAM1 (code space) as a convenience.
  loadRom(src) {
    this.rom.fill(0xFF);
    if (typeof src === 'string') {
      for (const { addr, data } of parseIntelHex(src).segments) {
        for (let i = 0; i < data.length; i++) {
          const a = addr + i;
          if (a < 0x8000) this.rom[a] = data[i];
          else if (a < 0x10000) this.ram1[a - 0x8000] = data[i];
        }
      }
    } else {
      const b = src instanceof Uint8Array ? src : new Uint8Array(src);
      if (b.length > 0x8000) throw new Error('ROM image larger than 32K');
      this.rom.set(b);
    }
  }

  // Hardware reset: CPU SFRs reset, RAM contents kept, UART state cleared.
  reset() {
    this.cpu.reset();
    this._resetUart();
    this.cpu.sbufRx = 0;
    this._scheduleRx();
    if (this.sd) this.sd.update(this.portLatch(1)); // P1 = FFh: card deselected
  }

  // Power cycle: RAM0, RAM1 and IRAM filled with pseudo-random bytes, then reset.
  // Pass a seed for a deterministic fill.
  powerCycle(seed) {
    const s = seed === undefined ? (Math.random() * 0x100000000) >>> 0 : seed;
    const rnd = mulberry32(s);
    const fill = (arr) => {
      for (let i = 0; i < arr.length; i += 4) {
        const r = rnd();
        arr[i] = r; arr[i + 1] = r >> 8; arr[i + 2] = r >> 16; arr[i + 3] = r >> 24;
      }
    };
    fill(this.ram0); fill(this.ram1); fill(this.cpu.iram);
    if (this.sd) this.sd.card.powerCycle();
    this.reset();
  }

  // ---- ports -------------------------------------------------------------

  // setPin('P3.2', 0) drives an input pin externally (1 = released/pulled up).
  setPin(name, level) {
    const m = /^P([13])\.([0-7])$/i.exec(name);
    if (!m) throw new Error(`setPin: unsupported pin ${name}`);
    const bit = 1 << Number(m[2]);
    const cpu = this.cpu;
    if (m[1] === '1') cpu.p1in = level ? cpu.p1in | bit : cpu.p1in & ~bit;
    else { cpu.p3in = level ? cpu.p3in | bit : cpu.p3in & ~bit; cpu.updatePins(); }
  }
  getPin(name) {
    const m = /^P([0-3])\.([0-7])$/i.exec(name);
    if (!m) throw new Error(`getPin: unsupported pin ${name}`);
    return (this.portPins(Number(m[1])) >> Number(m[2])) & 1;
  }
  // Output latch of port 0..3.
  portLatch(p) { return this.cpu.data[0x80 + (p << 4)]; }
  // Effective pin levels (latch AND external drive).
  portPins(p) {
    const l = this.portLatch(p);
    return p === 1 ? l & this.cpu.p1in : p === 3 ? l & this.cpu.p3in : l;
  }

  // ---- UART --------------------------------------------------------------

  // Machine cycles per bit for modes 1/3, or null if the baud clock is stopped.
  _t1BitCycles() {
    const d = this.cpu.data;
    const tmod = d[TMOD], tcon = d[TCON];
    const m1 = (tmod >> 4) & 3;
    const t0m3 = (tmod & 3) === 3;
    if (tmod & 0x40) return null;                 // counter mode: rate unknown
    if (m1 === 3) return null;                    // timer 1 stopped
    if (!t0m3 && !(tcon & 0x40)) return null;     // TR1 = 0
    let period;
    switch (m1) {
      case 0: period = 8192; break;
      case 1: period = 65536; break;
      default: period = 256 - d[TH1];
    }
    return (32 * period) / ((d[PCON] & 0x80) ? 2 : 1);
  }

  // Machine cycles for one complete frame in the current serial mode.
  frameCycles() {
    const d = this.cpu.data;
    const mode = d[SCON] >> 6;
    switch (mode) {
      case 0: return 8;
      case 2: return Math.ceil(11 * (64 / 12) / ((d[PCON] & 0x80) ? 2 : 1));
      case 1: { const b = this._t1BitCycles(); return b === null ? null : Math.round(10 * b); }
      default: { const b = this._t1BitCycles(); return b === null ? null : Math.round(11 * b); }
    }
  }

  // Bit period in machine cycles for the current mode (null if stopped).
  bitCycles() {
    const f = this.frameCycles();
    if (f === null) return null;
    const mode = this.cpu.data[SCON] >> 6;
    return f / (mode === 0 ? 8 : mode === 1 ? 10 : 11);
  }

  // Current baud rate (bits/s) or 0 if stopped.
  get baud() {
    const b = this.bitCycles();
    return b ? MC_PER_SEC / b : 0;
  }

  _startTx(v) {
    // Writing SBUF while a frame is in progress aborts it and starts the new one.
    this.txBusy = true;
    this.txByte = v;
    this.txBit9 = (this.cpu.data[SCON] >> 3) & 1;
    this.txStart = this.cpu.cycles;
    this._retimeTx();
  }
  _retimeTx() {
    this.txEnd = this._txDoneTime();
    if (this.txEnd < this.cpu.limit) this.cpu.limit = this.txEnd;
  }

  // Cycle at which TI rises for a frame started now. In modes 1/3 with Timer 1
  // in auto-reload mode, TI rises on the 10th (11th) bit tick counted from the
  // SBUF write, where a bit tick is every 16th (SMOD=1) or 32nd Timer 1
  // overflow: the result is quantised to the actual T1 overflow phase, e.g.
  // 478..480 cycles at 19200 baud. This matches ucsim exactly. (Silicon aligns
  // the start bit to a free-running divider instead; the difference is below
  // one bit time and the frame rate is identical.)
  _txDoneTime() {
    const cpu = this.cpu, d = cpu.data;
    const mode = d[SCON] >> 6;
    if ((mode & 1) && ((d[TMOD] >> 4) & 3) === 2 && this._t1BitCycles() !== null) {
      const div = (d[PCON] & 0x80) ? 16 : 32;
      const overflows = (mode === 1 ? 10 : 11) * div;
      return cpu.cycles + (256 - d[0x8B]) + (overflows - 1) * (256 - d[TH1]);
    }
    const f = this.frameCycles();
    return f === null ? Infinity : cpu.cycles + f;
  }

  _scheduleRx() {
    if (this.rxBusy || this.rxHead >= this.rxQueue.length) return;
    const scon = this.cpu.data[SCON];
    if (!(scon & 0x10)) return;                          // REN = 0: host waits
    const mode = scon >> 6;
    if ((mode === 0 || this.rxPacing === 'flow') && (scon & 1)) return; // wait for RI = 0
    const f = this.frameCycles();
    if (f === null) return;
    this.rxBusy = true;
    this.rxEnd = this.cpu.cycles + f;
    if (this.rxEnd < this.cpu.limit) this.cpu.limit = this.rxEnd;
  }

  _completeRx() {
    const d = this.cpu.data;
    const byte = this.rxQueue[this.rxHead++];
    if (this.rxHead > 4096 && this.rxHead * 2 > this.rxQueue.length) {
      this.rxQueue = this.rxQueue.slice(this.rxHead);
      this.rxHead = 0;
    }
    this.rxBusy = false;
    this.rxEnd = Infinity;
    const scon = d[SCON];
    const mode = scon >> 6;
    // Stop bit / 9th bit from the host is always 1, so SM2 never blocks reception.
    if (!(scon & 0x10)) { this._scheduleRx(); return; }
    if (scon & 1) { this.rxOverruns++; }
    else {
      this.cpu.sbufRx = byte;
      this.rxBytes++;
      d[SCON] = mode === 0 ? scon | 1 : scon | 0x05; // RI (+ RB8 = stop/9th bit)
    }
    this._scheduleRx();
  }

  _completeTx() {
    const d = this.cpu.data;
    this.txBusy = false;
    this.txEnd = Infinity;
    d[SCON] |= 0x02; // TI
    this.txBytes++;
    if (this.onTx) this.onTx(this.txByte, this.txBit9);
  }

  _events() {
    const now = this.cpu.cycles;
    if (this.txEnd <= now) this._completeTx();
    if (this.rxEnd <= now) this._completeRx();
    if (this.txBusy && this.txEnd === Infinity) this._retimeTx();
    if (!this.rxBusy && this.rxHead < this.rxQueue.length) this._scheduleRx();
  }

  // Queue bytes from the host (Uint8Array, array of numbers, or string as UTF-8).
  serialInput(data) {
    if (typeof data === 'string') {
      data = textEncoder ? textEncoder.encode(data) : Array.from(data, c => c.charCodeAt(0) & 0xFF);
    }
    for (let i = 0; i < data.length; i++) this.rxQueue.push(data[i] & 0xFF);
    this._scheduleRx();
  }
  // Host bytes not yet delivered into SBUF (including a frame in flight).
  get rxPending() { return this.rxQueue.length - this.rxHead; }
  clearSerialInput() { this.rxQueue = []; this.rxHead = 0; this.rxBusy = false; this.rxEnd = Infinity; }

  // ---- running ------------------------------------------------------------

  // Run for n machine cycles; returns cycles actually executed (>= n, instruction granular).
  run(n) {
    const cpu = this.cpu;
    const start = cpu.cycles;
    const target = start + n;
    while (cpu.cycles < target) {
      this._events();
      let next = target;
      if (this.txEnd < next) next = this.txEnd;
      if (this.rxEnd < next) next = this.rxEnd;
      if (next <= cpu.cycles) next = cpu.cycles + 1;
      cpu.run(next);
      if (cpu.hitBreak) break;
    }
    this._events();
    return cpu.cycles - start;
  }

  // Run until PC reaches addr (or maxCycles elapse). Returns true if reached.
  runUntilPC(addr, maxCycles = Infinity) {
    const cpu = this.cpu;
    const prev = cpu.breakAt;
    cpu.breakAt = addr;
    const end = cpu.cycles + maxCycles;
    try {
      while (cpu.cycles < end) {
        this.run(Math.min(end - cpu.cycles, 1_000_000));
        if (cpu.hitBreak) return true;
      }
      return cpu.pc === addr;
    } finally { cpu.breakAt = prev; }
  }

  // Run for a wall-clock duration of emulated time in milliseconds.
  // Instruction-granular overshoot is carried over to the next call, so
  // repeated runFor() calls track emulated time exactly.
  runFor(ms) {
    const now = this.cpu.cycles;
    if (this._timeTarget < now - 16 || this._timeTarget > now + MC_PER_SEC * 3600) this._timeTarget = now;
    this._timeTarget += (ms * MC_PER_SEC) / 1000;
    const n = Math.floor(this._timeTarget) - now;
    return n > 0 ? this.run(n) : 0;
  }

  // ---- battery-backed state -----------------------------------------------

  getState() {
    return { version: 1, ram0: toB64(this.ram0), ram1: toB64(this.ram1) };
  }
  setState(s) {
    if (!s || s.version !== 1) throw new Error('unsupported state');
    this.ram0.set(fromB64(s.ram0).subarray(0, 0x8000));
    this.ram1.set(fromB64(s.ram1).subarray(0, 0x8000));
  }
}

function toB64(u8) {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.length).toString('base64');
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
