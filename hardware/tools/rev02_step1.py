"""rev 0.2 step 1: U11 MIC5504-3.3YM5 (SOT-23-5) as alternative to U9 KF33BD (SO-8).

  python3 rev02_step1.py sch          (plain python)
  <kicad python> rev02_step1.py pcb   (after the schematic part)

MIC5504 SOT-23-5 (Micrel/Microchip MIC550X data sheet, pin description table):
  1 VIN, 2 GND, 3 EN (active high, internal pull-down), 4 NC, 5 VOUT.
Needs 1 uF ceramic on the input and >= 1 uF low-ESR ceramic on the output ("high ESR capacitors
are not recommended"), the opposite of the KF33 (output ESR 0.1-10 ohm, i.e. the tantalum).
So the two regulators share the capacitors: C20 becomes 1 uF (fine for both), and C18's 3216 pads
take the tantalum for U9 or a 1206 MLCC for U11.
"""
import sys


def sch():
    import kiedit as k
    from kiedit import q, uq, find, first, libsym, G

    # project-owned copy of KiCad's symbol with VOUT passive: U9 already drives +3V3 as power output
    sym = libsym.get_symbol('Regulator_Linear', 'MIC5504-3.3YM5')
    sym[1] = q('MIC5504-3.3YM5')
    for sub in find(sym, 'symbol'):
        for p in find(sub, 'pin'):
            if uq(first(p, 'number')[1]) == '5':
                assert p[1] == 'power_out', p[1]
                p[1] = 'passive'
    for p in find(sym, 'property'):
        if uq(p[1]) == 'Description':
            p[2] = q('300 mA LDO 3.3 V, SOT-23-5: 1 VIN, 2 GND, 3 EN, 4 NC, 5 VOUT. '
                     'VOUT is passive here because this part is an alternative to U9 on the same rail')
    k.add_lib_symbol(sym)

    s = k.session(1)
    X, Y = 110 * G, 91 * G                                   # 279.4, 231.14
    pin = s.place('ABN8051:MIC5504-3.3YM5', 'U11', 'MIC5504-3.3YM5', 110, 91,
                  {'1': '+5V', '3': '+5V', '5': '+3V3', '2': 'GND'}, fp='Package_TO_SOT_SMD:SOT-23-5',
                  props={'LCSC': 'C3021093', 'Alt': 'Alternative to U9: fit U9 or U11, never both'},
                  libpath=k.SYMLIB, draw={'3': 'N', '2': 'N'}, stubs={'1': 0, '5': 0}, dnp=True,
                  refpos=(-7.62, -6.6, 'left'), valpos=(-2.54, -6.6, 'left'))
    s.wire(pin['3'], pin['1'])                               # EN tied to VIN
    s.power('GND', pin['2'][0], pin['2'][1], (1, 0))
    s.text('U11 (MIC5504) is an alternative to U9: fit only one of them.\n'
           'With U11, C18 must be a 10 uF 1206 MLCC, not the tantalum.', 180.34, 245.0, 1.0)

    def edit(t):
        a, b = k.symbol_block(t, 'C20')
        blk = k.set_property(k.set_property(t[a:b], 'Value', '1uF'), 'LCSC', 'C28323')
        t = t[:a] + blk + t[b:]
        a, b = k.symbol_block(t, 'C18')
        blk = t[a:b]
        assert '(property "Alt"' not in blk
        lcsc = blk.index('(property "LCSC"'); e = k.block_end(blk, lcsc)
        alt = blk[lcsc:e].replace('"LCSC"', '"Alt"').replace('"C7171"', '"With U11: 10uF 1206 MLCC (LCSC C13585)"')
        t = t[:a] + blk[:e] + '\n\t\t' + alt + blk[e:] + t[b:]
        old = '(at 270.51 234.442 0)'                        # "JP6 open by default" note: make room for U11
        assert t.count(old) == 1
        return t.replace(old, '(at 270.51 223.012 0)')
    k.commit(s, edit)


def pcb():
    import pcbedit as p
    comps, padnet = p.netlist()
    b = p.load()
    fps = p.fp_by_ref(b)
    c20 = fps['C20']
    assert c20.GetValue() == '100nF'
    c20.SetValue('1uF'); c20.SetField('LCSC', 'C28323')
    fps['C18'].SetField('Alt', comps['C18']['fields']['Alt'])
    for f in (c20, fps['C18']):
        for fld in f.GetFields():
            if not fld.IsReference(): fld.SetVisible(False)
    p.add_fp(b, comps, padnet, 'U11', 60.4, 10.9, 0, refxy=(60.4, 13.5))
    t = p.texts(b)[('3V3', 'F.Silkscreen')]
    assert len(t) == 1
    t[0].SetText('3V3: U9 or U11')
    for i, s in enumerate(('3V3: fit U9 or U11, never both', 'U9 KF33: C18 = 10uF TANTALUM',
                           'U11 MIC5504: C18 = 10uF MLCC')):
        p.text(b, s, 64.5, 6.4 + i * 1.7, 0.8, 'B.SilkS')
    p.save(b)


if __name__ == '__main__':
    {'sch': sch, 'pcb': pcb}[sys.argv[1]]()
