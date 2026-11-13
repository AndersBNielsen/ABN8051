"""ABN8051 board: outline, placement, nets, silkscreen. No tracks. Run with KiCad's python."""
import sys, os, re, json
import pcbnew
from pcbnew import VECTOR2I, FromMM, ToMM
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sexp import parse, find, first, uq

HW = os.path.expanduser('~/ai/ABN8051/hardware')
NET = sys.argv[1]
FPDIR = '/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints'
OX, OY = 100.0, 60.0          # board origin on the page
BW, BH = 100.0, 89.0

t = parse(open(NET).read())
comps = {}
for c in find(first(t, 'components'), 'comp'):
    ref = uq(first(c, 'ref')[1])
    d = {'value': uq(first(c, 'value')[1]), 'fp': uq(first(c, 'footprint')[1]), 'fields': {}}
    ts = first(c, 'tstamps')
    d['ts'] = uq(ts[1]) if ts else None
    sp = first(c, 'sheetpath')
    fl = first(c, 'fields')
    if fl:
        for f in find(fl, 'field'):
            if len(f) > 2: d['fields'][uq(first(f, 'name')[1])] = uq(f[2])
    comps[ref] = d
padnet = {}
for n in find(first(t, 'nets'), 'net'):
    name = uq(first(n, 'name')[1])
    for x in find(n, 'node'):
        padnet[(uq(first(x, 'ref')[1]), uq(first(x, 'pin')[1]))] = name

board = pcbnew.BOARD()
def P(x, y): return VECTOR2I(FromMM(OX + x), FromMM(OY + y))
nets = {}
def net(name):
    if name not in nets:
        ni = pcbnew.NETINFO_ITEM(board, name)
        board.Add(ni); nets[name] = ni
    return nets[name]

L = {'F.SilkS': pcbnew.F_SilkS, 'B.SilkS': pcbnew.B_SilkS, 'Edge.Cuts': pcbnew.Edge_Cuts, 'Cmts.User': pcbnew.Cmts_User, 'Dwgs.User': pcbnew.Dwgs_User, 'F.Fab': pcbnew.F_Fab, 'F.Cu': pcbnew.F_Cu}
placed = {}
def place(ref, x, y, rot=0, refxy=None, refrot=0, hide_ref=False, refsize=0.8):
    c = comps[ref]
    lib, name = c['fp'].split(':')
    libdir = os.path.join(HW, 'ABN8051.pretty') if lib == 'ABN8051' else os.path.join(FPDIR, lib + '.pretty')
    fp = pcbnew.FootprintLoad(libdir, name)
    assert fp, c['fp']
    fp.SetFPID(pcbnew.LIB_ID(lib, name))
    fp.SetReference(ref); fp.SetValue(c['value'])
    board.Add(fp)
    fp.SetPosition(P(x, y)); fp.SetOrientationDegrees(rot)
    if c['ts']:
        fp.SetPath(pcbnew.KIID_PATH('/' + c['ts']))
    for k, v in c['fields'].items():
        if k in ('Footprint', 'Datasheet', 'Description') or not v: continue
        fp.SetField(k, v)
    for fld in fp.GetFields():
        if not fld.IsReference():
            fld.SetVisible(False); fld.SetLayer(L['F.Fab'])
    for pad in fp.Pads():
        nn = padnet.get((ref, pad.GetNumber()))
        if nn: pad.SetNet(net(nn))
    r = fp.Reference()
    r.SetTextSize(VECTOR2I(FromMM(refsize), FromMM(refsize))); r.SetTextThickness(FromMM(0.13))
    if refxy:
        r.SetPosition(P(*refxy)); r.SetTextAngleDegrees(refrot)
    if hide_ref: r.SetVisible(False)
    placed[ref] = fp
    return fp

def text(s, x, y, size=1.0, layer='F.SilkS', rot=0, just='c', thick=None, bold=False):
    tx = pcbnew.PCB_TEXT(board)
    tx.SetText(s); tx.SetLayer(L[layer]); tx.SetPosition(P(x, y))
    tx.SetTextSize(VECTOR2I(FromMM(size), FromMM(size)))
    tx.SetTextThickness(FromMM(thick or max(0.13, size * 0.15)))
    tx.SetTextAngleDegrees(rot)
    tx.SetHorizJustify({'l': pcbnew.GR_TEXT_H_ALIGN_LEFT, 'c': pcbnew.GR_TEXT_H_ALIGN_CENTER, 'r': pcbnew.GR_TEXT_H_ALIGN_RIGHT}[just])
    if layer.startswith('B.'): tx.SetMirrored(True)
    board.Add(tx); return tx
def line(x1, y1, x2, y2, layer='F.SilkS', w=0.15):
    s = pcbnew.PCB_SHAPE(board); s.SetShape(pcbnew.SHAPE_T_SEGMENT)
    s.SetStart(P(x1, y1)); s.SetEnd(P(x2, y2)); s.SetLayer(L[layer]); s.SetWidth(FromMM(w)); board.Add(s)
def rect(x1, y1, x2, y2, layer='F.SilkS', w=0.15):
    line(x1, y1, x2, y1, layer, w); line(x2, y1, x2, y2, layer, w); line(x2, y2, x1, y2, layer, w); line(x1, y2, x1, y1, layer, w)
def arc(cx, cy, sx, sy, ang, layer='Edge.Cuts', w=0.1):
    s = pcbnew.PCB_SHAPE(board); s.SetShape(pcbnew.SHAPE_T_ARC)
    s.SetCenter(P(cx, cy)); s.SetStart(P(sx, sy)); s.SetArcAngleAndEnd(pcbnew.EDA_ANGLE(ang, pcbnew.DEGREES_T))
    s.SetLayer(L[layer]); s.SetWidth(FromMM(w)); board.Add(s)

# ---------------------------------------------------------------- outline (r = 3 mm corners)
R = 3.0
line(R, 0, BW - R, 0, 'Edge.Cuts', 0.1); line(BW, R, BW, BH - R, 'Edge.Cuts', 0.1)
line(BW - R, BH, R, BH, 'Edge.Cuts', 0.1); line(0, BH - R, 0, R, 'Edge.Cuts', 0.1)
arc(R, R, 0, R, 90); arc(BW - R, R, BW - R, 0, 90); arc(BW - R, BH - R, BW, BH - R, 90); arc(R, BH - R, R, BH, 90)

# ---------------------------------------------------------------- placement
TOP = 27.0                         # y of DIP pin 1 rows
XU1, XU2, XU3, XU4, XU5 = 20.0, 35.5, 51.0, 70.0, 89.0
def dip(ref, xc, w, ytop=TOP):
    place(ref, xc - w / 2, ytop, 0, refxy=(xc, ytop + 5), refrot=90, refsize=1.2)
dip('U1', XU1, 15.24); dip('U2', XU2, 7.62); dip('U3', XU3, 15.24); dip('U4', XU4, 15.24); dip('U5', XU5, 15.24)
dip('U6', XU2, 7.62, 60.5)
CY = 23.2
for _r, _x in (('C1', XU1), ('C2', XU2), ('C3', XU3 + 4.0), ('C4', XU4 - 4.5), ('C5', XU5 - 4.5)):
    place(_r, _x, CY, refxy=(_x + 3.0, CY))
place('C6', XU2, 57.75, hide_ref=True)
place('JP1', 45.6, 21.7, 90, hide_ref=True)
place('JP2', XU4 + 4.5, 22.9, refxy=(XU4 + 4.5, 20.9)); place('JP3', XU5 + 4.5, 22.9, refxy=(XU5 + 4.5, 20.9))
# left strip
place('J3', 6.3, 27.0, 0, refxy=(7.6, 24.6))
for i in range(4):
    y = 45.5 + i * 3.4
    place('D%d' % (i + 1), 3.2, y, 0, hide_ref=True); place('R%d' % (i + 4), 7.6, y, 0, hide_ref=True)
place('JP5', 5.4, 59.6, 0, hide_ref=True)
place('Y1', 5.6, 69.0, 90, refxy=(2.2, 69.0), refrot=90)
place('C11', 9.5, 66.6, 90, hide_ref=True); place('C12', 9.5, 71.4, 90, hide_ref=True)
# bottom-left: buttons, reset RC
place('SW2', 12.5, 82.5, 0, hide_ref=True); place('SW3', 21.0, 82.5, 0, hide_ref=True); place('SW4', 29.5, 82.5, 0, hide_ref=True)
place('C15', 36.3, 80.0, 0, refxy=(36.3, 78.2)); place('R3', 36.3, 83.6, 0, refxy=(36.3, 85.4))
# bottom-right: bus header, decoder
place('J2', 41.5, 83.04, 90, hide_ref=True)
place('U7', 49.5, 68.5, 90, refxy=(49.5, 68.5), refsize=0.9); place('C7', 57.3, 68.5, 90, refxy=(57.3, 65.9))
place('J5', 63.0, 70.2, 90, hide_ref=True)
place('JP4', 92.0, 68.6, 0, refxy=(92.0, 66.7))
place('C17', 92.0, 74.4, 0, refxy=(92.0, 76.3))
# top-left: USB, power
place('J1', 16.0, 3.2, 180, hide_ref=True)
place('R1', 11.2, 10.6, 0, refxy=(8.2, 10.6)); place('R2', 20.8, 10.6, 0, refxy=(23.8, 10.6))
place('F1', 26.4, 3.2, 0, refxy=(26.4, 5.2))
place('SW1', 34.3, 3.4, 0, hide_ref=True)
place('D5', 27.0, 8.6, 0, hide_ref=True); place('R8', 31.4, 8.6, 0, hide_ref=True)
place('C16', 37.6, 9.2, 0, refxy=(37.6, 11.1))
place('J7', 42.8, 3.2, 90, hide_ref=True)
place('J4', 51.0, 3.2, 90, hide_ref=True)
place('U8', 24.0, 17.6, 90, refxy=(24.0, 17.6), refsize=0.9)
place('C8', 16.4, 16.0, 90, refxy=(14.0, 16.0), refrot=90); place('C19', 16.4, 19.6, 90, hide_ref=True)
place('R9', 31.8, 16.0, 90, refxy=(33.5, 16.0), refrot=90)
place('Y2', 41.5, 16.6, 0, refxy=(41.5, 16.6))
place('C13', 33.9, 20.0, 90, hide_ref=True); place('C14', 49.3, 14.6, 90, refxy=(51.2, 14.6), refrot=90)
# top-right: SD
place('U9', 65.0, 5.4, 0, refxy=(65.0, 5.4), refsize=0.9)
place('C20', 60.0, 5.6, 90, refxy=(60.0, 8.4)); place('C18', 65.0, 10.6, 0, refxy=(65.0, 12.6))
place('U10', 67.5, 17.3, 0, refxy=(67.5, 17.3), refsize=0.8)
place('C10', 62.2, 17.3, 90, refxy=(60.4, 17.3), refrot=90)
place('R10', 56.4, 13.4, 0, refxy=(56.4, 11.6)); place('R11', 56.4, 17.0, 0, refxy=(56.4, 18.8))
place('R12', 72.4, 16.6, 90, hide_ref=True); place('R13', 74.4, 16.6, 90, hide_ref=True)
place('C21', 70.5, 11.4, 0, refxy=(70.5, 9.6)); place('JP6', 71.6, 5.0, 0, refxy=(71.6, 3.0))
place('J6', 83.0, 16.4, 0, refxy=(83.0, 18.9))
# mounting holes
for ref, (x, y) in zip(('H1', 'H2', 'H3', 'H4'), ((4.5, 4.5), (95.5, 4.5), (4.5, 84.5), (95.5, 84.5))):
    place(ref, x, y, hide_ref=True)

missing = sorted(set(comps) - set(placed))
print('unplaced:', missing)

# ---------------------------------------------------------------- SD keep-out rule area (Hirose: no conductors)
z = pcbnew.ZONE(board); z.SetIsRuleArea(True); z.SetLayer(L['F.Cu'])
z.SetDoNotAllowTracks(True); z.SetDoNotAllowVias(True); z.SetDoNotAllowPads(False)
try: z.SetDoNotAllowZoneFills(True)
except AttributeError: z.SetDoNotAllowCopperPour(True)
z.SetDoNotAllowFootprints(False); z.SetZoneName('microSD no-copper area')
o = z.Outline(); o.NewOutline()
jx, jy = 83.0, 16.4
for x, y in ((-5.05, -10.45), (3.8, -10.45), (3.8, -7.95), (-5.05, -7.95)):
    o.Append(FromMM(OX + jx + x), FromMM(OY + jy + y))
board.Add(z)

# ---------------------------------------------------------------- silkscreen
text('ABN8051', 33.0, 43.0, 0, 'F.SilkS') if False else None
text('ABN8051', 20.0, 40.0, 0, 'F.SilkS') if False else None
text('ABN8051', 60.5, 64.3, 2.2, thick=0.35, just='l')
text('DOS/51', 77.5, 64.6, 1.4, thick=0.22, just='l')
text('iMania.dk', 97.5, 63.2, 0.8, just='r'); text('rev 0.1', 97.5, 64.9, 0.8, just='r')
# chip names under the sockets (inside the DIP outline, visible before the socket is fitted) and above
def chip(xc, y, s, size=1.0): text(s, xc, y, size, rot=90)
chip(XU1 + 2.6, TOP + 24, 'P80C31', 1.4)
chip(XU2 + 1.4, TOP + 16, 'ALS873 LATCH', 0.9)
chip(XU3 + 2.6, TOP + 17, 'ROM W27C512 / 27C256', 1.0)
chip(XU4 + 2.6, TOP + 17, 'RAM0 62256 / 6264', 1.0)
chip(XU5 + 2.6, TOP + 17, 'RAM1 62256 / 6264', 1.0)
chip(XU2 + 1.4, 68.2, '74LS00', 0.9)
text('0000-7FFF CODE', XU3 - 2.6, TOP + 17, 0.8, rot=90)
text('0000-7FFF XDATA', XU4 - 2.6, TOP + 17, 0.8, rot=90)
text('8000-FFFF CODE+XDATA', XU5 - 2.6, TOP + 17, 0.8, rot=90)
# jumpers
text('JP1', 40.4, 21.7, 0.8); text('LO', 43.3, 21.7, 0.8); text('HI', 53.0, 21.7, 0.8)
text('32K', XU4 + 1.1, 22.9, 0.8); text('8K', XU4 + 7.7, 22.9, 0.8)
text('32K', XU5 + 1.1, 22.9, 0.8); text('8K', XU5 + 7.7, 22.9, 0.8)
text('RAM1 CS', 92.0, 70.8, 0.8); text('A15', 88.3, 68.6, 0.8); text('IO4', 96.0, 68.6, 0.8)
text('CD>T0', 71.6, 7.0, 0.8)
# left strip
text('P1', 3.0, 24.6, 0.9)
for i, s in enumerate(('5V 3V3', '0  1', '2  3', '4  5', '6  7', 'GND')):
    text(s, 4.6, 27.0 + i * 2.54, 0.8, just='r')
for i in range(4): text('P1.%d' % i, 10.9, 45.5 + i * 3.4, 0.8, rot=0, just='r') if False else None
text('LED P1.0-3', 5.4, 43.3, 0.8); text('LED EN', 5.4, 61.7, 0.8)
text('11.0592', 6.2, 77.4, 0.8, just='c')
text('RESET', 12.5, 87.0, 0.8); text('INT0', 21.0, 87.0, 0.8); text('INT1', 29.5, 87.0, 0.8)
# top
text('USB-C', 16.0, 10.6, 0.8)
text('POWER', 34.3, 6.4, 0.8); text('ON', 30.6, 1.0, 0.8); text('PWR', 29.2, 10.6, 0.8)
text('5V', 42.8, 5.6, 0.8); text('+', 42.8, 1.1, 0.8); text('-', 45.3, 1.1, 0.8)
text('UART', 53.5, 5.6, 0.8); text('G', 51.0, 1.1, 0.8); text('RX', 53.54, 1.1, 0.8); text('TX', 56.08, 1.1, 0.8)
text('microSD', 83.0, 1.5, 0.9); text('12MHz', 41.5, 20.2, 0.8); text('3V3', 65.0, 1.6, 0.8)
# bus header labels: odd pins (row y=80.5) above, even pins (row 83.04) below
J2N = ['5V', '5V', 'AD0', 'AD1', 'AD2', 'AD3', 'AD4', 'AD5', 'AD6', 'AD7'] + ['A%d' % i for i in range(16)] + \
      ['ALE', 'PSEN', 'RD', 'WR', 'RST', 'RST/', 'INT0', 'INT1', 'T0', 'T1', 'RXD', 'TXD', 'GND', 'GND']
for i, s in enumerate(J2N):
    x = 41.5 + (i // 2) * 2.54
    if i % 2 == 1: text(s, x, 78.6, 0.8, rot=90, just='l')
    else: text(s, x, 84.9, 0.8, rot=90, just='r')
text('BUS', 39.3, 80.6, 0.8, rot=90)
text('1', 39.4, 84.6, 0.8)
for i in range(8): text('%d' % i, 63.0 + i * 2.54, 72.8, 0.8)
text('IO SELECT', 71.9, 67.9, 0.8); text('74HC138', 49.5, 73.6, 0.8)
# back side: memory map + jumper legend, written inside the DIP outlines (no holes there)
def back(xc, yc, lines, size=1.0, pitch=2.3):
    n = len(lines)
    for i, s in enumerate(lines):
        text(s, xc + ((n - 1) / 2.0 - i) * pitch, yc, size, layer='B.SilkS', rot=90)
back(XU1, TOP + 24.1, ['ABN8051 rev 0.1 - 80C31 SBC for DOS/51', 'CODE  0000-7FFF ROM   8000-FFFF RAM1',
                       'XDATA 0000-7FFF RAM0  8000-FFFF RAM1', 'P1.0-3 LED/GPIO  P1.4-7 SD CS SCK MOSI MISO',
                       'UART 57600 8N1: USB-C (CH340G) or header'])
back(XU3, TOP + 16.5, ['JP1 = ROM pin 1 (A15 / VPP)', 'LO: W27C512 lower half', 'HI: upper half, or 27C256'])
back(XU4, TOP + 16.5, ['JP2 JP3 RAM size', '32K: 62256 (default)', '8K: 6264', 'JP5 cut: LEDs off'])
back(XU5, TOP + 16.5, ['JP4 = RAM1 chip select', 'A15: 8000-FFFF (default)', 'IO4: 8000-9FFF, fit the 138',
                       'IOn low in block n x 2000h'])

pcbnew.SaveBoard(os.path.join(HW, 'ABN8051.kicad_pcb'), board)
print('saved', len(placed), 'footprints', len(nets), 'nets')
