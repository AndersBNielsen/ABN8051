// Browser smoke test for the static site: node scripts/smoke-site.mjs URL [screenshot.png]
// Needs playwright resolvable (e.g. NODE_PATH pointing at a node_modules with it).
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatCard } from '../emu/fatfmt.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dos51-smoke-'));
const fatimg = (...a) => execFileSync('python3', [path.join(ROOT, 'scripts/fatimg.py'), ...a], { encoding: 'latin1' });

const url = process.argv[2];
const shot = process.argv[3];
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROME || undefined });
const errors = [];
const requests = [];

async function run(viewport, label) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label}: ${m.text()}`); });
  page.on('request', (r) => requests.push(r.url()));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${label}: HTTP ${r.status()} ${r.url()}`); });
  page.on('dialog', (d) => d.accept());
  await page.goto(url);
  const screen = () => page.evaluate(() => {
    const b = window.__term ? null : document.querySelector('.xterm-rows');
    return b ? b.innerText : '';
  });
  const waitFor = async (re, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const t = await screen(); if (re.test(t)) return t; await page.waitForTimeout(200); }
    throw new Error(`${label}: timed out waiting for ${re}\n${await screen()}`);
  };
  await waitFor(/dos51\$/);
  await page.locator('#term').click();
  await page.keyboard.type('asm -r hello.asm\r', { delay: 20 });
  await waitFor(/0 error\(s\)[\s\S]*dos51\$\s*$/m);
  await page.keyboard.type('echo hi > t.txt\r', { delay: 20 });
  await page.keyboard.type('ls\r', { delay: 20 });
  await waitFor(/t\.txt/);
  // Editor + on-screen Ctrl-X key
  await page.keyboard.type('nano t.txt\r', { delay: 20 });
  await waitFor(/\^X/);
  await page.locator('.keys button', { hasText: '^X' }).click();
  await waitFor(/dos51\$\s*$/m);
  const type = (s) => page.keyboard.type(s, { delay: 20 });
  if (label === 'desktop') {
    // SD card: copy a file to the card and back
    await type('clear\recho sd card test > sd.txt\rsdput sd.txt\rsdls\r');
    await waitFor(/sd\.txt +13[\s\S]*dos51\$\s*$/m);
    await type('rm sd.txt\rsdget sd.txt\rcat sd.txt\r');
    await waitFor(/cat sd\.txt\s+sd card test\s+dos51\$\s*$/m);
    await type('rm sd.txt\r');                      // from now on only the card has it
    // the downloaded card image is a valid FAT volume holding the file
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#carddl')]);
    const img = path.join(tmp, 'card.img');
    await dl.saveAs(img);
    const check = fatimg(img, 'check');
    if (!/ok$/m.test(check)) errors.push(`${label}: downloaded card: ${check}`);
    if (fatimg(img, 'get', 'SD.TXT') !== 'sd card test\n') errors.push(`${label}: SD.TXT not in the downloaded card`);
    await page.locator('#term').click();
  }
  // RAM persists across reload
  await page.waitForTimeout(1500);
  await page.evaluate(() => dispatchEvent(new Event('pagehide')));
  await page.reload();
  await waitFor(/RAM (and SD card )?restored/);
  await page.locator('#term').click();
  await page.keyboard.type('ls\r', { delay: 20 });
  await waitFor(/t\.txt[\s\S]*dos51\$\s*$/m);
  if (label === 'desktop') {
    // ... and so does the SD card (IndexedDB)
    await type('sdget sd.txt\rcat sd.txt\r');
    await waitFor(/cat sd\.txt\s+sd card test\s+dos51\$\s*$/m);
    // The separate SD-card game must assemble and run in the real browser.
    await type('sdget dropblk.asm\r');
    await waitFor(/dos51\$\s*$/m);
    await type('asm -r dropblk.asm\r');
    await waitFor(/Press a key/);
    await type('g');
    await waitFor(/\[\]/);
    await page.waitForTimeout(250);
    if (shot) await page.screenshot({ path: shot });
    await type('q');
    await waitFor(/dos51\$\s*$/m);
    // insert a card image made on the host
    const host = path.join(tmp, 'host.img');
    fs.writeFileSync(host, formatCard(8 << 20, { fat: 16 }));
    const f = path.join(tmp, 'host.txt');
    fs.writeFileSync(f, 'made on the host\n');
    fatimg(host, 'put', f, 'HOST.TXT');
    await page.setInputFiles('#cardfile', host);
    await waitFor(/SD card replaced by host\.img/);
    await page.click('#dropblocks');
    await waitFor(/DROPBLK\.ASM added to SD card/);
    await page.locator('#term').click();
    await type('sdls\rsdget host.txt\rcat host.txt\r');
    await waitFor(/dropblk\.asm +9302/);
    await waitFor(/cat host\.txt\s+made on the host\s+dos51\$\s*$/m);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  if (overflow) errors.push(`${label}: page overflows horizontally`);
  const t = await screen();

  await page.close();
  return t;
}

await run({ width: 1100, height: 900 }, 'desktop');
await run({ width: 390, height: 844 }, 'phone');
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
const origin = new URL(url).origin;
const foreign = requests.filter((r) => !r.startsWith(origin) && !r.startsWith('data:'));
if (foreign.length) errors.push(`third-party requests: ${foreign.join(', ')}`);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`ok: desktop + phone, ${new Set(requests).size} same-origin requests`);
