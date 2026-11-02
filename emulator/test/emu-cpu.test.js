// CPU unit tests: opcode table vs datasheet, flags, bit addressing, ports,
// interrupts, timers, PCON.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CPU8051, OPLEN, OPCYC } from '../emu/cpu8051.js';
import { Board } from '../emu/board.js';

// MCS-51 instruction set (Intel/Philips datasheet), "bytes cycles" per opcode,
// one row per high nibble, columns 0..F.
const DATASHEET = [
  '11 22 32 11 11 21 11 11 11 11 11 11 11 11 11 11', // 0x: NOP AJMP LJMP RR INC...
  '32 22 32 11 11 21 11 11 11 11 11 11 11 11 11 11', // 1x: JBC ACALL LCALL RRC DEC
  '32 22 12 11 21 21 11 11 11 11 11 11 11 11 11 11', // 2x: JB AJMP RET RL ADD
  '32 22 12 11 21 21 11 11 11 11 11 11 11 11 11 11', // 3x: JNB ACALL RETI RLC ADDC
  '22 22 21 32 21 21 11 11 11 11 11 11 11 11 11 11', // 4x: JC AJMP ORL
  '22 22 21 32 21 21 11 11 11 11 11 11 11 11 11 11', // 5x: JNC ACALL ANL
  '22 22 21 32 21 21 11 11 11 11 11 11 11 11 11 11', // 6x: JZ AJMP XRL
  '22 22 22 12 21 32 21 21 21 21 21 21 21 21 21 21', // 7x: JNZ ACALL ORL C JMP MOV
  '22 22 22 12 14 32 22 22 22 22 22 22 22 22 22 22', // 8x: SJMP AJMP ANL C MOVC DIV MOV
  '32 22 22 12 21 21 11 11 11 11 11 11 11 11 11 11', // 9x: MOV DPTR ACALL MOV bit MOVC SUBB
  '22 22 21 12 14 11 22 22 22 22 22 22 22 22 22 22', // Ax: ORL C/ AJMP MOV C INC DPTR MUL (A5) MOV
  '22 22 21 11 32 32 32 32 32 32 32 32 32 32 32 32', // Bx: ANL C/ ACALL CPL CPL CJNE
  '22 22 21 11 11 21 11 11 11 11 11 11 11 11 11 11', // Cx: PUSH AJMP CLR CLR SWAP XCH
  '22 22 21 11 11 32 11 11 22 22 22 22 22 22 22 22', // Dx: POP ACALL SETB SETB DA DJNZ XCHD DJNZ
  '12 22 12 12 11 21 11 11 11 11 11 11 11 11 11 11', // Ex: MOVX AJMP MOVX CLR MOV
  '12 22 12 12 11 21 11 11 11 11 11 11 11 11 11 11', // Fx: MOVX ACALL MOVX CPL MOV
];

function cpuWith(bytes, at = 0) {
  const code = new Uint8Array(65536).fill(0x00);
  code.set(bytes, at);
  const cpu = new CPU8051({ code });
  cpu.pc = at;
  return cpu;
}
function steps(cpu, n) { let c = 0; for (let i = 0; i < n; i++) c += cpu.step(); return c; }
const CY = 0x80, AC = 0x40, OV = 0x04;

test('opcode lengths and cycle counts match the datasheet for all 256 opcodes', () => {
  for (let hi = 0; hi < 16; hi++) {
    const cols = DATASHEET[hi].split(' ');
    for (let lo = 0; lo < 16; lo++) {
      const op = (hi << 4) | lo;
      assert.equal(OPLEN[op], Number(cols[lo][0]), `length of ${op.toString(16)}`);
      assert.equal(OPCYC[op], Number(cols[lo][1]), `cycles of ${op.toString(16)}`);
    }
  }
});

test('every opcode executes with the table cycles; non-jumps advance PC by length', () => {
  const jumps = new Set([0x02, 0x12, 0x22, 0x32, 0x73, 0x80, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0xD5,
    0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xBB, 0xBC, 0xBD, 0xBE, 0xBF, 0xD8, 0xD9, 0xDA, 0xDB, 0xDC, 0xDD, 0xDE, 0xDF]);
  for (let op = 0; op < 256; op++) {
    // operands chosen so conditional branches have rel = 0 (target = next)
    const cpu = cpuWith([op, 0x30, 0x00], 0x100);
    cpu.data[0xD0] = 0; // bank 0
    const c = cpu.step();
    assert.equal(c, OPCYC[op], `cycles ${op.toString(16)}`);
    if ((op & 0x1F) === 0x01 || (op & 0x1F) === 0x11 || jumps.has(op)) continue;
    assert.equal(cpu.pc, 0x100 + OPLEN[op], `pc after ${op.toString(16)}`);
  }
});

test('ADD/ADDC flags', () => {
  const add = (a, b, cin = 0, op = 0x24) => {
    const cpu = cpuWith([op, b]);
    cpu.acc = a; cpu.psw = cin ? CY : 0;
    cpu.step();
    return [cpu.acc, cpu.psw & (CY | AC | OV)];
  };
  assert.deepEqual(add(0x7F, 0x01), [0x80, AC | OV]);
  assert.deepEqual(add(0xFF, 0x01), [0x00, CY | AC]);
  assert.deepEqual(add(0x80, 0x80), [0x00, CY | OV]);
  assert.deepEqual(add(0x0F, 0x01), [0x10, AC]);
  assert.deepEqual(add(0x12, 0x34), [0x46, 0]);
  assert.deepEqual(add(0xFF, 0xFF, 1, 0x34), [0xFF, CY | AC]);
  assert.deepEqual(add(0x7F, 0x00, 1, 0x34), [0x80, AC | OV]);
  assert.deepEqual(add(0xC0, 0xC0), [0x80, CY]);
});

test('SUBB flags', () => {
  const sub = (a, b, cin = 0) => {
    const cpu = cpuWith([0x94, b]);
    cpu.acc = a; cpu.psw = cin ? CY : 0;
    cpu.step();
    return [cpu.acc, cpu.psw & (CY | AC | OV)];
  };
  assert.deepEqual(sub(0x80, 0x01), [0x7F, AC | OV]);
  assert.deepEqual(sub(0x00, 0x01), [0xFF, CY | AC]);
  assert.deepEqual(sub(0x7F, 0xFF), [0x80, CY | OV]);
  assert.deepEqual(sub(0x10, 0x01), [0x0F, AC]);
  assert.deepEqual(sub(0x55, 0x55, 1), [0xFF, CY | AC]);
  assert.deepEqual(sub(0xC9, 0x54, 1), [0x74, OV]); // Intel manual example: C9h - 54h - 1 = 74h, OV=1
});

test('DA A', () => {
  const da = (a, psw) => { const cpu = cpuWith([0xD4]); cpu.acc = a; cpu.psw = psw; cpu.step(); return [cpu.acc, cpu.psw & (CY | AC | OV)]; };
  assert.deepEqual(da(0x3C, 0), [0x42, 0]);         // 15h + 27h
  assert.deepEqual(da(0x12, AC), [0x18, AC]);       // 09h + 09h
  assert.deepEqual(da(0x9A, 0), [0x00, CY]);        // 99h + 01h
  assert.deepEqual(da(0xA0, 0), [0x00, CY]);        // 50h + 50h
  assert.deepEqual(da(0x00, CY), [0x60, CY]);       // 80h + 80h
  assert.deepEqual(da(0xBE, 0), [0x24, CY]);        // Intel manual: 56h + 67h + 1 = BEh -> 24h, CY
  assert.deepEqual(da(0x99, OV), [0x99, OV]);       // OV unaffected, already BCD
});

test('MUL AB / DIV AB', () => {
  const run = (op, a, b) => { const cpu = cpuWith([op]); cpu.acc = a; cpu.data[0xF0] = b; cpu.psw = CY; cpu.step(); return [cpu.acc, cpu.data[0xF0], cpu.psw & (CY | OV)]; };
  assert.deepEqual(run(0xA4, 0x80, 0x02), [0x00, 0x01, OV]);
  assert.deepEqual(run(0xA4, 0x50, 0xA0), [0x00, 0x32, OV]); // Intel example: 80*160 = 12800 = 3200h
  assert.deepEqual(run(0xA4, 0x10, 0x0F), [0xF0, 0x00, 0]);
  assert.deepEqual(run(0x84, 0xFB, 0x12), [0x0D, 0x11, 0]); // 251/18 = 13 r 17
  const [, , f] = run(0x84, 0x42, 0x00);
  assert.equal(f, OV); // divide by zero: OV=1, CY=0
});

test('parity is live from ACC, bank switching via PSW bits', () => {
  // MOV A,#07 ; SETB RS0 ; MOV R0,#55 ; CLR RS0 ; SETB RS1 ; MOV R7,#66
  const cpu = cpuWith([0x74, 0x07, 0xD2, 0xD3, 0x78, 0x55, 0xC2, 0xD3, 0xD2, 0xD4, 0x7F, 0x66]);
  cpu.step();
  assert.equal(cpu.psw & 1, 1);
  assert.equal(cpu.readSfr(0xD0) & 1, 1);
  steps(cpu, 5);
  assert.equal(cpu.data[0x08], 0x55);
  assert.equal(cpu.data[0x17], 0x66);
  assert.equal(cpu.regs[7], 0x66);
});

test('bit addressing: IRAM 0x20-0x2F and SFR bits; JBC; carry logic', () => {
  // SETB 00h ; SETB 7Fh ; SETB ACC.7 ; CPL B.0 ; MOV C,7Fh ; ANL C,/00h ; JBC 7Fh,+0 ; ORL C,/7Fh
  const cpu = cpuWith([0xD2, 0x00, 0xD2, 0x7F, 0xD2, 0xE7, 0xB2, 0xF0, 0xA2, 0x7F, 0xB0, 0x00, 0x10, 0x7F, 0x00, 0xA0, 0x7F]);
  steps(cpu, 4);
  assert.equal(cpu.data[0x20], 0x01);
  assert.equal(cpu.data[0x2F], 0x80);
  assert.equal(cpu.acc, 0x80);
  assert.equal(cpu.data[0xF0], 0x01);
  cpu.step(); assert.equal(cpu.psw & CY, CY);
  cpu.step(); assert.equal(cpu.psw & CY, 0); // C AND NOT(1) = 0
  cpu.step(); assert.equal(cpu.data[0x2F], 0x00); // JBC cleared the bit
  cpu.step(); assert.equal(cpu.psw & CY, CY);
});

test('ports: read-modify-write uses the latch, plain reads use the pins', () => {
  // ORL P1,#00 ; MOV A,P1 ; CPL P1.1 ; MOV C,P1.0 ; MOV 30h,P1
  const cpu = cpuWith([0x43, 0x90, 0x00, 0xE5, 0x90, 0xB2, 0x91, 0xA2, 0x90, 0x85, 0x90, 0x30]);
  const writes = [];
  cpu.onPortWrite = (p, v) => writes.push([p, v]);
  cpu.p1in = 0x00; // something external pulls every P1 pin low
  cpu.step();
  assert.equal(cpu.data[0x90], 0xFF, 'latch preserved');
  cpu.step();
  assert.equal(cpu.acc, 0x00, 'pins read');
  cpu.step();
  assert.equal(cpu.data[0x90], 0xFD, 'CPL used latch');
  cpu.step();
  assert.equal(cpu.psw & CY, 0);
  cpu.step();
  assert.equal(cpu.data[0x30], 0x00);
  assert.deepEqual(writes, [[1, 0xFF], [1, 0xFD]]);
});

test('80C31: indirect access above 0x7F reads 0xFF and ignores writes; stack too', () => {
  // MOV R0,#90h ; MOV @R0,#12h ; MOV A,@R0 ; MOV SP,#7Fh ; PUSH ACC ; POP B
  const cpu = cpuWith([0x78, 0x90, 0x76, 0x12, 0xE6, 0x75, 0x81, 0x7F, 0xC0, 0xE0, 0xD0, 0xF0]);
  steps(cpu, 3);
  assert.equal(cpu.data[0x90], 0xFF, 'P1 untouched');
  assert.equal(cpu.acc, 0xFF);
  steps(cpu, 3);
  assert.equal(cpu.sp, 0x7F);
  assert.equal(cpu.data[0xF0], 0xFF);
});

test('MOVC and MOVX (P2 supplies the high byte for @Ri)', () => {
  // MOV DPTR,#1234h ; MOV A,#01 ; MOVC A,@A+DPTR ; MOVX @DPTR,A ; MOV P2,#12h ; MOV R1,#34h ; MOVX A,@R1 ; MOV A,#1 ; MOVC A,@A+PC
  const cpu = cpuWith([0x90, 0x12, 0x34, 0x74, 0x01, 0x93, 0xF0, 0x75, 0xA0, 0x12, 0x79, 0x34, 0xE4, 0xE3, 0x74, 0x01, 0x83, 0x00, 0x77]);
  cpu.code[0x1235] = 0xAB;
  steps(cpu, 4);
  assert.equal(cpu.xlo[0x1234], 0xAB);
  steps(cpu, 4);
  assert.equal(cpu.acc, 0xAB);
  steps(cpu, 2);
  assert.equal(cpu.acc, 0x77);
});

// Interrupt test scaffold: vectors increment a counter byte and RETI.
function irqCpu(main, vectors = {}) {
  const code = new Uint8Array(65536).fill(0);
  code.set([0x02, 0x01, 0x00]); // LJMP 0100h
  for (const [vec, body] of Object.entries(vectors)) code.set(body, Number(vec));
  code.set(main, 0x100);
  const cpu = new CPU8051({ code });
  return cpu;
}

test('interrupts: poll order, priority, nesting, RETI and IE-write blocking', () => {
  const log = [];
  // T0 vector: logs at entry via trace hook
  const cpu = irqCpu(
    // MOV IE,#83h (EA, ET0, EX0) ; then NOPs
    [0x75, 0xA8, 0x83, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    { 0x03: [0x00, 0x32], 0x0B: [0x00, 0x32] });
  cpu.trace = (pc) => { if (pc === 0x03 || pc === 0x0B) log.push(pc); };
  cpu.step(); // LJMP
  cpu.data[0x88] |= 0x22; // TF0 and IE0 pending together (IT0=0 is level, so use edge mode)
  cpu.data[0x88] |= 0x01;
  cpu.step(); // MOV IE: write blocks one instruction
  assert.equal(cpu.pc, 0x103);
  cpu.step(); // NOP executes, then INT0 (higher in poll order) is vectored
  assert.equal(cpu.pc, 0x03);
  assert.equal(cpu.data[0x88] & 0x02, 0, 'IE0 cleared (edge mode)');
  cpu.step(); // NOP in ISR (TF0 pending, same level: no nesting)
  assert.equal(cpu.pc, 0x04);
  cpu.step(); // RETI -> back to main, one instruction must run before T0
  assert.equal(cpu.pc, 0x104);
  cpu.step();
  assert.equal(cpu.pc, 0x0B, 'T0 taken after one main instruction');
  assert.equal(cpu.data[0x88] & 0x20, 0, 'TF0 cleared by hardware');
  steps(cpu, 1);
  assert.deepEqual(log, [0x03, 0x0B]); // trace saw both ISRs execute
});

test('interrupts: high priority preempts low, not vice versa; RI/TI not cleared', () => {
  const cpu = irqCpu([0x75, 0xB8, 0x10, 0x75, 0xA8, 0x92, 0x00, 0x00, 0x00, 0x00, 0x80, 0xFE],
    { 0x0B: [0x00, 0x00, 0x00, 0x32], 0x23: [0x00, 0x00, 0x32] }); // IP: PS high; IE: EA|ES|ET0
  steps(cpu, 3); // LJMP, MOV IP, MOV IE
  cpu.step(); // NOP (IE write blocking)
  cpu.data[0x88] |= 0x20; // TF0 (low)
  cpu.step(); // NOP -> T0 vectored
  assert.equal(cpu.pc, 0x0B);
  assert.ok(cpu.activeLo && !cpu.activeHi);
  cpu.data[0x98] |= 0x01; // RI (high priority)
  cpu.step(); // NOP in T0 ISR, then serial preempts
  assert.equal(cpu.pc, 0x23);
  assert.ok(cpu.activeHi);
  assert.equal(cpu.data[0x98] & 1, 1, 'RI not cleared by hardware');
  cpu.data[0x98] &= ~1;
  steps(cpu, 2); // NOP NOP
  cpu.step(); // RETI from serial
  assert.equal(cpu.pc, 0x0C);
  assert.ok(!cpu.activeHi && cpu.activeLo);
  cpu.data[0x88] |= 0x20; // another low request while low active: must wait
  steps(cpu, 2);
  assert.equal(cpu.pc, 0x0E);
  cpu.step(); // RETI (T0 interrupted the NOP at 0x107, so it returns to 0x108)
  assert.equal(cpu.pc, 0x108);
  cpu.step();
  assert.equal(cpu.pc, 0x0B, 'pending low request taken after RETI + 1 instruction');
});

test('external interrupts: edge vs level via pins', () => {
  const b = new Board({ seed: 1 });
  const cpu = b.cpu;
  cpu.data[0x88] = 0x01; // IT0 = edge
  b.setPin('P3.2', 0);
  assert.equal(cpu.data[0x88] & 0x02, 0x02, 'falling edge latched');
  cpu.data[0x88] &= ~0x02;
  b.setPin('P3.2', 0);
  assert.equal(cpu.data[0x88] & 0x02, 0, 'no new edge');
  b.setPin('P3.2', 1);
  cpu.writeSfr(0x88, 0x00); // level mode while pin high
  assert.equal(cpu.data[0x88] & 0x02, 0);
  b.setPin('P3.2', 0);
  assert.equal(cpu.data[0x88] & 0x02, 0x02, 'level: follows pin');
  b.setPin('P3.2', 1);
  assert.equal(cpu.data[0x88] & 0x02, 0);
  // INT1 via the P3 latch (software drives its own pin low)
  cpu.writeSfr(0x88, 0x04);
  cpu.writeSfr(0xB0, 0xF7);
  assert.equal(cpu.data[0x88] & 0x08, 0x08);
});

function timerCpu(tmod, tl0, th0, tl1, th1, tcon) {
  const cpu = cpuWith([]); // NOP sled
  Object.assign(cpu.data, { [0x89]: tmod, [0x8A]: tl0, [0x8C]: th0, [0x8B]: tl1, [0x8D]: th1, [0x88]: tcon });
  return cpu;
}

test('timer modes 0, 1, 2, 3', () => {
  let cpu = timerCpu(0x01, 0xF0, 0xFF, 0, 0, 0x10); // mode 1
  steps(cpu, 15); assert.equal(cpu.data[0x88] & 0x20, 0);
  cpu.step(); assert.equal(cpu.data[0x88] & 0x20, 0x20); assert.equal(cpu.data[0x8A], 0); assert.equal(cpu.data[0x8C], 0);
  cpu = timerCpu(0x00, 0x1E, 0xFF, 0, 0, 0x10); // mode 0: 13 bit, overflow after 2 counts
  steps(cpu, 2); assert.equal(cpu.data[0x88] & 0x20, 0x20); assert.equal(cpu.data[0x8C], 0);
  cpu = timerCpu(0x20, 0, 0, 0xFE, 0xF0, 0x40); // T1 mode 2 auto-reload
  steps(cpu, 2); assert.equal(cpu.data[0x88] & 0x80, 0x80); assert.equal(cpu.data[0x8B], 0xF0);
  cpu.data[0x88] &= 0x7F;
  steps(cpu, 16); assert.equal(cpu.data[0x88] & 0x80, 0x80); assert.equal(cpu.data[0x8B], 0xF0);
  // Bulk advance (idle fast-forward path) matches stepwise behaviour
  cpu = timerCpu(0x20, 0, 0, 0x00, 0xFD, 0x40);
  cpu.tickTimers(1000); assert.equal(cpu.data[0x8B], 0xFD + ((1000 - 256) % 3)); assert.equal(cpu.t1Overflows, 1 + Math.floor((1000 - 256) / 3));
  // mode 3: TL0 under TR0 sets TF0, TH0 under TR1 sets TF1
  cpu = timerCpu(0x03, 0xFF, 0xFE, 0, 0, 0x50);
  cpu.step(); assert.equal(cpu.data[0x88] & 0xA0, 0x20);
  cpu.step(); assert.equal(cpu.data[0x88] & 0xA0, 0xA0);
});

test('timer counter mode (T0 pin) and GATE (INT0 pin)', () => {
  const b = new Board({ seed: 1 });
  const cpu = b.cpu;
  cpu.writeSfr(0x89, 0x05); // T0 counter, mode 1
  cpu.writeSfr(0x88, 0x10);
  for (let i = 0; i < 5; i++) { b.setPin('P3.4', 0); b.setPin('P3.4', 1); }
  assert.equal(cpu.data[0x8A], 5);
  b.run(100);
  assert.equal(cpu.data[0x8A], 5, 'counter mode ignores the clock');
  cpu.writeSfr(0x89, 0x09); // gated timer mode 1
  cpu.data[0x8A] = 0;
  b.setPin('P3.2', 0);
  b.run(100);
  assert.equal(cpu.data[0x8A], 0, 'gate closed');
  b.setPin('P3.2', 1);
  const c0 = b.cycles; b.run(100);
  assert.equal(cpu.data[0x8A], b.cycles - c0);
});

test('PCON idle: CPU stops, timer interrupt wakes it, fast-forward is fast', () => {
  // main: MOV TMOD,#01 ; SETB TR0 ; MOV IE,#82h ; loop: ORL PCON,#01 ; INC 30h ; SJMP loop
  // T0 ISR: INC 31h ; RETI
  const b = new Board({ seed: 1 });
  b.loadRom(Uint8Array.from([0x02, 0x01, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0x05, 0x31, 0x32]).slice());
  const main = [0x75, 0x89, 0x01, 0xD2, 0x8C, 0x75, 0xA8, 0x82, 0x43, 0x87, 0x01, 0x05, 0x30, 0x80, 0xF9];
  b.rom.set(main, 0x100);
  b.reset();
  b.cpu.data[0x30] = 0; b.cpu.data[0x31] = 0;
  const t0 = performance.now();
  b.run(921600 * 60); // one emulated minute
  const ms = performance.now() - t0;
  const wakes = Math.floor(921600 * 60 / 65536);
  assert.ok(Math.abs(b.cpu.data[0x31] - (wakes & 0xFF)) <= 1, `isr count ${b.cpu.data[0x31]}`);
  assert.equal(b.cpu.data[0x30], b.cpu.data[0x31]);
  assert.ok(ms < 500, `idle minute took ${ms.toFixed(0)} ms`);
});

test('PCON power-down stops everything until reset', () => {
  const b = new Board({ seed: 1 });
  b.loadRom(Uint8Array.from([0x75, 0x87, 0x02, 0x05, 0x30, 0x80, 0xFC]));
  b.reset();
  b.cpu.data[0x30] = 0;
  b.run(10000);
  assert.ok(b.cpu.pd);
  assert.equal(b.cpu.data[0x30], 0);
  b.reset();
  assert.ok(!b.cpu.pd);
});
