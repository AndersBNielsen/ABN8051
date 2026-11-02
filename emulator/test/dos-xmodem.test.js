// DOS/51 ROM end to end: XMODEM upload (rx) and download (sx).
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, cmd, upload, download, PROMPT, SEC } from './dos-helpers.js';
import { crc16xmodem } from '../emu/xmodem.js';

const bytes = (n, f) => Uint8Array.from({ length: n }, (_, i) => f(i) & 0xFF);

test('binary upload and download round trip (CRC-16), size not a multiple of 128', () => {
  const { h } = boot();
  const data = bytes(1000, i => i * 37 + 11);
  const u = upload(h, 'bin.dat', data);
  assert.ok(u.ok, u.error);
  assert.match(u.tail, /received 1000 bytes\r\n/);
  assert.match(cmd(h, 'ls -l'), / 1000 {2}[0-9A-F]{4} {2}bin\.dat/);
  const d = download(h, 'bin.dat');
  assert.ok(d.ok, d.error);
  assert.match(d.tail, /sent 1000 bytes\r\n/);
  assert.deepEqual(Array.from(d.data), Array.from(data));
});

test('download with checksum instead of CRC, empty file, exact 128-byte multiple', () => {
  const { h } = boot();
  const d = download(h, 'hello.asm', { mode: 'checksum' });
  assert.ok(d.ok, d.error);
  assert.equal(Buffer.from(d.data).toString('latin1'), cmd(h, 'cat hello.asm'));
  cmd(h, 'touch empty');
  const e = download(h, 'empty');
  assert.ok(e.ok, e.error);
  assert.equal(e.data.length, 0);
  const data = bytes(256, i => 255 - i);
  assert.ok(upload(h, 'b256', data).ok);
  const r = download(h, 'b256');
  assert.deepEqual(Array.from(r.data), Array.from(data));
});

test('upload a program as a binary and run it', () => {
  // "Hi!" via PUTSI, then RET  (assembled by hand)
  const prog = [0x12, 0x7F, 0x30, 0x48, 0x69, 0x21, 0x0A, 0x00, 0x22];
  const { h } = boot();
  assert.ok(upload(h, 'hi.bin', Uint8Array.from(prog)).ok);
  assert.equal(cmd(h, 'hi'), 'Hi!\n');
  assert.equal(cmd(h, 'hi.bin'), 'Hi!\n');
  // an assembled program comes back unchanged
  cmd(h, 'asm primes.asm');
  const d = download(h, 'primes.bin');
  assert.ok(d.ok);
  assert.deepEqual(Array.from(d.data), Array.from(h.board.ram1.subarray(0, d.data.length)));
});

test('1K (STX) blocks, a repeated block and a corrupted block', () => {
  const { h } = boot();
  const big = bytes(2500, i => i ^ (i >> 8));
  h.send('rx big.dat\r');
  h.waitFor('start the upload now');
  const got = [];
  h._sink = (b) => got.push(b);
  const next = (ms) => {
    const end = h.board.cycles + ms * SEC / 1000;
    while (h.board.cycles < end) { if (got.length) return got.shift(); h.run(2000); }
    return -1;
  };
  const block = (n, off) => {
    const p = new Uint8Array(1029);
    p[0] = 0x02; p[1] = n; p[2] = 255 - n;
    for (let i = 0; i < 1024; i++) p[3 + i] = off + i < big.length ? big[off + i] : 0x1A;
    const c = crc16xmodem(p, 3, 1027);
    p[1027] = c >> 8; p[1028] = c & 0xFF;
    return p;
  };
  h.board.rxPacing = 'wire';
  let c;
  while ((c = next(4000)) !== 0x43) assert.notEqual(c, -1, 'no C from the receiver');
  h.board.serialInput(block(1, 0));
  assert.equal(next(3000), 0x06);
  h.board.serialInput(block(1, 0));          // sender missed our ACK: repeat
  assert.equal(next(3000), 0x06);
  const bad = block(2, 1024);
  bad[500] ^= 0x40;
  h.board.serialInput(bad);
  assert.equal(next(3000), 0x15);             // NAK
  h.board.serialInput(block(2, 1024));
  assert.equal(next(3000), 0x06);
  h.board.serialInput(block(3, 2048));
  assert.equal(next(3000), 0x06);
  h.board.serialInput([0x04]);
  assert.equal(next(3000), 0x06);
  h._sink = null;
  assert.match(h.waitFor(PROMPT, { timeoutCycles: 5 * SEC }), /received 2500 bytes/);
  const d = download(h, 'big.dat');
  assert.deepEqual(Array.from(d.data), Array.from(big));
});

test('cancelled or failed transfers leave no file; disk full is reported', () => {
  const { h } = boot();
  h.send('rx gone.dat\r');
  h.waitFor('start the upload now');
  h.runMs(500);
  h.send('\x18\x18');
  assert.match(h.waitFor(PROMPT, { timeoutCycles: 10 * SEC }), /transfer failed, 0 bytes/);
  assert.ok(!cmd(h, 'ls').includes('gone.dat'));
  assert.equal(cmd(h, 'sx nothere'), 'no such file: nothere\n');
  // fill the disk, then try to upload more than is free
  const free = Number(/(\d+) free/.exec(cmd(h, 'ls -l'))[1]);
  const u = upload(h, 'huge.dat', bytes(free + 200, i => i));
  assert.ok(!u.ok);
  assert.match(u.tail, /disk full/);
  assert.ok(!cmd(h, 'ls').includes('huge.dat'));
});
