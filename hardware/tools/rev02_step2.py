"""rev 0.2 step 2: U4/U5 SRAMs accept a 600 mil (62256 'P') or a 300 mil (62256 'SP'/skinny) DIP-28.

One combined footprint ABN8051:DIP-28_W7.62mm_W15.24mm: KiCad's DIP-28_W15.24mm plus a second set of
pads 15-28 at x = 7.62 mm. Pads with the same number are the same pin, so both columns carry the
same net and only one socket/chip is fitted. Pin 1..14 are shared, pin 1 position is unchanged.

  python3 rev02_step2.py fp     (writes the footprint)
  python3 rev02_step2.py sch    (points U4/U5 at it)
  <kicad python> rev02_step2.py pcb
"""
import os, re, sys, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
HW = os.path.dirname(HERE)
SRC = '/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints/Package_DIP.pretty/DIP-28_W15.24mm.kicad_mod'
NAME = 'DIP-28_W7.62mm_W15.24mm'
DST = os.path.join(HW, 'ABN8051.pretty', NAME + '.kicad_mod')
FPID = 'ABN8051:' + NAME


def fp():
    sys.path.insert(0, HERE)
    from kiedit import block_end
    t = open(SRC).read()
    t = t.replace('(footprint "DIP-28_W15.24mm"', '(footprint "%s"' % NAME, 1)
    t = re.sub(r'\(descr "[^"]*"\)', '(descr "28-lead DIP, 600 mil (15.24 mm) and 300 mil (7.62 mm) row spacing in one '
               'footprint: pads 15-28 exist at both widths. Fit one socket or chip only.")', t, count=1)
    new = []
    for m in re.finditer(r'\n\t\(pad "(\d+)" thru_hole', t):
        n = int(m.group(1))
        if n < 15: continue
        a = m.start() + 2; b = block_end(t, a)
        blk = t[a:b]
        assert '(at 15.24 ' in blk, blk[:80]
        blk = blk.replace('(at 15.24 ', '(at 7.62 ', 1)
        blk = re.sub(r'\(uuid "[^"]+"\)', '(uuid "%s")' % uuid.uuid4(), blk)
        new.append(blk)
    assert len(new) == 14
    k = t.rstrip().rfind(')')
    # fab outline of the narrow body, on F.Fab only so silk stays clean
    fab = ('\t(fp_rect (start 1.27 -1.27) (end 6.35 34.29) (stroke (width 0.1) (type solid)) (fill no) '
           '(layer "F.Fab") (uuid "%s"))\n' % uuid.uuid4())
    t = t[:k].rstrip() + '\n' + ''.join('\t' + x + '\n' for x in new) + fab + ')\n'
    # pin-1 notch: pad 28 of the 300 mil row sits where the inward notch was; draw it outward instead
    assert t.count('(mid 7.62 -0.33)') == 1
    t = t.replace('(mid 7.62 -0.33)', '(mid 7.62 -2.33)')
    open(DST, 'w').write(t)
    print('wrote', DST)


def sch():
    sys.path.insert(0, HERE)
    import kiedit as k

    def edit(t):
        for ref in ('U4', 'U5'):
            a, b = k.symbol_block(t, ref)
            blk = t[a:b]
            assert '(property "Footprint" "Package_DIP:DIP-28_W15.24mm"' in blk, ref
            blk = k.set_property(blk, 'Footprint', FPID)
            t = t[:a] + blk + t[b:]
        return t
    s = k.session(2)
    k.commit(s, edit)


def pcb():
    sys.path.insert(0, HERE)
    import pcbedit as p
    import pcbnew
    comps, padnet = p.netlist()
    b = p.load()
    fps = p.fp_by_ref(b)
    for ref in ('U4', 'U5'):
        old = fps[ref]
        assert old.GetFPID().GetUniStringLibItemName() == 'DIP-28_W15.24mm'
        pos, rot = p.xy(old.GetPosition()), old.GetOrientationDegrees()
        r = old.Reference()
        rpos, rang, rvis = p.xy(r.GetPosition()), r.GetTextAngleDegrees(), r.IsVisible()
        rsize = pcbnew.ToMM(r.GetTextSize().x)
        b.Remove(old)
        nf = p.add_fp(b, comps, padnet, ref, pos[0], pos[1], rot, refxy=rpos, refrot=rang, hide_ref=not rvis,
                      refsize=rsize)
        assert nf.GetFPID().GetUniStringLibItemName() == NAME
        # reference text was centred on the body, now the 300 mil pad column: move it to the free band
        nf.Reference().SetPosition(p.P(pos[0] + 3.0, rpos[1]))
        # silk: mark the 300 mil row
        p.text(b, '300', pos[0] + 7.62, pos[1] + 35.2, 0.8)
        p.text(b, '600', pos[0] + 15.24, pos[1] + 35.2, 0.8)
    # back-silk legends under U4/U5 were centred on the body (now the 300 mil column): move them into
    # the free band between the 600 and 300 mil rows, tighter line pitch
    T = p.texts(b)
    for ref, lines in (('U4', ['JP2 JP3 RAM size', '32K: 62256 (default)', '8K: 6264', 'JP5 cut: LEDs off']),
                       ('U5', ['JP4 = RAM1 chip select', 'A15: 8000-FFFF (default)', 'IO4: 8000-9FFF, fit the 138',
                               'IOn low in block n x 2000h'])):
        x0 = p.xy(fps[ref].GetPosition())[0] if ref in fps and fps[ref].GetParent() else None
        x0 = p.xy(p.fp_by_ref(b)[ref].GetPosition())[0]
        n = len(lines)
        for i, s in enumerate(lines):
            items = T[(s, 'B.Silkscreen')]
            assert len(items) == 1, s
            tx = items[0]
            y = p.xy(tx.GetPosition())[1]
            tx.SetPosition(p.P(x0 + 11.43 + ((n - 1) / 2.0 - i) * 1.45, y))
            tx.SetTextSize(pcbnew.VECTOR2I(pcbnew.FromMM(0.9), pcbnew.FromMM(0.9)))
            tx.SetTextThickness(pcbnew.FromMM(0.14))
    p.save(b)


if __name__ == '__main__':
    {'fp': fp, 'sch': sch, 'pcb': pcb}[sys.argv[1]]()
