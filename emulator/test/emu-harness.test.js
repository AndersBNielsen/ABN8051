// Harness, UART RX/TX paths, XMODEM state machines and the CLI, using an
// SDCC-built monitor program running on the emulated board.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../emu/harness.js';
import { findTool, sdccBuild, tmpDir } from '../emu/devtools.js';
import { XmodemSender, XmodemReceiver, stripPadding, crc16xmodem } from '../emu/xmodem.js';
import { mulberry32 } from '../emu/board.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDCC = findTool('sdcc');
const skip = !SDCC && 'sdcc not installed (skipping harness tests that need a test ROM)';

// Tiny monitor: prompt "> ", commands:
//   e<text>\r  echo upper-cased    r  XMODEM-receive into XRAM 0x0000 (CRC mode)
//   s<n>\r     XMODEM-send n bytes of XRAM 0x0000 back (CRC or checksum)
//   c          print CRC-16 and length of the last received file
const MONITOR = `
#include <8051.h>
#include <stdint.h>
#define SOH 1
#define EOT 4
#define ACK 6
#define NAK 0x15
#define CAN 0x18
__xdata uint8_t file[8192];
uint16_t flen;
static void putc_(uint8_t c) { while (!TI); TI = 0; SBUF = c; }
static void puts_(const char *s) { while (*s) putc_(*s++); }
static int getc_t(uint16_t ms) {      /* -1 on timeout (approximate ms) */
  uint16_t i; uint8_t j;
  for (i = 0; i < ms; i++) for (j = 0; j < 60; j++) if (RI) { RI = 0; return SBUF; }
  return -1;
}
static uint8_t getc_(void) { while (!RI); RI = 0; return SBUF; }
static void puthex(uint16_t v) { const char *h = "0123456789ABCDEF"; uint8_t i; for (i = 0; i < 4; i++) { putc_(h[v >> 12]); v <<= 4; } }
static uint16_t crc_upd(uint16_t crc, uint8_t b) {
  uint8_t k; crc ^= (uint16_t)b << 8;
  for (k = 0; k < 8; k++) crc = (crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1;
  return crc;
}
static void xrecv(void) {
  uint8_t blk = 1, i; int c; uint16_t crc, pos = 0; uint8_t tries = 0;
  __xdata uint8_t *p;
  putc_('C');
  for (;;) {
    c = getc_t(3000);
    if (c < 0) { if (++tries > 10) return; putc_(pos ? NAK : 'C'); continue; }
    if (c == EOT) { putc_(ACK); flen = pos; return; }
    if (c == CAN) return;
    if (c != SOH) continue;
    { uint8_t n = getc_(), nn = getc_(); p = file + pos; crc = 0;
      for (i = 0; i < 128; i++) { uint8_t b = getc_(); p[i] = b; crc = crc_upd(crc, b); }
      c = getc_(); crc ^= (uint16_t)c << 8; c = getc_(); crc ^= (uint8_t)c;
      if ((uint8_t)(n ^ nn) != 0xFF || crc) { putc_(NAK); continue; }
      if (n == blk) { blk++; pos += 128; }
      putc_(ACK); }
  }
}
static void xsend(uint16_t n) {
  uint8_t blk = 1, i, crcmode; int c; uint16_t pos = 0, crc;
  do c = getc_(); while (c != 'C' && c != NAK);
  crcmode = c == 'C';
  while (pos < n) {
    uint8_t sum = 0; crc = 0;
    putc_(SOH); putc_(blk); putc_(~blk);
    for (i = 0; i < 128; i++) {
      uint8_t b = pos + i < n ? file[pos + i] : 0x1A;
      putc_(b); sum += b; crc = crc_upd(crc, b);
    }
    if (crcmode) { putc_(crc >> 8); putc_(crc); } else putc_(sum);
    c = getc_();
    if (c == ACK) { blk++; pos += 128; }
    else if (c == CAN) return;
  }
  do { putc_(EOT); c = getc_(); } while (c != ACK);
}
void halt(void) { while (1); }
void main(void) {
  uint8_t c; uint16_t n;
  SCON = 0x50; TMOD = 0x20; TH1 = 0xFD; TL1 = 0xFD; PCON |= 0x80; TR1 = 1; TI = 1;
  puts_("MON51\\r\\n");
  for (;;) {
    puts_("> ");
    c = getc_();
    if (c == 'e') {
      while ((c = getc_()) != '\\r') putc_(c >= 'a' && c <= 'z' ? c - 32 : c);
      puts_("\\r\\n");
    } else if (c == 'r') { flen = 0; xrecv(); puts_("\\r\\nGOT "); puthex(flen); puts_("\\r\\n"); }
    else if (c == 's') {
      n = 0; while ((c = getc_()) != '\\r') n = n * 10 + (c - '0');
      xsend(n); puts_("\\r\\nSENT\\r\\n");
    } else if (c == 'c') {
      uint16_t crc = 0, i; for (i = 0; i < flen; i++) crc = crc_upd(crc, file[i]);
      puthex(crc); putc_(' '); puthex(flen); puts_("\\r\\n");
    } else if (c == 'q') { puts_("BYE\\r\\n"); while (!TI); halt(); }
  }
}`;

let monitor = null;
function getMonitor() {
  if (!monitor) monitor = sdccBuild(MONITOR, { name: 'monitor' });
  return monitor;
}

test('harness: prompt, echo, waitFor marks', { skip }, () => {
  const h = createHarness({ romBytes: getMonitor().ihx });
  assert.match(h.waitFor('> '), /MON51\r\n> $/);
  h.send('ehello world\r');
  assert.equal(h.waitFor('> '), 'HELLO WORLD\r\n> ');
  // A long paste in flow pacing is never dropped, even with slow code.
  const long = 'e' + 'abcdefghij'.repeat(40) + '\r';
  h.send(long);
  assert.equal(h.waitFor('> '), 'ABCDEFGHIJ'.repeat(40) + '\r\n> ');
  assert.throws(() => h.waitFor('never', { timeoutCycles: 50000 }), /timed out/);
});

test('harness: wire pacing drops bytes while RI is set (overrun)', { skip }, () => {
  const h = createHarness({ romBytes: getMonitor().ihx, rxPacing: 'wire' });
  h.waitFor('> ');
  // 'c' prints 10 chars (~4800 cycles) while 3 more bytes arrive back to back.
  h.send('cee\r');
  h.run(20000);
  assert.ok(h.board.rxOverruns >= 1, 'expected overrun in wire mode');
});

test('harness: XMODEM send to and receive from emulated program', { skip }, () => {
  const h = createHarness({ romBytes: getMonitor().ihx });
  h.waitFor('> ');
  const rnd = mulberry32(7);
  const data = Uint8Array.from({ length: 1000 }, () => rnd() & 0xFF);
  h.send('r');
  const up = h.xmodemSend(data);
  assert.ok(up.ok, up.error);
  const got = h.waitFor(/GOT [0-9A-F]{4}\r\n> /);
  assert.match(got, /GOT 0400/); // 8 blocks of 128
  h.send('c');
  const padded = new Uint8Array(1024).fill(0x1A); padded.set(data);
  const crc = crc16xmodem(padded).toString(16).toUpperCase().padStart(4, '0');
  assert.match(h.waitFor('> '), new RegExp(`${crc} 0400`));
  // Upload took about 8 blocks * 133 bytes * 480 cycles plus turnaround.
  assert.ok(up.cycles > 8 * 133 * 480 && up.cycles < 3 * 8 * 133 * 480, `cycles ${up.cycles}`);

  h.send('s1000\r');
  const down = h.xmodemReceive();
  assert.ok(down.ok, down.error);
  assert.equal(down.raw.length, 1024);
  assert.deepEqual(down.data, stripPadding(padded));
  assert.deepEqual(down.raw.subarray(0, 1000), data);
  h.waitFor('SENT');

  // checksum-mode receive (receiver asks with NAK)
  h.send('s300\r');
  const d2 = h.xmodemReceive({ mode: 'checksum' });
  assert.ok(d2.ok, d2.error);
  assert.deepEqual(d2.raw.subarray(0, 300), data.subarray(0, 300));
});

test('xmodem: sender/receiver loopback with line noise, corruption and retries', () => {
  for (const mode of ['crc', 'checksum']) {
    const rnd = mulberry32(99);
    const data = Uint8Array.from({ length: 777 }, () => rnd() & 0xFF);
    let result = null, corruptNext = 3;
    const q1 = [], q2 = [];
    const rx = new XmodemReceiver({ mode, fallback: false, send: (b) => q2.push(...b), onDone: (d) => { result = d; } });
    const tx = new XmodemSender(data, {
      send: (b) => {
        const c = Uint8Array.from(b);
        if (c.length > 100 && corruptNext-- === 0) c[50] ^= 0x40; // one damaged packet
        q1.push(...c);
      },
    });
    rx.start();
    for (let i = 0; i < 10000 && !result; i++) {
      if (q1.length) rx.feed(q1.splice(0));
      if (q2.length) tx.feed(q2.splice(0));
      rx.tick(10); tx.tick(10);
    }
    assert.ok(result, `${mode}: transfer did not finish`);
    assert.equal(tx.state, 'done');
    assert.equal(result.length, 896);
    assert.deepEqual(stripPadding(result), data);
  }
});

test('xmodem: timeouts, CAN abort, empty file', () => {
  // receiver polls with C, falls back to NAK after 3 polls, gives up eventually
  const sent = [];
  let err = null;
  const rx = new XmodemReceiver({ send: (b) => sent.push(...b), onError: (e) => { err = e; }, maxPolls: 5 });
  rx.start();
  for (let i = 0; i < 20; i++) rx.tick(3000);
  assert.deepEqual(sent.slice(0, 5), [0x43, 0x43, 0x43, 0x15, 0x15]);
  assert.match(err, /never started/);
  // sender aborts on CAN CAN
  let e2 = null;
  const tx = new XmodemSender(new Uint8Array(10), { onError: (e) => { e2 = e; } });
  tx.feed([0x43]);
  tx.feed([0x18, 0x18]);
  assert.match(e2, /cancelled/);
  // sender retries on timeout then fails
  let e3 = null, packets = 0;
  const tx2 = new XmodemSender(new Uint8Array(10), { retries: 3, send: () => packets++, onError: (e) => { e3 = e; } });
  tx2.feed([0x15]);
  for (let i = 0; i < 10; i++) tx2.tick(10000);
  assert.equal(packets, 4 + 1); // first + 3 retries, then CAN burst
  assert.match(e3, /retries/);
  // empty file: just EOT
  const out = [];
  let done = false;
  const tx3 = new XmodemSender(new Uint8Array(0), { send: (b) => out.push(...b), onDone: () => { done = true; } });
  tx3.feed([0x43]);
  assert.deepEqual(out, [0x04]);
  tx3.feed([0x06]);
  assert.ok(done);
  assert.deepEqual(Array.from(stripPadding(Uint8Array.of(1, 2, 0x1A, 0x1A))), [1, 2]);
});

function runCli(args, { input, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'bin/dos51.js'), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d.toString('latin1'); });
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { p.kill(); reject(new Error(`cli timeout; stdout=${JSON.stringify(out)} stderr=${err}`)); }, timeoutMs);
    p.on('exit', (code) => { clearTimeout(t); resolve({ code, out, err, proc: p }); });
    if (input !== undefined) { p.stdin.end(input); }
    resolve.proc = p;
  });
}

test('cli: piped stdin, state file save/restore', { skip }, async () => {
  const dir = tmpDir('dos51-cli-');
  const rom = path.join(dir, 'mon.ihx');
  fs.writeFileSync(rom, getMonitor().ihx);
  const state = path.join(dir, 'state.json');
  const r = await runCli(['--rom', rom, '--state', state, '--baud-pacing', 'flow', '--seed', '3'], { input: 'eabc\r' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /MON51\r\n> ABC\r\n> /);
  const s = JSON.parse(fs.readFileSync(state, 'utf8'));
  assert.equal(s.version, 1);
  assert.equal(Buffer.from(s.ram0, 'base64').length, 32768);
});

test('cli: --tcp serves the serial port', { skip }, async () => {
  const dir = tmpDir('dos51-cli-');
  const rom = path.join(dir, 'mon.ihx');
  fs.writeFileSync(rom, getMonitor().ihx);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, [path.join(ROOT, 'bin/dos51.js'), '--rom', rom, '--tcp', String(port)], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await new Promise((res) => p.stderr.on('data', (d) => { if (/tcp:\/\//.test(d)) res(); }));
    const sock = net.connect(port, '127.0.0.1');
    let got = '';
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`tcp timeout: ${JSON.stringify(got)}`)), 10000);
      sock.on('data', (d) => {
        got += d.toString('latin1');
        if (got.endsWith('> ') && !got.includes('TCP')) sock.write('etcp ok\r');
        if (/TCP OK\r\n> $/.test(got)) { clearTimeout(t); res(); }
      });
    });
    sock.destroy();
    // reset via stdin command; the board restarts and prints the banner again
    p.stdin.write('q\n');
    await new Promise((res) => p.on('exit', res));
  } finally { p.kill(); }
});
