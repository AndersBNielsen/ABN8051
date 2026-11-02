// DOS/51 ROM end to end: the self-hosted two-pass assembler.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { boot, cmd, upload, tpa } from './dos-helpers.js';
import { instructionLines, dosSource, sdasSource } from './asm-forms.js';
import { findTool, tmpDir } from '../emu/devtools.js';
import { parseIntelHex } from '../emu/ihex.js';

const hex = (a) => a.map(x => x.toString(16).padStart(2, '0')).join(' ');

test('every instruction form encodes like sdas8051', { skip: !findTool('sdas8051') && 'sdas8051 not installed' }, () => {
  const lines = instructionLines();
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'ref.asm'), sdasSource(lines));
  let r = spawnSync(findTool('sdas8051'), ['-plosgff', 'ref.rel', 'ref.asm'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  r = spawnSync(findTool('sdld'), ['-i', 'ref.ihx', 'ref.rel'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const ref = new Map();
  for (const s of parseIntelHex(fs.readFileSync(path.join(dir, 'ref.ihx'), 'utf8')).segments) {
    s.data.forEach((v, i) => ref.set(s.addr + i, v));
  }
  fs.rmSync(dir, { recursive: true, force: true });
  const len = Math.max(...ref.keys()) + 1 - 0x8000;
  assert.ok(len > 900);

  const { h } = boot();
  assert.ok(upload(h, 'forms.asm', dosSource(lines)).ok);
  const out = cmd(h, 'asm -n forms.asm', { timeout: 120 });
  assert.match(out, new RegExp(`${lines.length + 2} lines, \\d+ symbols, 0 error\\(s\\)\\ncode 8000h-[0-9A-F]{4}h, ${len} bytes\\n$`));
  const got = tpa(h, 0x8000, len);
  for (let i = 0; i < len; i++) {
    if (got[i] !== ref.get(0x8000 + i)) {
      assert.fail(`byte ${(0x8000 + i).toString(16)}: got ${hex(got.slice(i, i + 4))}, sdas ${hex([0, 1, 2, 3].map(k => ref.get(0x8000 + i + k)))}`);
    }
  }
  // the -n flag did not write forms.bin
  assert.ok(!cmd(h, 'ls').includes('forms.bin'));
});

test('numbers, operators, directives, symbols, INCLUDE, listing', () => {
  const src = `; expression and directive test
CONST1  EQU     1234h
VAL     =       CONST1 + 2 * 3          ; 123Ah
CNT     SET     5
CNT     SET     CNT + 1
FLAG    BIT     20h.3
PORTX   DATA    0A0h
        INCLUDE "inc.asm"
        ORG     8000h
start:  DB      LOW VAL, HIGH VAL, CNT, FLAG, PORTX, INCV
        DB      'A', "ab", 0FFh, 1010b, 17o, 0x1F, $1F, 255d
        DW      1234h, start, $
        DB      (3 + 4) * 2, 100 / 7, 100 % 7, 1 << 4, 80h >> 3
        DB      0F0h & 3Ch, 0F0h | 0Fh, 0FFh ^ 0Fh, ~0 & 0FFh, -1 & 0FFh
        DB      5 AND 3, 5 OR 2, 6 XOR 3, 17 MOD 5, 1 SHL 3, 16 SHR 2, NOT 0FFFEh
        DB      ACC.7, P1.0, TPA >> 8, LOW(PUTC), 'a' - 'A', 2 + 3 * 4 - 1
        DS      3
here:   setb    flag                    ; case does not matter
        MOV     A, #-1
        MOV     R0, #LOW(-2)
        CJNE    A, #'x', $
        DB      "esc\\t\\n\\0;"
        .db     1, 2                    ; directives may have a leading dot
lbl     equ     $
        db      high lbl, low lbl
        jmp     fwd                     ; generic JMP/CALL are LJMP/LCALL
        call    fwd
fwd:    END
        DB      99                      ; after END: ignored
`;
  const { h } = boot();
  assert.ok(upload(h, 'inc.asm', 'INCV    EQU     77h\n').ok);
  assert.ok(upload(h, 'expr.asm', src).ok);
  const out = cmd(h, 'asm -l expr.asm');
  assert.match(out, /^8000 3A120603\+ start: {2}DB {6}LOW VAL/m);
  assert.match(out, /^ {15}INCV {4}EQU {5}77h$/m);           // listing shows the include
  assert.match(out, /^802C {19}DS {6}3$/m);
  assert.match(out, /^8043 028049 {12}jmp {5}fwd/m);
  assert.match(out, /29 lines, 10 symbols, 0 error\(s\)\ncode 8000h-8048h, 70 bytes\nwrote expr\.bin \(73 bytes, load at 8000h\)\n$/);
  const want = [
    0x3A, 0x12, 0x06, 0x03, 0xA0, 0x77,
    0x41, 0x61, 0x62, 0xFF, 0x0A, 0x0F, 0x1F, 0x1F, 0xFF,
    0x12, 0x34, 0x80, 0x00, 0x80, 0x0F,
    0x0E, 0x0E, 0x02, 0x10, 0x10,
    0x30, 0xFF, 0xF0, 0xFF, 0xFF,
    0x01, 0x07, 0x05, 0x02, 0x08, 0x04, 0x01,
    0xE7, 0x90, 0x80, 0x03, 0x20, 0x0D,
    0x00, 0x00, 0x00,
    0xD2, 0x03, 0x74, 0xFF, 0x78, 0xFE, 0xB4, 0x78, 0xFD,
    0x65, 0x73, 0x63, 0x09, 0x0A, 0x00, 0x3B, 0x01, 0x02, 0x80, 0x41,
    0x02, 0x80, 0x49, 0x12, 0x80, 0x49,
  ];
  assert.equal(hex(tpa(h, 0x8000, want.length)), hex(want));
  // NAME.bin holds the image from 8000h
  assert.match(cmd(h, 'ls -l'), / 73 {2}[0-9A-F]{4} {2}expr\.bin/);
});

test('errors are reported with file:line, the source line and a count', () => {
  const bad = `        ORG 8000h
        MOV A, #300
        DB 1,
        FOO
        MOV A, @R2
        MOV A, undefinedsym
dup:    NOP
dup:    NOP
        SJMP far
        DB (1+2
        DB 4/0
        AJMP 9000h
        MOV 100h, A
        INC A, B
        DB 1 2
        DS 200h
far:    RET
        ORG 7000h
        NOP
`;
  const { h } = boot();
  assert.ok(upload(h, 'bad.asm', bad).ok);
  const out = cmd(h, 'asm bad.asm');
  const errs = [...out.matchAll(/^bad\.asm:(\d+): (.*)\n {4}(.*)$/mg)].map(m => [Number(m[1]), m[2], m[3].trim()]);
  assert.deepEqual(errs, [
    [2, 'byte value out of range', 'MOV A, #300'],
    [3, 'missing operand', 'DB 1,'],
    [4, "unknown instruction (labels need a ':')", 'FOO'],
    [5, 'bad operand', 'MOV A, @R2'],
    [6, 'undefined symbol', 'MOV A, undefinedsym'],
    [8, 'symbol redefined', 'dup:    NOP'],
    [9, 'relative jump out of range', 'SJMP far'],
    [10, 'unbalanced (', 'DB (1+2'],
    [11, 'division by zero', 'DB 4/0'],
    [12, 'AJMP/ACALL target not in same 2K page', 'AJMP 9000h'],
    [13, 'address out of range (> 0FFh)', 'MOV 100h, A'],
    [14, 'invalid operand combination', 'INC A, B'],
    [15, 'syntax error', 'DB 1 2'],
    [19, 'code outside TPA (8000h-FFFFh)', 'NOP'],
  ]);
  assert.match(out, /19 lines, \d+ symbols, 14 error\(s\)\n$/);
  assert.ok(!cmd(h, 'ls').includes('bad.bin'));
  // pass 1 errors stop before pass 2
  assert.ok(upload(h, 'p1.asm', '        ORG undefd\n        NOP\n').ok);
  assert.equal(cmd(h, 'asm p1.asm'), 'pass 1\np1.asm:1: value must be known in pass 1\n            ORG undefd\n1 error(s)\n');
  assert.equal(cmd(h, 'asm nothere.asm'), 'asm: no such file\n');
  assert.ok(upload(h, 'inc2.asm', '        INCLUDE missing.asm\n').ok);
  assert.match(cmd(h, 'asm inc2.asm'), /inc2\.asm:1: include file not found/);
});

test('asm -r assembles and runs; run without a name restarts the TPA program', () => {
  const { h } = boot();
  const out = cmd(h, 'asm -r hello.asm');
  assert.ok(out.endsWith('wrote hello.bin (53 bytes, load at 8000h)\nHello from the 80C31!\n'), out);
  assert.equal(cmd(h, 'run'), 'Hello from the 80C31!\n');
  assert.equal(cmd(h, 'go 8000h'), 'Hello from the 80C31!\n');
});

test('labels, forward references and a larger program (255-symbol table)', () => {
  // 200 labels, each referenced before it is defined
  let src = '        ORG 8000h\n';
  for (let i = 0; i < 200; i++) src += `        LJMP    L${i}\n`;
  for (let i = 0; i < 200; i++) src += `L${i}:    DB      ${i & 0xFF}\n`;
  const { h } = boot();
  assert.ok(upload(h, 'big.asm', src).ok);
  const out = cmd(h, 'asm -n big.asm', { timeout: 120 });
  assert.match(out, /401 lines, 200 symbols, 0 error\(s\)\ncode 8000h-831Fh, 800 bytes/);
  const img = tpa(h, 0x8000, 800);
  for (let i = 0; i < 200; i++) {
    const t = 0x8000 + 600 + i;
    assert.deepEqual(img.slice(i * 3, i * 3 + 3), [0x02, t >> 8, t & 0xFF]);
    assert.equal(img[600 + i], i);
  }
  // too many symbols
  let many = '        ORG 8000h\n';
  for (let i = 0; i < 260; i++) many += `S${i} EQU ${i}\n`;
  assert.ok(upload(h, 'many.asm', many).ok);
  assert.match(cmd(h, 'asm many.asm', { timeout: 120 }), /many\.asm:257: symbol table full \(255\)/);
});
