"""rev 0.2 step 4: solder jumpers JP2-JP6 on the bottom side, each labelled where it sits.
JP1 (ROM pin 1) stays a top-side 2.54 mm header.  <kicad python> rev02_step4.py
"""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pcbedit as p
import pcbnew
from pcbnew import FromMM, VECTOR2I

b = p.load()
fps = p.fp_by_ref(b)
T = p.texts(b)


def front_text(s, near):
    """the front silk text s closest to (x, y)"""
    c = T[(s, 'F.Silkscreen')]
    return min(c, key=lambda t: (p.xy(t.GetPosition())[0] - near[0]) ** 2 + (p.xy(t.GetPosition())[1] - near[1]) ** 2)


def flip(ref, to=None, rot=None):
    f = fps[ref]
    assert f.GetLayer() == pcbnew.F_Cu, ref
    if to: f.SetPosition(p.P(*to))
    f.Flip(f.GetPosition(), pcbnew.FLIP_DIRECTION_LEFT_RIGHT)
    if rot is not None: f.SetOrientationDegrees(rot)
    return f


def pad_xy(f, net_suffix):
    for pad in f.Pads():
        if pad.GetNetname().endswith(net_suffix):
            return p.xy(pad.GetPosition())
    raise KeyError(net_suffix)


def drop(s, near):
    t = front_text(s, near); b.Remove(t)


def bt(s, x, y, size=0.8, rot=0, just='c'):
    return p.text(b, s, x, y, size, 'B.SilkS', rot=rot, just=just)


# JP2 / JP3: flip in place above the RAMs; labels go to the pad they describe
for ref, x in (('JP2', 74.5), ('JP3', 93.5)):
    drop('32K', (x - 3.4, 22.9)); drop('8K', (x + 3.4, 22.9))
    f = flip(ref)
    xa = pad_xy(f, 'A13')[0]; xv = pad_xy(f, '+5V')[0]
    bt('32K', xa + (2.6 if xa > x else -2.6), 22.9)
    bt('8K', xv + (2.3 if xv > x else -2.3), 22.9)
    f.Reference().SetPosition(p.P(x, 20.9))
bt('JP2 = RAM0 size, JP3 = RAM1 size', 84.0, 17.6, 0.8)
bt('32K: 62256 (default)   8K: 6264', 84.0, 19.1, 0.8)
# their old legend under U4 is now redundant
for s in ('JP2 JP3 RAM size', '32K: 62256 (default)', '8K: 6264', 'JP5 cut: LEDs off'):
    t, = T[(s, 'B.Silkscreen')]; b.Remove(t)

# JP4: into the free band under U5, below its legend (legend moved up a little to make room)
for s in ('JP4 = RAM1 chip select', 'A15: 8000-FFFF (default)', 'IO4: 8000-9FFF, fit the 138', 'IOn low in block n x 2000h'):
    t, = T[(s, 'B.Silkscreen')]
    x, y = p.xy(t.GetPosition()); t.SetPosition(p.P(x, y - 2.5))
drop('A15', (88.3, 68.6)); drop('IO4', (96.0, 68.6)); drop('RAM1 CS', (92.0, 70.8))
f = flip('JP4', to=(92.8, 55.9), rot=90)
ya = pad_xy(f, 'A15}')[1]; yi = pad_xy(f, 'IO4}')[1]
bt('A15', 92.8, ya + (2.2 if ya > 55.9 else -2.2), rot=90)
bt('IO4', 92.8, yi + (2.2 if yi > 55.9 else -2.2), rot=90)
f.Reference().SetPosition(p.P(90.6, 55.9)); f.Reference().SetTextAngleDegrees(90)

# JP5: flip in place at the LEDs
drop('LED EN', (5.4, 61.7))
f = flip('JP5')
bt('JP5: cut', 5.4, 61.6); bt('= LEDs off', 5.4, 63.1)

# JP6: flip in place by the microSD; U9/U11 notes move down out of its way
drop('CD>T0', (71.6, 7.0))
f = flip('JP6')
bt('CD>T0', 71.6, 7.0)
for i, s in enumerate(('3V3: fit U9 or U11, never both', 'U9 KF33: C18 = 10uF TANTALUM', 'U11 MIC5504: C18 = 10uF MLCC')):
    t, = T[(s, 'B.Silkscreen')]
    t.SetPosition(p.P(61.0, 8.6 + i * 1.7))

p.save(b)
print('ok')
