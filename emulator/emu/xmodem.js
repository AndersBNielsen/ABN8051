// Host-side XMODEM (128-byte blocks, checksum or CRC-16) as event-driven state
// machines. Feed received bytes with feed(), drive timeouts with tick(ms);
// bytes to transmit are passed to the `send(Uint8Array)` callback.
// The receiver also accepts 1K (STX) blocks.

export const SOH = 0x01, STX = 0x02, EOT = 0x04, ACK = 0x06, NAK = 0x15, CAN = 0x18, SUB = 0x1A, CRC_C = 0x43;

export function crc16xmodem(data, start = 0, end = data.length) {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc ^= data[i] << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}

export function checksum8(data, start = 0, end = data.length) {
  let s = 0;
  for (let i = start; i < end; i++) s += data[i];
  return s & 0xFF;
}

// Remove trailing SUB (0x1A) padding.
export function stripPadding(data, pad = SUB) {
  let n = data.length;
  while (n > 0 && data[n - 1] === pad) n--;
  return data.subarray ? data.subarray(0, n) : data.slice(0, n);
}

const noop = () => {};

// Sender: waits for 'C' (CRC) or NAK (checksum) from the receiver.
export class XmodemSender {
  constructor(data, opts = {}) {
    this.data = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.send = opts.send || noop;
    this.onDone = opts.onDone || noop;          // ()
    this.onError = opts.onError || noop;        // (message)
    this.onProgress = opts.onProgress || noop;  // (bytesAcked, total)
    this.maxRetries = opts.retries ?? 10;
    this.startTimeoutMs = opts.startTimeoutMs ?? 60000;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 10000;
    this.blocks = Math.ceil(this.data.length / 128);
    this.state = 'waitStart';
    this.mode = null;  // 'crc' | 'checksum'
    this.block = 0;    // index of block being sent (0-based)
    this.retries = 0;
    this.timer = 0;
    this.cans = 0;
    this.error = null;
  }

  get done() { return this.state === 'done' || this.state === 'error'; }

  _packet(i) {
    const crc = this.mode === 'crc';
    const p = new Uint8Array(3 + 128 + (crc ? 2 : 1));
    const n = (i + 1) & 0xFF;
    p[0] = SOH; p[1] = n; p[2] = 0xFF - n;
    p.fill(SUB, 3, 131);
    p.set(this.data.subarray(i * 128, Math.min(this.data.length, (i + 1) * 128)), 3);
    if (crc) { const c = crc16xmodem(p, 3, 131); p[131] = c >> 8; p[132] = c & 0xFF; }
    else p[131] = checksum8(p, 3, 131);
    return p;
  }

  _sendCurrent() {
    this.timer = 0;
    if (this.block < this.blocks) { this.state = 'waitAck'; this.send(this._packet(this.block)); }
    else { this.state = 'waitEotAck'; this.send(Uint8Array.of(EOT)); }
  }

  _fail(msg, sendCan = true) {
    if (this.done) return;
    this.state = 'error';
    this.error = msg;
    if (sendCan) this.send(Uint8Array.of(CAN, CAN, CAN, CAN, CAN, CAN, CAN, CAN));
    this.onError(msg);
  }

  _retry(why) {
    if (++this.retries > this.maxRetries) return this._fail(`too many retries (${why})`);
    this._sendCurrent();
  }

  feed(bytes) {
    if (typeof bytes === 'number') bytes = [bytes];
    for (const b of bytes) {
      if (this.done) return;
      if (b === CAN) { if (++this.cans >= 2) this._fail('cancelled by receiver', false); continue; }
      this.cans = 0;
      switch (this.state) {
        case 'waitStart':
          if (b === CRC_C || b === NAK) {
            this.mode = b === CRC_C ? 'crc' : 'checksum';
            this.retries = 0;
            this._sendCurrent();
          }
          break;
        case 'waitAck':
          if (b === ACK) {
            this.block++;
            this.retries = 0;
            this.onProgress(Math.min(this.block * 128, this.data.length), this.data.length);
            this._sendCurrent();
          } else if (b === NAK || (b === CRC_C && this.block === 0)) {
            this._retry('NAK');
          }
          break;
        case 'waitEotAck':
          if (b === ACK) { this.state = 'done'; this.onDone(); }
          else if (b === NAK) this._retry('EOT NAK');
          break;
      }
    }
  }

  tick(ms) {
    if (this.done) return;
    this.timer += ms;
    if (this.state === 'waitStart') {
      if (this.timer >= this.startTimeoutMs) this._fail('receiver never started');
    } else if (this.timer >= this.ackTimeoutMs) this._retry('timeout');
  }

  cancel() { this._fail('cancelled'); }
}

// Receiver: polls with 'C' (or NAK in checksum mode) until the sender starts.
export class XmodemReceiver {
  constructor(opts = {}) {
    this.send = opts.send || noop;
    this.onDone = opts.onDone || noop;   // (Uint8Array data incl. padding)
    this.onError = opts.onError || noop;
    this.onProgress = opts.onProgress || noop; // (bytesReceived)
    this.mode = opts.mode || 'crc';
    this.fallback = opts.fallback ?? true;       // switch to checksum after 3 unanswered 'C'
    this.pollMs = opts.pollMs ?? 3000;
    this.maxPolls = opts.maxPolls ?? 20;
    this.charTimeoutMs = opts.charTimeoutMs ?? 1000;
    this.blockTimeoutMs = opts.blockTimeoutMs ?? 10000;
    this.maxRetries = opts.retries ?? 10;
    this.state = 'idle';
    this.chunks = [];
    this.length = 0;
    this.expected = 1;
    this.buf = new Uint8Array(1029);
    this.pos = 0;
    this.need = 0;
    this.timer = 0;
    this.polls = 0;
    this.retries = 0;
    this.cans = 0;
    this.error = null;
    this.data = null;
  }

  get done() { return this.state === 'done' || this.state === 'error'; }

  start() {
    this.state = 'polling';
    this._poll();
  }

  _poll() {
    this.timer = 0;
    this.polls++;
    if (this.fallback && this.mode === 'crc' && this.polls > 3) this.mode = 'checksum';
    this.send(Uint8Array.of(this.mode === 'crc' ? CRC_C : NAK));
  }

  _fail(msg, sendCan = true) {
    if (this.done) return;
    this.state = 'error';
    this.error = msg;
    if (sendCan) this.send(Uint8Array.of(CAN, CAN, CAN, CAN, CAN, CAN, CAN, CAN));
    this.onError(msg);
  }

  _nak() {
    this.pos = 0;
    this.state = 'block';
    this.timer = 0;
    if (++this.retries > this.maxRetries) return this._fail('too many errors');
    this.send(Uint8Array.of(NAK));
  }

  _finishPacket() {
    const b = this.buf, size = b[0] === STX ? 1024 : 128;
    const crc = this.mode === 'crc';
    let ok = (b[1] ^ b[2]) === 0xFF;
    if (ok) {
      if (crc) ok = crc16xmodem(b, 3, 3 + size) === ((b[3 + size] << 8) | b[4 + size]);
      else ok = checksum8(b, 3, 3 + size) === b[3 + size];
    }
    this.pos = 0;
    this.state = 'block';
    this.timer = 0;
    if (!ok) return this._nak();
    const n = b[1];
    if (n === (this.expected & 0xFF)) {
      this.chunks.push(b.slice(3, 3 + size));
      this.length += size;
      this.expected++;
      this.retries = 0;
      this.send(Uint8Array.of(ACK));
      this.onProgress(this.length);
    } else if (n === ((this.expected - 1) & 0xFF)) {
      this.send(Uint8Array.of(ACK)); // duplicate
    } else {
      this._fail(`block sequence error (got ${n}, want ${this.expected & 0xFF})`);
    }
  }

  feed(bytes) {
    if (typeof bytes === 'number') bytes = [bytes];
    for (const c of bytes) {
      if (this.done || this.state === 'idle') return;
      if (this.state === 'packet') {
        this.buf[this.pos++] = c;
        this.timer = 0;
        if (this.pos === this.need) this._finishPacket();
        continue;
      }
      // polling / block: expect a header byte
      if (c === CAN) { if (++this.cans >= 2) this._fail('cancelled by sender', false); continue; }
      this.cans = 0;
      if (c === SOH || c === STX) {
        if (this.state === 'polling') this.retries = 0;
        this.state = 'packet';
        this.buf[0] = c;
        this.pos = 1;
        this.need = 3 + (c === STX ? 1024 : 128) + (this.mode === 'crc' ? 2 : 1);
        this.timer = 0;
      } else if (c === EOT && (this.state === 'block' || this.state === 'polling')) { // polling: empty file
        this.send(Uint8Array.of(ACK));
        const out = new Uint8Array(this.length);
        let o = 0;
        for (const ch of this.chunks) { out.set(ch, o); o += ch.length; }
        this.data = out;
        this.state = 'done';
        this.onDone(out);
      }
      // anything else is line noise and ignored
    }
  }

  tick(ms) {
    if (this.done || this.state === 'idle') return;
    this.timer += ms;
    if (this.state === 'polling') {
      if (this.timer >= this.pollMs) {
        if (this.polls >= this.maxPolls) this._fail('sender never started');
        else this._poll();
      }
    } else if (this.state === 'packet') {
      if (this.timer >= this.charTimeoutMs) this._nak();
    } else if (this.timer >= this.blockTimeoutMs) this._nak();
  }

  cancel() { this._fail('cancelled'); }
}
