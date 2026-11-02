// DOS/51 ROM end to end: system call ABI.  Every call must preserve R0-R7
// (in whatever bank is selected), B, DPTR (unless it is a result), PSW
// bank bits and SP; results come back in A and CY.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, cmd, upload, PROMPT, SEC } from './dos-helpers.js';

const prog = `
        ORG     8000h
        MOV     PSW, #08h               ; register bank 1
        MOV     R0, #11h
        MOV     R1, #22h
        MOV     R2, #33h
        MOV     R3, #44h
        MOV     R4, #55h
        MOV     R5, #66h
        MOV     R6, #77h
        MOV     R7, #10                 ; GETLINE buffer size
        MOV     B, #0A5h
        MOV     DPTR, #12345
        MOV     A, #'['
        LCALL   PUTC
        LCALL   PUTB
        LCALL   PUTHEX
        LCALL   PUTHEX16
        LCALL   PUTDEC
        LCALL   CRLF
        LCALL   KBHIT
        LCALL   PUTSI
        DB      "putsi", 10, 0
        MOV     DPTR, #msg
        LCALL   PUTS
        MOV     DPTR, #30
        LCALL   DELAY
        MOV     DPTR, #buf
        LCALL   GETLINE
        LCALL   PUTS
        LCALL   CRLF
        LCALL   GETC
        LCALL   GETKEY
        MOV     DPTR, #fname
        MOV     A, #'w'
        LCALL   FOPEN
        MOV     B, A
        MOV     A, #'Z'
        LCALL   FPUTC
        MOV     A, B
        LCALL   FCLOSE
        MOV     A, #'r'
        LCALL   FOPEN
        LCALL   FGETC
        LCALL   FGETC
        LCALL   ARGS
        MOV     PSW, #0
        RET
msg:    DB      "puts", 10, 0
fname:  DB      "abi.txt", 0
buf:    DS      10
`;

test('system calls preserve registers in any bank', () => {
  const { h } = boot();
  assert.ok(upload(h, 'abi.asm', prog).ok);
  const list = cmd(h, 'asm -l abi.asm');
  assert.match(list, /0 error\(s\)/);
  // address of every LCALL and of the instruction after it
  const calls = [...list.matchAll(/^([0-9A-F]{4}) 12([0-9A-F]{4}) +(?:\S+:)?\s*LCALL\s+(\w+)/mg)]
    .map(m => ({ at: parseInt(m[1], 16), target: parseInt(m[2], 16), name: m[3] }));
  assert.equal(calls.length, 22);
  const cpu = h.board.cpu;
  const state = () => ({
    regs: Array.from(cpu.iram.slice(8, 16)), bank0: Array.from(cpu.iram.slice(0, 8)),
    b: cpu.readSfr(0xF0), dptr: cpu.dptr, bank: cpu.psw & 0x18, sp: cpu.sp, a: cpu.acc, cy: cpu.psw >> 7,
  });
  // state at each LCALL and at every return from ROM into TPA code
  const before = new Map();
  const returns = [];
  let prevPc = 0;
  cpu.trace = (pc) => {
    for (const c of calls) if (pc === c.at) before.set(c.at, state());
    if (pc >= 0x8000 && prevPc < 0x8000 && prevPc !== 0) returns.push({ pc, s: state() });
    prevPc = pc;
  };
  h.send('abi\r');
  h.waitFor('puts\r\n', { timeoutCycles: 2 * SEC });
  h.send('typed\r');
  h.runMs(100);
  h.send('k');
  h.runMs(20);
  h.send('\x1b[A');
  assert.match(h.waitFor(PROMPT, { timeoutCycles: 2 * SEC }), /typed\r\ntyped\r\n/);
  cpu.trace = null;
  assert.equal(cmd(h, 'cat abi.txt'), 'Z');
  // pair each call with the first return into TPA code after it
  let ri = 0;
  for (const c of calls) {
    while (ri < returns.length && returns[ri].pc <= c.at) ri++;
    const b = before.get(c.at), a = returns[ri].s;
    assert.ok(b, `${c.name} not executed`);
    const why = `${c.name} at ${c.at.toString(16)}`;
    assert.deepEqual(a.regs, b.regs, `${why}: R0-R7 (bank 1)`);
    assert.equal(a.bank, 0x08, `${why}: bank`);
    assert.equal(a.sp, b.sp, `${why}: SP`);
    if (!['FOPEN', 'FPUTC'].includes(c.name)) assert.equal(a.b, b.b, `${why}: B`);
    if (c.name !== 'ARGS') assert.equal(a.dptr, b.dptr, `${why}: DPTR`);
    if (['PUTC', 'PUTB', 'PUTHEX', 'PUTHEX16', 'PUTDEC', 'CRLF', 'PUTSI', 'PUTS', 'DELAY', 'FCLOSE'].includes(c.name)) {
      assert.equal(a.a, b.a, `${why}: A preserved`);
    }
    if (c.name === 'GETLINE') assert.equal(a.a, 5);
    if (c.name === 'GETC') assert.equal(a.a, 'k'.charCodeAt(0));
    if (c.name === 'GETKEY') assert.equal(a.a, 0x80);              // K_UP
    if (c.name === 'FOPEN') assert.equal(a.cy, 0);
    ri++;
  }
  // FGETC: first 'Z', then end of file (carry)
  const fg = calls.filter(c => c.name === 'FGETC').map(c => returns.find(r => r.pc > c.at).s);
  assert.deepEqual([fg[0].a, fg[0].cy, fg[1].cy], [0x5A, 0, 1]);
});

test('EXIT returns to the shell from any depth; RET with a clean stack', () => {
  const { h } = boot();
  assert.ok(upload(h, 'ex.asm', '        ORG 8000h\n        LCALL sub\n        RET\nsub:    PUSH ACC\n        PUSH ACC\n        LJMP EXIT\n').ok);
  cmd(h, 'asm ex.asm');
  const sp = h.board.cpu.sp;
  assert.equal(cmd(h, 'ex'), '');
  assert.equal(cmd(h, 'ex'), '');
  assert.equal(h.board.cpu.sp, sp);
  assert.match(cmd(h, 'ver'), /DOS\/51/);
});
