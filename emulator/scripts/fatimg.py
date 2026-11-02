#!/usr/bin/env python3
"""Small host-side FAT16/FAT32 tool for SD card images (independent of the
DOS/51 firmware and of emu/fatfmt.js, so tests can cross-check both).

  fatimg.py IMAGE ls                 root directory: NAME.EXT size
  fatimg.py IMAGE get NAME [OUT]     copy a root file out (stdout if no OUT)
  fatimg.py IMAGE put FILE [NAME]    copy a host file into the root directory
  fatimg.py IMAGE rm NAME
  fatimg.py IMAGE check              FAT consistency: both FATs equal, chains
                                     match sizes, no cross-links or lost
                                     clusters; exit 1 on problems
The volume is the first MBR partition, or sector 0 for a superfloppy.
"""
import struct
import sys


class Volume:
    def __init__(self, path):
        self.path = path
        self.f = open(path, 'r+b')
        s0 = self.sec(0)
        if s0[510:512] != b'\x55\xaa':
            raise SystemExit('no boot signature')
        self.part = 0
        if not (s0[0] in (0xEB, 0xE9) and struct.unpack_from('<H', s0, 11)[0] == 512):
            self.part = struct.unpack_from('<I', s0, 446 + 8)[0]
        b = self.sec(self.part)
        if b[510:512] != b'\x55\xaa':
            raise SystemExit('no boot sector signature')
        (bps, self.spc, res, self.nfats, rootents, tot16, _media, fsz16) = struct.unpack_from('<HBHBHHBH', b, 11)
        assert bps == 512, 'sector size'
        tot32, fsz32 = struct.unpack_from('<II', b, 32)
        self.fatsz = fsz16 or fsz32
        tot = tot16 or tot32
        self.fat_lba = self.part + res
        self.root_secs = (rootents * 32 + 511) // 512
        self.root_lba = self.fat_lba + self.nfats * self.fatsz
        self.data_lba = self.root_lba + self.root_secs
        self.nclus = (tot - (self.data_lba - self.part)) // self.spc
        if self.nclus < 4085:
            raise SystemExit('FAT12 is not supported')
        self.fat32 = self.nclus >= 65525
        self.root_clus = struct.unpack_from('<I', b, 44)[0] if self.fat32 else 0
        self.eoc = 0x0FFFFFF8 if self.fat32 else 0xFFF8
        self.fat = bytearray(self.read(self.fat_lba, self.fatsz))

    def sec(self, lba):
        return self.read(lba, 1)

    def read(self, lba, n):
        self.f.seek(lba * 512)
        return self.f.read(n * 512)

    def write(self, lba, data):
        self.f.seek(lba * 512)
        self.f.write(data)

    def get(self, c):
        if self.fat32:
            return struct.unpack_from('<I', self.fat, c * 4)[0] & 0x0FFFFFFF
        return struct.unpack_from('<H', self.fat, c * 2)[0]

    def set(self, c, v):
        if self.fat32:
            old = struct.unpack_from('<I', self.fat, c * 4)[0]
            struct.pack_into('<I', self.fat, c * 4, (old & 0xF0000000) | v)
        else:
            struct.pack_into('<H', self.fat, c * 2, v)

    def flush_fat(self):
        for i in range(self.nfats):
            self.write(self.fat_lba + i * self.fatsz, bytes(self.fat))

    def chain(self, c):
        out = []
        while 2 <= c < self.eoc:
            if c >= self.nclus + 2 or c in out:
                raise SystemExit('bad chain at cluster %d' % c)
            out.append(c)
            c = self.get(c)
        return out

    def clba(self, c):
        return self.data_lba + (c - 2) * self.spc

    # root directory as a list of (lba, offset) slots
    def root_slots(self):
        if self.fat32:
            secs = [self.clba(c) + i for c in self.chain(self.root_clus) for i in range(self.spc)]
        else:
            secs = range(self.root_lba, self.root_lba + self.root_secs)
        for lba in secs:
            for o in range(0, 512, 32):
                yield lba, o

    def entries(self):
        for lba, o in self.root_slots():
            e = self.sec(lba)[o:o + 32]
            if e[0] == 0:
                return
            if e[0] == 0xE5 or e[11] == 0x0F or e[11] & 0x08:
                continue
            yield lba, o, e

    @staticmethod
    def name83(e):
        base = e[0:8].decode('latin1').rstrip()
        ext = e[8:11].decode('latin1').rstrip()
        return base + ('.' + ext if ext else '')

    @staticmethod
    def to83(name):
        name = name.upper()
        base, _, ext = name.partition('.')
        if not base or len(base) > 8 or len(ext) > 3 or '.' in ext:
            raise SystemExit('not an 8.3 name: ' + name)
        return (base.ljust(8) + ext.ljust(3)).encode('latin1')

    def find(self, name):
        n = self.to83(name)
        for lba, o, e in self.entries():
            if e[0:11] == n:
                return lba, o, e
        return None

    def first_clus(self, e):
        hi = struct.unpack_from('<H', e, 20)[0] if self.fat32 else 0
        return hi << 16 | struct.unpack_from('<H', e, 26)[0]

    def read_file(self, e):
        size = struct.unpack_from('<I', e, 28)[0]
        data = b''.join(self.read(self.clba(c), self.spc) for c in self.chain(self.first_clus(e)))
        return data[:size]

    def free_chain(self, c):
        for x in self.chain(c):
            self.set(x, 0)

    def put(self, name, data):
        n = self.to83(name)
        old = self.find(name)
        if old:
            self.rm(name)
        csize = self.spc * 512
        need = (len(data) + csize - 1) // csize
        free = [c for c in range(2, self.nclus + 2) if self.get(c) == 0][:need]
        if len(free) < need:
            raise SystemExit('card full')
        for i, c in enumerate(free):
            self.set(c, free[i + 1] if i + 1 < need else (0x0FFFFFFF if self.fat32 else 0xFFFF))
            chunk = data[i * csize:(i + 1) * csize]
            self.write(self.clba(c), chunk.ljust(csize, b'\0'))
        first = free[0] if free else 0
        for lba, o in self.root_slots():
            s = bytearray(self.sec(lba))
            if s[o] in (0, 0xE5):
                e = bytearray(32)
                e[0:11] = n
                e[11] = 0x20
                struct.pack_into('<HHHHHHHI', e, 14, 0, 0x0021, 0x0021, first >> 16, 0, 0x0021, first & 0xFFFF, len(data))
                s[o:o + 32] = e
                self.write(lba, bytes(s))
                self.flush_fat()
                return
        raise SystemExit('root directory full')

    def rm(self, name):
        hit = self.find(name)
        if not hit:
            raise SystemExit('no such file: ' + name)
        lba, o, e = hit
        self.free_chain(self.first_clus(e))
        s = bytearray(self.sec(lba))
        s[o] = 0xE5
        self.write(lba, bytes(s))
        self.flush_fat()

    def check(self):
        problems = []
        for i in range(1, self.nfats):
            if self.read(self.fat_lba + i * self.fatsz, self.fatsz) != bytes(self.fat):
                problems.append('FAT %d differs from FAT 0' % (i + 1))
        used = {}
        if self.fat32:
            for c in self.chain(self.root_clus):
                used[c] = '<root>'
        for lba, o, e in self.entries():
            name = self.name83(e)
            size = struct.unpack_from('<I', e, 28)[0]
            c0 = self.first_clus(e)
            ch = self.chain(c0) if c0 else []
            if e[11] & 0x10:
                continue
            want = (size + self.spc * 512 - 1) // (self.spc * 512)
            if len(ch) != want:
                problems.append('%s: %d clusters for %d bytes' % (name, len(ch), size))
            for c in ch:
                if c in used:
                    problems.append('%s: cluster %d cross-linked with %s' % (name, c, used[c]))
                used[c] = name
        lost = [c for c in range(2, self.nclus + 2) if self.get(c) != 0 and c not in used]
        if lost:
            problems.append('%d lost clusters (first %d)' % (len(lost), lost[0]))
        return problems


def main(argv):
    if len(argv) < 3:
        raise SystemExit(__doc__)
    v = Volume(argv[1])
    cmd = argv[2]
    if cmd == 'ls':
        for _lba, _o, e in v.entries():
            print('%-12s %10d%s' % (v.name83(e), struct.unpack_from('<I', e, 28)[0], ' <DIR>' if e[11] & 0x10 else ''))
    elif cmd == 'get':
        hit = v.find(argv[3])
        if not hit:
            raise SystemExit('no such file: ' + argv[3])
        data = v.read_file(hit[2])
        if len(argv) > 4:
            open(argv[4], 'wb').write(data)
        else:
            sys.stdout.buffer.write(data)
    elif cmd == 'put':
        data = open(argv[3], 'rb').read()
        v.put(argv[4] if len(argv) > 4 else argv[3].split('/')[-1], data)
    elif cmd == 'rm':
        v.rm(argv[3])
    elif cmd == 'check':
        p = v.check()
        print('FAT%d, %d clusters of %d bytes: %s' % (32 if v.fat32 else 16, v.nclus, v.spc * 512, '; '.join(p) or 'ok'))
        sys.exit(1 if p else 0)
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main(sys.argv)
