// Add an 8.3 file to an existing FAT16 card without replacing other files.
// Used to seed the browser's blank card; the DOS/51 shell remains the normal
// way to copy files between the card and RAM disk.
const u16 = (a, p) => a[p] | a[p + 1] << 8;
const u32 = (a, p) => (u16(a, p) | u16(a, p + 2) << 16) >>> 0;
const w16 = (a, p, n) => { a[p] = n & 255; a[p + 1] = n >>> 8 & 255; };
const w32 = (a, p, n) => { w16(a, p, n); w16(a, p + 2, n >>> 16); };

export function putFat16File(image, name, data, onWrite = () => {}) {
  if (!(image instanceof Uint8Array) || !(data instanceof Uint8Array)) throw Error('byte arrays required');
  const match = /^([A-Z0-9_-]{1,8})(?:\.([A-Z0-9_-]{1,3}))?$/.exec(name.toUpperCase());
  if (!match) throw Error('invalid 8.3 name');
  const filename = (match[1].padEnd(8) + (match[2] || '').padEnd(3)).split('').map(c => c.charCodeAt(0));
  const part = image[0] === 0xeb ? 0 : u32(image, 454);
  const boot = part * 512;
  if (u16(image, boot + 11) !== 512 || image[boot + 510] !== 0x55 || image[boot + 511] !== 0xaa) throw Error('not a FAT card');
  const spc = image[boot + 13], reserved = u16(image, boot + 14);
  const nfats = image[boot + 16], rootents = u16(image, boot + 17), fatsz = u16(image, boot + 22);
  if (!spc || !nfats || !rootents || !fatsz) throw Error('FAT16 card required');
  const tot = u16(image, boot + 19) || u32(image, boot + 32);
  const rootsecs = Math.ceil(rootents * 32 / 512);
  const nclus = Math.floor((tot - reserved - nfats * fatsz - rootsecs) / spc);
  if (nclus < 4085 || nclus > 65524 || (spc & (spc - 1)) || spc > 128) throw Error('FAT16 card required');
  const fat = (part + reserved) * 512;
  const root = fat + nfats * fatsz * 512;
  const dataStart = root + rootsecs * 512;
  if (fat + nfats * fatsz * 512 > image.length || dataStart + nclus * spc * 512 > image.length) throw Error('truncated FAT card');
  let slot = -1;
  for (let p = root; p < root + rootents * 32; p += 32) {
    if (image[p] === 0 || image[p] === 0xe5) { if (slot < 0) slot = p; if (image[p] === 0) break; continue; }
    if (filename.every((b, i) => image[p + i] === b)) return false; // never overwrite a visitor's file
  }
  if (slot < 0) throw Error('SD root directory full');
  const csize = spc * 512, need = Math.ceil(data.length / csize), free = [];
  for (let c = 2; c < nclus + 2 && free.length < need; c++) if (u16(image, fat + c * 2) === 0) free.push(c);
  if (free.length < need) throw Error('SD card full');
  for (let i = 0; i < need; i++) {
    const c = free[i], off = dataStart + (c - 2) * csize;
    image.fill(0, off, off + csize);
    image.set(data.subarray(i * csize, (i + 1) * csize), off);
    onWrite(off, csize);
    for (let f = 0; f < nfats; f++) {
      const p = fat + f * fatsz * 512 + c * 2;
      w16(image, p, free[i + 1] || 0xffff);
      onWrite(p, 2);
    }
  }
  image.fill(0, slot, slot + 32);
  image.set(filename, slot);
  image[slot + 11] = 0x20;
  w16(image, slot + 24, 0x21); // 1980-01-01
  w16(image, slot + 26, free[0] || 0);
  w32(image, slot + 28, data.length);
  onWrite(slot, 32);
  return true;
}
