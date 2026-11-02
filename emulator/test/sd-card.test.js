// SPI-mode SD card model (emu/sdcard.js): protocol state machine, byte level
// and pin level.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SDCard, cmdFrame, crc7, crc16 } from '../emu/sdcard.js';
import { Board } from '../emu/board.js';

// Send a command frame and return the first non-FF byte (R1) plus `extra`
// following bytes.
function command(card, idx, arg, { extra = 0, frame = cmdFrame(idx, arg) } = {}) {
  card.xfer(0xFF);
  for (const b of frame) card.xfer(b);
  let r1 = 0xFF;
  for (let i = 0; i < 9 && r1 === 0xFF; i++) r1 = card.xfer(0xFF);
  const rest = [];
  for (let i = 0; i < extra; i++) rest.push(card.xfer(0xFF));
  return { r1, rest };
}

function init(card, { hcs = true } = {}) {
  assert.equal(command(card, 0, 0).r1, 0x01);
  const r7 = command(card, 8, 0x1AA, { extra: 4 });
  let polls = 0, r1;
  do {
    command(card, 55, 0);
    r1 = command(card, 41, hcs ? 0x40000000 : 0).r1;
    polls++;
  } while (r1 === 0x01 && polls < 50);
  const ocr = command(card, 58, 0, { extra: 4 });
  return { r7, r1, polls, ocr };
}

function readBlock(card, arg) {
  const { r1 } = command(card, 17, arg);
  if (r1 !== 0) return { r1 };
  let t;
  for (let i = 0; i < 100 && (t = card.xfer(0xFF)) === 0xFF; i++);
  const data = Uint8Array.from({ length: 512 }, () => card.xfer(0xFF));
  const crc = (card.xfer(0xFF) << 8) | card.xfer(0xFF);
  return { r1, token: t, data, crc };
}

function writeBlock(card, arg, data, crc = 0xFFFF) {
  const { r1 } = command(card, 24, arg);
  if (r1 !== 0) return { r1 };
  card.xfer(0xFF);
  card.xfer(0xFE);
  for (const b of data) card.xfer(b);
  card.xfer(crc >> 8); card.xfer(crc & 0xFF);
  const resp = card.xfer(0xFF);
  let busy = 0;
  while (card.xfer(0xFF) === 0x00) busy++;
  return { r1, resp, busy };
}

test('CRC7 and CRC16 match the SD specification examples', () => {
  assert.deepEqual(cmdFrame(0, 0), [0x40, 0, 0, 0, 0, 0x95]);
  assert.deepEqual(cmdFrame(8, 0x1AA), [0x48, 0, 0, 1, 0xAA, 0x87]);
  assert.equal(crc7([0x51, 0, 0, 0, 0]), 0x2A);             // CMD17 arg 0 -> 55h
  assert.equal(crc16(new Uint8Array(512).fill(0xFF)), 0x7FA1);
});

test('SDHC: CMD0, CMD8 (R7), ACMD41 with HCS, CMD58 CCS, block addressed read/write', () => {
  const image = new Uint8Array(1 << 20);
  const writes = [];
  const card = new SDCard({ image, sdhc: true, readyAfter: 3, onWrite: (o, l) => writes.push([o, l]) });
  card.select();
  const r = init(card);
  assert.deepEqual(r.r7.rest, [0, 0, 1, 0xAA]);              // voltage + check pattern echoed
  assert.equal(r.r7.r1, 0x01);
  assert.equal(r.r1, 0x00);
  assert.equal(r.polls, 3);
  assert.equal(r.ocr.r1, 0x00);
  assert.equal(r.ocr.rest[0] & 0xC0, 0xC0);                  // powered up, CCS = 1
  const data = Uint8Array.from({ length: 512 }, (_, i) => (i * 7 + 3) & 0xFF);
  const w = writeBlock(card, 5, data);
  assert.equal(w.resp & 0x1F, 0x05);                          // data accepted
  assert.ok(w.busy >= 1, 'busy after the write');
  assert.deepEqual(writes, [[5 * 512, 512]]);
  assert.deepEqual(image.subarray(2560, 3072), data);
  const rd = readBlock(card, 5);
  assert.equal(rd.token, 0xFE);
  assert.deepEqual(rd.data, data);
  assert.equal(rd.crc, crc16(data));
  assert.equal(command(card, 17, 2048).r1, 0x40);             // beyond the end: parameter error
});

test('SDSC: CCS = 0, CMD16, byte addresses; misaligned access is refused', () => {
  const image = new Uint8Array(1 << 20);
  image[1024] = 0xA5;
  const card = new SDCard({ image, sdhc: false });
  card.select();
  const r = init(card);
  assert.equal(r.ocr.rest[0] & 0xC0, 0x80);                  // powered up, CCS = 0
  assert.equal(command(card, 16, 512).r1, 0x00);
  assert.equal(readBlock(card, 1024).data[0], 0xA5);          // byte address of sector 2
  assert.equal(command(card, 17, 1000).r1, 0x20);             // address error
  assert.equal(command(card, 16, 4096).r1, 0x40);
});

test('version 1 card rejects CMD8; SDHC without HCS never leaves idle', () => {
  const v1 = new SDCard({ image: new Uint8Array(65536), sdhc: false, version: 1 });
  v1.select();
  assert.equal(command(v1, 0, 0).r1, 0x01);
  assert.equal(command(v1, 8, 0x1AA).r1, 0x05);               // idle + illegal command
  const hc = new SDCard({ image: new Uint8Array(65536) });
  hc.select();
  const r = init(hc, { hcs: false });
  assert.equal(r.r1, 0x01);
  assert.equal(command(hc, 17, 0).r1, 0x05);                  // still idle: illegal
});

test('a CMD0 with a bad CRC is rejected; CMD8 CRC is always checked', () => {
  const card = new SDCard({ image: new Uint8Array(65536) });
  card.select();
  const bad = [0x40, 0, 0, 0, 0, 0x01];
  assert.equal(command(card, 0, 0, { frame: bad }).r1, 0xFF); // native mode: no answer
  assert.equal(card.stats.crcErrors, 1);
  assert.equal(command(card, 0, 0).r1, 0x01);                 // a good CMD0 enters SPI mode
  assert.equal(command(card, 0, 0, { frame: bad }).r1 & 0x08, 0x08); // R1 CRC error bit
  assert.equal(command(card, 8, 0x1AA, { frame: [0x48, 0, 0, 1, 0xAA, 0x01] }).r1, 0x09);
  // other commands ignore the CRC until CMD59 turns checking on
  assert.equal(command(card, 55, 0, { frame: [0x77, 0, 0, 0, 0, 0x01] }).r1, 0x01);
});

test('CMD59 CRC on: a data block with a bad CRC16 is rejected', () => {
  const image = new Uint8Array(65536);
  const card = new SDCard({ image });
  card.select();
  init(card);
  assert.equal(command(card, 59, 1).r1, 0x00);
  const data = new Uint8Array(512).fill(0x5A);
  assert.equal(writeBlock(card, 1, data, 0x1234).resp & 0x1F, 0x0B);
  assert.equal(image[512], 0);
  assert.equal(writeBlock(card, 1, data, crc16(data)).resp & 0x1F, 0x05);
  assert.equal(image[512], 0x5A);
});

test('pin level: SPI mode 0 on P1.4-P1.7 of the board', () => {
  const board = new Board({ seed: 1 });
  const card = new SDCard({ image: new Uint8Array(65536) }).attach(board);
  const cpu = board.cpu;
  const P1 = 0x90;
  const set = (v) => cpu.writeSfr(P1, v);
  // exchange one byte: MOSI before the rising edge, read MISO while SCK is high
  const xfer = (b) => {
    let r = 0;
    for (let i = 7; i >= 0; i--) {
      const mosi = (b >> i) & 1;
      set(0x8F | (mosi << 6));            // /CS low, SCK low, MISO latch high
      set(0xAF | (mosi << 6));            // SCK high
      r = (r << 1) | ((cpu.readSfr(P1) >> 7) & 1);
    }
    set(0xCF);
    return r;
  };
  set(0xDF);                                // idle: /CS high, SCK low
  assert.equal((cpu.readSfr(P1) >> 7) & 1, 1, 'MISO released while deselected');
  for (const b of cmdFrame(0, 0)) xfer(b);
  let r1 = 0xFF;
  for (let i = 0; i < 8 && r1 === 0xFF; i++) r1 = xfer(0xFF);
  assert.equal(r1, 0x01);
  assert.equal(card.spi, true);
  set(0xDF);
  assert.equal((cpu.readSfr(P1) >> 7) & 1, 1);
  board.powerCycle();                        // the card loses power too
  assert.equal(card.spi, false);
});
