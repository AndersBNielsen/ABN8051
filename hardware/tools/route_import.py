"""Import a Freerouting SES onto a copy of the unrouted board and widen neck-down segments to the
board minimum where KiCad's DRC allows it.  <kicad python> route_import.py UNROUTED.kicad_pcb SES OUT.kicad_pcb
OUT must sit next to ABN8051.kicad_pro under the same basename so DRC uses the project rules."""
import json, os, subprocess, sys, tempfile
import pcbnew

src, ses, out = sys.argv[1:4]
KCLI = '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
MINW = pcbnew.FromMM(0.2)

b = pcbnew.LoadBoard(src)
assert pcbnew.ImportSpecctraSES(b, ses)
pcbnew.SaveBoard(out, b)


def drc(path):
    rep = tempfile.mktemp(suffix='.json')
    subprocess.run([KCLI, 'pcb', 'drc', '--format', 'json', '--severity-all', '--refill-zones', '-o', rep, path],
                   capture_output=True)
    return json.load(open(rep))


def bad_uuids(d):
    s = set()
    for v in d['violations']:
        if v['type'] in ('clearance', 'shorting_items', 'tracks_crossing', 'hole_clearance', 'copper_edge_clearance',
                         'solder_mask_bridge'):
            for it in v['items']:
                s.add(it['uuid'])
    return s


base = bad_uuids(drc(out))
b = pcbnew.LoadBoard(out)
thin = {t.m_Uuid.AsString(): t.GetWidth() for t in b.GetTracks()
        if t.GetClass() == 'PCB_TRACK' and t.GetWidth() < MINW}
print('thin segments', len(thin), 'baseline copper errors', len(base))
for _ in range(6):
    b = pcbnew.LoadBoard(out)
    for t in b.GetTracks():
        u = t.m_Uuid.AsString()
        if u in thin and t.GetWidth() < MINW:
            t.SetWidth(MINW)
    pcbnew.SaveBoard(out, b)
    new = bad_uuids(drc(out)) - base
    culprits = new & set(thin)
    print('widened; new copper errors', len(new), 'reverting', len(culprits))
    if not culprits:
        break
    b = pcbnew.LoadBoard(out)
    for t in b.GetTracks():
        u = t.m_Uuid.AsString()
        if u in culprits:
            t.SetWidth(thin.pop(u))
    pcbnew.SaveBoard(out, b)
b = pcbnew.LoadBoard(out)
left = [pcbnew.ToMM(t.GetWidth()) for t in b.GetTracks() if t.GetClass() == 'PCB_TRACK' and t.GetWidth() < MINW]
print('still thin', len(left), sorted(set(left)))
