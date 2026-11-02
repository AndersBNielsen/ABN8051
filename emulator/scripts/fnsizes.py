#!/usr/bin/env python3
import re, sys, glob
res = []
for f in sys.argv[1:]:
    labs = []
    area = None
    for line in open(f):
        m = re.search(r'\.area\s+(\w+)', line)
        if m: area = m.group(1)
        m = re.match(r'\s+([0-9A-F]{6})\s+\d+\s+(_\w+):\s*$', line)
        if m and area == 'CSEG': labs.append((int(m.group(1), 16), m.group(2)))
        m2 = re.match(r'\s+([0-9A-F]{6})\s', line)
        if m2 and area == 'CSEG': last = int(m2.group(1), 16)
    labs.sort()
    for i, (a, n) in enumerate(labs):
        e = labs[i+1][0] if i + 1 < len(labs) else last + 3
        res.append((e - a, f.split('/')[-1], n))
for s, f, n in sorted(res, reverse=True)[:int(__import__('os').environ.get('N', '40'))]:
    print('%6d %-12s %s' % (s, f, n))
