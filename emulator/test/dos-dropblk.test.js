// DropBlocks lives on the SD card, not in the space-constrained 32 KiB ROM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHarness } from '../emu/harness.js';
import { formatCard } from '../emu/fatfmt.js';
import { putFat16File } from '../emu/fatfile.js';
import { SDCard } from '../emu/sdcard.js';
import { ROM_PATH, PROMPT, SEC, cmd } from './dos-helpers.js';
import { Screen } from './vt-screen.js';

const source = new Uint8Array(fs.readFileSync(new URL('../games/dropblk.asm', import.meta.url)));
function game() {
  const image = formatCard(16 << 20);
  assert.equal(putFat16File(image, 'DROPBLK.ASM', source), true);
  assert.equal(putFat16File(image, 'DROPBLK.ASM', source), false);
  const h = createHarness({ romPath: ROM_PATH, seed: 1 });
  new SDCard({ image }).attach(h.board);
  h.waitFor(PROMPT, { timeoutCycles: 5 * SEC });
  assert.match(cmd(h, 'sdls'), /dropblk\.asm +9302/);
  assert.equal(cmd(h, 'sdget dropblk.asm', { timeout: 60 }), '');
  assert.equal(cmd(h, 'cat dropblk.asm'), Buffer.from(source).toString('latin1'));
  const compiled = cmd(h, 'asm dropblk.asm', { timeout: 90 });
  assert.match(compiled, /545 lines, 108 symbols, 0 error\(s\)/);
  assert.match(compiled, /wrote dropblk\.bin \(1373 bytes, load at 8000h\)/);
  h.clearOutput();
  h.send('run dropblk.bin\r');
  h.waitFor('Press a key', { timeoutCycles: 12 * SEC });
  const screen = new Screen();
  screen.write(h.output);
  assert.match(screen.dump(), /DOS\/51 DROPBLOCKS/);
  assert.match(screen.dump(), /Next/);
  assert.equal(screen.cursor, false);
  h.send('g');
  h.runMs(300);
  return { h, screen };
}

test('DropBlocks on SD card: assemble, move, rotate, drop, pause and quit', () => {
  const { h, screen } = game();
  const ram = h.board.cpu.iram;
  const x = ram[0x18], y = ram[0x19], rot = ram[0x1a];
  h.send('\x1b[D'); h.runMs(80);
  assert.equal(ram[0x18], x - 1, 'left arrow');
  h.send('d'); h.runMs(80);
  assert.equal(ram[0x18], x, 'D moves right');
  h.send('\x1b[A'); h.runMs(80);
  assert.equal(ram[0x1a], (rot + 1) & 3, 'up arrow rotates');
  h.send('s'); h.runMs(80);
  assert.equal(ram[0x19], y + 1, 'soft drop');
  h.send('p'); h.waitFor('Paused');
  const paused = ram[0x19]; h.runMs(1200);
  assert.equal(ram[0x19], paused, 'gravity waits while paused');
  h.send('p'); h.runMs(80);
  h.send(' '); h.runMs(400);
  assert.ok(h.board.ram1.subarray(0x6000, 0x6140).some(v => v > 0 && v < 8), 'hard drop locks blocks');
  const playing = new Screen(); playing.write(h.output);
  assert.match(playing.dump(), /Score +0/);
  h.send('q'); h.waitFor(PROMPT, { timeoutCycles: 5 * SEC });
  const exited = new Screen(); exited.write(h.output);
  assert.equal(exited.cursor, true, 'cursor shown again');
  assert.equal(exited.fg, 0, 'terminal colour reset');
  assert.match(exited.dump(), /dos51\$/);
  assert.equal(h.board.cpu.readSfr(0x88) & 0x10, 0, 'Timer 0 stopped');
  assert.match(cmd(h, 'ver'), /DOS\/51/);
});

test('DropBlocks clears a completed row and scores it', () => {
  const { h } = game();
  const ram = h.board.cpu.iram, board = h.board.ram1;
  const ys = Array.from(ram.subarray(0x08, 0x0c));
  const xs = Array.from(ram.subarray(0x0c, 0x10));
  const maxy = Math.max(...ys);
  const holes = new Set(xs.filter((_, i) => ys[i] === maxy));
  for (let c = 1; c <= 10; c++) board[0x6000 + 19 * 16 + c] = holes.has(c) ? 0 : 1;
  h.send(' '); h.runMs(600);
  assert.equal(ram[0x28] * 256 + ram[0x29], 1, 'one row cleared');
  assert.ok(ram[0x2a] * 256 + ram[0x2b] > 0, 'score increased');
  assert.ok(Array.from(board.subarray(0x6000 + 19 * 16 + 1, 0x6000 + 19 * 16 + 11)).some(v => v === 0), 'cleared row compacted');
  h.send('q'); h.waitFor(PROMPT, { timeoutCycles: 5 * SEC });
});

test('DropBlocks game over waits for a key, then returns to DOS', () => {
  const { h } = game();
  // Occupy only spawn columns, not a complete row. The current piece can
  // still hard-drop; the next one must collide at the top.
  const board = h.board.ram1;
  for (let y = 0; y < 4; y++) for (let x = 4; x <= 7; x++) board[0x6000 + y * 16 + x] = 1;
  h.send(' '); h.waitFor('GAME OVER', { timeoutCycles: 6 * SEC });
  h.send('x'); h.waitFor(PROMPT, { timeoutCycles: 5 * SEC });
  assert.match(cmd(h, 'ver'), /DOS\/51/);
});
