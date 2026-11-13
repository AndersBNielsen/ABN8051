"""Minimal KiCad S-expression parser/serializer. Atoms are kept as raw token strings
(quoted strings keep their quotes) so round-tripping is lossless apart from whitespace."""
import re
_tok = re.compile(r'\s*(\(|\)|"(?:[^"\\]|\\.)*"|[^\s()]+)')
def parse(s):
    stack=[[]]
    for m in _tok.finditer(s):
        t=m.group(1)
        if t=='(':
            l=[]; stack[-1].append(l); stack.append(l)
        elif t==')':
            stack.pop()
        else:
            stack[-1].append(t)
    return stack[0][0]
def q(s):
    return '"'+str(s).replace('\\','\\\\').replace('"','\\"').replace('\n','\\n')+'"'
def uq(t):
    if isinstance(t,str) and t.startswith('"'):
        return t[1:-1].replace('\\"','"').replace('\\\\','\\')
    return t
def dump(e,ind=0):
    if not isinstance(e,list): return e
    simple=all(not isinstance(x,list) for x in e)
    if simple: return '('+' '.join(e)+')'
    out='('+e[0] if e and not isinstance(e[0],list) else '('
    i=1 if e and not isinstance(e[0],list) else 0
    # leading atoms on same line
    while i<len(e) and not isinstance(e[i],list):
        out+=' '+e[i]; i+=1
    for x in e[i:]:
        out+='\n'+'\t'*(ind+1)+dump(x,ind+1)
    out+='\n'+'\t'*ind+')'
    return out
def find(e,name):
    return [x for x in e if isinstance(x,list) and x and x[0]==name]
def first(e,name):
    r=find(e,name); return r[0] if r else None
