#!/usr/bin/env python3
import sys
src, dst, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
img = bytearray(b'\xff' * size)
hi = 0
for line in open(src):
    line = line.strip()
    if not line.startswith(':'):
        continue
    b = bytes.fromhex(line[1:])
    n, a, t = b[0], (b[1] << 8) | b[2], b[3]
    assert sum(b) & 0xFF == 0, 'checksum'
    if t == 0:
        a += hi
        assert a + n <= size, 'address %04X beyond image' % a
        img[a:a + n] = b[4:4 + n]
    elif t == 4:
        hi = ((b[4] << 8) | b[5]) << 16
open(dst, 'wb').write(img)
