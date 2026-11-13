"""Small schematic writer for KiCad 10 (.kicad_sch) with a net model for verification."""
import uuid, os, copy
from sexp import *
import libsym

NS = uuid.UUID('8051ab00-0000-4000-8000-000000000000')
G = 2.54
POWER = {'GND': 'power:GND', '+5V': 'power:+5V', '+3V3': 'power:+3V3'}

def f(v):
    s = ('%.4f' % v).rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s

def font(size=1.27, bold=False):
    e = ['font', ['size', f(size), f(size)]]
    if bold: e.append(['bold', 'yes'])
    return e

class Sch:
    def __init__(self, project, paper='A2', title='', rev='', date='', company='', comments=()):
        self.project = project
        self.paper = paper
        self.tb = (title, rev, date, company, comments)
        self.n = 0
        self.root = self.uid('root')
        self.libsyms = {}     # libid -> sexp
        self.libpins = {}
        self.items = []
        self.model = {}       # net -> set((ref,pin))
        self.comps = {}       # ref -> dict
        self.pwr = 0
        self.unit_uuids = {}

    def uid(self, key=None):
        self.n += 1
        return str(uuid.uuid5(NS, '%s-%d' % (key or 'x', self.n)))

    # ---- library -------------------------------------------------------
    def lib(self, libid, libpath=None):
        if libid not in self.libsyms:
            lib, name = libid.split(':')
            s = libsym.get_symbol(lib, name, libpath)
            self.libsyms[libid] = s
            self.libpins[libid] = libsym.pins(s)
        return self.libsyms[libid], self.libpins[libid]

    # ---- primitives ----------------------------------------------------
    def wire(self, *pts):
        """pts in mm; polyline"""
        for a, b in zip(pts, pts[1:]):
            self.items.append(['wire', ['pts', ['xy', f(a[0]), f(a[1])], ['xy', f(b[0]), f(b[1])]],
                               ['stroke', ['width', '0'], ['type', 'default']], ['uuid', q(self.uid('w'))]])

    def junction(self, x, y):
        self.items.append(['junction', ['at', f(x), f(y)], ['diameter', '0'], ['color', '0', '0', '0', '0'],
                           ['uuid', q(self.uid('j'))]])

    def nc(self, x, y):
        self.items.append(['no_connect', ['at', f(x), f(y)], ['uuid', q(self.uid('nc'))]])

    def label(self, name, x, y, d=(1, 0)):
        ang, just = {(1, 0): (0, 'left'), (-1, 0): (180, 'right'), (0, -1): (90, 'left'), (0, 1): (270, 'right')}[d]
        self.items.append(['label', q(name), ['at', f(x), f(y), str(ang)],
                           ['effects', font(), ['justify', just, 'bottom']], ['uuid', q(self.uid('l'))]])

    def text(self, s, x, y, size=1.27, bold=False, just='left bottom'):
        self.items.append(['text', q(s), ['exclude_from_sim', 'no'], ['at', f(x), f(y), '0'],
                           ['effects', font(size, bold), ['justify'] + just.split()], ['uuid', q(self.uid('t'))]])

    def box(self, x1, y1, x2, y2, title=None):
        self.items.append(['rectangle', ['start', f(x1), f(y1)], ['end', f(x2), f(y2)],
                           ['stroke', ['width', '0.2'], ['type', 'dash']], ['fill', ['type', 'none']],
                           ['uuid', q(self.uid('r'))]])
        if title:
            self.text(title, x1 + 1.5, y1 + 4.2, size=2.2, bold=True)

    def power(self, net, x, y, d=(0, 1)):
        """power symbol with its pin at x,y; graphic extends along d (screen coords)"""
        libid = POWER[net]
        natural = (0, 1) if net == 'GND' else (0, -1)
        # rotation needed (KiCad rotates CCW on screen for positive angle)
        order = [(0, -1), (-1, 0), (0, 1), (1, 0)]  # up, left, down, right = successive 90deg CCW steps
        rot = ((order.index(d) - order.index(natural)) % 4) * 90
        self.pwr += 1
        ref = '#PWR%03d' % self.pwr
        self._inst(libid, ref, net, x, y, rot, 1, '', {}, power=True, d=d)

    def flag(self, x, y, d=(0, -1)):
        order = [(0, -1), (-1, 0), (0, 1), (1, 0)]
        rot = (order.index(d) % 4) * 90
        self.pwr += 1
        self._inst('power:PWR_FLAG', '#FLG%03d' % self.pwr, 'PWR_FLAG', x, y, rot, 1, '', {}, power=True, d=d)

    # ---- symbols -------------------------------------------------------
    @staticmethod
    def xf(rot, x, y):
        """symbol-local (y up) -> screen offset (y down) for rotation rot"""
        if rot == 0: return (x, -y)
        if rot == 90: return (-y, -x)
        if rot == 180: return (-x, y)
        if rot == 270: return (y, x)
        raise ValueError(rot)

    def pinpos(self, libid, unit, num, X, Y, rot=0):
        _, P = self.lib(libid)
        p = P.get(unit, {}).get(num) or P.get(0, {}).get(num)
        dx, dy = self.xf(rot, p[0], p[1])
        return (X + dx, Y + dy)

    def _inst(self, libid, ref, value, X, Y, rot, unit, fp, props, power=False, d=None, refpos=None, valpos=None,
              libpath=None, showval=True, dnp=False):
        sym, P = self.lib(libid, libpath)
        u = self.uid(ref)
        e = ['symbol', ['lib_id', q(libid)], ['at', f(X), f(Y), str(rot)], ['unit', str(unit)], ['body_style', '1'],
             ['exclude_from_sim', 'no'], ['in_bom', 'no' if power else 'yes'], ['on_board', 'no' if power else 'yes'],
             ['in_pos_files', 'yes'], ['dnp', 'yes' if dnp else 'no'], ['uuid', q(u)]]
        tang = 90 if rot in (90, 270) else 0

        def P_(name, val, x, y, hide=False, just=None, ang=None):
            p = ['property', q(name), q(val), ['at', f(x), f(y), str(tang if ang is None else ang)]]
            if hide: p.append(['hide', 'yes'])
            p += [['show_name', 'no'], ['do_not_autoplace', 'no']]
            eff = ['effects', font()]
            if just: eff.append(['justify'] + just.split())
            p.append(eff)
            e.append(p)

        def libprop(name):
            lp = libsym.prop(sym, name)
            at = first(lp, 'at')
            eff = first(lp, 'effects')
            j = first(eff, 'justify') if eff else None
            return float(at[1]), float(at[2]), (' '.join(j[1:]) if j else None)

        if power:
            if ref.startswith('#FLG'):
                P_('Reference', ref, X, Y, hide=True)
                P_('Value', value, X + 3 * d[0], Y + 3 * d[1] - (0 if d[1] else 0), hide=True)
            else:
                P_('Reference', ref, X, Y, hide=True)
                off = 3.6 if value != 'GND' else 5.2
                vx, vy = X + off * d[0], Y + off * d[1]
                just = None
                if d[0] == 1: just = 'left'
                if d[0] == -1: just = 'right'
                if rot == 90 and just: just = {'left': 'right', 'right': 'left'}[just]
                P_('Value', value, vx, vy, just=just, ang=(90 if rot in (90, 270) else 0))
        else:
            if refpos is None:
                px, py, j = libprop('Reference')
                dx, dy = self.xf(rot, px, py) if rot == 0 else (0, -3.0)
                rx, ry, rj = X + dx, Y + dy, (j if rot == 0 else None)
            else:
                rx, ry, rj = X + refpos[0], Y + refpos[1], (refpos[2] if len(refpos) > 2 else None)
            if valpos is None:
                px, py, j = libprop('Value')
                dx, dy = self.xf(rot, px, py) if rot == 0 else (0, 3.0)
                vx, vy, vj = X + dx, Y + dy, (j if rot == 0 else None)
            else:
                vx, vy, vj = X + valpos[0], Y + valpos[1], (valpos[2] if len(valpos) > 2 else None)
            P_('Reference', ref, rx, ry, just=rj)
            P_('Value', value, vx, vy, just=vj, hide=not showval)
        P_('Footprint', fp, X, Y, hide=True, ang=0)
        ds = libsym.prop(sym, 'Datasheet')
        P_('Datasheet', props.get('Datasheet', uq(ds[2]) if ds else ''), X, Y, hide=True, ang=0)
        de = libsym.prop(sym, 'Description')
        P_('Description', props.get('Description', uq(de[2]) if de else ''), X, Y, hide=True, ang=0)
        for k, v in props.items():
            if k in ('Datasheet', 'Description'): continue
            P_(k, v, X, Y, hide=True, ang=0)
        allp = {}
        for uu in P.values(): allp.update(uu)
        for num in sorted(allp):
            e.append(['pin', q(num), ['uuid', q(self.uid(ref + num))]])
        e.append(['instances', ['project', q(self.project),
                                ['path', q('/' + self.root), ['reference', q(ref)], ['unit', str(unit)]]]])
        self.items.append(e)
        if not power:
            self.unit_uuids.setdefault(ref, []).append(u)
        return u

    def place(self, libid, ref, value, gx, gy, nets=None, rot=0, unit=1, fp='', props=None, draw=None, stub=2,
              stubs=None, libpath=None, refpos=None, valpos=None, showval=True, dnp=False, ncall=True):
        """gx,gy in grid units (2.54mm). nets: {pin: net}. draw: {pin: 'L'|'N'} override (default label/power).
        stub: stub length in grid units (default) ; stubs: per-pin override."""
        nets = nets or {}; draw = draw or {}; props = props or {}; stubs = stubs or {}
        X, Y = gx * G, gy * G
        sym, P = self.lib(libid, libpath)
        self._inst(libid, ref, value, X, Y, rot, unit, fp, props, refpos=refpos, valpos=valpos, libpath=libpath,
                   showval=showval, dnp=dnp)
        c = self.comps.setdefault(ref, {'value': value, 'fp': fp, 'props': props, 'libid': libid, 'dnp': dnp})
        pins = dict(P.get(0, {})); pins.update(P.get(unit, {}))
        done = set()
        out = {}
        for num, (px, py, ang, name, ptype) in pins.items():
            dx, dy = self.xf(rot, px, py)
            x, y = X + dx, Y + dy
            out[num] = (x, y)
            import math
            ox, oy = -round(math.cos(math.radians(ang))), -round(math.sin(math.radians(ang)))
            d = self.xf(rot, ox, oy)
            d = (int(round(d[0])), int(round(d[1])))
            if num not in nets:
                if ptype != 'no_connect' and ncall and (round(x, 2), round(y, 2)) not in done:
                    self.nc(x, y); done.add((round(x, 2), round(y, 2)))
                continue
            net = nets[num]
            self.model.setdefault(net, set()).add((ref, num))
            mode = draw.get(num, 'L')
            key = (round(x, 2), round(y, 2))
            if mode == 'N' or key in done: continue
            done.add(key)
            L = stubs.get(num, stub) * G
            ex, ey = x + d[0] * L, y + d[1] * L
            if net in POWER:
                Lp = stubs.get(num, 1) * G
                ex, ey = x + d[0] * Lp, y + d[1] * Lp
                if Lp: self.wire((x, y), (ex, ey))
                self.power(net, ex, ey, d)
            else:
                if L: self.wire((x, y), (ex, ey))
                self.label(net, ex, ey, d)
        return out

    def connect(self, net, ref, pin):
        self.model.setdefault(net, set()).add((ref, pin))

    # ---- output --------------------------------------------------------
    def dump(self):
        title, rev, date, company, comments = self.tb
        tb = ['title_block', ['title', q(title)], ['date', q(date)], ['rev', q(rev)], ['company', q(company)]]
        for i, c in enumerate(comments, 1): tb.append(['comment', str(i), q(c)])
        top = ['kicad_sch', ['version', '20260306'], ['generator', q('eeschema')], ['generator_version', q('10.0')],
               ['uuid', q(self.root)], ['paper', q(self.paper)], tb,
               ['lib_symbols'] + [self.libsyms[k] for k in sorted(self.libsyms)]]
        top += self.items
        top += [['sheet_instances', ['path', q('/'), ['page', q('1')]]], ['embedded_fonts', 'no']]
        return dump(top) + '\n'


def mk_ic(name, left=(), right=(), top=(), bottom=(), hw=4, ref='U', title=None, footprint='', datasheet='',
          desc='', fpfilter=''):
    """Rectangular symbol. pins: (number, name, type) or None for a gap. Units: grid of 2.54mm. hw = half width."""
    rows = max(len(left), len(right), 1)
    hh = (rows + 1) / 2.0
    def fnt(): return ['effects', ['font', ['size', '1.27', '1.27']]]
    s = ['symbol', q(name), ['pin_names', ['offset', '1.016']], ['exclude_from_sim', 'no'], ['in_bom', 'yes'],
         ['on_board', 'yes'], ['in_pos_files', 'yes'], ['duplicate_pin_numbers_are_jumpers', 'no']]
    def prop(n, v, x, y, hide=False, just=None):
        p = ['property', q(n), q(v), ['at', f(x), f(y), '0']]
        if hide: p.append(['hide', 'yes'])
        p += [['show_name', 'no'], ['do_not_autoplace', 'no']]
        eff = ['effects', ['font', ['size', '1.27', '1.27']]]
        if just: eff.append(['justify', just])
        p.append(eff); s.append(p)
    prop('Reference', ref, -hw * G, hh * G + 1.6, just='left')
    prop('Value', title or name, 0.6 * G, hh * G + 1.6, just='left')
    prop('Footprint', footprint, 0, 0, hide=True)
    prop('Datasheet', datasheet, 0, 0, hide=True)
    prop('Description', desc, 0, 0, hide=True)
    body = ['symbol', q(name + '_0_1'), ['rectangle', ['start', f(-hw * G), f(hh * G)], ['end', f(hw * G), f(-hh * G)],
                                        ['stroke', ['width', '0.254'], ['type', 'default']],
                                        ['fill', ['type', 'background']]]]
    s.append(body)
    u = ['symbol', q(name + '_1_1')]
    def pin(p, x, y, ang):
        num, nm, typ = p
        u.append(['pin', typ, 'line', ['at', f(x), f(y), str(ang)], ['length', '2.54'], ['name', q(nm), fnt()],
                  ['number', q(num), fnt()]])
    y0 = (rows - 1) / 2.0
    for i, p in enumerate(left):
        if p: pin(p, -(hw + 1) * G, (y0 - i) * G, 0)
    for i, p in enumerate(right):
        if p: pin(p, (hw + 1) * G, (y0 - i) * G, 180)
    def spread(lst):
        n = len(lst); return [(i - (n - 1) / 2.0) for i in range(n)]
    for xo, p in zip(spread(top), top):
        if p: pin(p, xo * G, (hh + 1) * G, 270)
    for xo, p in zip(spread(bottom), bottom):
        if p: pin(p, xo * G, -(hh + 1) * G, 90)
    s.append(u)
    s.append(['embedded_fonts', 'no'])
    return s


def write_symlib(path, syms):
    top = ['kicad_symbol_lib', ['version', '20251024'], ['generator', q('kicad_symbol_editor')],
           ['generator_version', q('10.0')]] + syms
    open(path, 'w').write(dump(top) + '\n')
