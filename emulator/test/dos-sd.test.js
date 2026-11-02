// DOS/51 ROM with an SD card on P1.4-P1.7: driver, FAT16/FAT32 file tool,
// system calls. Card images are formatted on the host (emu/fatfmt.js) and
// cross-checked with an independent host FAT reader (scripts/fatimg.py) and,
// when available, the system's fsck_msdos / fsck.vfat.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../emu/harness.js';
import { SDCard } from '../emu/sdcard.js';
import { formatCard } from '../emu/fatfmt.js';
import { ROM_PATH, PROMPT, SEC, cmd, upload, download, tpa } from './dos-helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FATIMG = path.join(root, 'scripts/fatimg.py');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dos51-sd-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let nimg = 0;

function bootCard(image, { sdhc = true, seed = 1 } = {}) {
  const h = createHarness({ romPath: ROM_PATH, seed });
  const card = image ? new SDCard({ image, sdhc }).attach(h.board) : null;
  h.waitFor(PROMPT, { timeoutCycles: 5 * SEC });
  return { h, card };
}

// Run scripts/fatimg.py on a copy of `image` (or in place with `update`).
function fatimg(image, args, { update = false, input } = {}) {
  const f = path.join(tmp, `card${nimg++}.img`);
  fs.writeFileSync(f, image);
  const r = spawnSync('python3', [FATIMG, f, ...args], { input, encoding: 'latin1' });
  if (update) image.set(new Uint8Array(fs.readFileSync(f)));
  fs.rmSync(f);
  return r;
}
function hostGet(image, name) {
  const r = fatimg(image, ['get', name]);
  assert.equal(r.status, 0, r.stderr);
  return Buffer.from(r.stdout, 'latin1');
}
function hostPut(image, name, data) {
  const f = path.join(tmp, `put${nimg++}`);
  fs.writeFileSync(f, data);
  const r = fatimg(image, ['put', f, name], { update: true });
  fs.rmSync(f);
  assert.equal(r.status, 0, r.stderr);
}
function assertValidFat(image) {
  const r = fatimg(image, ['check']);
  assert.equal(r.status, 0, `fatimg check: ${r.stdout}${r.stderr}`);
  // the system's checker, on the volume itself (it does not parse an MBR)
  const fsck = ['/sbin/fsck_msdos', '/usr/sbin/fsck.vfat', '/sbin/fsck.vfat'].find((p) => fs.existsSync(p));
  if (!fsck) return r.stdout;
  const part = image[0] === 0xEB ? 0 : image[454] | image[455] << 8 | image[456] << 16;
  const f = path.join(tmp, `vol${nimg++}.img`);
  fs.writeFileSync(f, image.subarray(part * 512));
  const c = spawnSync(fsck, ['-n', f], { encoding: 'utf8' });
  fs.rmSync(f);
  assert.equal(c.status, 0, `${fsck}: ${c.stdout}${c.stderr}`);
  assert.doesNotMatch(c.stdout, /(lost|cross-linked|differ|corrupt|invalid)/i, c.stdout);
  return r.stdout + c.stdout;
}

const same = (a, b, msg) => assert.ok(Buffer.from(a).equals(Buffer.from(b)), msg || `contents differ (${a.length} vs ${b.length} bytes)`);
const pattern = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 17 + (i >> 8)) & 0xFF);

test('FAT16 card: sdput, sdls, sdget round trip byte-identical; image valid on the host', () => {
  const image = formatCard(32 << 20);
  const { h } = bootCard(image);
  const data = pattern(5000);                       // all byte values, 3 clusters
  assert.equal(upload(h, 'data.bin', data).ok, true);
  assert.equal(cmd(h, 'sdls'), '');
  assert.equal(cmd(h, 'sdput data.bin'), '');
  assert.equal(cmd(h, 'echo hello card > hello.txt'), '');
  assert.equal(cmd(h, 'sdput hello.txt Greet.TXT'), '');
  assert.equal(cmd(h, 'sdls'), 'data.bin      5000\ngreet.txt     11\n');
  // the host sees DOS 8.3 names, contents and a consistent FAT
  same(hostGet(image, 'DATA.BIN'), data);
  assert.equal(hostGet(image, 'greet.txt').toString(), 'hello card\n');
  assert.match(fatimg(image, ['ls']).stdout, /DATA\.BIN +5000\nGREET\.TXT +11\n/);
  assertValidFat(image);
  // back from the card into the RAM disk under the same and another name
  assert.equal(cmd(h, 'rm data.bin'), '');
  assert.equal(cmd(h, 'sdget data.bin'), '');
  assert.equal(cmd(h, 'sdget DATA.BIN copy.bin'), '');
  for (const n of ['data.bin', 'copy.bin']) {
    const r = download(h, n);
    assert.equal(r.ok, true);
    same(r.data, data);
  }
  assert.equal(cmd(h, 'sdget greet.txt'), '');
  assert.equal(cmd(h, 'cat greet.txt'), 'hello card\n');
});

test('a file written on the host is read by DOS/51; replace and sdrm keep the FAT consistent', () => {
  const image = formatCard(16 << 20);
  const text = 'Written on the PC.\n'.repeat(150);       // 2850 bytes
  hostPut(image, 'PCFILE.TXT', text);
  const { h } = bootCard(image);
  assert.equal(cmd(h, 'sdls'), 'pcfile.txt    2850\n');
  assert.equal(cmd(h, 'sdget pcfile.txt'), '');
  assert.equal(cmd(h, 'cat pcfile.txt'), text);
  assert.match(cmd(h, 'wc pcfile.txt'), /^ +150 +600 +2850 pcfile\.txt\n$/);
  // replace it with a shorter file, then delete another one
  cmd(h, 'echo short > s.txt');
  assert.equal(cmd(h, 'sdput s.txt pcfile.txt'), '');
  assert.equal(cmd(h, 'sdput s.txt'), '');
  assert.equal(cmd(h, 'sdls'), 'pcfile.txt    6\ns.txt         6\n');
  assert.equal(cmd(h, 'sdrm s.txt'), '');
  assert.equal(cmd(h, 'sdls'), 'pcfile.txt    6\n');
  assert.equal(hostGet(image, 'PCFILE.TXT').toString(), 'short\n');
  assertValidFat(image);
  // the last partial sector is zero padded
  const r = fatimg(image, ['ls']);
  assert.equal(r.status, 0);
});

test('FAT32 card in an SDSC (byte addressed) card, and a superfloppy FAT16 volume', () => {
  for (const [image, sdhc] of [[formatCard(40 << 20, { fat: 32 }), false], [formatCard(8 << 20, { mbr: false }), true]]) {
    const { h } = bootCard(image, { sdhc });
    const data = pattern(7000, 3);
    assert.equal(upload(h, 'big.bin', data).ok, true);
    assert.equal(cmd(h, 'sdput big.bin'), '');
    assert.equal(cmd(h, 'sdput big.bin big2.bin'), '');
    assert.equal(cmd(h, 'sdrm big.bin'), '');
    assert.equal(cmd(h, 'sdls'), 'big2.bin      7000\n');
    same(hostGet(image, 'BIG2.BIN'), data);
    const out = assertValidFat(image);
    assert.match(out, sdhc ? /FAT16/ : /FAT32/);
    cmd(h, 'rm big.bin');
    assert.equal(cmd(h, 'sdget big2.bin'), '');
    same(download(h, 'big2.bin').data, data);
  }
});

test('cluster allocation crosses a FAT sector boundary', () => {
  const image = formatCard(32 << 20);              // FAT16, 2 KiB clusters
  hostPut(image, 'FILLER.BIN', new Uint8Array(252 * 2048)); // clusters 2..253
  const { h } = bootCard(image);
  const data = pattern(14000, 5);                   // 7 clusters: 254..260
  assert.equal(upload(h, 'x.bin', data).ok, true);
  assert.equal(cmd(h, 'sdput x.bin', { timeout: 60 }), '');
  same(hostGet(image, 'X.BIN'), data);
  assertValidFat(image);
  cmd(h, 'rm x.bin');
  assert.equal(cmd(h, 'sdget x.bin', { timeout: 60 }), '');
  same(download(h, 'x.bin').data, data);
});

test('errors: no card, no FAT volume, missing file, bad names, directories, full card, RAM disk full', () => {
  let { h } = bootCard(null);
  assert.equal(cmd(h, 'sdls'), 'no SD card\n');
  ({ h } = bootCard(new Uint8Array(4 << 20)));      // blank, unformatted
  assert.equal(cmd(h, 'sdls'), 'no FAT16/32 volume\n');

  const image = formatCard(8 << 20, { mbr: false });
  // a subdirectory entry (made by hand) is listed but not touched
  const v = fatimg(image, ['ls']);
  assert.equal(v.status, 0);
  const rootOff = (1 + 2 * image[22]) * 512 + 32; // second root entry
  image.set(Buffer.from('SUBDIR     '), rootOff);
  image[rootOff + 11] = 0x10;
  ({ h } = bootCard(image));
  assert.equal(cmd(h, 'sdls'), 'subdir        <DIR>\n');
  assert.equal(cmd(h, 'sdget subdir'), 'is a directory\n');
  assert.equal(cmd(h, 'sdrm subdir'), 'is a directory\n');
  assert.equal(cmd(h, 'sdget nothere.txt'), 'not found\n');
  assert.equal(cmd(h, 'sdrm nothere.txt'), 'not found\n');
  assert.equal(cmd(h, 'sdput nothere.txt'), 'not found\n');
  assert.equal(cmd(h, 'sdget toolongname.txt'), 'bad 8.3 name\n');
  assert.equal(cmd(h, 'sdput hello.asm a.b.c'), 'bad 8.3 name\n');
  assert.equal(cmd(h, 'sdput hello.asm .asm'), 'bad 8.3 name\n');
  assert.match(cmd(h, 'sdget'), /^usage: sdget NAME \[LOCAL\]/);
  // DOS/51 names without an 8.3 equivalent need an explicit name
  cmd(h, 'echo x > longnamex.s');
  assert.equal(cmd(h, 'sdput longnamex.s'), 'bad 8.3 name\n');
  assert.equal(cmd(h, 'sdput longnamex.s long.s'), '');
  // a card file that cannot be a DOS/51 name needs LOCAL
  hostPut(image, 'A~1.TXT', 'tilde\n');
  assert.equal(cmd(h, 'sdget a~1.txt'), 'cannot create\n');
  assert.equal(cmd(h, 'sdget a~1.txt tilde.txt'), '');
  assert.equal(cmd(h, 'cat tilde.txt'), 'tilde\n');
  image[rootOff] = 0xE5;                            // drop the hand-made, cluster-less directory
  assertValidFat(image);

  // full card: nothing changes
  const small = formatCard(8 << 20, { mbr: false });
  const clusters = (small.length / 512 - 1 - 2 * small[22] - 32) >> 1;
  hostPut(small, 'FILL.BIN', new Uint8Array((clusters - 2) * 1024));
  ({ h } = bootCard(small));
  const before = Buffer.from(small);
  cmd(h, 'echo 1 > one.txt');
  assert.equal(cmd(h, 'sdput one.txt'), '');        // fits the last clusters
  assert.equal(cmd(h, 'sdput hello.asm h2.asm'), ''); // 626 bytes: one cluster
  assert.equal(cmd(h, 'sdput primes.asm'), 'card full\n');
  assert.match(fatimg(small, ['ls']).stdout, /FILL\.BIN.*\nONE\.TXT +2\nH2\.ASM +\d+\n$/);
  assertValidFat(small);
  assert.notDeepEqual(Buffer.from(small), before);

  // RAM disk full: the card file is not copied
  hostPut(small, 'FILL.BIN', new Uint8Array(30000));
  assert.equal(cmd(h, 'sdget fill.bin'), 'disk full\n');
  assert.equal(cmd(h, 'cat fill.bin'), 'no such file: fill.bin\n');
});

test('SDINIT, SDREAD and SDWRITE system calls from an assembled program', () => {
  const image = formatCard(16 << 20);
  const { h, card } = bootCard(image);
  const src = [
    '        ORG     8000h',
    '        LCALL   SDINIT          ; A = 2 for SDHC, C = no card',
    '        JC      fail',
    '        LCALL   PUTHEX',
    '        MOV     R7, #0          ; sector 0 (MBR)',
    '        MOV     R6, #0',
    '        MOV     R5, #0',
    '        MOV     R4, #0',
    '        MOV     DPTR, #9000h',
    '        LCALL   SDREAD',
    '        JC      fail',
    '        MOV     DPTR, #91FEh    ; 55 AA',
    '        MOVX    A, @DPTR',
    '        LCALL   PUTHEX',
    '        INC     DPTR',
    '        MOVX    A, @DPTR',
    '        LCALL   PUTHEX',
    '        MOV     DPTR, #9000h    ; write it back to sector 4003h',
    '        MOV     A, #42h',
    '        MOVX    @DPTR, A',
    '        MOV     R5, #40h        ; sector 4003h: R7:R6:R5:R4',
    '        MOV     R4, #3',
    '        LCALL   SDWRITE',
    '        JC      fail',
    '        LCALL   PUTSI',
    '        DB      " ok", 10, 0',
    '        RET',
    'fail:   LCALL   PUTSI',
    '        DB      "SD error", 10, 0',
    '        RET',
  ].join('\n');
  h.send('paste sd.asm\r');
  h.waitFor('^D on an empty line');
  h.send(src.replace(/\n/g, '\r') + '\r\x04');
  h.waitFor(PROMPT);
  assert.match(cmd(h, 'asm -r sd.asm'), /0 error\(s\)[\s\S]*\n0255AA ok\n$/);
  const s = 0x4003 * 512;
  assert.equal(image[s], 0x42);
  assert.deepEqual(Array.from(image.subarray(s + 1, s + 512)), tpa(h, 0x9001, 511));
  assert.equal(card.stats.writes, 1);
  // the calls are appended to the jump table after PUTB (7F36h)
  assert.match(cmd(h, 'mem -c 7F36h 12'), /^7F36: 02 .. .. 02 .. .. 02 .. .. 02 .. .. /);
  assert.match(cmd(h, 'ver'), /DOS\/51/);
});

test('transfer speed at 11.0592 MHz (reported)', () => {
  const image = formatCard(32 << 20);
  const { h } = bootCard(image);
  const data = pattern(12288, 9);
  assert.equal(upload(h, 's.bin', data).ok, true);
  let c0 = h.cycles;
  assert.equal(cmd(h, 'sdput s.bin', { timeout: 60 }), '');
  const put = (h.cycles - c0) / SEC;
  cmd(h, 'rm s.bin');
  c0 = h.cycles;
  assert.equal(cmd(h, 'sdget s.bin', { timeout: 60 }), '');
  const get = (h.cycles - c0) / SEC;
  c0 = h.cycles;
  cmd(h, 'sdls');
  const ls = (h.cycles - c0) / SEC;
  test.diagnostic?.(`12 KiB: sdput ${put.toFixed(2)} s (${(12 / put).toFixed(1)} KB/s), sdget ${get.toFixed(2)} s (${(12 / get).toFixed(1)} KB/s), sdls ${ls.toFixed(2)} s`);
  console.log(`# SD speed, 12 KiB file: sdput ${put.toFixed(2)} s = ${(12 / put).toFixed(1)} KiB/s, sdget ${get.toFixed(2)} s = ${(12 / get).toFixed(1)} KiB/s; sdls ${ls.toFixed(2)} s`);
  assert.ok(put < 10 && get < 10);
});
