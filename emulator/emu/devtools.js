// Node-only helpers for tests: build programs with SDCC/sdas8051 and drive
// ucsim (s51) for differential testing. Not used by the browser.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SEARCH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

export function findTool(name) {
  for (const dir of (process.env.PATH || '').split(':').concat(SEARCH)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

export function tmpDir(prefix = 'dos51-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Compile a C source with SDCC. Returns { ihx, symbols, dir }.
export function sdccBuild(source, { name = 'prog', flags = [], dir = tmpDir() } = {}) {
  const sdcc = findTool('sdcc');
  if (!sdcc) throw new Error('sdcc not found');
  const c = path.join(dir, name + '.c');
  fs.writeFileSync(c, source);
  const args = ['-mmcs51', '--model-large', ...flags, name + '.c', '-o', name + '.ihx'];
  const r = spawnSync(sdcc, args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sdcc failed:\n${r.stdout}\n${r.stderr}`);
  return { ihx: fs.readFileSync(path.join(dir, name + '.ihx'), 'utf8'), symbols: readMap(path.join(dir, name + '.map')), dir };
}

// Parse an SDCC linker .map for C:/X: symbols -> address.
export function readMap(file) {
  const syms = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*[CX]:\s+([0-9A-Fa-f]{8})\s+(\S+)/.exec(line);
    if (m) syms[m[2]] = parseInt(m[1], 16);
  }
  return syms;
}

// Run s51 with a command script (stdin). Returns stdout+stderr text.
export function runS51(commands, { args = [], cwd, timeout = 120000 } = {}) {
  const s51 = findTool('s51');
  if (!s51) throw new Error('s51 not found');
  // Commands go through `exec <file>`: stdin commands are echoed in chunks that
  // can interleave with output, a command file is executed sequentially.
  const dir = tmpDir('dos51-s51-');
  const cmdFile = path.join(dir, 'cmds.txt');
  fs.writeFileSync(cmdFile, ['set error non-classified off', 'set error stack off',
    'set error stack_overflow off', ...commands].join('\n') + '\n');
  const r = spawnSync(s51, ['-t', '8031', '-b', ...args], {
    cwd, input: `exec "${cmdFile}"\nquit\n`, encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  if (r.error) throw r.error;
  // Normalise line endings and strip interactive prompts ("0> ").
  return (r.stdout || '').replace(/\r/g, '')
    .split('\n').map(l => l.replace(/^(\d+> )+/, '')).join('\n');
}

// Run an IHX in s51 until PC reaches `stopAddr`; returns { serial, cycles }.
export function s51SerialRun(ihxPath, stopAddr) {
  const dir = path.dirname(ihxPath);
  const out = path.join(dir, 's51-serial.out');
  try { fs.unlinkSync(out); } catch { /* none */ }
  const text = runS51([`break 0x${stopAddr.toString(16)}`, "run"], { cwd: dir, timeout: 60000, args: ["-S", `out=${out}`, ihxPath] });
  const m = /Simulated (\d+) ticks/.exec(text);
  const serial = fs.existsSync(out) ? fs.readFileSync(out, 'latin1') : '';
  return { serial, cycles: m ? Number(m[1]) / 12 : NaN, log: text };
}
