// End-to-end: C programs compiled with SDCC (--model-large) run on the Board;
// serial output is checked against values computed in JS and against ucsim.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Board } from '../emu/board.js';
import { findTool, sdccBuild, s51SerialRun } from '../emu/devtools.js';

const SDCC = findTool('sdcc');
const S51 = findTool('s51');
const skip = !SDCC && 'sdcc not installed (skipping SDCC end-to-end tests)';

const PRELUDE = `
#include <8051.h>
#include <stdio.h>
#include <stdint.h>
int putchar(int c) { while (!TI); TI = 0; SBUF = c; return c; }
void halt(void) { while (1); }
static void uart_init(void) {
  SCON = 0x50; TMOD = (TMOD & 0x0F) | 0x20; TH1 = 0xFD; TL1 = 0xFD; PCON |= 0x80; TR1 = 1; TI = 1;
}
static void puthex32(uint32_t v) { printf("%04x%04x", (unsigned)(v >> 16), (unsigned)(v & 0xFFFF)); }
static void finish(void) { while (!TI); halt(); }
`;

function runOnBoard(ihx, haltAddr, maxCycles = 100_000_000) {
  const b = new Board({ rom: ihx, seed: 42 });
  let out = '';
  b.onTx = (c) => { out += String.fromCharCode(c); };
  assert.ok(b.runUntilPC(haltAddr, maxCycles), 'program did not reach halt()');
  const haltCycles = b.cycles;
  b.run(2000); // let the last frame leave the UART (finish() waited for TI already)
  return { out, board: b, haltCycles };
}

function check(name, body, expected, { flags = [], s51 = true, cycles = true } = {}) {
  test(`sdcc: ${name}`, { skip }, () => {
    const { ihx, symbols, dir } = sdccBuild(PRELUDE + body, { name: name.replace(/\W+/g, '_'), flags });
    const halt = symbols._halt;
    assert.ok(halt !== undefined, 'no _halt symbol');
    const t0 = performance.now();
    const { out, board, haltCycles } = runOnBoard(ihx, halt);
    const ms = performance.now() - t0;
    const exp = typeof expected === 'function' ? expected() : expected;
    if (exp && typeof exp === 'object') assert.equal(out.slice(0, exp.prefix.length), exp.prefix);
    else if (exp !== null) assert.equal(out, exp);
    if (s51 && S51) {
      const ref = s51SerialRun(path.join(dir, fs.readdirSync(dir).find(f => f.endsWith('.ihx'))), halt);
      assert.equal(out, ref.serial, 'serial output differs from ucsim');
      // Instructions up to halt(): cycle counts must agree with ucsim (allowing
      // for the final SJMP-to-self iteration count difference).
      if (cycles) assert.equal(haltCycles, ref.cycles, 'cycles to halt() differ from ucsim');
    }
    const speed = board.cycles / (ms / 1000);
    if (process.env.EMU_VERBOSE) console.log(`  ${name}: ${board.cycles} cycles, ${(speed / 1e6).toFixed(1)}M cycles/s`);
  });
}

// ---- JS reference implementations ----------------------------------------

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const hex32 = (v) => (v >>> 0).toString(16).padStart(8, '0');

check('crc32', `
static uint32_t crc32(const uint8_t *p, unsigned n) {
  uint32_t c = 0xFFFFFFFFUL; unsigned k;
  while (n--) { c ^= *p++; for (k = 0; k < 8; k++) c = (c & 1) ? (c >> 1) ^ 0xEDB88320UL : c >> 1; }
  return ~c;
}
static uint8_t buf[1000];
void main(void) {
  unsigned i;
  uart_init();
  for (i = 0; i < sizeof buf; i++) buf[i] = (uint8_t)(i * 7 + (i >> 3));
  puthex32(crc32((const uint8_t *)"123456789", 9)); printf("\\r\\n");
  puthex32(crc32(buf, sizeof buf)); printf("\\r\\n");
  finish();
}`, () => {
  const buf = Array.from({ length: 1000 }, (_, i) => (i * 7 + (i >> 3)) & 0xFF);
  return hex32(crc32([...'123456789'].map(c => c.charCodeAt(0)))) + '\r\n' + hex32(crc32(buf)) + '\r\n';
});

check('quicksort', `
static int16_t a[300];
static uint32_t seed = 12345;
static int16_t rnd(void) { seed = seed * 1103515245UL + 12345UL; return (int16_t)(seed >> 16); }
static int stk[64];
static void qs(int16_t *v, int lo0, int hi0) {
  int sp = 0;
  stk[sp++] = lo0; stk[sp++] = hi0;
  while (sp) {
    int hi = stk[--sp], lo = stk[--sp];
    if (lo < hi) {
      int16_t p = v[(lo + hi) / 2]; int i = lo, j = hi;
      while (i <= j) {
        while (v[i] < p) i++;
        while (v[j] > p) j--;
        if (i <= j) { int16_t t = v[i]; v[i] = v[j]; v[j] = t; i++; j--; }
      }
      stk[sp++] = lo; stk[sp++] = j; stk[sp++] = i; stk[sp++] = hi;
    }
  }
}
void main(void) {
  int i; uint32_t sum = 0; uint8_t ok = 1;
  uart_init();
  for (i = 0; i < 300; i++) a[i] = rnd();
  qs(a, 0, 299);
  for (i = 0; i < 300; i++) { sum = sum * 31 + (uint16_t)a[i]; if (i && a[i - 1] > a[i]) ok = 0; }
  printf("%d %d %d ", ok, a[0], a[299]); puthex32(sum); printf("\\r\\n");
  finish();
}`, () => {
  let seed = 12345;
  const a = [];
  for (let i = 0; i < 300; i++) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; a.push(((seed >>> 16) << 16) >> 16); }
  a.sort((x, y) => x - y);
  let sum = 0;
  for (const v of a) sum = (Math.imul(sum, 31) + (v & 0xFFFF)) >>> 0;
  return `1 ${a[0]} ${a[299]} ${hex32(sum)}\r\n`;
});

const LONGS = [[123456789, 1000], [-987654321, 12345], [2147483647, -3], [-2147483647, 7], [99991, 99989], [0x7FFF1234, 0x10001]];
check('long arithmetic', `
static const int32_t xs[] = { ${LONGS.map(p => p[0] + 'L').join(', ')} };
static const int32_t ys[] = { ${LONGS.map(p => p[1] + 'L').join(', ')} };
void main(void) {
  unsigned char i;
  uart_init();
  for (i = 0; i < sizeof xs / sizeof xs[0]; i++) {
    int32_t x = xs[i], y = ys[i];
    printf("%ld %ld %ld %ld ", x * y, x / y, x % y, x - y);
    puthex32((uint32_t)x * (uint32_t)y); printf(" "); puthex32((uint32_t)x / (uint32_t)y); printf("\\r\\n");
  }
  finish();
}`, () => LONGS.map(([x, y]) => {
  const mul = Math.imul(x, y) | 0;
  const div = Math.trunc(x / y) | 0;
  const mod = (x % y) | 0;
  const sub = (x - y) | 0;
  const umul = Math.imul(x, y) >>> 0;
  const udiv = Math.floor((x >>> 0) / (y >>> 0)) >>> 0;
  return `${mul} ${div} ${mod} ${sub} ${hex32(umul)} ${hex32(udiv)}\r\n`;
}).join(''));

check('recursion stack-auto', `
static int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
static unsigned ack(unsigned m, unsigned n) { return m == 0 ? n + 1 : n == 0 ? ack(m - 1, 1) : ack(m - 1, ack(m, n - 1)); }
static long fact(int n) { return n <= 1 ? 1 : n * fact(n - 1); }
void main(void) {
  uart_init();
  printf("%d %u %ld\\r\\n", fib(10), ack(1, 4), fact(9));
  finish();
}`, '55 6 362880\r\n', { flags: ['--stack-auto'] });

function f32bits(x) { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, x); return b.getUint32(0); }
check('float math', `
#include <math.h>
static void pf(float f) { union { float f; uint32_t u; } x; x.f = f; puthex32(x.u); printf(" "); }
void main(void) {
  volatile float a = 3.25f, b = -0.1f, c = 1234567.0f;
  uart_init();
  pf(a + b); pf(a * b); pf(c / a); pf(a - c); pf((float)(long)(c * 3.0f)); pf(a * a * a);
  printf("%ld\\r\\n", (long)(c / 7.0f));
  pf(sqrtf(2.0f)); pf(sinf(0.5f)); pf(expf(1.0f));
  printf("\\r\\n");
  finish();
}`, () => {
  const F = Math.fround;
  const a = F(3.25), b = F(-0.1), c = F(1234567);
  const v = [F(a + b), F(a * b), F(c / a), F(a - c), F(Math.trunc(F(c * 3))), F(F(a * a) * a)];
  const line = v.map(x => hex32(f32bits(x)) + ' ').join('') + `${Math.trunc(F(c / F(7)))}\r\n`;
  // sqrtf/sinf/expf results are library-specific: only compared against ucsim.
  return { prefix: line };
}, {});

check('printf formats', `
void main(void) {
  uart_init();
  printf("[%5d|%-5d|%05u|%x|%X|%o|%c|%s|%8s|%lu]\\r\\n", -42, 42, 42u, 0xabcd, 0xabcd, 8, 'Z', "str", "pad", 4000000000UL);
  finish();
}`, '[  -42|42   |00042|abcd|ABCD|10|Z|str|     pad|4000000000]\r\n');

check('timer0 interrupt + idle', `
volatile unsigned ticks;
void t0_isr(void) __interrupt(1) { TH0 = 0xFC; TL0 = 0x66; ticks++; P1 ^= 1; }
void main(void) {
  unsigned char n;
  uart_init();
  TMOD = (TMOD & 0xF0) | 0x01; TH0 = 0xFC; TL0 = 0x66; ET0 = 1; EA = 1; TR0 = 1;
  for (n = 0; n < 50; n++) PCON |= 1;   /* idle until each interrupt */
  EA = 0;
  printf("ticks=%u P1=%02x\\r\\n", ticks, P1);
  finish();
}`, 'ticks=50 P1=ff\r\n', { s51: false }); // ucsim 0.8.2 does not implement PCON.IDL

// Interrupt entry timing differs from ucsim 0.8.2, which takes an interrupt
// right after a write to IE (silicon/datasheet: one more instruction first)
// and charges 1 cycle instead of 2 for the hardware LCALL. Output must match.
check('timer0 interrupt busy-wait', `
volatile unsigned ticks;
void t0_isr(void) __interrupt(1) { ticks++; }
void main(void) {
  uart_init();
  TMOD = (TMOD & 0xF0) | 0x02; TH0 = 256 - 200; TL0 = 256 - 200; ET0 = 1; EA = 1; TR0 = 1;
  while (ticks < 300);
  TR0 = 0; EA = 0;
  printf("t=%u\\r\\n", ticks);
  finish();
}`, 't=300\r\n', { cycles: false });

check('external int0 vs serial priority', `
volatile unsigned char log[8]; volatile unsigned char nlog;
void ex0_isr(void) __interrupt(0) { log[nlog++] = 'X'; }
void t1dummy(void) __interrupt(3) { }
void main(void) {
  uart_init();
  IT0 = 1; IE0 = 1; EX0 = 1;      /* pending edge interrupt */
  EA = 1;                         /* taken after the next instruction */
  log[nlog++] = 'm';
  EA = 0;
  printf("%c%c%u\\r\\n", log[0], log[1], nlog);
  finish();
}`, 'Xm2\r\n', { cycles: false });
