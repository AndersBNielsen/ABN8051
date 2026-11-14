"""rev 0.2 step 3: SW2-SW4 accept a TL3342 (5.2 mm) or a 3x6 mm two-terminal SMD tact switch
(iMania FC-003D-5.0, 1500 pcs in stock).

FC-003D-5.0 has no datasheet; its listing/artwork is a 3x6 mm body with one gull-wing lead on each short
end. Land pattern taken from the equivalent XKB TS-1101 drawing (LCSC C318938): pads 1.1 x 1.0 mm,
outer span 8.60 mm, inner span 6.40 mm, i.e. pad centres 7.50 mm apart. Pads here are 1.0 x 1.5 mm
(longer outwards for hand soldering), centres +-3.85 mm on the Y axis, so the 3x6 part is fitted
rotated 90 deg and its plunger shares the TL3342 centre. They are numbered like the TL3342 pads they
sit next to (1 top, 2 bottom): same number = same net, no schematic change.

  python3 rev02_step3.py fp ; python3 rev02_step3.py sch ; <kicad python> rev02_step3.py pcb
"""
import os, re, sys, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
HW = os.path.dirname(HERE)
SRC = '/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints/Button_Switch_SMD.pretty/SW_SPST_TL3342.kicad_mod'
NAME = 'SW_SPST_TL3342_or_3x6mm'
DST = os.path.join(HW, 'ABN8051.pretty', NAME + '.kicad_mod')
FPID = 'ABN8051:' + NAME
PY, PW, PH = 3.85, 1.0, 1.5


def fp():
    t = open(SRC).read()
    t = t.replace('(footprint "SW_SPST_TL3342"', '(footprint "%s"' % NAME, 1)
    t = re.sub(r'\(descr "[^"]*"\)', '(descr "TL3342 5.2 mm SMD tact switch, or a 3x6 mm two-terminal gull-wing SMD tact '
               'switch (XKB TS-1101 land pattern, e.g. FC-003D-5.0) fitted rotated 90 deg on the same centre. '
               'Fit one switch only.")', t, count=1)
    # courtyard: the TL3342 rectangle is +-4.25 x +-3; extend in Y to cover the 3x6 pads
    n = t.count('(start -4.25 -3)') + t.count('(end 4.25 -3)')
    t = t.replace('-4.25 -3)', '-4.25 -%.2f)' % (PY + PH / 2 + 0.25)).replace('4.25 -3)', '4.25 -%.2f)' % (PY + PH / 2 + 0.25))
    t = t.replace('-4.25 3)', '-4.25 %.2f)' % (PY + PH / 2 + 0.25)).replace('4.25 3)', '4.25 %.2f)' % (PY + PH / 2 + 0.25))
    assert n, 'courtyard not found'
    add = ''
    for num, y in (('1', -PY), ('2', PY)):
        add += ('\t(pad "%s" smd roundrect (at 0 %g) (size %g %g) (layers "F.Cu" "F.Mask" "F.Paste") '
                '(roundrect_rratio 0.15) (uuid "%s"))\n') % (num, y, PW, PH, uuid.uuid4())
    # 3x6 body on fab (rotated): 3.7 wide, 6.05 tall
    add += ('\t(fp_rect (start -1.85 -3.025) (end 1.85 3.025) (stroke (width 0.1) (type solid)) (fill no) '
            '(layer "F.Fab") (uuid "%s"))\n' % uuid.uuid4())
    k = t.rstrip().rfind(')')
    t = t[:k].rstrip() + '\n' + add + ')\n'
    open(DST, 'w').write(t)
    print('wrote', DST)


def sch():
    sys.path.insert(0, HERE)
    import kiedit as k

    def edit(t):
        for ref in ('SW2', 'SW3', 'SW4'):
            a, b = k.symbol_block(t, ref)
            blk = t[a:b]
            assert '(property "Footprint" "Button_Switch_SMD:SW_SPST_TL3342"' in blk, ref
            blk = k.set_property(blk, 'Footprint', FPID)
            if '(property "Alt"' not in blk:
                i = blk.index('(property "LCSC"'); e = k.block_end(blk, i)
                alt = blk[i:e].replace('"LCSC"', '"Alt"').replace('"C318884"', '"3x6 mm 2-pin SMD tact switch '
                                                                   '(iMania FC-003D-5.0, 7342)"')
                blk = blk[:e] + '\n\t\t' + alt + blk[e:]
            t = t[:a] + blk + t[b:]
        return t
    k.commit(k.session(3), edit)


def pcb():
    sys.path.insert(0, HERE)
    import pcbedit as p
    import pcbnew
    comps, padnet = p.netlist()
    b = p.load()
    fps = p.fp_by_ref(b)
    for ref in ('SW2', 'SW3', 'SW4'):
        old = fps[ref]
        assert old.GetFPID().GetUniStringLibItemName() == 'SW_SPST_TL3342'
        pos, rot = p.xy(old.GetPosition()), old.GetOrientationDegrees()
        r = old.Reference(); rvis = r.IsVisible()
        b.Remove(old)
        nf = p.add_fp(b, comps, padnet, ref, pos[0], pos[1], rot, hide_ref=not rvis)
        assert nf.GetFPID().GetUniStringLibItemName() == NAME
    # switch names sat where the lower 3x6 pad is now: move them below the pads
    T = p.texts(b)
    for s in ('RESET', 'INT0', 'INT1'):
        tx, = [x for x in T[(s, 'F.Silkscreen')] if p.xy(x.GetPosition())[0] < 35]
        x = p.xy(tx.GetPosition())[0]
        tx.SetPosition(p.P(x, 87.95))
        tx.SetTextSize(pcbnew.VECTOR2I(pcbnew.FromMM(0.8), pcbnew.FromMM(0.8)))
    p.text(b, 'SW2-SW4: TL3342 or 3x6 mm tact switch (90 deg)', 21.0, 82.5, 0.8, 'B.SilkS')
    p.save(b)


if __name__ == '__main__':
    {'fp': fp, 'sch': sch, 'pcb': pcb}[sys.argv[1]]()
