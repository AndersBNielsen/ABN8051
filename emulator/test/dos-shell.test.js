// DOS/51 ROM end to end: boot, shell commands, RAM disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, cmd, PROMPT, SEC, tpa } from './dos-helpers.js';

test('boot banner, RAM disk formatted with the examples, prompt', () => {
  const { h, banner } = boot();
  assert.match(banner, /DOS\/51 1\.0 {2}- {2}80C31 @ 11\.0592 MHz, 32K ROM, 64K RAM/);
  assert.match(banner, /Formatting RAM disk\.\.\. done/);
  assert.match(banner, /RAM disk: 8 files, \d+ bytes free\.  TPA 8000h-FFFFh\.  Type 'help'\./);
  assert.ok(banner.endsWith(PROMPT));
  // serial setup: mode 1, T1 auto-reload at 19200 baud
  assert.equal(h.board.baud, 19200);
  const ls = cmd(h, 'ls');
  for (const f of ['readme.txt', 'hello.asm', 'blink.asm', 'timer.asm', 'button.asm', 'upper.asm', 'primes.asm', 'files.asm']) {
    assert.ok(ls.includes(f), `${f} missing from ls`);
  }
});

test('help, ver, unknown command, empty line', () => {
  const { h } = boot();
  const help = cmd(h, 'help');
  for (const w of ['ls', 'cat', 'rm', 'mv', 'cp', 'nano', 'asm', 'run', 'rx', 'sx', 'mem', 'hexdump', 'grep']) {
    assert.ok(help.includes(w), `help lacks ${w}`);
  }
  assert.match(cmd(h, 'ver'), /DOS\/51 1\.0 for 80C31/);
  assert.equal(cmd(h, 'frobnicate'), 'frobnicate: command not found (try help)\n');
  assert.equal(cmd(h, ''), '\n'.slice(1));
});

test('file commands: echo >, cat, cp, mv, rm, touch, wc, grep, hexdump, ls -l, df', () => {
  const { h } = boot();
  assert.equal(cmd(h, 'echo hello world > t.txt'), '');
  assert.equal(cmd(h, 'cat t.txt'), 'hello world\n');
  assert.equal(cmd(h, 'wc t.txt'), '     1      2     12 t.txt\n');
  assert.equal(cmd(h, 'cp t.txt u.txt'), '');
  assert.equal(cmd(h, 'cat u.txt'), 'hello world\n');
  assert.equal(cmd(h, 'mv u.txt v.txt'), '');
  assert.equal(cmd(h, 'cat u.txt'), 'no such file: u.txt\n');
  assert.equal(cmd(h, 'cat t.txt v.txt'), 'hello world\nhello world\n');
  assert.equal(cmd(h, 'rm v.txt t.txt'), '');
  assert.equal(cmd(h, 'rm v.txt'), 'no such file: v.txt\n');
  assert.equal(cmd(h, 'touch empty'), '');
  assert.match(cmd(h, 'ls -l'), /-rw- {6}0 {2}[0-9A-F]{4} {2}empty\n9 files, \d+ bytes used, \d+ free\n$/);
  assert.equal(cmd(h, 'grep LCALL hello.asm').split('\n').filter(Boolean).length, 5);
  assert.match(cmd(h, 'grep "the 80C31" hello.asm'), /^ {3}6: +DB +"Hello from the 80C31!"/);
  assert.equal(cmd(h, 'echo AB > ab'), '');
  assert.match(cmd(h, 'hexdump ab'), /^[0-9A-F]{4}: 41 42 0A {41}AB\.\n$/);
  const df = cmd(h, 'df');
  assert.match(df, /ramdisk +24576 +\d+ +\d+ +10\/32/);
  // a bad name and a missing source are refused
  assert.equal(cmd(h, 'mv ab bad/name'), 'bad name: bad/name\n');
  assert.equal(cmd(h, 'cp nothing x'), 'no such file: nothing\n');
});

test('mv over an existing file replaces it; files compact after rm', () => {
  const { h } = boot();
  cmd(h, 'echo one > a');
  cmd(h, 'echo two > b');
  cmd(h, 'echo three > c');
  cmd(h, 'mv c a');
  assert.equal(cmd(h, 'cat a'), 'three\n');
  cmd(h, 'rm b');
  assert.equal(cmd(h, 'cat a'), 'three\n');
  assert.equal(cmd(h, 'cat hello.asm').split('\n')[0], '; hello.asm - the first DOS/51 program');
});

test('mem, poke, mem -c (ROM jump table), free', () => {
  const { h } = boot();
  assert.equal(cmd(h, 'poke 9000h 1 2 0x33 $44'), '');
  assert.deepEqual(tpa(h, 0x9000, 4), [1, 2, 0x33, 0x44]);
  assert.match(cmd(h, 'mem 0x9000 4'), /^9000: 01 02 33 44 {38}\.\.3D\n$/);
  // the system call table starts with LJMPs
  const m = cmd(h, 'mem -c 7F00h 6');
  assert.match(m, /^7F00: 02 [0-9A-F]{2} [0-9A-F]{2} 02 [0-9A-F]{2} [0-9A-F]{2} /);
  assert.match(cmd(h, 'free'), /8000-FFFF RAM1 +TPA/);
  assert.equal(cmd(h, 'poke'), 'usage: poke ADDR BYTE..\n');
});

test('line editing: backspace, history (Up), tab completion', () => {
  const { h } = boot();
  const done = /\r\n(dos51\$ )$/;
  h.send('verx\x08\r');
  assert.match(h.waitFor(done), /DOS\/51 1\.0 for/);
  h.send('\x1b[A');               // recall "ver"
  h.runMs(100);
  h.send('\r');
  assert.match(h.waitFor(done), /dos51\$ ver\r\nDOS\/51 1\.0 for/);
  h.send('cat hel\t');            // completes to "hello.asm "
  h.runMs(100);
  h.send('\r');
  assert.match(h.waitFor(done), /cat hello\.asm \r\n; hello\.asm - the first DOS\/51 program/);
});

test('RAM disk survives a reset; format and examples -f', () => {
  const { h } = boot();
  cmd(h, 'echo keep me > keep.txt');
  h.board.reset();                // SRAM keeps its contents
  const banner = h.waitFor(PROMPT, { timeoutCycles: 5 * SEC });
  assert.ok(!banner.includes('Formatting'));
  assert.match(banner, /RAM disk: 9 files/);
  assert.equal(cmd(h, 'cat keep.txt'), 'keep me\n');
  h.send('format\r');
  h.waitFor('[y/N] ');
  h.send('y');
  assert.match(h.waitFor(PROMPT), /formatted/);
  assert.equal(cmd(h, 'ls'), '');
  cmd(h, 'examples');
  assert.equal(cmd(h, 'ls').split(/\s+/).filter(Boolean).length, 8);
  // reboot command restarts from the ROM and keeps the disk
  h.send('reboot\r');
  assert.match(h.waitFor(PROMPT, { timeoutCycles: 5 * SEC }), /RAM disk: 8 files/);
});

test('a corrupted RAM disk is detected and reformatted at boot', () => {
  const { h } = boot();
  h.board.ram0[0x2008] ^= 0xFF;   // used_end no longer matches its check word
  h.board.reset();
  assert.match(h.waitFor(PROMPT, { timeoutCycles: 5 * SEC }), /Formatting RAM disk\.\.\. done/);
});

test('paste a text file, ^D ends', () => {
  const { h } = boot();
  h.send('paste p.txt\r');
  h.waitFor('^D on an empty line');
  h.send('line one\r\nline two\r\x04');
  assert.match(h.waitFor(PROMPT), /18 bytes saved/);
  assert.equal(cmd(h, 'cat p.txt'), 'line one\nline two\n');
});
