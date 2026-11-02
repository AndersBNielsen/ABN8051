// Differential test: random MCS-51 instruction streams executed in ucsim (s51)
// and in our CPU; IRAM, SFRs, an XDATA window, PC and cycle count must match.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CPU8051, OPLEN, MNEMONIC } from '../emu/cpu8051.js';
import { emitIntelHex } from '../emu/ihex.js';
import { findTool, runS51, tmpDir } from '../emu/devtools.js';
import { mulberry32 } from '../emu/board.js';

const S51 = findTool('s51');
const CASES = Number(process.env.DIFF_CASES || 150);
const STEPS = 400;
const GROUPS = 260;

// Direct addresses safe to use as random operands (no timers running, no
// interrupt or UART side effects, no unimplemented SFRs).
const DIRS = [];
for (let a = 0; a < 0x80; a++) DIRS.push(a);
for (const a of [0xE0, 0xE0, 0xE0, 0xF0, 0xF0, 0xD0, 0xD0, 0x82, 0x83, 0x90, 0xA0, 0x89, 0x8A, 0x8B, 0x8C, 0x8D]) DIRS.push(a);
const BITS = [];
for (let b = 0; b < 0x80; b++) BITS.push(b);
for (const base of [0xE0, 0xF0, 0xD0, 0x90, 0xA0]) for (let i = 0; i < 8; i++) BITS.push(base + i, base + i);
// ucsim 0.8.2 quirks (silicon behaviour is modelled by us, so avoid them here):
//  - bit operations on PSW.3/PSW.4 (RS0/RS1) do not switch the register bank;
//  - PSW.P is stored, not live, so reading P or INC/DEC/DJNZ on PSW differs.
for (const q of [0xD0, 0xD3, 0xD4]) while (BITS.includes(q)) BITS.splice(BITS.indexOf(q), 1);
const DIRS_NO_PSW = DIRS.filter(a => a !== 0xD0);
const COMPARE_SFR = [0x81, 0x82, 0x83, 0x89, 0x8A, 0x8B, 0x8C, 0x8D, 0x90, 0xA0, 0xD0, 0xE0, 0xF0];
const XWIN = 0x7FF0, XLEN = 32;
const EXCLUDE = new Set([0x22, 0x32, 0x73, 0xA5]);

function genProgram(seed) {
  const rnd = mulberry32(seed);
  const r = (n) => rnd() % n;
  const pick = (arr) => arr[r(arr.length)];
  const init = [];
  for (let a = 0; a < 0x80; a++) init.push(0x75, a, r(256));
  for (let i = 0; i < XLEN; i++) {
    const x = XWIN + i;
    init.push(0x90, x >> 8, x & 0xFF, 0x74, r(256), 0xF0);
  }
  init.push(0x90, r(256), r(256), 0x75, 0xF0, r(256), 0x75, 0xD0, r(256) & 0xFB, 0x74, r(256));
  // Body: groups of [prefix..., instruction], jumps refer to group indices.
  const groups = [];
  for (let g = 0; g < GROUPS; g++) {
    let op;
    do op = r(256); while (EXCLUDE.has(op));
    const m = MNEMONIC[op];
    const pre = [];
    const isMovx = (op & 0xEE) === 0xE2;
    if ((op & 0x0F) === 6 || (op & 0x0F) === 7) {
      pre.push(0x78 | (op & 1), r(0x80));
    }
    if (isMovx) pre.push(0x75, 0xA0, XWIN >> 8, 0x78 | (op & 1), (XWIN & 0xFF) + r(16));
    if (op === 0xE0 || op === 0xF0) { const x = XWIN + r(XLEN); pre.push(0x90, x >> 8, x & 0xFF); }
    if (op === 0x93) { pre.push(0x90, r(0x20), r(256)); }
    if (op === 0xC0 || op === 0xD0) pre.push(0x75, 0x81, 0x30 + r(0x40));
    const ins = [op];
    const fix = [];
    if (op === 0x85) ins.push(pick(DIRS), pick(DIRS));
    else {
      const parts = m.split(/[ ,]/).slice(1).filter(Boolean);
      for (const p of parts) {
        if (p === 'dir') ins.push(pick(op === 0x05 || op === 0x15 || op === 0xD5 ? DIRS_NO_PSW : DIRS));
        else if (p === 'bit' || p === '/bit') ins.push(pick(BITS));
        else if (p === '#imm') ins.push(r(256));
        else if (p === '#imm16') ins.push(r(256), r(256));
        else if (p === 'rel') { fix.push({ kind: 'rel', at: ins.length }); ins.push(0); }
        else if (p === 'addr16') { fix.push({ kind: 'abs', at: ins.length }); ins.push(0, 0); }
        else if (p === 'addr11') { fix.push({ kind: 'a11', at: ins.length }); ins.push(0); }
      }
    }
    assert.equal(ins.length, OPLEN[op], `length mismatch generating ${m}`);
    groups.push({ pre, ins, fix, target: Math.max(0, Math.min(GROUPS, g - 6 + r(14))) });
  }
  // Layout
  let addr = init.length;
  for (const g of groups) { g.addr = addr; g.iaddr = addr + g.pre.length; addr += g.pre.length + g.ins.length; }
  const end = addr;
  const addrOf = (i) => (i >= GROUPS ? end : groups[i].addr);
  const code = [...init];
  for (let gi = 0; gi < GROUPS; gi++) {
    const g = groups[gi];
    const after = g.iaddr + g.ins.length;
    for (const f of g.fix) {
      let t = addrOf(g.target);
      if (f.kind === 'rel') {
        let disp = t - after;
        if (disp < -128 || disp > 127) disp = addrOf(gi + 1) - after;
        g.ins[f.at] = disp & 0xFF;
      } else if (f.kind === 'abs') { g.ins[f.at] = t >> 8; g.ins[f.at + 1] = t & 0xFF; }
      else { assert.ok((t & 0xF800) === (after & 0xF800)); g.ins[f.at] = t & 0xFF; g.ins[0] = (g.ins[0] & 0x1F) | ((t >> 3) & 0xE0); }
    }
    code.push(...g.pre, ...g.ins);
  }
  code.push(0x80, 0xFE);
  assert.ok(code.length < 0x800, 'program must fit in the first 2K page for AJMP/ACALL');
  const image = new Uint8Array(0x2000).fill(0xFF);
  image.set(code);
  return image;
}

function parseDump(lines, startIdx, count) {
  // Lines like "0x80 ff 07 00 ..." (8 bytes each)
  const out = new Map();
  let i = startIdx, got = 0;
  while (got < count && i < lines.length) {
    const m = /^0x([0-9a-f]+)((?:\s[0-9a-f]{2}){1,8})\s/.exec(lines[i]);
    if (m) {
      const base = parseInt(m[1], 16);
      m[2].trim().split(/\s+/).forEach((h, k) => out.set(base + k, parseInt(h, 16)));
      got++;
    }
    i++;
  }
  return { map: out, next: i };
}

test('random instruction streams match ucsim (s51)', { skip: !S51 && 's51 not installed' }, () => {
  const dir = tmpDir('dos51-diff-');
  const cmds = [];
  const images = [];
  for (let c = 0; c < CASES; c++) {
    const img = generate(c);
    images.push(img);
    const f = path.join(dir, `c${c}.ihx`);
    fs.writeFileSync(f, emitIntelHex(img));
    cmds.push(`file "${f}"`, 'reset', `step ${STEPS}`, 'ds 0x80 0xff', 'di 0x00 0x7f', `dx 0x${XWIN.toString(16)} 0x${(XWIN + XLEN - 1).toString(16)}`);
  }
  const text = runS51(cmds, { cwd: dir });
  if (process.env.DIFF_DEBUG) { fs.writeFileSync(path.join(dir, "s51.log"), text); console.log(dir); }
  const lines = text.split('\n');
  let idx = 0;
  let failures = 0;
  for (let c = 0; c < CASES; c++) {
    while (idx < lines.length && !/^Stop at 0x/.test(lines[idx])) idx++;
    const sm = /^Stop at 0x([0-9a-f]+).*stepped (\d+) ticks/.exec(lines[idx]);
    assert.ok(sm, `case ${c}: no stop line from s51`);
    const s51pc = parseInt(sm[1], 16), s51cyc = Number(sm[2]) / 12;
    idx++;
    const sfr = parseDump(lines, idx, 16); idx = sfr.next;
    const iram = parseDump(lines, idx, 16); idx = iram.next;
    const xr = parseDump(lines, idx, XLEN / 8); idx = xr.next;

    const code = new Uint8Array(65536).fill(0xFF);
    code.set(images[c]);
    const cpu = new CPU8051({ code });
    let cyc = 0;
    for (let s = 0; s < STEPS; s++) cyc += cpu.step();
    const diffs = [];
    if (cpu.pc !== s51pc) diffs.push(`PC ours=${cpu.pc.toString(16)} s51=${s51pc.toString(16)}`);
    if (cyc !== s51cyc) diffs.push(`cycles ours=${cyc} s51=${s51cyc}`);
    for (const a of COMPARE_SFR) {
      const ours = cpu.readSfr(a);
      let theirs = sfr.map.get(a);
      // ucsim keeps a software-written PSW.P until ACC changes; on silicon P is
      // always the live parity of ACC (our model), so normalise s51's value.
      if (a === 0xD0) theirs = (theirs & 0xFE) | parity(sfr.map.get(0xE0));
      if (ours !== theirs) diffs.push(`SFR ${a.toString(16)} ours=${ours.toString(16)} s51=${theirs?.toString(16)}`);
    }
    for (let a = 0; a < 0x80; a++) {
      if (cpu.data[a] !== iram.map.get(a)) diffs.push(`IRAM ${a.toString(16)} ours=${cpu.data[a].toString(16)} s51=${iram.map.get(a)?.toString(16)}`);
    }
    for (let i = 0; i < XLEN; i++) {
      const x = XWIN + i;
      const ours = x & 0x8000 ? cpu.xhi[x & 0x7FFF] : cpu.xlo[x];
      if (ours !== xr.map.get(x)) diffs.push(`XRAM ${x.toString(16)} ours=${ours.toString(16)} s51=${xr.map.get(x)?.toString(16)}`);
    }
    if (diffs.length) {
      failures++;
      if (failures <= 3) console.log(`case ${c} (seed ${c}) differs:\n  ` + diffs.slice(0, 12).join('\n  '));
    }
  }
  assert.equal(failures, 0, `${failures}/${CASES} random programs differ from s51`);
});

function parity(v) { let p = 0; while (v) { p ^= v & 1; v >>= 1; } return p; }
function generate(c) { return genProgram(0x5EED0000 + c); }
export { genProgram };
