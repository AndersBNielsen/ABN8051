import sys,json
from sexp import *
t=parse(open(sys.argv[1]).read())
m=json.load(open('model.json'))
nets={}
for n in find(first(t,'nets'),'net'):
    name=uq(first(n,'name')[1])
    nodes=set((uq(first(x,'ref')[1]),uq(first(x,'pin')[1])) for x in find(n,'node'))
    nets[name]=nodes
model={k:set(map(tuple,v)) for k,v in m['nets'].items()}
def norm(n): return n.lstrip('/')
real={norm(k):v for k,v in nets.items()}
ok=True
for k,v in model.items():
    r=real.get(k)
    if r is None and v in real.values(): continue
    if r!=v:
        ok=False; print('MISMATCH',k,'model-only',sorted(v-(r or set())),'real-only',sorted((r or set())-v))
for k,v in real.items():
    if k not in model and v not in model.values() and not k.startswith('unconnected'):
        ok=False; print('EXTRA net',k,sorted(v))
comps={uq(first(c,'ref')[1]):c for c in find(first(t,'components'),'comp')}
print('comps',len(comps),'model comps',len(m['comps']),'missing',sorted(set(m['comps'])-set(comps)))
print('NETLIST MATCHES MODEL' if ok else 'DIFFERENCES')
print('nets',len(real),'unconnected',sum(1 for k in real if k.startswith('unconnected')))
