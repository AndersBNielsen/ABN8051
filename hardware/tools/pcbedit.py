"""Direct edits of ABN8051.kicad_pcb with KiCad's pcbnew (rev 0.2 onwards). Run with KiCad's python:
/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3

Coordinates are board-relative mm (origin = top-left board corner), as in pcbgen.py.
"""
import os, subprocess, sys, tempfile
import pcbnew
from pcbnew import VECTOR2I, FromMM, ToMM

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from sexp import parse, find, first, uq   # noqa: E402

HW = os.path.dirname(HERE)
PCB = os.path.join(HW, 'ABN8051.kicad_pcb')
SCH = os.path.join(HW, 'ABN8051.kicad_sch')
PRO = os.path.join(HW, 'ABN8051.kicad_pro')
KCLI = '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
FPDIR = '/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints'
OX, OY = 100.0, 60.0
LAYER = {'F.SilkS': pcbnew.F_SilkS, 'B.SilkS': pcbnew.B_SilkS, 'F.Fab': pcbnew.F_Fab, 'B.Fab': pcbnew.B_Fab,
         'Cmts.User': pcbnew.Cmts_User, 'Dwgs.User': pcbnew.Dwgs_User, 'Edge.Cuts': pcbnew.Edge_Cuts}


def P(x, y): return VECTOR2I(FromMM(OX + x), FromMM(OY + y))
def xy(v): return (round(ToMM(v.x) - OX, 4), round(ToMM(v.y) - OY, 4))


def netlist():
    """({ref: {value, fp, ts, fields, dnp, in_bom}}, {(ref, pad): net}) from the current schematic"""
    out = os.path.join(tempfile.mkdtemp(), 'n.net')
    subprocess.run([KCLI, 'sch', 'export', 'netlist', '--format', 'kicadsexpr', '-o', out, SCH],
                   check=True, capture_output=True)
    t = parse(open(out).read())
    comps = {}
    for c in find(first(t, 'components'), 'comp'):
        d = {'value': uq(first(c, 'value')[1]), 'fp': uq(first(c, 'footprint')[1]), 'fields': {},
             'ts': uq(first(c, 'tstamps')[1]), 'dnp': False, 'in_bom': True}
        fl = first(c, 'fields')
        for f in (find(fl, 'field') if fl else []):
            d['fields'][uq(first(f, 'name')[1])] = uq(f[2]) if len(f) > 2 else ''
        for p in find(c, 'property'):
            n = uq(first(p, 'name')[1])
            if n == 'dnp': d['dnp'] = True
            if n == 'exclude_from_bom': d['in_bom'] = False
        ds = first(c, 'datasheet'); de = first(c, 'description')
        d['datasheet'] = uq(ds[1]) if ds and len(ds) > 1 else ''
        d['description'] = uq(de[1]) if de and len(de) > 1 else ''
        comps[uq(first(c, 'ref')[1])] = d
    padnet = {}
    for n in find(first(t, 'nets'), 'net'):
        name = uq(first(n, 'name')[1])
        for x in find(n, 'node'):
            padnet[(uq(first(x, 'ref')[1]), uq(first(x, 'pin')[1]))] = name
    return comps, padnet


def load():
    return pcbnew.LoadBoard(PCB)


def save(board):
    pro = open(PRO).read()
    pcbnew.SaveBoard(PCB, board)
    if open(PRO).read() != pro:              # never let a save touch the project rules
        open(PRO, 'w').write(pro)


def fp_by_ref(board):
    return {f.GetReference(): f for f in board.GetFootprints()}


def net(board, name):
    ni = board.FindNet(name)
    if ni is None:
        ni = pcbnew.NETINFO_ITEM(board, name); board.Add(ni)
    return ni


def apply_nets(board, fp, padnet):
    ref = fp.GetReference()
    for pad in fp.Pads():
        nn = padnet.get((ref, pad.GetNumber()))
        if nn: pad.SetNet(net(board, nn))


def sync_fields(fp, c):
    """symbol link, value, fields and attributes as 'Update PCB from Schematic' would set them"""
    fp.SetValue(c['value'])
    fp.SetPath(pcbnew.KIID_PATH('/' + c['ts']))
    fl = dict(c['fields'])
    fl['Datasheet'] = c.get('datasheet') or fl.get('Datasheet', '')
    fl['Description'] = c.get('description') or fl.get('Description', '')
    for k, v in fl.items():
        if k in ('Footprint', 'Reference', 'Value'): continue
        if v in ('', '~') and k not in ('Datasheet', 'Description'): continue
        fp.SetField(k, '' if v == '~' else v)
    for fld in fp.GetFields():
        if not fld.IsReference():
            fld.SetVisible(False)
            fld.SetLayer(pcbnew.B_Fab if fp.GetLayer() == pcbnew.B_Cu else pcbnew.F_Fab)
    fp.SetDNP(c['dnp'])
    fp.SetExcludedFromBOM(not c['in_bom'])


def add_fp(board, comps, padnet, ref, x, y, rot=0, refxy=None, refrot=0, hide_ref=False, refsize=0.8):
    c = comps[ref]
    lib, name = c['fp'].split(':')
    libdir = os.path.join(HW, lib + '.pretty') if lib == 'ABN8051' else os.path.join(FPDIR, lib + '.pretty')
    fp = pcbnew.FootprintLoad(libdir, name)
    assert fp, c['fp']
    fp.SetFPID(pcbnew.LIB_ID(lib, name))
    fp.SetReference(ref)
    board.Add(fp)
    fp.SetPosition(P(x, y)); fp.SetOrientationDegrees(rot)
    sync_fields(fp, c)
    apply_nets(board, fp, padnet)
    r = fp.Reference()
    r.SetTextSize(VECTOR2I(FromMM(refsize), FromMM(refsize))); r.SetTextThickness(FromMM(0.13))
    if refxy:
        r.SetPosition(P(*refxy)); r.SetTextAngleDegrees(refrot)
    if hide_ref: r.SetVisible(False)
    return fp


def text(board, s, x, y, size=0.8, layer='F.SilkS', rot=0, just='c', thick=None):
    tx = pcbnew.PCB_TEXT(board)
    tx.SetText(s); tx.SetLayer(LAYER[layer]); tx.SetPosition(P(x, y))
    tx.SetTextSize(VECTOR2I(FromMM(size), FromMM(size)))
    tx.SetTextThickness(FromMM(thick or max(0.13, size * 0.15)))
    tx.SetTextAngleDegrees(rot)
    tx.SetHorizJustify({'l': pcbnew.GR_TEXT_H_ALIGN_LEFT, 'c': pcbnew.GR_TEXT_H_ALIGN_CENTER,
                        'r': pcbnew.GR_TEXT_H_ALIGN_RIGHT}[just])
    if layer.startswith('B.'): tx.SetMirrored(True)
    board.Add(tx); return tx


def line(board, x1, y1, x2, y2, layer='F.SilkS', w=0.15):
    s = pcbnew.PCB_SHAPE(board); s.SetShape(pcbnew.SHAPE_T_SEGMENT)
    s.SetStart(P(x1, y1)); s.SetEnd(P(x2, y2)); s.SetLayer(LAYER[layer]); s.SetWidth(FromMM(w))
    board.Add(s); return s


def texts(board):
    """{(text, layer name): PCB_TEXT} for free board texts"""
    out = {}
    for d in board.GetDrawings():
        if isinstance(d, pcbnew.PCB_TEXT) or d.GetClass() == 'PCB_TEXT':
            d = d.Cast() if hasattr(d, 'Cast') else d
            out.setdefault((d.GetText(), board.GetLayerName(d.GetLayer())), []).append(d)
    return out


def report(board, x1, y1, x2, y2):
    """courtyard boxes and free texts inside a window: placement aid"""
    for f in sorted(board.GetFootprints(), key=lambda f: f.GetReference()):
        bb = f.GetCourtyard(f.GetLayer()).BBox() if f.GetCourtyard(f.GetLayer()).OutlineCount() else f.GetBoundingBox(False)
        a = xy(VECTOR2I(bb.GetLeft(), bb.GetTop())); b = xy(VECTOR2I(bb.GetRight(), bb.GetBottom()))
        if a[0] <= x2 and b[0] >= x1 and a[1] <= y2 and b[1] >= y1:
            print('FP  %-5s %-6s crtyd x %.2f..%.2f y %.2f..%.2f  at %s rot %g' % (
                f.GetReference(), 'back' if f.GetLayer() == pcbnew.B_Cu else 'front', a[0], b[0], a[1], b[1],
                xy(f.GetPosition()), f.GetOrientationDegrees()))
            r = f.Reference()
            if r.IsVisible():
                bb = r.GetBoundingBox()
                print('      ref text x %.2f..%.2f y %.2f..%.2f' % (
                    ToMM(bb.GetLeft()) - OX, ToMM(bb.GetRight()) - OX, ToMM(bb.GetTop()) - OY, ToMM(bb.GetBottom()) - OY))
    for d in board.GetDrawings():
        if d.GetClass() == 'PCB_TEXT':
            bb = d.GetBoundingBox()
            a = (ToMM(bb.GetLeft()) - OX, ToMM(bb.GetTop()) - OY); b = (ToMM(bb.GetRight()) - OX, ToMM(bb.GetBottom()) - OY)
            if a[0] <= x2 and b[0] >= x1 and a[1] <= y2 and b[1] >= y1:
                print('TXT %-7s %-28r x %.2f..%.2f y %.2f..%.2f' % (board.GetLayerName(d.GetLayer()), d.Cast().GetText() if hasattr(d, 'Cast') else d.GetText(), a[0], b[0], a[1], b[1]))


if __name__ == '__main__':
    report(load(), *map(float, sys.argv[1:5]))
