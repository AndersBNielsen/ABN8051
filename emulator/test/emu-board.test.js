// Board tests: memory map, reset/power cycle, UART timing, RX pacing,
// ports, Intel HEX, and emulation speed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Board, CLOCK_HZ, MC_PER_SEC } from '../emu/board.js';
import { parseIntelHex, emitIntelHex, hexToImage } from '../emu/ihex.js';

function boardWith(code, opts = {}) {
  const b = new Board({ seed: 1, ...opts });
  b.loadRom(Uint8Array.from(code));
  b.reset();
  return b;
}
// SCON=50h, TMOD=20h, TH1=TL1=FDh, PCON=80h, SETB TR1
const UART_INIT = [0x75, 0x98, 0x50, 0x75, 0x89, 0x20, 0x75, 0x8D, 0xFD, 0x75, 0x8B, 0xFD, 0x75, 0x87, 0x80, 0xD2, 0x8E];

test('constants', () => {
  assert.equal(CLOCK_HZ, 11059200);
  assert.equal(MC_PER_SEC, 921600);
  assert.equal(Board.MC_PER_SEC, 921600);
});

test('memory map: RAM1 is both XDATA and CODE 0x8000-0xFFFF; RAM0 is XDATA low only', () => {
  // MOV DPTR,#8000h ; MOV A,#5Ah ; MOVX @DPTR,A ; CLR A ; MOVC A,@A+DPTR ; MOV DPTR,#0010h ; MOV A,#11h ; MOVX @DPTR,A ;
  // CLR A ; MOVC A,@A+DPTR (reads ROM, not RAM0) ; LJMP 8000h
  const b = boardWith([0x90, 0x80, 0x00, 0x74, 0x5A, 0xF0, 0xE4, 0x93, 0xF5, 0x30, 0x90, 0x00, 0x10, 0x74, 0x11, 0xF0, 0xE4, 0x93, 0xF5, 0x31, 0x02, 0x80, 0x01]);
  b.ram1[1] = 0x00; // NOP at 8001h, then MOV A,#77h, SJMP $
  b.ram1.set([0x00, 0x74, 0x77, 0x80, 0xFE], 1);
  b.run(100);
  assert.equal(b.cpu.data[0x30], 0x5A, 'MOVX write visible to MOVC');
  assert.equal(b.ram1[0], 0x5A);
  assert.equal(b.ram0[0x10], 0x11);
  assert.equal(b.cpu.data[0x31], b.rom[0x10], 'MOVC low half reads ROM');
  assert.equal(b.cpu.acc, 0x77, 'code executes from RAM1');
  assert.equal(b.rom.length, 32768);
  assert.equal(b.rom[100], 0xFF, 'ROM padded with FF');
});

test('reset keeps RAM, power cycle randomises deterministically', () => {
  const b = new Board({ seed: 5 });
  const first = b.ram0.slice(0, 64);
  b.ram0[0] = 0xAA; b.ram1[0] = 0xBB; b.cpu.data[0x40] = 0xCC;
  b.reset();
  assert.equal(b.ram0[0], 0xAA); assert.equal(b.ram1[0], 0xBB); assert.equal(b.cpu.data[0x40], 0xCC);
  assert.equal(b.cpu.pc, 0); assert.equal(b.cpu.sp, 7); assert.equal(b.portLatch(1), 0xFF);
  b.powerCycle(5);
  assert.deepEqual(b.ram0.slice(0, 64), first);
  b.powerCycle(6);
  assert.notDeepEqual(b.ram0.slice(0, 64), first);
});

test('loadRom accepts Intel HEX; data above 0x8000 goes to RAM1', () => {
  const hex = emitIntelHex(Uint8Array.of(1, 2, 3), 0x10) + emitIntelHex(Uint8Array.of(9), 0x8005);
  const b = new Board({ seed: 1 });
  b.loadRom(hex.replace(/:00000001FF\n(?=:)/, ''));
  assert.deepEqual(Array.from(b.rom.subarray(0x10, 0x13)), [1, 2, 3]);
  assert.equal(b.rom[0], 0xFF);
  assert.equal(b.ram1[5], 9);
});

test('ihex: parse/emit round trip, checksum errors, extended address', () => {
  const data = Uint8Array.from({ length: 300 }, (_, i) => (i * 13) & 0xFF);
  const hex = emitIntelHex(data, 0x1F80);
  const { segments } = parseIntelHex(hex);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].addr, 0x1F80);
  assert.deepEqual(segments[0].data, data);
  const { image, min, max } = hexToImage(hex, 0x4000);
  assert.equal(min, 0x1F80); assert.equal(max, 0x1F80 + 300);
  assert.deepEqual(image.subarray(min, max), data);
  assert.throws(() => parseIntelHex(':0300000002003FBA\n'), /checksum/);
  const ext = emitIntelHex(Uint8Array.of(7, 8), 0x1FFFF);
  const p = parseIntelHex(ext);
  assert.deepEqual(p.segments.map(s => s.addr), [0x1FFFF, 0x20000]);
});

test('UART mode 1 at TH1=FDh SMOD=1: 19200 baud, 480-cycle frames, onTx', () => {
  // init ; MOV SBUF,#41h ; w: JNB TI,w ; CLR TI ; MOV SBUF,#42h ; SJMP $
  const b = boardWith([...UART_INIT, 0x75, 0x99, 0x41, 0x30, 0x99, 0xFD, 0xC2, 0x99, 0x75, 0x99, 0x42, 0x80, 0xFE]);
  const tx = [];
  b.onTx = (c) => tx.push([c, b.cycles]);
  b.run(20);
  assert.equal(b.baud, 19200);
  assert.equal(b.frameCycles(), 480);
  assert.equal(b.bitCycles(), 48);
  b.run(2000);
  assert.deepEqual(tx.map(t => t[0]), [0x41, 0x42]);
  const d = tx[1][1] - tx[0][1];
  assert.ok(d >= 480 && d <= 486, `frame spacing ${d}`);
  // SBUF is written at cycle 11 (after the 11-cycle init)
  assert.ok(tx[0][1] - 11 >= 478 && tx[0][1] - 11 <= 482, `first frame ${tx[0][1]}`);
  // SMOD = 0 -> 9600 baud
  b.cpu.writeSfr(0x87, 0x00);
  assert.equal(b.baud, 9600);
  assert.equal(b.frameCycles(), 960);
});

test('UART RX: REN gating, RI timing, wire overrun vs flow pacing', () => {
  // init ; SJMP $  (never reads SBUF)
  for (const pacing of ['wire', 'flow']) {
    const b = boardWith([...UART_INIT, 0x80, 0xFE], { rxPacing: pacing });
    b.run(20);
    b.serialInput('AB');
    const c0 = b.cycles;
    b.run(470);
    assert.equal(b.cpu.data[0x98] & 1, 0, 'RI not yet');
    b.run(c0 + 482 - b.cycles);
    assert.equal(b.cpu.data[0x98] & 1, 1, 'RI after one frame');
    assert.equal(b.cpu.readSfr(0x99), 0x41);
    b.run(2000);
    if (pacing === 'wire') {
      assert.equal(b.rxOverruns, 1, 'second byte lost while RI=1');
      assert.equal(b.rxPending, 0);
    } else {
      assert.equal(b.rxOverruns, 0);
      assert.equal(b.rxPending, 1, 'flow mode waits for RI=0');
      b.cpu.writeSfr(0x98, b.cpu.data[0x98] & ~1); // CLR RI
      b.run(500);
      assert.equal(b.cpu.readSfr(0x99), 0x42);
      assert.equal(b.rxPending, 0);
    }
  }
  // REN = 0: host bytes wait
  const b = boardWith([0x75, 0x98, 0x40, 0x75, 0x89, 0x20, 0x75, 0x8D, 0xFD, 0xD2, 0x8E, 0x80, 0xFE]);
  b.run(20);
  b.serialInput([1, 2, 3]);
  b.run(5000);
  assert.equal(b.cpu.data[0x98] & 1, 0);
  assert.equal(b.rxPending, 3);
});

test('UART stalls without a baud clock (TR1=0) and resumes when it starts', () => {
  const b = boardWith([0x75, 0x98, 0x50, 0x75, 0x89, 0x20, 0x75, 0x8D, 0xFD, 0x75, 0x99, 0x55, 0x80, 0xFE]);
  const tx = [];
  b.onTx = (c) => tx.push(c);
  b.run(5000);
  assert.equal(tx.length, 0);
  b.cpu.writeSfr(0x88, 0x40); // TR1
  b.run(2000);
  assert.deepEqual(tx, [0x55]);
});

test('ports: setPin/getPin, onPortWrite callback', () => {
  // MOV P1,#0F0h ; MOV A,P1 ; MOV P1,A ; SJMP $
  const b = boardWith([0x75, 0x90, 0xF0, 0xE5, 0x90, 0xF5, 0x90, 0x80, 0xFE]);
  const writes = [];
  b.onPortWrite = (p, v) => writes.push([p, v]);
  b.setPin('P1.4', 0);
  b.run(10);
  assert.deepEqual(writes, [[1, 0xF0], [1, 0xE0]]);
  assert.equal(b.getPin('P1.4'), 0);
  assert.equal(b.getPin('P1.7'), 1);
  assert.equal(b.portPins(1), 0xE0);
  assert.throws(() => b.setPin('P0.1', 0));
});

test('runFor keeps fractional cycles; run returns executed cycles', () => {
  const b = boardWith([0x80, 0xFE]);
  let total = 0;
  for (let i = 0; i < 1000; i++) total += b.runFor(1);
  assert.ok(b.cycles - 921600 >= 0 && b.cycles - 921600 <= 2, `cycles ${b.cycles}`);
  assert.equal(total, b.cycles);
});

test(`speed: at least 10x real time (${MC_PER_SEC * 10} machine cycles/s)`, () => {
  // Busy CRC-like loop mixing ALU, MOVX, bit ops and calls.
  const prog = [
    0x90, 0x00, 0x00,       // 0000 MOV DPTR,#0
    0x78, 0x40,             // 0003 MOV R0,#40h
    0xE0,                   // 0005 loop: MOVX A,@DPTR
    0x25, 0x30,             // ADD A,30h
    0x33,                   // RLC A
    0xF5, 0x30,             // MOV 30h,A
    0x64, 0x5A,             // XRL A,#5Ah
    0xF0,                   // MOVX @DPTR,A
    0xA3,                   // INC DPTR
    0xB2, 0x00,             // CPL 20h.0
    0x12, 0x00, 0x20,       // LCALL 0020h
    0xD8, 0xEF,             // DJNZ R0,loop
    0x80, 0xE8,             // SJMP 0003+...
  ];
  prog[prog.length - 1] = (0x03 - prog.length) & 0xFF;
  const code = new Array(0x30).fill(0);
  code.splice(0, prog.length, ...prog);
  code.splice(0x20, 3, 0xA4, 0x06, 0x22); // MUL AB ; INC @R0 ; RET
  const b = boardWith(code);
  b.run(1_000_000); // warm up
  const n = 30_000_000;
  const t0 = performance.now();
  b.run(n);
  const s = (performance.now() - t0) / 1000;
  const rate = n / s;
  console.log(`  emulation speed: ${(rate / 1e6).toFixed(1)}M machine cycles/s = ${(rate / MC_PER_SEC).toFixed(1)}x real time`);
  assert.ok(rate >= MC_PER_SEC * 10, `only ${(rate / 1e6).toFixed(2)}M cycles/s`);
});
