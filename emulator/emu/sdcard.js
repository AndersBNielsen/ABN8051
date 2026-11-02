// SPI-mode SD card on the DOS/51 board's P1 upper nibble (see docs/HARDWARE.md):
//   P1.4 = /CS, P1.5 = SCK, P1.6 = MOSI (from the MCU), P1.7 = MISO (to the MCU).
// SPI mode 0: the card samples MOSI on the rising SCK edge and changes MISO
// after the falling edge. Byte-level protocol model: CMD0/8/55/ACMD41/58/59/
// 16/17/24/13, R1/R3/R7 responses, data tokens, data response + busy, SDSC
// byte addressing or SDHC block addressing. CRC7 is checked for CMD0 and CMD8
// (and for every command after CMD59 enables CRC); data CRC16 is generated on
// reads and checked on writes only when CRC is enabled, as on real cards.

const R1_IDLE = 0x01, R1_ILLEGAL = 0x04, R1_CRC = 0x08, R1_ADDR = 0x20, R1_PARAM = 0x40;

export function crc7(bytes, n = bytes.length) {
  let c = 0;
  for (let i = 0; i < n; i++) {
    let d = bytes[i];
    for (let k = 0; k < 8; k++) {
      c <<= 1;
      if ((d ^ c) & 0x80) c ^= 0x09;    // x^7 + x^3 + 1
      d <<= 1;
    }
    c &= 0x7F;
  }
  return c;
}

export function crc16(bytes, off = 0, n = bytes.length - off) {
  let c = 0;
  for (let i = 0; i < n; i++) {
    c ^= bytes[off + i] << 8;
    for (let k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
  }
  return c;
}

// Build a 6-byte command frame with a valid CRC7 (used by tests and hosts).
export function cmdFrame(index, arg) {
  const f = [0x40 | index, (arg >>> 24) & 0xFF, (arg >>> 16) & 0xFF, (arg >>> 8) & 0xFF, arg & 0xFF, 0];
  f[5] = (crc7(f, 5) << 1) | 1;
  return f;
}

export class SDCard {
  // opts: { image: Uint8Array (multiple of 512), sdhc: bool (default true),
  // version: 1|2 (CMD8 support), readyAfter: ACMD41 polls before ready,
  // busyBytes: write busy length, onWrite(offset, length) after a block write }
  constructor(opts = {}) {
    this.image = opts.image || new Uint8Array(opts.size || 32 << 20);
    if (this.image.length % 512) throw new Error('SD image size must be a multiple of 512');
    this.sdhc = opts.sdhc !== undefined ? !!opts.sdhc : true;
    this.version = opts.version || 2;
    if (this.sdhc && this.version < 2) throw new Error('SDHC cards are version 2');
    this.readyAfter = opts.readyAfter ?? 3;
    this.busyBytes = opts.busyBytes ?? 4;
    this.onWrite = opts.onWrite || null;
    this.log = opts.log || null;      // (string) protocol trace
    this.stats = { cmds: 0, reads: 0, writes: 0, crcErrors: 0 };
    this.powerCycle();
  }

  get blocks() { return this.image.length / 512; }

  // Power-on: native SD mode until CMD0 with /CS low.
  powerCycle() {
    this.spi = false;       // entered SPI mode
    this.idle = true;
    this.crcOn = false;
    this.app = false;
    this.acmd41Polls = 0;
    this.hcsSeen = false;
    this.blockLen = 512;
    this.cs = 1; this.sck = 0; this.mosi = 1;
    this.miso = 1;
    this._resetBus();
  }

  _resetBus() {
    this.frame = [];
    this.out = [];
    this.cur = 0xFF;        // byte being shifted out
    this.inb = 0;
    this.bits = 0;
    this.rx = null;         // write data reception state
  }

  // ---- pin level interface (called on every P1 latch write) -------------
  // Returns the MISO level (1 = released / pulled up).
  pins(cs, sck, mosi) {
    if (cs !== this.cs) {
      this.cs = cs;
      if (cs) {             // deselect: card releases MISO, aborts partial bytes
        this.bits = 0; this.frame = []; this.out = []; this.rx = null; this.miso = 1;
      } else {
        this.bits = 0;
        this.cur = this.out.length ? this.out.shift() : 0xFF;
        this.miso = (this.cur >> 7) & 1;
      }
    }
    if (sck !== this.sck) {
      this.sck = sck;
      if (!this.cs) {
        if (sck) {          // rising edge: sample
          this.inb = ((this.inb << 1) | mosi) & 0xFF;
          this.bits++;
        } else {            // falling edge: shift out
          if (this.bits === 8) {
            this.bits = 0;
            this._byte(this.inb);
            this.cur = this.out.length ? this.out.shift() : 0xFF;
          }
          this.miso = (this.cur >> (7 - this.bits)) & 1;
        }
      }
    }
    this.mosi = mosi;
    return this.cs ? 1 : this.miso;
  }

  // Hook into a Board: P1 writes drive the card, P1.7 reads its MISO.
  attach(board) {
    const cpu = board.cpu;
    this.board = board;
    const update = (v) => {
      const m = this.pins((v >> 4) & 1, (v >> 5) & 1, (v >> 6) & 1);
      cpu.p1in = m ? cpu.p1in | 0x80 : cpu.p1in & 0x7F;
    };
    board.sd = { card: this, update };
    update(board.portLatch(1));
    return this;
  }

  // ---- byte level -------------------------------------------------------
  // Exchange one byte directly (unit tests): returns the byte the card sent
  // while `b` was received.
  xfer(b) {
    const out = this.cur;
    this._byte(b & 0xFF);
    this.cur = this.out.length ? this.out.shift() : 0xFF;
    return out;
  }
  select() { this.cs = 0; this.bits = 0; this.cur = this.out.length ? this.out.shift() : 0xFF; }
  deselect() { this.cs = 1; this.bits = 0; this.frame = []; this.out = []; this.rx = null; this.cur = 0xFF; }

  _r1() { return this.idle ? R1_IDLE : 0; }

  _byte(b) {
    if (this.rx) { this._rxData(b); return; }
    if (this.out.length) return;          // response or data still going out
    if (this.frame.length === 0) {
      if ((b & 0xC0) !== 0x40) return;    // idle 0xFF bytes between commands
    }
    this.frame.push(b);
    if (this.frame.length === 6) {
      const f = this.frame;
      this.frame = [];
      this._command(f);
    }
  }

  _respond(...bytes) { this.out.push(0xFF, ...bytes); } // Ncr = 1 byte

  _command(f) {
    const idx = f[0] & 0x3F;
    const arg = ((f[1] << 24) | (f[2] << 16) | (f[3] << 8) | f[4]) >>> 0;
    const crcOk = ((crc7(f, 5) << 1) | 1) === f[5];
    const app = this.app;
    this.app = false;
    this.stats.cmds++;
    if (this.log) this.log(`${app ? 'A' : ''}CMD${idx} ${arg.toString(16)}${crcOk ? '' : ' badcrc'}`);

    if (!this.spi) {
      // native mode: only a CMD0 with a correct CRC (and /CS low) is accepted
      if (idx === 0 && crcOk) { this.spi = true; this.idle = true; this.crcOn = false; this._respond(R1_IDLE); }
      else if (idx === 0) this.stats.crcErrors++;
      return;
    }
    if (!crcOk && (this.crcOn || idx === 0 || idx === 8)) {
      this.stats.crcErrors++;
      this._respond(this._r1() | R1_CRC);
      return;
    }
    if (app) {
      switch (idx) {
        case 41: {
          if (arg & 0x40000000) this.hcsSeen = true;
          // an SDHC card never leaves idle for a host that did not set HCS
          if (this.sdhc && !(arg & 0x40000000)) { this._respond(R1_IDLE); return; }
          if (this.idle && ++this.acmd41Polls >= this.readyAfter) this.idle = false;
          this._respond(this._r1());
          return;
        }
        case 13: this._respond(this._r1(), 0); return;
        default: break;    // fall through to the normal command set
      }
    }
    switch (idx) {
      case 0:
        this.idle = true; this.acmd41Polls = 0; this.blockLen = 512;
        this._respond(R1_IDLE);
        return;
      case 8:
        if (this.version < 2) { this._respond(this._r1() | R1_ILLEGAL); return; }
        this._respond(this._r1(), 0, 0, (arg >> 8) & 0x0F, arg & 0xFF);
        return;
      case 55: this.app = true; this._respond(this._r1()); return;
      case 58: {
        const ready = !this.idle;
        const o0 = (ready ? 0x80 : 0) | (ready && this.sdhc ? 0x40 : 0);
        this._respond(this._r1(), o0, 0xFF, 0x80, 0x00); // 2.7-3.6 V window
        return;
      }
      case 59: this.crcOn = !!(arg & 1); this._respond(this._r1()); return;
      case 1: // MMC init: an SD card may accept it in SPI mode
        if (this.sdhc) { this._respond(this._r1() | R1_ILLEGAL); return; }
        if (this.idle && ++this.acmd41Polls >= this.readyAfter) this.idle = false;
        this._respond(this._r1());
        return;
      case 13: this._respond(this._r1(), 0); return;
      default: break;
    }
    if (this.idle) { this._respond(R1_IDLE | R1_ILLEGAL); return; }
    switch (idx) {
      case 16:
        if (!this.sdhc && (arg < 1 || arg > 512)) { this._respond(R1_PARAM); return; }
        if (!this.sdhc) this.blockLen = arg;
        this._respond(0);
        return;
      case 17: {
        const off = this._addr(arg);
        if (off < 0) return;
        const len = this.sdhc ? 512 : this.blockLen;
        const data = this.image.subarray(off, off + len);
        const c = crc16(data);
        this.stats.reads++;
        this._respond(0, 0xFF, 0xFE, ...data, c >> 8, c & 0xFF);
        return;
      }
      case 24: {
        const off = this._addr(arg);
        if (off < 0) return;
        this._respond(0);
        this.rx = { off, len: this.sdhc ? 512 : this.blockLen, buf: null, n: 0 };
        return;
      }
      default:
        this._respond(R1_ILLEGAL);
    }
  }

  _addr(arg) {
    const off = this.sdhc ? arg * 512 : arg;
    const len = this.sdhc ? 512 : this.blockLen;
    if (!this.sdhc && off % 512 && len === 512) {
      // misaligned SDSC access is allowed only within one block (partial blocks off)
      this._respond(R1_ADDR);
      return -1;
    }
    if (off + len > this.image.length) { this._respond(R1_PARAM); return -1; }
    return off;
  }

  // Data phase of CMD24: wait for 0xFE, take len bytes + CRC16, then answer.
  _rxData(b) {
    const r = this.rx;
    if (!r.buf) {
      if (b === 0xFE) { r.buf = new Uint8Array(r.len + 2); r.n = 0; }
      return;
    }
    r.buf[r.n++] = b;
    if (r.n < r.len + 2) return;
    this.rx = null;
    const data = r.buf.subarray(0, r.len);
    if (this.crcOn && crc16(data) !== ((r.buf[r.len] << 8) | r.buf[r.len + 1])) {
      this.stats.crcErrors++;
      this.out.push(0x0B);                  // data rejected: CRC error
      return;
    }
    this.image.set(data, r.off);
    this.stats.writes++;
    if (this.onWrite) this.onWrite(r.off, r.len);
    this.out.push(0x05);                    // data accepted
    for (let i = 0; i < this.busyBytes; i++) this.out.push(0x00);
  }
}
