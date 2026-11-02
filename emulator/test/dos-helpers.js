// Shared helpers for the DOS/51 ROM end-to-end tests (test/dos-*.test.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../emu/harness.js';
import { MC_PER_SEC } from '../emu/board.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROM_PATH = path.join(root, 'firmware/build/dos51.ihx');
export const EXAMPLES = path.join(root, 'firmware/examples');
export const PROMPT = 'dos51$ ';
export const SEC = MC_PER_SEC;

// Boot a fresh board (power-on RAM contents) and wait for the first prompt.
export function boot({ seed = 1 } = {}) {
  const h = createHarness({ romPath: ROM_PATH, seed });
  const banner = h.waitFor(PROMPT, { timeoutCycles: 5 * SEC });
  return { h, banner };
}

// Type a command line, wait for the next prompt; returns the output between
// the echoed command and the prompt (CR LF normalised to LF).
export function cmd(h, line, { timeout = 30 } = {}) {
  h.send(line + '\r');
  const out = h.waitFor(PROMPT, { timeoutCycles: timeout * SEC });
  let text = out.slice(0, -PROMPT.length).replace(/\r\n/g, '\n');
  if (text.startsWith(line + '\n')) text = text.slice(line.length + 1);
  return text;
}

// Upload a file with XMODEM (rx NAME).
export function upload(h, name, data, opts = {}) {
  h.send(`rx ${name}\r`);
  h.waitFor('start the upload now', { timeoutCycles: 5 * SEC });
  const r = h.xmodemSend(data, opts);
  const tail = h.waitFor(PROMPT, { timeoutCycles: 10 * SEC });
  return { ...r, tail };
}

// Download a file with XMODEM (sx NAME).
export function download(h, name, opts = {}) {
  h.send(`sx ${name}\r`);
  h.waitFor('start the download now', { timeoutCycles: 5 * SEC });
  const r = h.xmodemReceive(opts);
  const tail = h.waitFor(PROMPT, { timeoutCycles: 10 * SEC });
  return { ...r, tail };
}

export function example(name) {
  return fs.readFileSync(path.join(EXAMPLES, name), 'latin1').replace(/\r\n/g, '\n');
}

// Bytes of upper RAM (TPA) as seen by the CPU.
export function tpa(h, addr, len) {
  return Array.from(h.board.ram1.subarray(addr - 0x8000, addr - 0x8000 + len));
}
