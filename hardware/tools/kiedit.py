"""Direct edits of the hand-maintained KiCad schematic (rev 0.2 onwards).

design.py / pcbgen.py generated rev 0.1 and must not be re-run: the schematic has been edited in
KiCad since. This module appends new symbols/wires/labels to ABN8051.kicad_sch as text and lets
kicad-cli re-save it, so everything already in the file is left alone.

Plain python3 (no pcbnew needed).
"""
import os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from sexp import parse, find, first, uq, q, dump   # noqa: E402
import libsym                                        # noqa: E402
from schgen import Sch, G                            # noqa: E402

HW = os.path.dirname(HERE)
SCH = os.path.join(HW, 'ABN8051.kicad_sch')
SYMLIB = os.path.join(HW, 'ABN8051.kicad_sym')
KCLI = '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'


def block_end(t, i):
    """index just past the ')' matching the '(' at t[i]; honours quoted strings"""
    assert t[i] == '('
    depth = 0; j = i; n = len(t)
    while j < n:
        c = t[j]
        if c == '"':
            j += 1
            while t[j] != '"':
                j += 2 if t[j] == '\\' else 1
        elif c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
            if depth == 0: return j + 1
        j += 1
    raise ValueError('unbalanced')


def top_blocks(t, name):
    """(start, end) of every top-level (name ...) block of a KiCad-saved file (one tab indent)"""
    out = []
    for m in re.finditer(r'^\t\(%s\b' % re.escape(name), t, re.M):
        i = m.start() + 1
        out.append((i, block_end(t, i)))
    return out


def symbol_block(t, ref, unit=None):
    """(start, end) of the placed symbol with this reference"""
    for a, b in top_blocks(t, 'symbol'):
        blk = t[a:b]
        if '(property "Reference" %s' % q(ref) in blk and (unit is None or '\n\t\t(unit %d)' % unit in blk):
            return a, b
    raise KeyError(ref)


def session(step):
    """Sch object whose UUIDs and #PWR numbers continue after what is in the file"""
    t = open(SCH).read()
    s = Sch('ABN8051')
    s.root = re.search(r'^\t\(uuid "([^"]+)"\)', t, re.M).group(1)
    s.n = step * 100000                      # uuid5 counter: rev 0.1 used < 100000
    s.pwr = max(int(x) for x in re.findall(r'"Reference" "#(?:PWR|FLG)0*(\d+)"', t))
    return s


def commit(s, edit=None):
    """append s.items (and lib symbols the file does not embed yet); edit(text) -> text for in-place changes"""
    t = open(SCH).read()
    if edit: t = edit(t)
    a, b = top_blocks(t, 'lib_symbols')[0]
    have = set(re.findall(r'^\t\t\(symbol "([^"]+)"', t[a:b], re.M))
    libs = ''.join('\t\t' + dump(v, 2) + '\n' for k, v in sorted(s.libsyms.items()) if k not in have)
    t = t[:b - 1].rstrip('\t') + libs + '\t' + t[b - 1:]
    k = t.index('\n\t(sheet_instances') + 1
    t = t[:k] + ''.join('\t' + dump(x, 1) + '\n' for x in s.items) + t[k:]
    open(SCH, 'w').write(t)
    resave()


def resave():
    """let KiCad rewrite the file in its own format (also proves that it parses)"""
    r = subprocess.run([KCLI, 'sch', 'upgrade', '--force', SCH], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    t = open(SCH).read()
    if '(embedded_fonts' not in t[-200:]:    # kicad-cli drops it, the GUI writes it
        k = t.rstrip().rfind(')')
        t = t[:k] + '\t(embedded_fonts no)\n' + t[k:]
        open(SCH, 'w').write(t)


def set_property(blk, name, value):
    m = re.search(r'\(property %s "((?:[^"\\]|\\.)*)"' % re.escape(q(name)), blk)
    assert m, name
    return blk[:m.start(1)] + value.replace('\\', '\\\\').replace('"', '\\"') + blk[m.end(1):]


def add_lib_symbol(sym):
    """append a symbol (sexp, plain name) to the project symbol library unless it is already there"""
    t = open(SYMLIB).read()
    name = uq(sym[1])
    if re.search(r'\(symbol %s\b' % re.escape(q(name)), t): return False
    k = t.rstrip().rfind(')')
    open(SYMLIB, 'w').write(t[:k].rstrip() + '\n\t' + dump(sym, 1) + '\n)\n')
    return True
