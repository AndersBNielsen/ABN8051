import os,copy
from sexp import *
SYMDIR='/Applications/KiCad/KiCad.app/Contents/SharedSupport/symbols'
_cache={}
def load_lib(path):
    if path not in _cache:
        t=parse(open(path).read())
        _cache[path]={uq(s[1]):s for s in find(t,'symbol')}
    return _cache[path]
def get_symbol(lib,name,libpath=None):
    """Return flattened symbol sexp named "lib:name" for embedding in lib_symbols."""
    L=load_lib(libpath or os.path.join(SYMDIR,lib+'.kicad_sym'))
    s=copy.deepcopy(L[name])
    ext=first(s,'extends')
    if ext:
        pname=uq(ext[1])
        p=copy.deepcopy(L[pname])
        assert not first(p,'extends'), 'nested extends'
        # child properties override parent's
        cprops={uq(x[1]):x for x in find(s,'property')}
        new=[]
        for x in p:
            if isinstance(x,list) and x[0]=='property':
                n=uq(x[1])
                if n in cprops: new.append(cprops.pop(n))
                else: new.append(x)
            elif isinstance(x,list) and x[0]=='symbol':
                x[1]=q(uq(x[1]).replace(pname,name,1)); new.append(x)
            else: new.append(x)
        # insert remaining child props after last property
        idx=max(i for i,x in enumerate(new) if isinstance(x,list) and x[0]=='property')+1
        for x in cprops.values(): new.insert(idx,x); idx+=1
        s=new
    s[1]=q(lib+':'+name)
    return s
def pins(sym):
    """{unit: {number: (x,y,angle,name,type)}}; unit 0 = common"""
    out={}
    for sub in find(sym,'symbol'):
        nm=uq(sub[1]); u=int(nm.rsplit('_',2)[1]); st=int(nm.rsplit('_',2)[2])
        if st>1: continue
        for p in find(sub,'pin'):
            at=first(p,'at'); num=uq(first(p,'number')[1]); name=uq(first(p,'name')[1])
            out.setdefault(u,{})[num]=(float(at[1]),float(at[2]),int(float(at[3])) if len(at)>3 else 0,name,p[1])
    return out
def prop(sym,name):
    for x in find(sym,'property'):
        if uq(x[1])==name: return x
if __name__=='__main__':
    import sys
    for a in sys.argv[1:]:
        lib,name=a.split(':')
        s=get_symbol(lib,name)
        P=pins(s)
        print('==',a,'ref',uq(prop(s,'Reference')[2]),'units',sorted(P))
        for u in sorted(P):
            print(' unit',u,' '.join(f"{n}:{v[3]}@{v[0]:g},{v[1]:g},{v[2]}" for n,v in sorted(P[u].items(),key=lambda kv:(len(kv[0]),kv[0]))))
