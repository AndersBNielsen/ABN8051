// MCS-51 (80C31) instruction-set interpreter with on-chip timers 0/1,
// interrupt controller and PCON idle/power-down. The UART datapath lives in
// board.js; the CPU only exposes SBUF/SCON hooks and polls RI/TI for interrupts.
//
// Memory model:
//   code   Uint8Array(65536)  CODE space (PSEN), fetched directly
//   xlo    Uint8Array(32768)  XDATA 0x0000-0x7FFF
//   xhi    Uint8Array(32768)  XDATA 0x8000-0xFFFF
//   data   Uint8Array(256)    0x00-0x7F internal RAM, 0x80-0xFF SFR storage
//
// 80C31 upper-IRAM choice: there are only 128 bytes of internal RAM. Indirect
// accesses (@R0/@R1, PUSH/POP, CALL/RET stack) to 0x80-0xFF read 0xFF and
// writes are ignored. Direct addresses 0x80-0xFF are the SFRs. Unimplemented
// SFR addresses read 0xFF and ignore writes.

// Instruction length (bytes) per opcode.
export const OPLEN = new Uint8Array(256);
// Machine cycles per opcode.
export const OPCYC = new Uint8Array(256);

// Mnemonics, used for tracing/disassembly.
export const MNEMONIC = new Array(256);

(function buildTables() {
  const set = (op, len, cyc, m) => { OPLEN[op] = len; OPCYC[op] = cyc; MNEMONIC[op] = m; };
  for (let op = 0; op < 256; op++) set(op, 1, 1, '???');
  const rows = [
    // [base, len, cyc, mnemonic] for the low nibble 0x00-0x05 per row
    [0x00, 1, 1, 'NOP'], [0x02, 3, 2, 'LJMP addr16'], [0x03, 1, 1, 'RR A'], [0x04, 1, 1, 'INC A'], [0x05, 2, 1, 'INC dir'],
    [0x10, 3, 2, 'JBC bit,rel'], [0x12, 3, 2, 'LCALL addr16'], [0x13, 1, 1, 'RRC A'], [0x14, 1, 1, 'DEC A'], [0x15, 2, 1, 'DEC dir'],
    [0x20, 3, 2, 'JB bit,rel'], [0x22, 1, 2, 'RET'], [0x23, 1, 1, 'RL A'], [0x24, 2, 1, 'ADD A,#imm'], [0x25, 2, 1, 'ADD A,dir'],
    [0x30, 3, 2, 'JNB bit,rel'], [0x32, 1, 2, 'RETI'], [0x33, 1, 1, 'RLC A'], [0x34, 2, 1, 'ADDC A,#imm'], [0x35, 2, 1, 'ADDC A,dir'],
    [0x40, 2, 2, 'JC rel'], [0x42, 2, 1, 'ORL dir,A'], [0x43, 3, 2, 'ORL dir,#imm'], [0x44, 2, 1, 'ORL A,#imm'], [0x45, 2, 1, 'ORL A,dir'],
    [0x50, 2, 2, 'JNC rel'], [0x52, 2, 1, 'ANL dir,A'], [0x53, 3, 2, 'ANL dir,#imm'], [0x54, 2, 1, 'ANL A,#imm'], [0x55, 2, 1, 'ANL A,dir'],
    [0x60, 2, 2, 'JZ rel'], [0x62, 2, 1, 'XRL dir,A'], [0x63, 3, 2, 'XRL dir,#imm'], [0x64, 2, 1, 'XRL A,#imm'], [0x65, 2, 1, 'XRL A,dir'],
    [0x70, 2, 2, 'JNZ rel'], [0x72, 2, 2, 'ORL C,bit'], [0x73, 1, 2, 'JMP @A+DPTR'], [0x74, 2, 1, 'MOV A,#imm'], [0x75, 3, 2, 'MOV dir,#imm'],
    [0x80, 2, 2, 'SJMP rel'], [0x82, 2, 2, 'ANL C,bit'], [0x83, 1, 2, 'MOVC A,@A+PC'], [0x84, 1, 4, 'DIV AB'], [0x85, 3, 2, 'MOV dir,dir'],
    [0x90, 3, 2, 'MOV DPTR,#imm16'], [0x92, 2, 2, 'MOV bit,C'], [0x93, 1, 2, 'MOVC A,@A+DPTR'], [0x94, 2, 1, 'SUBB A,#imm'], [0x95, 2, 1, 'SUBB A,dir'],
    [0xA0, 2, 2, 'ORL C,/bit'], [0xA2, 2, 1, 'MOV C,bit'], [0xA3, 1, 2, 'INC DPTR'], [0xA4, 1, 4, 'MUL AB'], [0xA5, 1, 1, 'reserved'],
    [0xB0, 2, 2, 'ANL C,/bit'], [0xB2, 2, 1, 'CPL bit'], [0xB3, 1, 1, 'CPL C'], [0xB4, 3, 2, 'CJNE A,#imm,rel'], [0xB5, 3, 2, 'CJNE A,dir,rel'],
    [0xC0, 2, 2, 'PUSH dir'], [0xC2, 2, 1, 'CLR bit'], [0xC3, 1, 1, 'CLR C'], [0xC4, 1, 1, 'SWAP A'], [0xC5, 2, 1, 'XCH A,dir'],
    [0xD0, 2, 2, 'POP dir'], [0xD2, 2, 1, 'SETB bit'], [0xD3, 1, 1, 'SETB C'], [0xD4, 1, 1, 'DA A'], [0xD5, 3, 2, 'DJNZ dir,rel'],
    [0xE0, 1, 2, 'MOVX A,@DPTR'], [0xE2, 1, 2, 'MOVX A,@R0'], [0xE3, 1, 2, 'MOVX A,@R1'], [0xE4, 1, 1, 'CLR A'], [0xE5, 2, 1, 'MOV A,dir'],
    [0xF0, 1, 2, 'MOVX @DPTR,A'], [0xF2, 1, 2, 'MOVX @R0,A'], [0xF3, 1, 2, 'MOVX @R1,A'], [0xF4, 1, 1, 'CPL A'], [0xF5, 2, 1, 'MOV dir,A'],
  ];
  for (const [op, len, cyc, m] of rows) set(op, len, cyc, m);
  for (let p = 0; p < 8; p++) {
    set((p << 5) | 0x01, 2, 2, 'AJMP addr11');
    set((p << 5) | 0x11, 2, 2, 'ACALL addr11');
  }
  // Columns 6-F (@R0,@R1,R0..R7) per row.
  const cols = [
    [0x00, 1, 1, 'INC'], [0x10, 1, 1, 'DEC'], [0x20, 1, 1, 'ADD A,'], [0x30, 1, 1, 'ADDC A,'],
    [0x40, 1, 1, 'ORL A,'], [0x50, 1, 1, 'ANL A,'], [0x60, 1, 1, 'XRL A,'], [0x70, 2, 1, 'MOV ', ',#imm'],
    [0x80, 2, 2, 'MOV dir,'], [0x90, 1, 1, 'SUBB A,'], [0xA0, 2, 2, 'MOV ', ',dir'], [0xB0, 3, 2, 'CJNE ', ',#imm,rel'],
    [0xC0, 1, 1, 'XCH A,'], [0xD0, 0, 0, ''], [0xE0, 1, 1, 'MOV A,'], [0xF0, 1, 1, 'MOV ', ',A'],
  ];
  const names = ['@R0', '@R1', 'R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'];
  for (const [row, len, cyc, pre, post = ''] of cols) {
    if (row === 0xD0) continue;
    for (let i = 0; i < 10; i++) set(row + 6 + i, len, cyc, pre + names[i] + post);
  }
  set(0xD6, 1, 1, 'XCHD A,@R0'); set(0xD7, 1, 1, 'XCHD A,@R1');
  for (let r = 0; r < 8; r++) set(0xD8 + r, 2, 2, 'DJNZ R' + r + ',rel');
})();

const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let p = 0, v = i;
  while (v) { p ^= v & 1; v >>= 1; }
  PARITY[i] = p;
}

// SFR addresses present on an 80C31.
const SFR_IMPL = new Uint8Array(256);
for (const a of [0x80, 0x81, 0x82, 0x83, 0x87, 0x88, 0x89, 0x8A, 0x8B, 0x8C, 0x8D,
  0x90, 0x98, 0x99, 0xA0, 0xA8, 0xB0, 0xB8, 0xD0, 0xE0, 0xF0]) SFR_IMPL[a] = 1;

export const SFR = {
  P0: 0x80, SP: 0x81, DPL: 0x82, DPH: 0x83, PCON: 0x87, TCON: 0x88, TMOD: 0x89,
  TL0: 0x8A, TL1: 0x8B, TH0: 0x8C, TH1: 0x8D, P1: 0x90, SCON: 0x98, SBUF: 0x99,
  P2: 0xA0, IE: 0xA8, P3: 0xB0, IP: 0xB8, PSW: 0xD0, ACC: 0xE0, B: 0xF0,
};

const ACC = 0xE0, PSW = 0xD0, B = 0xF0, SP = 0x81, DPL = 0x82, DPH = 0x83;
const TCON = 0x88, TMOD = 0x89, TL0 = 0x8A, TL1 = 0x8B, TH0 = 0x8C, TH1 = 0x8D;
const SCON = 0x98, IE = 0xA8, IP = 0xB8, PCON = 0x87;

const noop = () => {};

export class CPU8051 {
  constructor(opts = {}) {
    this.code = opts.code || new Uint8Array(65536).fill(0xFF);
    this.xlo = opts.xlo || new Uint8Array(32768);
    this.xhi = opts.xhi || new Uint8Array(32768);
    this.data = new Uint8Array(256);
    this.iram = this.data.subarray(0, 128);
    this.sfr = this.data.subarray(128, 256); // raw SFR storage, index = addr-0x80
    this.pc = 0;
    this.cycles = 0;   // machine cycles since construction
    this.limit = 0;    // run() stops when cycles >= limit; hooks may lower it
    this.sbufRx = 0;   // receive buffer (SBUF read side), maintained by the UART
    // Externally driven pin levels (1 = high / pull-up). Pin = latch & external.
    this.p1in = 0xFF;
    this.p3in = 0xFF;
    this.p3pins = 0xFF; // last effective P3 pin levels (edge detection)
    this.idle = false;
    this.pd = false;
    this.irqBlock = false;
    this.activeHi = false;
    this.activeLo = false;
    this.t1Overflows = 0; // total timer-1 overflows (informational)
    // Hooks. sfrReadHooks/sfrWriteHooks are indexed by addr-0x80; a read hook
    // replaces the value, a write hook runs after the internal write.
    this.sfrReadHooks = new Array(128).fill(null);
    this.sfrWriteHooks = new Array(128).fill(null);
    this.onPortWrite = noop;  // (portIndex 0..3, latchValue)
    this.onSbufWrite = noop;  // (byte)
    this.onSconWrite = noop;  // (value)
    this.onTimerControl = noop; // TCON/TMOD/TH1/PCON written (baud may change)
    this.trace = null;        // (pc, opcode, cpu) called before each instruction
    this.breakAt = -1;        // run() stops once PC reaches this address
    this.hitBreak = false;    // set when run() stopped at breakAt
    this.reset();
  }

  // Hardware reset: SFRs to reset values, IRAM and XDATA untouched.
  reset() {
    const d = this.data;
    d.fill(0, 0x80, 0x100);
    d[0x80] = d[0x90] = d[0xA0] = d[0xB0] = 0xFF;
    d[SP] = 0x07;
    this.pc = 0;
    this.idle = false;
    this.pd = false;
    this.irqBlock = false;
    this.activeHi = false;
    this.activeLo = false;
    this.t1Overflows = 0; // also clears the UART /16 baud divider phase
    this.p3pins = d[0xB0] & this.p3in;
    this.levelInts();
  }

  get acc() { return this.data[ACC]; }
  set acc(v) { this.data[ACC] = v; }
  get sp() { return this.data[SP]; }
  set sp(v) { this.data[SP] = v; }
  get psw() { return (this.data[PSW] & 0xFE) | PARITY[this.data[ACC]]; }
  set psw(v) { this.data[PSW] = v; }
  get dptr() { return (this.data[DPH] << 8) | this.data[DPL]; }
  set dptr(v) { this.data[DPH] = (v >> 8) & 0xFF; this.data[DPL] = v & 0xFF; }
  // Current register bank R0..R7 view.
  get regs() { const b = this.data[PSW] & 0x18; return this.data.subarray(b, b + 8); }

  // ---- data space access -------------------------------------------------

  readSfr(a) {
    const h = this.sfrReadHooks[a - 0x80];
    if (h !== null) return h(a) & 0xFF;
    const d = this.data;
    switch (a) {
      case 0x90: return d[0x90] & this.p1in;
      case 0xB0: return d[0xB0] & this.p3in;
      case 0x99: return this.sbufRx;
      case 0xD0: return (d[PSW] & 0xFE) | PARITY[d[ACC]];
      default: return SFR_IMPL[a] ? d[a] : 0xFF;
    }
  }

  writeSfr(a, v) {
    const d = this.data;
    switch (a) {
      case 0x80: d[a] = v; this.onPortWrite(0, v); break;
      case 0x90: d[a] = v; this.onPortWrite(1, v); break;
      case 0xA0: d[a] = v; this.onPortWrite(2, v); break;
      case 0xB0: d[a] = v; this.updatePins(); this.onPortWrite(3, v); break;
      case 0x99: this.onSbufWrite(v); break;
      case 0x98: d[a] = v; this.onSconWrite(v); break;
      case 0xA8: case 0xB8: d[a] = v; this.irqBlock = true; break;
      case 0x88: d[a] = v; this.levelInts(); this.onTimerControl(); break;
      case 0x89: case 0x8D: d[a] = v; this.onTimerControl(); break;
      case 0x87:
        d[a] = v;
        if (v & 2) this.pd = true; else if (v & 1) this.idle = true;
        this.onTimerControl();
        break;
      default: if (SFR_IMPL[a]) d[a] = v;
    }
    const h = this.sfrWriteHooks[a - 0x80];
    if (h !== null) h(a, v);
  }

  readDirect(a) { return a < 0x80 ? this.data[a] : this.readSfr(a); }
  writeDirect(a, v) { if (a < 0x80) this.data[a] = v; else this.writeSfr(a, v); }
  // Read-modify-write source: ports return the output latch, not the pins.
  readLatch(a) {
    if (a < 0x80) return this.data[a];
    if ((a & 0xCF) === 0x80) return this.sfrReadHooks[a - 0x80] !== null ? this.readSfr(a) : this.data[a]; // P0..P3
    return this.readSfr(a);
  }
  readInd(a) { return a < 0x80 ? this.data[a] : 0xFF; }
  writeInd(a, v) { if (a < 0x80) this.data[a] = v; }

  bitRead(b) {
    if (b < 0x80) return (this.data[0x20 + (b >> 3)] >> (b & 7)) & 1;
    return (this.readSfr(b & 0xF8) >> (b & 7)) & 1;
  }
  bitReadLatch(b) {
    if (b < 0x80) return (this.data[0x20 + (b >> 3)] >> (b & 7)) & 1;
    return (this.readLatch(b & 0xF8) >> (b & 7)) & 1;
  }
  bitWrite(b, v) {
    const m = 1 << (b & 7);
    if (b < 0x80) {
      const a = 0x20 + (b >> 3);
      this.data[a] = v ? this.data[a] | m : this.data[a] & ~m;
    } else {
      const a = b & 0xF8;
      const old = this.readLatch(a);
      this.writeSfr(a, v ? old | m : old & ~m);
    }
  }

  push(v) {
    const s = (this.data[SP] + 1) & 0xFF;
    this.data[SP] = s;
    if (s < 0x80) this.data[s] = v;
  }
  pop() {
    const s = this.data[SP];
    this.data[SP] = (s - 1) & 0xFF;
    return s < 0x80 ? this.data[s] : 0xFF;
  }

  // ---- pins, external interrupts, counters -------------------------------

  // Call after changing p3in (or writing the P3 latch). Detects falling edges
  // on INT0/INT1 (edge mode) and T0/T1 (counter mode).
  updatePins() {
    const d = this.data;
    const now = d[0xB0] & this.p3in;
    const fall = this.p3pins & ~now;
    this.p3pins = now;
    if (fall & 0x04 && d[TCON] & 0x01) d[TCON] |= 0x02;
    if (fall & 0x08 && d[TCON] & 0x04) d[TCON] |= 0x08;
    if (fall & 0x30) {
      const tmod = d[TMOD];
      if (fall & 0x10 && tmod & 0x04) this.countPulse(0);
      if (fall & 0x20 && tmod & 0x40) this.countPulse(1);
    }
    this.levelInts();
  }

  // Level-triggered INTx: IEx follows the inverted pin while ITx = 0.
  levelInts() {
    const d = this.data;
    const t = d[TCON];
    if (!(t & 0x01)) d[TCON] = (this.p3pins & 0x04) ? d[TCON] & ~0x02 : d[TCON] | 0x02;
    if (!(t & 0x04)) d[TCON] = (this.p3pins & 0x08) ? d[TCON] & ~0x08 : d[TCON] | 0x08;
  }

  countPulse(t) {
    const d = this.data;
    const tmod = d[TMOD], tcon = d[TCON];
    if (t === 0) {
      if (!(tcon & 0x10) || (tmod & 0x08 && !(this.p3pins & 0x04))) return;
      this.advance0(1, tmod & 3);
    } else {
      if ((tmod & 0x30) === 0x30) return;
      if ((tmod & 3) !== 3 && !(tcon & 0x40)) return;
      if (tmod & 0x80 && !(this.p3pins & 0x08)) return;
      this.advance1(1, (tmod >> 4) & 3, (tmod & 3) !== 3);
    }
  }

  // ---- timers -------------------------------------------------------------

  // Advance timer 0 by n counts in the given mode (mode 3 = TL0 only).
  advance0(n, mode) {
    const d = this.data;
    let ov = advanceTimer(d, TL0, TH0, mode, n);
    if (ov) d[TCON] |= 0x20;
  }
  advance1(n, mode, setFlag) {
    if (mode === 3) return; // timer 1 mode 3: stopped
    const d = this.data;
    const ov = advanceTimer(d, TL1, TH1, mode, n);
    this.t1Overflows += ov;
    if (ov && setFlag) d[TCON] |= 0x80;
  }

  tickTimers(n) {
    const d = this.data;
    const tcon = d[TCON], tmod = d[TMOD];
    const m0 = tmod & 3;
    const p = this.p3pins;
    // Timer 0 (in mode 3 this is TL0)
    if (tcon & 0x10 && !(tmod & 0x04) && (!(tmod & 0x08) || p & 0x04)) this.advance0(n, m0);
    if (m0 === 3) {
      // TH0 as 8-bit timer controlled by TR1, overflow sets TF1.
      if (tcon & 0x40) {
        const v = d[TH0] + n;
        d[TH0] = v;
        if (v > 0xFF) d[TCON] |= 0x80;
      }
      // Timer 1 runs whenever it is not in mode 3; it cannot set TF1.
      if (!(tmod & 0x40) && (!(tmod & 0x80) || p & 0x08)) this.advance1(n, (tmod >> 4) & 3, false);
    } else if (tcon & 0x40 && !(tmod & 0x40) && (!(tmod & 0x80) || p & 0x08)) {
      this.advance1(n, (tmod >> 4) & 3, true);
    }
  }

  // Machine cycles until the next timer overflow flag would be set (Infinity if none).
  cyclesToTimerEvent() {
    const d = this.data;
    const tcon = d[TCON], tmod = d[TMOD];
    const m0 = tmod & 3, p = this.p3pins;
    let best = Infinity;
    if (tcon & 0x10 && !(tmod & 0x04) && (!(tmod & 0x08) || p & 0x04)) best = Math.min(best, toOverflow(d, TL0, TH0, m0));
    if (m0 === 3) {
      if (tcon & 0x40) best = Math.min(best, 256 - d[TH0]);
    } else if (tcon & 0x40 && !(tmod & 0x40) && (!(tmod & 0x80) || p & 0x08) && (tmod & 0x30) !== 0x30) {
      best = Math.min(best, toOverflow(d, TL1, TH1, (tmod >> 4) & 3));
    }
    return best;
  }

  // ---- interrupts ---------------------------------------------------------

  checkInterrupts() {
    const d = this.data;
    const ie = d[IE];
    const tcon = d[TCON];
    const flags = ((tcon >> 1) & 1) | ((tcon >> 4) & 2) | ((tcon >> 1) & 4) | ((tcon >> 4) & 8) | ((d[SCON] & 3) ? 16 : 0);
    const req = flags & ie & 0x1F;
    if (req === 0) return 0;
    const ip = d[IP];
    let take = 0;
    if (!this.activeHi) {
      if (req & ip) take = req & ip;
      else if (!this.activeLo) take = req;
    }
    if (take === 0) return 0;
    const k = 31 - Math.clz32(take & -take);
    if (ip & (1 << k)) this.activeHi = true; else this.activeLo = true;
    switch (k) {
      case 0: if (tcon & 0x01) d[TCON] &= ~0x02; break;
      case 1: d[TCON] &= ~0x20; break;
      case 2: if (tcon & 0x04) d[TCON] &= ~0x08; break;
      case 3: d[TCON] &= ~0x80; break;
    }
    if (this.idle) { this.idle = false; d[PCON] &= ~1; }
    const pc = this.pc;
    this.push(pc & 0xFF);
    this.push(pc >> 8);
    this.pc = 3 + (k << 3);
    this.cycles += 2;
    if (d[TCON] & 0x50) this.tickTimers(2);
    return 2;
  }

  // ---- execution ----------------------------------------------------------

  // Execute one instruction (or one idle slice); returns machine cycles used.
  step() {
    const start = this.cycles;
    this.run(this.cycles + 1);
    return this.cycles - start;
  }

  // Run until cycles >= limit (the limit may be lowered by hooks during the run).
  run(limit) {
    this.limit = limit;
    this.hitBreak = false;
    const d = this.data;
    while (this.cycles < this.limit) {
      let n;
      if (this.idle || this.pd) {
        if (this.pd) { this.cycles = this.limit; break; }
        // Take a pending interrupt before skipping ahead.
        if (d[IE] & 0x80 && this.checkInterrupts()) continue;
        n = Math.min(this.limit - this.cycles, this.cyclesToTimerEvent());
        if (n < 1) n = 1;
      } else {
        if (this.trace !== null) this.trace(this.pc, this.code[this.pc], this);
        n = this.exec();
      }
      this.cycles += n;
      if (d[TCON] & 0x50) this.tickTimers(n);
      if (this.irqBlock) this.irqBlock = false;
      else if (d[IE] & 0x80) this.checkInterrupts();
      if (this.pc === this.breakAt) { this.hitBreak = true; break; }
    }
    return this.cycles;
  }

  add(b, c) {
    const d = this.data;
    const a = d[ACC];
    const r = a + b + c;
    let psw = d[PSW] & 0x3B;
    if (r > 0xFF) psw |= 0x80;
    if ((a & 0xF) + (b & 0xF) + c > 0xF) psw |= 0x40;
    if (~(a ^ b) & (a ^ r) & 0x80) psw |= 0x04;
    d[ACC] = r;
    d[PSW] = psw;
  }

  subb(b) {
    const d = this.data;
    const a = d[ACC];
    const c = d[PSW] >> 7;
    const r = a - b - c;
    let psw = d[PSW] & 0x3B;
    if (r < 0) psw |= 0x80;
    if ((a & 0xF) - (b & 0xF) - c < 0) psw |= 0x40;
    if ((a ^ b) & (a ^ r) & 0x80) psw |= 0x04;
    d[ACC] = r;
    d[PSW] = psw;
  }

  cjne(x, y, rel) {
    const d = this.data;
    d[PSW] = x < y ? d[PSW] | 0x80 : d[PSW] & 0x7F;
    if (x !== y) this.pc = (this.pc + ((rel << 24) >> 24)) & 0xFFFF;
  }

  exec() {
    const d = this.data, code = this.code;
    const pc0 = this.pc;
    const op = code[pc0];
    const b1 = code[(pc0 + 1) & 0xFFFF];
    let pc = (pc0 + OPLEN[op]) & 0xFFFF;
    this.pc = pc;
    let t, a, r;
    switch (op) {
      case 0x00: case 0xA5: break;
      case 0x01: case 0x21: case 0x41: case 0x61: case 0x81: case 0xA1: case 0xC1: case 0xE1:
        this.pc = (pc & 0xF800) | ((op & 0xE0) << 3) | b1; break;
      case 0x11: case 0x31: case 0x51: case 0x71: case 0x91: case 0xB1: case 0xD1: case 0xF1:
        this.push(pc & 0xFF); this.push(pc >> 8);
        this.pc = (pc & 0xF800) | ((op & 0xE0) << 3) | b1; break;
      case 0x02: this.pc = (b1 << 8) | code[(pc0 + 2) & 0xFFFF]; break;
      case 0x12:
        this.push(pc & 0xFF); this.push(pc >> 8);
        this.pc = (b1 << 8) | code[(pc0 + 2) & 0xFFFF]; break;
      case 0x22: t = this.pop() << 8; this.pc = t | this.pop(); break;
      case 0x32:
        t = this.pop() << 8; this.pc = t | this.pop();
        if (this.activeHi) this.activeHi = false; else this.activeLo = false;
        this.irqBlock = true; break;
      case 0x03: a = d[ACC]; d[ACC] = (a >> 1) | (a << 7); break;
      case 0x13: a = d[ACC]; t = d[PSW]; d[PSW] = (t & 0x7F) | ((a & 1) << 7); d[ACC] = (a >> 1) | (t & 0x80); break;
      case 0x23: a = d[ACC]; d[ACC] = (a << 1) | (a >> 7); break;
      case 0x33: a = d[ACC]; t = d[PSW]; d[PSW] = (t & 0x7F) | (a & 0x80); d[ACC] = (a << 1) | (t >> 7); break;
      case 0x04: d[ACC]++; break;
      case 0x14: d[ACC]--; break;
      case 0x05: this.writeDirect(b1, this.readLatch(b1) + 1); break;
      case 0x15: this.writeDirect(b1, this.readLatch(b1) - 1); break;
      case 0x06: case 0x07: a = d[(d[PSW] & 0x18) | (op & 1)]; this.writeInd(a, this.readInd(a) + 1); break;
      case 0x16: case 0x17: a = d[(d[PSW] & 0x18) | (op & 1)]; this.writeInd(a, this.readInd(a) - 1); break;
      case 0x08: case 0x09: case 0x0A: case 0x0B: case 0x0C: case 0x0D: case 0x0E: case 0x0F:
        d[(d[PSW] & 0x18) | (op & 7)]++; break;
      case 0x18: case 0x19: case 0x1A: case 0x1B: case 0x1C: case 0x1D: case 0x1E: case 0x1F:
        d[(d[PSW] & 0x18) | (op & 7)]--; break;
      case 0x10:
        if (this.bitReadLatch(b1)) { this.bitWrite(b1, 0); this.pc = (pc + ((code[(pc0 + 2) & 0xFFFF] << 24) >> 24)) & 0xFFFF; }
        break;
      case 0x20: if (this.bitRead(b1)) this.pc = (pc + ((code[(pc0 + 2) & 0xFFFF] << 24) >> 24)) & 0xFFFF; break;
      case 0x30: if (!this.bitRead(b1)) this.pc = (pc + ((code[(pc0 + 2) & 0xFFFF] << 24) >> 24)) & 0xFFFF; break;
      case 0x40: if (d[PSW] & 0x80) this.pc = (pc + ((b1 << 24) >> 24)) & 0xFFFF; break;
      case 0x50: if (!(d[PSW] & 0x80)) this.pc = (pc + ((b1 << 24) >> 24)) & 0xFFFF; break;
      case 0x60: if (d[ACC] === 0) this.pc = (pc + ((b1 << 24) >> 24)) & 0xFFFF; break;
      case 0x70: if (d[ACC] !== 0) this.pc = (pc + ((b1 << 24) >> 24)) & 0xFFFF; break;
      case 0x80: this.pc = (pc + ((b1 << 24) >> 24)) & 0xFFFF; break;
      case 0x73: this.pc = (d[ACC] + ((d[DPH] << 8) | d[DPL])) & 0xFFFF; break;

      // ADD / ADDC / SUBB
      case 0x24: this.add(b1, 0); break;
      case 0x25: this.add(this.readDirect(b1), 0); break;
      case 0x26: case 0x27: this.add(this.readInd(d[(d[PSW] & 0x18) | (op & 1)]), 0); break;
      case 0x28: case 0x29: case 0x2A: case 0x2B: case 0x2C: case 0x2D: case 0x2E: case 0x2F:
        this.add(d[(d[PSW] & 0x18) | (op & 7)], 0); break;
      case 0x34: this.add(b1, d[PSW] >> 7); break;
      case 0x35: this.add(this.readDirect(b1), d[PSW] >> 7); break;
      case 0x36: case 0x37: this.add(this.readInd(d[(d[PSW] & 0x18) | (op & 1)]), d[PSW] >> 7); break;
      case 0x38: case 0x39: case 0x3A: case 0x3B: case 0x3C: case 0x3D: case 0x3E: case 0x3F:
        this.add(d[(d[PSW] & 0x18) | (op & 7)], d[PSW] >> 7); break;
      case 0x94: this.subb(b1); break;
      case 0x95: this.subb(this.readDirect(b1)); break;
      case 0x96: case 0x97: this.subb(this.readInd(d[(d[PSW] & 0x18) | (op & 1)])); break;
      case 0x98: case 0x99: case 0x9A: case 0x9B: case 0x9C: case 0x9D: case 0x9E: case 0x9F:
        this.subb(d[(d[PSW] & 0x18) | (op & 7)]); break;

      // ORL / ANL / XRL
      case 0x42: this.writeDirect(b1, this.readLatch(b1) | d[ACC]); break;
      case 0x43: this.writeDirect(b1, this.readLatch(b1) | code[(pc0 + 2) & 0xFFFF]); break;
      case 0x44: d[ACC] |= b1; break;
      case 0x45: d[ACC] |= this.readDirect(b1); break;
      case 0x46: case 0x47: d[ACC] |= this.readInd(d[(d[PSW] & 0x18) | (op & 1)]); break;
      case 0x48: case 0x49: case 0x4A: case 0x4B: case 0x4C: case 0x4D: case 0x4E: case 0x4F:
        d[ACC] |= d[(d[PSW] & 0x18) | (op & 7)]; break;
      case 0x52: this.writeDirect(b1, this.readLatch(b1) & d[ACC]); break;
      case 0x53: this.writeDirect(b1, this.readLatch(b1) & code[(pc0 + 2) & 0xFFFF]); break;
      case 0x54: d[ACC] &= b1; break;
      case 0x55: d[ACC] &= this.readDirect(b1); break;
      case 0x56: case 0x57: d[ACC] &= this.readInd(d[(d[PSW] & 0x18) | (op & 1)]); break;
      case 0x58: case 0x59: case 0x5A: case 0x5B: case 0x5C: case 0x5D: case 0x5E: case 0x5F:
        d[ACC] &= d[(d[PSW] & 0x18) | (op & 7)]; break;
      case 0x62: this.writeDirect(b1, this.readLatch(b1) ^ d[ACC]); break;
      case 0x63: this.writeDirect(b1, this.readLatch(b1) ^ code[(pc0 + 2) & 0xFFFF]); break;
      case 0x64: d[ACC] ^= b1; break;
      case 0x65: d[ACC] ^= this.readDirect(b1); break;
      case 0x66: case 0x67: d[ACC] ^= this.readInd(d[(d[PSW] & 0x18) | (op & 1)]); break;
      case 0x68: case 0x69: case 0x6A: case 0x6B: case 0x6C: case 0x6D: case 0x6E: case 0x6F:
        d[ACC] ^= d[(d[PSW] & 0x18) | (op & 7)]; break;

      // Carry-bit logic
      case 0x72: if (this.bitRead(b1)) d[PSW] |= 0x80; break;
      case 0xA0: if (!this.bitRead(b1)) d[PSW] |= 0x80; break;
      case 0x82: if (!this.bitRead(b1)) d[PSW] &= 0x7F; break;
      case 0xB0: if (this.bitRead(b1)) d[PSW] &= 0x7F; break;
      case 0xA2: d[PSW] = (d[PSW] & 0x7F) | (this.bitRead(b1) << 7); break;
      case 0x92: this.bitWrite(b1, d[PSW] & 0x80); break;
      case 0xB2: this.bitWrite(b1, !this.bitReadLatch(b1)); break;
      case 0xC2: this.bitWrite(b1, 0); break;
      case 0xD2: this.bitWrite(b1, 1); break;
      case 0xB3: d[PSW] ^= 0x80; break;
      case 0xC3: d[PSW] &= 0x7F; break;
      case 0xD3: d[PSW] |= 0x80; break;

      // MOV
      case 0x74: d[ACC] = b1; break;
      case 0x75: this.writeDirect(b1, code[(pc0 + 2) & 0xFFFF]); break;
      case 0x76: case 0x77: this.writeInd(d[(d[PSW] & 0x18) | (op & 1)], b1); break;
      case 0x78: case 0x79: case 0x7A: case 0x7B: case 0x7C: case 0x7D: case 0x7E: case 0x7F:
        d[(d[PSW] & 0x18) | (op & 7)] = b1; break;
      case 0x85: this.writeDirect(code[(pc0 + 2) & 0xFFFF], this.readDirect(b1)); break;
      case 0x86: case 0x87: this.writeDirect(b1, this.readInd(d[(d[PSW] & 0x18) | (op & 1)])); break;
      case 0x88: case 0x89: case 0x8A: case 0x8B: case 0x8C: case 0x8D: case 0x8E: case 0x8F:
        this.writeDirect(b1, d[(d[PSW] & 0x18) | (op & 7)]); break;
      case 0x90: d[DPH] = b1; d[DPL] = code[(pc0 + 2) & 0xFFFF]; break;
      case 0xA6: case 0xA7: this.writeInd(d[(d[PSW] & 0x18) | (op & 1)], this.readDirect(b1)); break;
      case 0xA8: case 0xA9: case 0xAA: case 0xAB: case 0xAC: case 0xAD: case 0xAE: case 0xAF:
        d[(d[PSW] & 0x18) | (op & 7)] = this.readDirect(b1); break;
      case 0xE5: d[ACC] = this.readDirect(b1); break;
      case 0xE6: case 0xE7: d[ACC] = this.readInd(d[(d[PSW] & 0x18) | (op & 1)]); break;
      case 0xE8: case 0xE9: case 0xEA: case 0xEB: case 0xEC: case 0xED: case 0xEE: case 0xEF:
        d[ACC] = d[(d[PSW] & 0x18) | (op & 7)]; break;
      case 0xF5: this.writeDirect(b1, d[ACC]); break;
      case 0xF6: case 0xF7: this.writeInd(d[(d[PSW] & 0x18) | (op & 1)], d[ACC]); break;
      case 0xF8: case 0xF9: case 0xFA: case 0xFB: case 0xFC: case 0xFD: case 0xFE: case 0xFF:
        d[(d[PSW] & 0x18) | (op & 7)] = d[ACC]; break;
      case 0xE4: d[ACC] = 0; break;
      case 0xF4: d[ACC] = ~d[ACC]; break;
      case 0xC4: a = d[ACC]; d[ACC] = (a << 4) | (a >> 4); break;

      case 0x83: d[ACC] = code[(d[ACC] + pc) & 0xFFFF]; break;
      case 0x93: d[ACC] = code[(d[ACC] + ((d[DPH] << 8) | d[DPL])) & 0xFFFF]; break;
      case 0xA3: t = d[DPL] + 1; d[DPL] = t; if (t > 0xFF) d[DPH]++; break;

      case 0x84: // DIV AB
        a = d[ACC]; t = d[B];
        if (t === 0) d[PSW] = (d[PSW] & 0x7B) | 0x04;
        else { d[ACC] = (a / t) | 0; d[B] = a % t; d[PSW] &= 0x7B; }
        break;
      case 0xA4: // MUL AB
        r = d[ACC] * d[B];
        d[ACC] = r; d[B] = r >> 8;
        d[PSW] = (d[PSW] & 0x7B) | (r > 0xFF ? 0x04 : 0);
        break;
      case 0xD4: { // DA A
        a = d[ACC]; let psw = d[PSW];
        if ((a & 0x0F) > 9 || psw & 0x40) { a += 6; if (a > 0xFF) psw |= 0x80; a &= 0xFF; }
        if ((a & 0xF0) > 0x90 || psw & 0x80) { a += 0x60; if (a > 0xFF) psw |= 0x80; }
        d[ACC] = a; d[PSW] = psw;
        break;
      }

      case 0xB4: this.cjne(d[ACC], b1, code[(pc0 + 2) & 0xFFFF]); break;
      case 0xB5: this.cjne(d[ACC], this.readDirect(b1), code[(pc0 + 2) & 0xFFFF]); break;
      case 0xB6: case 0xB7: this.cjne(this.readInd(d[(d[PSW] & 0x18) | (op & 1)]), b1, code[(pc0 + 2) & 0xFFFF]); break;
      case 0xB8: case 0xB9: case 0xBA: case 0xBB: case 0xBC: case 0xBD: case 0xBE: case 0xBF:
        this.cjne(d[(d[PSW] & 0x18) | (op & 7)], b1, code[(pc0 + 2) & 0xFFFF]); break;

      case 0xC0: this.push(this.readDirect(b1)); break;
      case 0xD0: t = this.pop(); this.writeDirect(b1, t); break;

      case 0xC5: t = this.readDirect(b1); this.writeDirect(b1, d[ACC]); d[ACC] = t; break;
      case 0xC6: case 0xC7: a = d[(d[PSW] & 0x18) | (op & 1)]; t = this.readInd(a); this.writeInd(a, d[ACC]); d[ACC] = t; break;
      case 0xC8: case 0xC9: case 0xCA: case 0xCB: case 0xCC: case 0xCD: case 0xCE: case 0xCF:
        a = (d[PSW] & 0x18) | (op & 7); t = d[a]; d[a] = d[ACC]; d[ACC] = t; break;
      case 0xD6: case 0xD7:
        a = d[(d[PSW] & 0x18) | (op & 1)]; t = this.readInd(a);
        this.writeInd(a, (t & 0xF0) | (d[ACC] & 0x0F)); d[ACC] = (d[ACC] & 0xF0) | (t & 0x0F); break;

      case 0xD5:
        t = (this.readLatch(b1) - 1) & 0xFF; this.writeDirect(b1, t);
        if (t !== 0) this.pc = (pc + ((code[(pc0 + 2) & 0xFFFF] << 24) >> 24)) & 0xFFFF;
        break;
      case 0xD8: case 0xD9: case 0xDA: case 0xDB: case 0xDC: case 0xDD: case 0xDE: case 0xDF:
        a = (d[PSW] & 0x18) | (op & 7);
        if (--d[a] !== 0) this.pc = (pc + ((b1 << 24) >> 24)) & 0xFFFF;
        break;

      // MOVX
      case 0xE0: a = (d[DPH] << 8) | d[DPL]; d[ACC] = a & 0x8000 ? this.xhi[a & 0x7FFF] : this.xlo[a]; break;
      case 0xE2: case 0xE3:
        a = (d[0xA0] << 8) | d[(d[PSW] & 0x18) | (op & 1)];
        d[ACC] = a & 0x8000 ? this.xhi[a & 0x7FFF] : this.xlo[a]; break;
      case 0xF0: a = (d[DPH] << 8) | d[DPL]; if (a & 0x8000) this.xhi[a & 0x7FFF] = d[ACC]; else this.xlo[a] = d[ACC]; break;
      case 0xF2: case 0xF3:
        a = (d[0xA0] << 8) | d[(d[PSW] & 0x18) | (op & 1)];
        if (a & 0x8000) this.xhi[a & 0x7FFF] = d[ACC]; else this.xlo[a] = d[ACC]; break;
    }
    return OPCYC[op];
  }

  // One-line disassembly of the instruction at addr.
  disasm(addr) {
    const c = this.code, op = c[addr & 0xFFFF];
    const bytes = [];
    for (let i = 0; i < OPLEN[op]; i++) bytes.push(c[(addr + i) & 0xFFFF].toString(16).padStart(2, '0'));
    return `${addr.toString(16).padStart(4, '0')}  ${bytes.join(' ').padEnd(9)} ${MNEMONIC[op]}`;
  }
}

function advanceTimer(d, lo, hi, mode, n) {
  let ov = 0, v;
  switch (mode) {
    case 0: {
      v = ((d[hi] << 5) | (d[lo] & 0x1F)) + n;
      ov = Math.floor(v / 8192); v &= 0x1FFF;
      d[hi] = v >> 5; d[lo] = (d[lo] & 0xE0) | (v & 0x1F);
      break;
    }
    case 1:
      v = ((d[hi] << 8) | d[lo]) + n;
      ov = Math.floor(v / 65536); v &= 0xFFFF;
      d[hi] = v >> 8; d[lo] = v;
      break;
    case 2: {
      const first = 256 - d[lo];
      if (n < first) { d[lo] += n; break; }
      const period = 256 - d[hi];
      const rem = n - first;
      ov = 1 + Math.floor(rem / period);
      d[lo] = d[hi] + (rem % period);
      break;
    }
    case 3: // timer 0 mode 3: TL0 as 8-bit
      v = d[lo] + n;
      ov = v >> 8;
      d[lo] = v;
      break;
  }
  return ov;
}

function toOverflow(d, lo, hi, mode) {
  switch (mode) {
    case 0: return 8192 - ((d[hi] << 5) | (d[lo] & 0x1F));
    case 1: return 65536 - ((d[hi] << 8) | d[lo]);
    default: return 256 - d[lo];
  }
}
