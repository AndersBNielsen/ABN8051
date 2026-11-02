// Create a blank FAT16 or FAT32 SD card image (used by the CLI, the browser
// page and the tests). formatCard(bytes, { fat: 16|32, mbr: true, label })
// returns a Uint8Array: an MBR with one partition starting at sector 2048 (or
// a "superfloppy" volume at sector 0 with mbr: false).

const le16 = (b, o, v) => { b[o] = v & 0xFF; b[o + 1] = (v >> 8) & 0xFF; };
const le32 = (b, o, v) => { le16(b, o, v & 0xFFFF); le16(b, o + 2, (v >>> 16) & 0xFFFF); };
const ascii = (b, o, s, n) => { for (let i = 0; i < n; i++) b[o + i] = i < s.length ? s.charCodeAt(i) : 0x20; };

export function formatCard(bytes = 32 << 20, opts = {}) {
  const fat = opts.fat || 16;
  const mbr = opts.mbr !== false;
  const label = (opts.label || 'DOS51').toUpperCase().slice(0, 11);
  if (bytes % 512) throw new Error('size must be a multiple of 512');
  const img = new Uint8Array(bytes);
  const part = mbr ? 2048 : 0;
  const N = bytes / 512 - part;
  if (N < 4096) throw new Error('card image too small');

  const reserved = fat === 32 ? 32 : 1;
  const nfats = 2;
  const rootEnts = fat === 32 ? 0 : 512;
  const rootSecs = rootEnts * 32 / 512;
  let spc;
  if (fat === 16) {
    const mib = N / 2048;
    spc = mib <= 16 ? 2 : mib <= 128 ? 4 : mib <= 256 ? 8 : mib <= 512 ? 16 : mib <= 1024 ? 32 : 64;
  } else {
    const mib = N / 2048;
    spc = mib <= 260 ? 1 : mib <= 8192 ? 8 : mib <= 16384 ? 16 : mib <= 32768 ? 32 : 64;
  }
  const entBytes = fat === 32 ? 4 : 2;
  let fatsz = 1, clusters = 0;
  for (;;) {
    clusters = Math.floor((N - reserved - nfats * fatsz - rootSecs) / spc);
    const need = Math.ceil((clusters + 2) * entBytes / 512);
    if (need <= fatsz) break;
    fatsz = need;
  }
  if (fat === 16 && (clusters < 4085 || clusters > 65524)) throw new Error(`size gives ${clusters} clusters, not FAT16`);
  if (fat === 32 && clusters < 65525) throw new Error(`size gives ${clusters} clusters, too small for FAT32`);

  if (mbr) {
    const e = 446;
    img[e] = 0x00;
    img[e + 1] = 0xFE; img[e + 2] = 0xFF; img[e + 3] = 0xFF;     // CHS: use LBA
    img[e + 4] = fat === 32 ? 0x0C : 0x0E;                         // FAT32 / FAT16, LBA
    img[e + 5] = 0xFE; img[e + 6] = 0xFF; img[e + 7] = 0xFF;
    le32(img, e + 8, part);
    le32(img, e + 12, N);
    img[510] = 0x55; img[511] = 0xAA;
  }

  const bs = part * 512;
  const b = img.subarray(bs, bs + 512);
  b[0] = 0xEB; b[1] = fat === 32 ? 0x58 : 0x3C; b[2] = 0x90;
  ascii(b, 3, 'DOS51   ', 8);
  le16(b, 11, 512);
  b[13] = spc;
  le16(b, 14, reserved);
  b[16] = nfats;
  le16(b, 17, rootEnts);
  le16(b, 19, N < 65536 && fat === 16 ? N : 0);
  b[21] = 0xF8;
  le16(b, 22, fat === 16 ? fatsz : 0);
  le16(b, 24, 63);                                // sectors per track
  le16(b, 26, 255);                               // heads
  le32(b, 28, part);                              // hidden sectors
  le32(b, 32, N < 65536 && fat === 16 ? 0 : N);
  const serial = opts.serial ?? 0x51D05EC5;
  let x = 36;
  if (fat === 32) {
    le32(b, 36, fatsz);
    le16(b, 40, 0); le16(b, 42, 0);
    le32(b, 44, 2);                               // root directory cluster
    le16(b, 48, 1);                               // FSInfo sector
    le16(b, 50, 6);                               // backup boot sector
    x = 64;
  }
  b[x] = 0x80; b[x + 2] = 0x29;
  le32(b, x + 3, serial);
  ascii(b, x + 7, label, 11);
  ascii(b, x + 18, fat === 32 ? 'FAT32   ' : 'FAT16   ', 8);
  b[510] = 0x55; b[511] = 0xAA;

  const fat0 = bs + reserved * 512;
  const dataLba = reserved + nfats * fatsz + rootSecs;
  for (let f = 0; f < nfats; f++) {
    const o = fat0 + f * fatsz * 512;
    if (fat === 16) { le16(img, o, 0xFFF8); le16(img, o + 2, 0xFFFF); }
    else { le32(img, o, 0x0FFFFFF8); le32(img, o + 4, 0x0FFFFFFF); le32(img, o + 8, 0x0FFFFFFF); }
  }
  // volume label entry in the root directory
  const root = bs + (fat === 32 ? dataLba : reserved + nfats * fatsz) * 512;
  ascii(img, root, label.padEnd(11), 11);
  img[root + 11] = 0x08;
  le16(img, root + 24, 0x0021);                   // 1980-01-01
  if (fat === 32) {
    const fi = bs + 512;
    le32(img, fi, 0x41615252);
    le32(img, fi + 484, 0x61417272);
    le32(img, fi + 488, clusters - 1);            // free clusters (root uses one)
    le32(img, fi + 492, 3);                       // next free hint
    le32(img, fi + 508, 0xAA550000);
    img.copyWithin(bs + 6 * 512, bs, bs + 2 * 512); // backup boot + FSInfo
  }
  return img;
}
