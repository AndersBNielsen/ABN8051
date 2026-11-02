// DOS/51 ROM end to end: every bundled example assembles on the target and
// behaves as described in its header.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, cmd, PROMPT, SEC, EXAMPLES, example } from './dos-helpers.js';

function primesBelow(n) {
  const s = new Uint8Array(n).fill(1), p = [];
  for (let i = 2; i < n; i++) if (s[i]) { p.push(i); for (let j = 2 * i; j < n; j += i) s[j] = 0; }
  return p;
}

// name -> (h) => void : runs the assembled program and checks its behaviour
const checks = {
  'hello.asm'(h) {
    assert.equal(cmd(h, 'hello'), 'Hello from the 80C31!\n');
    assert.equal(cmd(h, 'hello Anders and friends'), 'Hello from the 80C31!\nYou said: Anders and friends\n');
    assert.equal(cmd(h, 'run hello.bin x'), 'Hello from the 80C31!\nYou said: x\n');
  },
  'blink.asm'(h) {
    const seen = [];
    h.board.onPortWrite = (port, v) => { if (port === 1) seen.push(v); };
    h.send('blink\r');
    h.waitFor('press any key to stop\r\n');
    h.runMs(120 * 9);
    h.send(' ');
    h.waitFor(PROMPT, { timeoutCycles: 2 * SEC });
    h.board.onPortWrite = () => {};
    // one LED (active low) walks around P1.0-P1.3 every 120 ms, all off at
    // the end; the SD card lines P1.4-P1.7 keep their idle levels (DFh)
    const lit = seen.filter((v) => (v & 15) !== 15);
    assert.deepEqual(lit.slice(0, 8), [0xDE, 0xDD, 0xDB, 0xD7, 0xDE, 0xDD, 0xDB, 0xD7]);
    assert.ok(seen.every((v) => (v & 0xF0) === 0xD0), 'P1.4-P1.7 changed');
    assert.equal(h.board.portLatch(1), 0xDF);
  },
  'timer.asm'(h) {
    h.send('timer\r');
    h.waitFor('Any key stops.\r\n');
    const toggles = [];
    h.board.onPortWrite = (port, v) => { if (port === 1) toggles.push(h.board.cycles); };
    h.runMs(3500);
    h.board.onPortWrite = () => {};
    h.send('q');
    const out = h.waitFor(PROMPT, { timeoutCycles: 2 * SEC });
    assert.match(out, /\rSeconds: 1\rSeconds: 2\rSeconds: 3/);
    // P1.0 toggles once per second: 20 Timer 0 interrupts of 50 ms
    assert.ok(toggles.length >= 3);
    const period = (toggles[2] - toggles[1]) / SEC;
    assert.ok(Math.abs(period - 1) < 0.002, `period ${period}`);
    // the program stopped Timer 0 and the shell still works (Timer 1 untouched)
    assert.equal(h.board.cpu.readSfr(0x88) & 0x10, 0);
    assert.match(cmd(h, 'ver'), /DOS\/51/);
  },
  'button.asm'(h) {
    h.send('button\r');
    h.waitFor('Any key quits.\r\n');
    h.runMs(30);
    for (let i = 0; i < 5; i++) {
      h.board.setPin('P3.2', 0); h.runMs(15);
      h.board.setPin('P3.2', 1); h.runMs(15);
    }
    h.runMs(30);
    h.send('q');
    const out = h.waitFor(PROMPT, { timeoutCycles: 2 * SEC });
    assert.match(out, /Presses: 0\rPresses: 1\rPresses: 2\rPresses: 3\rPresses: 4\rPresses: 5\r\n/);
    assert.equal(h.board.portLatch(1), 0xDF ^ 5);  // binary count on the LEDs
  },
  'upper.asm'(h) {
    h.send('upper\r');
    h.waitFor('Empty line quits.\r\n> ');
    h.send('Hello, World 123 xyz\r');
    assert.equal(h.waitFor('> '), 'Hello, World 123 xyz\r\nHELLO, WORLD 123 XYZ\r\n> ');
    h.send('ab\x08c\r');            // GETLINE edits with backspace
    assert.equal(h.waitFor('> '), 'ab\b \bc\r\nAC\r\n> ');
    h.send('\r');
    assert.equal(h.waitFor(PROMPT), '\r\n' + PROMPT);
  },
  'primes.asm'(h) {
    const out = cmd(h, 'primes', { timeout: 60 });
    const p = primesBelow(2000);
    assert.equal(out, `Primes below 2000:\n${p.join(' ')} \n${p.length} primes found\n`);
  },
  'files.asm'(h) {
    assert.equal(cmd(h, 'files'), 'Wrote hello.txt, reading it back:\nThis file was written by an 8051 program.\n');
    assert.equal(cmd(h, 'cat hello.txt'), 'This file was written by an 8051 program.\n');
    assert.match(cmd(h, 'ls -l'), / 42 {2}[0-9A-F]{4} {2}hello\.txt/);
  },
};

test('every example has a behaviour check', () => {
  const asm = fs.readdirSync(EXAMPLES).filter(f => f.endsWith('.asm')).sort();
  assert.deepEqual(asm, Object.keys(checks).sort());
});

for (const [name, check] of Object.entries(checks)) {
  test(`example ${name}: assembles on the target and runs`, () => {
    const { h } = boot();
    // the ROM installs the same text as firmware/examples
    assert.equal(cmd(h, `cat ${name}`), example(name));
    const out = cmd(h, `asm ${name}`, { timeout: 60 });
    assert.match(out, /, 0 error\(s\)\n/);
    const bin = name.replace('.asm', '.bin');
    assert.match(out, new RegExp(`wrote ${bin.replace('.', '\\.')} \\(\\d+ bytes, load at 8000h\\)`));
    check(h);
  });
}

test('the readme lists every example', () => {
  const readme = example('readme.txt');
  for (const f of fs.readdirSync(EXAMPLES).filter(f => f.endsWith('.asm'))) {
    assert.ok(readme.includes(f.replace('.asm', '')), f);
  }
});
