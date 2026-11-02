#!/usr/bin/env node
// DOS/51 board emulator CLI: serial console on the terminal (or TCP), real time.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Board, MC_PER_SEC } from '../emu/board.js';
import { XmodemSender, XmodemReceiver, stripPadding } from '../emu/xmodem.js';
import { SDCard } from '../emu/sdcard.js';
import { formatCard } from '../emu/fatfmt.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = `usage: dos51 [--rom file.ihx|file.bin] [--baud-pacing wire|flow] [--tcp PORT]
             [--state file.json] [--seed N]
             [--sd card.img [--sd-size MiB] [--sd-fat 16|32] [--sdsc]]

Console: keystrokes go to the emulated serial port. Ctrl-] opens a command prompt:
  u <hostfile>   XMODEM-send hostfile to the board (start the DOS receive command first)
  d <hostfile>   XMODEM-receive from the board into hostfile (keep padding: d! <file>)
  r              reset            p   power cycle (RAM randomised)
  x              toggle flow pacing (for pasting)            q   quit
--tcp PORT serves the serial port on TCP (one client); commands are then read
as lines from stdin. Connect a pty with:
  socat pty,link=/tmp/ttyDOS51,raw,echo=0 tcp:localhost:PORT
--state FILE keeps RAM0/RAM1 across runs (battery-backed SRAM).
--sd FILE attaches an SD card image on P1.4-P1.7 (written through to FILE).
A missing FILE is created blank: FAT16 (or --sd-fat 32) in one MBR partition,
--sd-size MiB (default 32; FAT32 needs at least 33). --sdsc emulates a
byte-addressed standard capacity card instead of SDHC.`;

function parseArgs(argv) {
  const o = { rom: path.join(ROOT, 'firmware/build/dos51.ihx'), pacing: 'wire', tcp: null, state: null, seed: undefined,
    sd: null, sdSize: 32, sdFat: 16, sdsc: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) die(`missing value for ${a}`); return argv[++i]; };
    if (a === '--rom') o.rom = val();
    else if (a === '--baud-pacing') o.pacing = val();
    else if (a === '--tcp') o.tcp = Number(val());
    else if (a === '--state') o.state = val();
    else if (a === '--seed') o.seed = Number(val());
    else if (a === '--sd') o.sd = val();
    else if (a === '--sd-size') o.sdSize = Number(val());
    else if (a === '--sd-fat') o.sdFat = Number(val());
    else if (a === '--sdsc') o.sdsc = true;
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else die(`unknown argument ${a}\n${USAGE}`);
  }
  if (!['wire', 'flow'].includes(o.pacing)) die('--baud-pacing must be wire or flow');
  if (![16, 32].includes(o.sdFat)) die('--sd-fat must be 16 or 32');
  if (!(o.sdSize >= 4 && o.sdSize <= 1024)) die('--sd-size must be 4..1024 MiB');
  return o;
}

function die(msg) { process.stderr.write(`dos51: ${msg}\n`); process.exit(2); }
function note(msg) { process.stderr.write(`\r\n[dos51] ${msg}\r\n`); }

const opts = parseArgs(process.argv.slice(2));
if (!fs.existsSync(opts.rom)) die(`ROM not found: ${opts.rom} (build the firmware or pass --rom)`);
const romData = /\.(ihx|hex)$/i.test(opts.rom) ? fs.readFileSync(opts.rom, 'latin1') : new Uint8Array(fs.readFileSync(opts.rom));

const board = new Board({ rom: romData, seed: opts.seed, rxPacing: opts.pacing });
if (opts.state && fs.existsSync(opts.state)) {
  try { board.setState(JSON.parse(fs.readFileSync(opts.state, 'utf8'))); board.reset(); note(`RAM restored from ${opts.state}`); }
  catch (e) { note(`could not restore state: ${e.message}`); }
}

// ---- SD card image (whole file in memory, written through sector by sector)
if (opts.sd) {
  let image;
  if (!fs.existsSync(opts.sd)) {
    try { image = formatCard(opts.sdSize * 1024 * 1024, { fat: opts.sdFat }); }
    catch (e) { die(`cannot format ${opts.sd}: ${e.message}`); }
    fs.writeFileSync(opts.sd, image);
    note(`created ${opts.sd}: blank ${opts.sdSize} MiB FAT${opts.sdFat} card image`);
  } else {
    const st = fs.statSync(opts.sd);
    if (st.size % 512 || st.size === 0) die(`${opts.sd}: size must be a non-zero multiple of 512`);
    if (st.size > 1024 * 1024 * 1024) die(`${opts.sd}: images above 1 GiB are not supported`);
    image = new Uint8Array(fs.readFileSync(opts.sd));
  }
  const fd = fs.openSync(opts.sd, 'r+');
  new SDCard({ image, sdhc: !opts.sdsc, onWrite: (off, len) => fs.writeSync(fd, image, off, len, off) }).attach(board);
  note(`SD card ${opts.sd} (${image.length >> 20} MiB, ${opts.sdsc ? 'SDSC' : 'SDHC'}) on P1.4-P1.7`);
}

// ---- serial output routing ------------------------------------------------
let outBuf = [];
let transfer = null; // { sm, kind, file, strip }
let client = null;   // TCP socket
board.onTx = (b) => { if (transfer) transfer.sm.feed(b); else outBuf.push(b); };

function flushOutput() {
  if (!outBuf.length) return;
  if (opts.tcp && !client) { // keep the last 64K for the next client
    if (outBuf.length > 65536) outBuf = outBuf.slice(-65536);
    return;
  }
  const chunk = Buffer.from(outBuf);
  outBuf = [];
  if (opts.tcp) client.write(chunk);
  else process.stdout.write(chunk);
}

// ---- real-time loop ---------------------------------------------------------
let last = performance.now();
const timer = setInterval(() => {
  const now = performance.now();
  const ms = Math.min(now - last, 100); // catch up at most 100 ms
  last = now;
  board.runFor(ms);
  if (transfer) transfer.sm.tick(ms);
  flushOutput();
}, 5);

// ---- commands -------------------------------------------------------------
function startTransfer(kind, file, strip = true) {
  if (transfer) return note('transfer already running');
  const send = (bytes) => board.serialInput(bytes);
  const prevPacing = board.rxPacing;
  board.rxPacing = 'wire';
  const finish = (msg) => { board.rxPacing = prevPacing; transfer = null; note(msg); };
  if (kind === 'u') {
    let data;
    try { data = new Uint8Array(fs.readFileSync(file)); } catch (e) { board.rxPacing = prevPacing; return note(e.message); }
    const sm = new XmodemSender(data, {
      send,
      onProgress: (n, t) => process.stderr.write(`\r[dos51] sent ${n}/${t} bytes`),
      onDone: () => finish(`upload of ${file} complete (${data.length} bytes)`),
      onError: (e) => finish(`upload failed: ${e}`),
    });
    transfer = { sm, kind };
    note(`XMODEM send ${file} (${data.length} bytes): waiting for receiver... (Ctrl-X twice cancels)`);
  } else {
    const sm = new XmodemReceiver({
      send,
      onProgress: (n) => process.stderr.write(`\r[dos51] received ${n} bytes`),
      onDone: (d) => {
        const out = strip ? stripPadding(d) : d;
        try { fs.writeFileSync(file, out); finish(`download complete: ${file} (${out.length} bytes)`); }
        catch (e) { finish(`write failed: ${e.message}`); }
      },
      onError: (e) => finish(`download failed: ${e}`),
    });
    transfer = { sm, kind };
    note(`XMODEM receive into ${file}... (Ctrl-X twice cancels)`);
    sm.start();
  }
}

function runCommand(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd) {
    case undefined: case '': break;
    case 'u': if (!arg) note('usage: u <hostfile>'); else startTransfer('u', arg); break;
    case 'd': case 'd!': if (!arg) note('usage: d <hostfile>'); else startTransfer('d', arg, cmd === 'd'); break;
    case 'r': board.reset(); note('reset'); break;
    case 'p': board.powerCycle(); note('power cycle'); break;
    case 'x': board.rxPacing = board.rxPacing === 'flow' ? 'wire' : 'flow'; note(`rx pacing: ${board.rxPacing}`); break;
    case 'q': quit(); break;
    default: note(`unknown command '${cmd}' (u d r p x q)`);
  }
}

let quitting = false;
function quit(code = 0) {
  if (quitting) return;
  quitting = true;
  clearInterval(timer);
  flushOutput();
  if (opts.state) {
    try { fs.writeFileSync(opts.state, JSON.stringify(board.getState())); note(`RAM saved to ${opts.state}`); }
    catch (e) { note(`could not save state: ${e.message}`); }
  }
  if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
  process.exit(code);
}
process.on('SIGTERM', () => quit());
process.on('SIGINT', () => quit());
process.on('SIGHUP', () => quit());

// ---- input ------------------------------------------------------------------
let cmdLine = null; // non-null while the Ctrl-] prompt is open
let cancelCount = 0;

function onKeys(buf) {
  for (const b of buf) {
    if (cmdLine !== null) {
      if (b === 0x0D || b === 0x0A) { const l = cmdLine; cmdLine = null; process.stderr.write('\r\n'); runCommand(l); }
      else if (b === 0x1B || b === 0x03) { cmdLine = null; process.stderr.write(' (cancelled)\r\n'); }
      else if (b === 0x7F || b === 0x08) { if (cmdLine.length) { cmdLine = cmdLine.slice(0, -1); process.stderr.write('\b \b'); } }
      else if (b >= 0x20) { cmdLine += String.fromCharCode(b); process.stderr.write(String.fromCharCode(b)); }
      continue;
    }
    if (b === 0x1D) { cmdLine = ''; process.stderr.write('\r\n[dos51] command (u/d file, r, p, x, q)> '); continue; }
    if (transfer) {
      if (b === 0x18 && ++cancelCount >= 2) { cancelCount = 0; transfer.sm.cancel(); }
      continue; // keystrokes do not reach the board during a transfer
    }
    cancelCount = 0;
    board.serialInput([b]);
  }
}

if (opts.tcp) {
  const server = net.createServer((sock) => {
    if (client) { sock.end('busy\r\n'); return; }
    client = sock;
    sock.setNoDelay(true);
    note(`client connected from ${sock.remoteAddress}`);
    sock.on('data', (d) => { if (!transfer) board.serialInput(d); });
    sock.on('close', () => { client = null; note('client disconnected'); });
    sock.on('error', () => {});
  });
  server.listen(opts.tcp, '127.0.0.1', () => note(`serial port on tcp://127.0.0.1:${opts.tcp}; commands on stdin (u/d file, r, p, x, q)`));
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', runCommand);
  rl.on('close', () => { if (!process.stdin.isTTY) { /* keep serving when stdin is closed */ } });
} else {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('data', onKeys);
  // Piped input: once it is consumed and delivered, run 1 s more, then exit.
  process.stdin.on('end', () => {
    let idle = 0;
    setInterval(() => { idle = board.rxPending || transfer ? 0 : idle + 100; if (idle >= 1000) quit(); }, 100);
  });
  note(`ROM ${path.relative(process.cwd(), opts.rom) || opts.rom}; Ctrl-] for commands`);
}
void MC_PER_SEC;
