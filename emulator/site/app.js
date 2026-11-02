// DOS/51 browser front end: real ROM on the shared emulator core, xterm.js as the VT100.
import { Board } from './emu/board.js';
import { SDCard } from './emu/sdcard.js';
import { formatCard } from './emu/fatfmt.js';

const STATE_KEY = 'dos51.ram.v1';
const $ = (id) => document.getElementById(id);
const status = (s) => { $('status').textContent = s; };

const narrow = window.matchMedia('(max-width: 700px)').matches;
const term = new Terminal({
  cols: 80, rows: 24,
  fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
  fontSize: narrow ? 9 : 14,
  cursorBlink: true,
  convertEol: false,
  scrollback: 2000,
  theme: { background: '#0b0f0b', foreground: '#7cfc7c', cursor: '#7cfc7c', selectionBackground: '#2f5f2f' },
});
term.open($('term'));

const rom = await fetch('dos51.ihx').then((r) => {
  if (!r.ok) throw new Error(`ROM fetch failed: ${r.status}`);
  return r.text();
});

const board = new Board({ rom, rxPacing: 'flow' });
let restored = false;
try {
  const saved = localStorage.getItem(STATE_KEY);
  if (saved) { board.setState(JSON.parse(saved)); board.reset(); restored = true; }
} catch { /* corrupt or unavailable storage: cold boot */ }

// ---- virtual SD card on P1.4-P1.7, kept in IndexedDB in 64 KiB chunks
// (only chunks that were ever written are stored, so a blank card is small)
const CARD_MB = 16;
const CHUNK = 65536;
const cardDb = await new Promise((resolve) => {
  try {
    const rq = indexedDB.open('dos51.sdcard', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('card');
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => resolve(null);
  } catch { resolve(null); }
});
const idb = (mode, fn) => new Promise((resolve, reject) => {
  const tx = cardDb.transaction('card', mode);
  const r = fn(tx.objectStore('card'));
  tx.oncomplete = () => resolve(r && r.result);
  tx.onerror = tx.onabort = () => reject(tx.error);
});
let card = null;
let dirty = new Set();
let saveTimer = 0;
async function saveCard() {
  clearTimeout(saveTimer);
  if (!cardDb || !card || !dirty.size) return;
  const chunks = [...dirty];
  dirty = new Set();
  const img = card.image;
  try {
    await idb('readwrite', (st) => {
      st.put({ size: img.length }, 'meta');
      for (const c of chunks) st.put(img.slice(c * CHUNK, (c + 1) * CHUNK), c);
    });
  } catch { for (const c of chunks) dirty.add(c); }
}
function insertCard(image, { save = 'all' } = {}) {
  card = new SDCard({
    image,
    onWrite: (off, len) => {
      for (let c = Math.floor(off / CHUNK); c <= Math.floor((off + len - 1) / CHUNK); c++) dirty.add(c);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveCard, 1000);
    },
  }).attach(board);
  if (save === 'all') {
    dirty = new Set();
    for (let c = 0; c * CHUNK < image.length; c++) {
      const part = image.subarray(c * CHUNK, (c + 1) * CHUNK);
      if (part.some((b) => b)) dirty.add(c);
    }
    if (cardDb) idb('readwrite', (st) => st.clear()).then(saveCard, () => {});
  }
}
async function loadCard() {
  if (cardDb) {
    try {
      const meta = await idb('readonly', (st) => st.get('meta'));
      if (meta && meta.size > 0 && meta.size % 512 === 0) {
        const image = new Uint8Array(meta.size);
        await new Promise((resolve, reject) => {
          const tx = cardDb.transaction('card', 'readonly');
          const rq = tx.objectStore('card').openCursor();
          rq.onsuccess = () => {
            const cur = rq.result;
            if (!cur) return;
            if (typeof cur.key === 'number' && cur.value instanceof Uint8Array) image.set(cur.value.subarray(0, Math.max(0, image.length - cur.key * CHUNK)), cur.key * CHUNK);
            cur.continue();
          };
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
        insertCard(image, { save: 'none' });
        return true;
      }
    } catch { /* unreadable: start with a blank card */ }
  }
  insertCard(formatCard(CARD_MB << 20));
  return false;
}
const cardRestored = await loadCard();

let out = [];
board.onTx = (b) => out.push(b);
const flush = () => {
  if (!out.length) return;
  term.write(new Uint8Array(out));
  out = [];
};

const send = (s) => board.serialInput(s);
term.onData((d) => send(d));
term.onBinary((d) => send(Uint8Array.from(d, (c) => c.charCodeAt(0) & 0xff)));

// ---- real-time loop: catch up at most 100 ms (background tabs get throttled)
let last = performance.now();
function tick() {
  const now = performance.now();
  board.runFor(Math.min(now - last, 100));
  last = now;
  flush();
}
setInterval(tick, 8);

// ---- persistence of both RAM chips (battery-backed SRAM, in effect)
const save = () => { try { localStorage.setItem(STATE_KEY, JSON.stringify(board.getState())); } catch { /* quota */ } };
setInterval(save, 5000);
addEventListener('pagehide', () => { save(); saveCard(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { save(); saveCard(); } });

// ---- controls
$('reset').onclick = () => { board.clearSerialInput(); board.reset(); term.focus(); };
$('power').onclick = () => {
  if (!confirm('Power-cycle the board? RAM and every file on the RAM disk will be lost.')) return;
  board.clearSerialInput();
  board.powerCycle();
  try { localStorage.removeItem(STATE_KEY); } catch { /* ignore */ }
  term.reset();
  term.focus();
};
for (const b of document.querySelectorAll('.keys button')) {
  const seq = b.dataset.k.replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace('\\t', '\t');
  b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the terminal focused on phones
  b.onclick = () => { send(seq); term.focus(); };
}

// Upload a text file through the shell's `paste` command (local only, no network).
$('upload').onclick = () => $('file').click();
$('file').onchange = async () => {
  const f = $('file').files[0];
  $('file').value = '';
  if (!f) return;
  if (f.size > 20000) { alert('Files must be under 20,000 bytes: the RAM disk is 24 KiB in total.'); return; }
  let name = f.name.replace(/[^A-Za-z0-9._-]/g, '').toLowerCase();
  const dot = name.lastIndexOf('.');
  if (name.length > 11) name = dot > 0 ? name.slice(0, Math.max(1, 11 - (name.length - dot))) + name.slice(dot) : name.slice(0, 11);
  name = prompt('Name on the RAM disk (max 11 characters):', name.slice(0, 11));
  if (!name) return;
  if (name.length > 11 || /\s/.test(name)) { alert('Use at most 11 characters and no spaces.'); return; }
  const text = (await f.text()).replace(/\r\n?/g, '\n');
  if (/[^\x09\x0a\x20-\x7e]/.test(text)) { alert('Only plain ASCII text files can be uploaded.'); return; }
  send(`\x03\rpaste ${name}\r`);
  send(text.replace(/\n/g, '\r') + (text.endsWith('\n') || !text ? '' : '\r') + '\x04');
  term.focus();
};

// ---- SD card controls (File API only: nothing leaves the browser)
$('carddl').onclick = async () => {
  await saveCard();
  const url = URL.createObjectURL(new Blob([card.image], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'dos51-sdcard.img';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  term.focus();
};
$('cardin').onclick = () => $('cardfile').click();
$('cardfile').onchange = async () => {
  const f = $('cardfile').files[0];
  $('cardfile').value = '';
  if (!f) return;
  if (f.size === 0 || f.size % 512 || f.size > 256 * 1024 * 1024) {
    alert('Card images must be a multiple of 512 bytes and at most 256 MiB.');
    return;
  }
  if (!confirm(`Replace the virtual SD card with ${f.name} (${(f.size / 1048576).toFixed(1)} MiB)? The current card's contents are discarded; download it first to keep them.`)) return;
  insertCard(new Uint8Array(await f.arrayBuffer()));
  term.write(`\r\n\x1b[2m[SD card replaced by ${f.name.replace(/[\x00-\x1f]/g, '')}]\x1b[0m\r\n`);
  term.focus();
};
$('cardnew').onclick = () => {
  if (!confirm(`Insert a blank ${CARD_MB} MiB FAT16 card? Every file on the current virtual card is lost.`)) return;
  insertCard(formatCard(CARD_MB << 20));
  term.write(`\r\n\x1b[2m[Blank ${CARD_MB} MiB SD card inserted – empty until you sdput]\x1b[0m\r\n`);
  term.focus();
};

// Status line: emulated speed relative to the real 11.0592 MHz board.
let c0 = board.cycles, t0 = performance.now();
setInterval(() => {
  const c = board.cycles, t = performance.now();
  const pct = ((c - c0) / ((t - t0) / 1000) / Board.MC_PER_SEC) * 100;
  c0 = c; t0 = t;
  status(`${board.baud} baud · ${pct.toFixed(0)}% speed${board.rxPending ? ` · ${board.rxPending} B queued` : ''}`);
}, 1000);

if (restored) term.write(`\x1b[2m[RAM ${cardRestored ? 'and SD card ' : ''}restored from this browser – press Enter]\x1b[0m\r\n`);
term.focus();
