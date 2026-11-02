// Intel HEX parsing and emitting (record types 00, 01, 02, 04; 03/05 ignored).

// Parse an Intel HEX string. Returns { segments: [{addr, data:Uint8Array}], start }
// where segments are contiguous runs in file order (adjacent records merged).
export function parseIntelHex(text) {
  const segments = [];
  let base = 0, cur = null, start = null, sawEof = false;
  const lines = String(text).split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].trim();
    if (!line) continue;
    if (line[0] !== ':') throw new Error(`ihex line ${ln + 1}: missing ':'`);
    if (sawEof) break;
    const bytes = new Uint8Array((line.length - 1) >> 1);
    for (let i = 0; i < bytes.length; i++) {
      const v = parseInt(line.substr(1 + i * 2, 2), 16);
      if (Number.isNaN(v)) throw new Error(`ihex line ${ln + 1}: bad hex`);
      bytes[i] = v;
    }
    if (bytes.length < 5 || bytes.length !== bytes[0] + 5) throw new Error(`ihex line ${ln + 1}: bad length`);
    let sum = 0;
    for (const b of bytes) sum += b;
    if (sum & 0xFF) throw new Error(`ihex line ${ln + 1}: checksum error`);
    const n = bytes[0], addr = (bytes[1] << 8) | bytes[2], type = bytes[3];
    const payload = bytes.subarray(4, 4 + n);
    switch (type) {
      case 0x00: {
        const a = base + addr;
        if (cur && cur.addr + cur.len === a) {
          if (cur.len + n > cur.buf.length) {
            const nb = new Uint8Array(Math.max(cur.buf.length * 2, cur.len + n));
            nb.set(cur.buf.subarray(0, cur.len));
            cur.buf = nb;
          }
          cur.buf.set(payload, cur.len);
          cur.len += n;
        } else {
          cur = { addr: a, buf: new Uint8Array(Math.max(256, n)), len: n };
          cur.buf.set(payload);
          segments.push(cur);
        }
        break;
      }
      case 0x01: sawEof = true; break;
      case 0x02: base = ((payload[0] << 8) | payload[1]) << 4; cur = null; break;
      case 0x04: base = ((payload[0] << 8) | payload[1]) * 65536; cur = null; break;
      case 0x03: start = (((payload[0] << 8) | payload[1]) << 4) + ((payload[2] << 8) | payload[3]); break;
      case 0x05: start = ((payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3]) >>> 0; break;
      default: throw new Error(`ihex line ${ln + 1}: unknown record type ${type}`);
    }
  }
  return { segments: segments.map(s => ({ addr: s.addr, data: s.buf.slice(0, s.len) })), start };
}

// Flatten parsed HEX into a byte image of `size` bytes filled with `fill`.
// Data outside [0, size) is ignored. Returns { image, min, max } (max exclusive).
export function hexToImage(text, size = 65536, fill = 0xFF) {
  const { segments } = typeof text === 'string' ? parseIntelHex(text) : text;
  const image = new Uint8Array(size).fill(fill);
  let min = Infinity, max = 0;
  for (const { addr, data } of segments) {
    for (let i = 0; i < data.length; i++) {
      const a = addr + i;
      if (a >= 0 && a < size) { image[a] = data[i]; if (a < min) min = a; if (a + 1 > max) max = a + 1; }
    }
  }
  return { image, min: min === Infinity ? 0 : min, max };
}

function rec(type, addr, payload) {
  let s = ':' + hex2(payload.length) + hex2(addr >> 8) + hex2(addr & 0xFF) + hex2(type);
  let sum = payload.length + (addr >> 8) + (addr & 0xFF) + type;
  for (const b of payload) { s += hex2(b); sum += b; }
  return s + hex2((-sum) & 0xFF);
}
function hex2(v) { return (v & 0xFF).toString(16).toUpperCase().padStart(2, '0'); }

// Emit Intel HEX for `data` starting at `addr` (16-byte records, type-04 for >64K).
export function emitIntelHex(data, addr = 0, recordSize = 16) {
  const out = [];
  let upper = 0;
  for (let i = 0; i < data.length; i += recordSize) {
    const a = addr + i;
    if ((a >>> 16) !== upper) { upper = a >>> 16; out.push(rec(4, 0, [upper >> 8, upper & 0xFF])); }
    const n = Math.min(recordSize, data.length - i, 0x10000 - (a & 0xFFFF));
    out.push(rec(0, a & 0xFFFF, data.subarray ? data.subarray(i, i + n) : data.slice(i, i + n)));
    if (n < recordSize && i + n < data.length) i -= recordSize - n;
  }
  out.push(':00000001FF');
  return out.join('\n') + '\n';
}
