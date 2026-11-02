// DOS/51 ROM end to end: the nano-like editor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, cmd, PROMPT, SEC } from './dos-helpers.js';

// type like a person (the editor redraws between keys)
function type(h, s, ms = 3) {
  for (const ch of s) { h.send(ch); h.runMs(ms); }
}
function key(h, k, ms = 60) { h.send(k); h.runMs(ms); }

const UP = '\x1b[A', DOWN = '\x1b[B', RIGHT = '\x1b[C', LEFT = '\x1b[D', END = '\x1b[F';

test('create a new file, type, ^O write out, ^X exit, assemble and run it', () => {
  const { h } = boot();
  h.send('nano new.asm\r');
  const screen = h.waitFor('New File', { timeoutCycles: 3 * SEC });
  assert.match(screen, /DOS\/51 nano {2}File: new\.asm/);
  assert.match(screen, /\^G.*Help.*\^O.*Write.*\^X.*Exit/);
  type(h, '        ORG 8000h\r');
  type(h, '        LCALL PUTSI\r');
  type(h, '        DB "Edited!", 10, 0\r');
  type(h, '        RET\r');
  key(h, '\x0f');                                // ^O
  h.waitFor('File Name to Write: new.asm');
  h.send('\r');
  assert.match(h.waitFor(/Wrote \d+ bytes/), /Wrote 78 bytes/);
  key(h, '\x18');                                // ^X: not modified any more
  h.waitFor(PROMPT, { timeoutCycles: 2 * SEC });
  assert.equal(cmd(h, 'cat new.asm'),
    '        ORG 8000h\n        LCALL PUTSI\n        DB "Edited!", 10, 0\n        RET\n');
  const out = cmd(h, 'asm -r new.asm');
  assert.match(out, /0 error\(s\)/);
  assert.ok(out.endsWith('Edited!\n'));
});

test('edit an existing file: cursor keys, cut/paste, search, delete, save on exit', () => {
  const { h } = boot();
  cmd(h, 'echo first > e.txt');
  h.send('paste e.txt\r');
  h.waitFor('^D');
  h.send('alpha\rbeta\rgamma\r\x04');
  h.waitFor(PROMPT);
  h.send('nano e.txt\r');
  h.waitFor('Paste', { timeoutCycles: 3 * SEC });
  h.runMs(100);
  key(h, DOWN);
  key(h, '\x0b');                                // ^K cuts "beta"
  key(h, UP);
  key(h, '\x15');                                // ^U pastes it above "alpha"
  key(h, '\x17');                                // ^W search
  h.waitFor('Search: ');
  type(h, 'mm\r');                               // cursor to "gamma" at "mm"
  key(h, RIGHT);
  key(h, LEFT);
  key(h, '\x04');                                // ^D deletes the first 'm'
  key(h, END);
  type(h, '!');
  key(h, '\x18');                                // ^X asks to save
  h.waitFor('Save modified buffer?');
  h.send('y');
  h.waitFor(PROMPT, { timeoutCycles: 2 * SEC });
  assert.equal(cmd(h, 'cat e.txt'), 'beta\nalpha\ngama!\n');
});

test('exit without saving, help screen, go to line, cursor position', () => {
  const { h } = boot();
  h.send('nano hello.asm\r');
  h.waitFor('Paste', { timeoutCycles: 3 * SEC });
  key(h, '\x07');                                // ^G help
  h.waitFor('Press any key...');
  key(h, ' ', 200);
  key(h, '\x14');                                // ^T go to line
  h.waitFor('Enter line number: ');
  type(h, '5\r');
  key(h, '\x03');                                // ^C position
  assert.match(h.waitFor(/line 5\/15, col 1/), /line 5\/15/);
  type(h, 'junk');
  key(h, '\x18');
  h.waitFor('Save modified buffer?');
  h.send('n');
  h.waitFor(PROMPT, { timeoutCycles: 2 * SEC });
  assert.equal(cmd(h, 'cat hello.asm').split('\n')[4], 'start:  LCALL   PUTSI           ; print the string that follows');
});
