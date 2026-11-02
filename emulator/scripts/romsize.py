#!/usr/bin/env python3
"""Print ROM/RAM usage from an SDCC (aslink) .map file."""
import re, sys
areas = {}
for line in open(sys.argv[1]):
    m = re.match(r'^(\S+)\s+([0-9A-F]{8})\s+([0-9A-F]{8})\s+=\s+(\d+)\. bytes \((.*)\)', line)
    if m:
        areas[m.group(1)] = (int(m.group(2), 16), int(m.group(3), 16), m.group(5))
code = [(n, a, l) for n, (a, l, f) in areas.items() if 'CODE' in f and l]
end = max(a + l for n, a, l in code if a < 0x7F00)
print('ROM: code+const end at %04Xh (%d bytes of 32512 before the 7F00h jump table, %d free)' % (end, end, 0x7F00 - end))
for n in ('DSEG', 'OSEG', 'BSEG', 'ISEG', 'SSEG', 'XSEG', 'PSEG', 'XISEG'):
    if n in areas and areas[n][1]:
        print('  %-6s %04Xh %5d bytes' % (n, areas[n][0], areas[n][1]))
