// Every 8051 instruction form, written so that the same line assembles with
// both the DOS/51 on-target assembler and sdas8051 (used as the reference).
// Numbers use the 0x prefix, which both accept; branch targets are labels.

const R = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'];
const RI = ['@R0', '@R1'];
const DIRS = ['0x00', '0x30', '0x7F', '0x81', '0xE0', '0xFF'];
const BITS = ['0x00', '0x2F', '0x7F', '0x88', '0xD7', '0xE7'];
const IMMS = ['#0x00', '#0x5A', '#0xFF'];

export function instructionLines() {
  const L = [];
  const add = (s) => L.push('        ' + s);
  // arithmetic / logic with A
  for (const m of ['ADD', 'ADDC', 'SUBB', 'ANL', 'ORL', 'XRL']) {
    for (const r of R) add(`${m} A, ${r}`);
    for (const d of DIRS) add(`${m} A, ${d}`);
    for (const r of RI) add(`${m} A, ${r}`);
    for (const i of IMMS) add(`${m} A, ${i}`);
  }
  for (const m of ['ANL', 'ORL', 'XRL']) {
    for (const d of DIRS) { add(`${m} ${d}, A`); add(`${m} ${d}, #0x3C`); }
  }
  for (const m of ['ANL', 'ORL']) for (const b of BITS) { add(`${m} C, ${b}`); add(`${m} C, /${b}`); }
  for (const m of ['CLR', 'CPL']) { add(`${m} A`); add(`${m} C`); for (const b of BITS) add(`${m} ${b}`); }
  for (const b of BITS) add(`SETB ${b}`);
  add('SETB C');
  for (const m of ['INC', 'DEC']) {
    add(`${m} A`);
    for (const r of R) add(`${m} ${r}`);
    for (const d of DIRS) add(`${m} ${d}`);
    for (const r of RI) add(`${m} ${r}`);
  }
  add('INC DPTR');
  for (const s of ['DA A', 'DIV AB', 'MUL AB', 'NOP', 'RET', 'RETI', 'RL A', 'RLC A', 'RR A', 'RRC A', 'SWAP A',
    'JMP @A+DPTR', 'MOVC A, @A+DPTR', 'MOVC A, @A+PC', 'MOVX A, @DPTR', 'MOVX @DPTR, A']) add(s);
  for (const r of RI) { add(`MOVX A, ${r}`); add(`MOVX ${r}, A`); add(`XCHD A, ${r}`); }
  for (const r of R) add(`XCH A, ${r}`);
  for (const d of DIRS) add(`XCH A, ${d}`);
  for (const r of RI) add(`XCH A, ${r}`);
  for (const d of DIRS) { add(`PUSH ${d}`); add(`POP ${d}`); }
  // MOV
  for (const r of R) { add(`MOV A, ${r}`); add(`MOV ${r}, A`); add(`MOV ${r}, #0x42`); add(`MOV ${r}, 0x55`); add(`MOV 0x66, ${r}`); }
  for (const d of DIRS) { add(`MOV A, ${d}`); add(`MOV ${d}, A`); add(`MOV ${d}, #0x99`); add(`MOV ${d}, 0x44`); add(`MOV 0x45, ${d}`); }
  for (const r of RI) { add(`MOV A, ${r}`); add(`MOV ${r}, A`); add(`MOV ${r}, #0x11`); add(`MOV ${r}, 0x22`); add(`MOV 0x23, ${r}`); }
  for (const i of IMMS) add(`MOV A, ${i}`);
  for (const b of BITS) { add(`MOV C, ${b}`); add(`MOV ${b}, C`); }
  for (const v of ['0x0000', '0x1234', '0xFFFF']) add(`MOV DPTR, #${v}`);
  // branches: each one jumps to itself and to the next line
  let n = 0;
  const br = (pre) => { n++; L.push(`b${n}:`); add(`${pre}b${n}`); add(`${pre}f${n}`); L.push(`f${n}:`); };
  for (const m of ['SJMP', 'JC', 'JNC', 'JZ', 'JNZ', 'AJMP', 'ACALL', 'LJMP', 'LCALL']) br(`${m} `);
  for (const b of BITS) for (const m of ['JB', 'JNB', 'JBC']) br(`${m} ${b}, `);
  for (const r of R) br(`DJNZ ${r}, `);
  for (const d of DIRS) br(`DJNZ ${d}, `);
  br('CJNE A, 0x30, '); br('CJNE A, #0x7E, ');
  for (const r of R) br(`CJNE ${r}, #0x10, `);
  for (const r of RI) br(`CJNE ${r}, #0xEE, `);
  add('LJMP 0x1234'); add('LCALL 0x7F03'); add('AJMP 0x8123'); add('ACALL 0x87FF');
  return L;
}

export function dosSource(lines) {
  return ['        ORG     8000h', ...lines, '        END', ''].join('\n');
}

export function sdasSource(lines) {
  return ['        .area   CODE (ABS)', '        .org    0x8000', ...lines, ''].join('\n');
}
