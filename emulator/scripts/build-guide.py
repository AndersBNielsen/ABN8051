#!/usr/bin/env python3
"""Build the searchable web companion and RAM-disk-sized ASCII chapters."""
from pathlib import Path
import json,html,textwrap,zipfile
root=Path(__file__).resolve().parents[1]
out=root/'site/guide'; data=json.loads((out/'content.json').read_text())
ops=json.loads((out/'opcodes.json').read_text())
e=html.escape
flags={'ADD':'CY AC OV','ADDC':'CY AC OV','SUBB':'CY AC OV','MUL':'CY=0 OV','DIV':'CY=0 OV','DA':'CY','CJNE':'CY','RLC':'CY','RRC':'CY'}
def flag(m,form):
 if form.startswith(('ANL C,','ORL C,','MOV C,','CLR C','CPL C','SETB C')):return 'CY'
 return flags.get(m,'—')
# Combine encoded register numbers / 2-KB page selectors into operand forms.
forms={}
for op in ops:
 if op['op']==165:continue
 import re
 key=re.sub(r'@R[01]', '@Ri', re.sub(r'(?<!@)R[0-7]', 'Rn',op['form']))
 forms.setdefault(key,[]).append(op)
assert len(forms)==111,len(forms)
assert len(data['instructions'])==44
ascii_dir=out/'ascii';ascii_dir.mkdir(exist_ok=True)
bar='+'+'-'*72+'+'
def textfile(name,title,body):
 banner=bar+'\n| '+title.center(70)+' |\n'+bar+'\n'
 lines=[]
 for line in body.splitlines():
  if line.startswith(' ') or line.startswith(('00-','08-','10-','18-','20-','30-','80-')):lines.append(line)
  else:lines.extend(textwrap.wrap(line,74,break_long_words=False,break_on_hyphens=False) or [''])
 content=banner+'\n'+'\n'.join(lines)+'\n\n[ DOS/51 FIELD MANUAL | IMANIA.DK | 2026-11-14 ]\n'
 content.encode('ascii');assert len(content)<19000,(name,len(content))
 (ascii_dir/name).write_bytes(content.encode('ascii'))
for c in data['chapters']:textfile(c['file'],c['title'],c['text'])
ref=[]
for m,(cat,desc,example,note) in sorted(data['instructions'].items()):
 ref.extend([m+' / '+cat.upper(),'-'*40,desc,'','Example: '+example,'Watch: '+note,'','OPERANDS                          BYTES MC  FLAGS'])
 for f,rr in forms.items():
  if f.split()[0]==m:
   r=rr[0];ref.append(f'{f:<34} {r["bytes"]}    {r["cycles"]}  '+flag(m,f).replace('—','-'))
 ref.append('')
# Two balanced instruction volumes fit beside the existing DOS/51 demo files.
cut=ref.index('MOV / DATA')
textfile('INST1.TXT','03A / INSTRUCTION DESK: ACALL - LJMP','\n'.join(ref[:cut]))
textfile('INST2.TXT','03B / INSTRUCTION DESK: MOV - XRL','\n'.join(ref[cut:]))
index='''                     _____   ___   _____ _
                    |  _  | / _ \\ |  ___/ |
                    | |_| || | | ||___ \\ |
                    |  _  || |_| | ___) | |
                    |_| |_| \\___/ |____/|_|

                THE ULTIMATE 8051 ASSEMBLY GUIDE
                      DOS/51 FIELD EDITION

       44 mnemonics / 111 forms / 255 defined opcode bytes
       Classic MCS-51 + Philips P80C31SFPN hardware notes

01 START51.TXT  Start here; first DOS/51 program
02 MEM51.TXT    Memory spaces, addressing, flags and stack
03 INST1.TXT    Instruction reference: ACALL through LJMP
   INST2.TXT    Instruction reference: MOV through XRL
04 CODE51.TXT   Loops, arithmetic, BCD, tables and contracts
05 CHIP51.TXT   Stocked chip, PDIP pinout, bus and power
06 IO51.TXT     Timer 0/1, UART, interrupt programming
07 PHIL51.TXT   Philips extensions; not emulator features
08 DOS51.TXT    Board map, SD card, lab and troubleshooting

READ ONE CHAPTER AT A TIME:
    sdget start51.txt
    cat start51.txt
    rm start51.txt

The last command removes the RAM-disk copy, NOT the SD original.
The RAM disk is 24 KB. These files are deliberately split to fit.
Keep your own work; never blank the card just to install the guide.

WEB EDITION / SEARCH / OPCODE MAP:
https://www.imania.dk/dos51/guide/

Sources: Intel MCS-51 Family User's Manual (instruction set);
Philips 80C31/80C32 product specification, 7 August 2000;
DOS/51 firmware and emulator source in the ABN8051 repository.
Philips extensions are documented separately; the current emulator
implements the classic core. Physical stocked silicon is not bench-
verified for later-revision extensions. See PHIL51.TXT for scope.
'''
textfile('GUIDE51.TXT','IMANIA // FIELD ARCHIVE 8051 // VOL. 01',index)
legacy=json.loads((out/'legacy.json').read_text()) if (out/'legacy.json').exists() else {}
manifest=[{'name':p.name,'bytes':p.stat().st_size,**({'legacy':legacy[p.name]} if p.name in legacy else {})} for p in sorted(ascii_dir.glob('*.TXT'))]
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
with zipfile.ZipFile(out/'8051-field-manual.zip','w',zipfile.ZIP_DEFLATED) as z:
 for p in sorted(ascii_dir.glob('*.TXT')):
  info=zipfile.ZipInfo(p.name,date_time=(2026,11,14,0,0,0))
  info.compress_type=zipfile.ZIP_DEFLATED
  info.external_attr=0o100644 << 16
  z.writestr(info,p.read_bytes())
nav=''.join(f'<a href="#{c["id"]}">{e(c["title"])}</a>' for c in data['chapters'])
nav=nav.replace('<a href="#recipes">','<a href="#instructions">03 / Every instruction</a><a href="#recipes">')
parts=[]
for c in data['chapters']:
 if c['id']=='recipes':
  cards=[]
  for m,(cat,desc,example,note) in sorted(data['instructions'].items()):
   rows=[]
   for f,rr in forms.items():
    if f.split()[0]!=m:continue
    r=rr[0];opstr=', '.join(f'{q["op"]:02X}' for q in rr)
    rows.append(f'<tr><td><code>{e(f)}</code></td><td>{opstr}</td><td>{r["bytes"]}</td><td>{r["cycles"]}</td><td>{flag(m,f)}</td></tr>')
   cards.append(f'<article class="instruction" id="ins-{m.lower()}" data-category="{cat}"><header><h3>{m}</h3><span>{cat}</span></header><p>{e(desc)}</p><div class="tablewrap"><table><thead><tr><th>Operand form</th><th>Opcode(s), hex</th><th>Bytes</th><th>MC</th><th>Flags</th></tr></thead><tbody>{"".join(rows)}</tbody></table></div><pre><code>{e(example)}</code></pre><p class="watch"><b>Watch:</b> {e(note)}</p></article>')
  parts.append('<section id="instructions"><p class="kicker">03 / THE COMPLETE DESK REFERENCE</p><h2>Every standard instruction.</h2><p>All 111 operand forms, all 255 defined opcode bytes. <b>Rn</b> = R0–R7; <b>@Ri</b> = @R0 or @R1; <b>dir</b> = direct byte address; <b>#imm</b> = immediate byte; <b>rel</b> = signed displacement from the next instruction; <b>addr11</b> = same-2-KB-page target; <b>addr16</b> = full CODE address. Commas separate opcodes within a form, not bytes of one encoding. Multi-byte operands follow the opcode; MOV dir,dir encodes source then destination. Full addresses/immediate words are high byte then low byte; stack PC pushes are low then high.</p><p>MC means classic 12-clock machine cycles. Flag columns list arithmetic/Boolean effects, not every possible destination side effect. Parity P follows A automatically; writes to PSW or its bits can explicitly alter flags. All conditional branches cost two MC whether taken or not. Reserved A5 has no portable behavior.</p><div class="filters"><label for="search">Find an instruction or operand</label><input id="search" type="search" placeholder="Try MOVX, carry, @Ri, stack…"><label for="category">Group</label><select id="category"><option value="all">All instructions</option>'+''.join(f'<option>{v}</option>' for v in ['arithmetic','bits','data','flow','logic'])+'</select><p id="results" aria-live="polite">44 mnemonics · 111 operand forms</p></div><div class="instruction-grid">'+''.join(cards)+'</div><noscript>All instruction entries remain visible without JavaScript.</noscript></section>')
 body=[]
 # Plain-text source is also the ASCII edition: keep web and card in sync.
 for para in c['text'].split('\n\n'):
  if '\n' in para:body.append('<pre tabindex="0">'+e(para)+'</pre>')
  else:body.append('<p>'+e(para)+'</p>')
 parts.append(f'<section id="{c["id"]}"><p class="kicker">FIELD NOTES / {e(c["file"])}</p><h2>{e(c["title"])}</h2>'+''.join(body)+f'<a class="download" href="ascii/{c["file"]}" download>↓ {e(c["file"])} · ASCII</a></section>')
maprows=[]
for row in range(16):
 cells=[]
 for col in range(16):
  op=ops[row*16+col];m=op['form'].split()[0]
  cells.append(f'<td><a href="#ins-{m.lower()}" title="{e(op["form"])}">{e(op["form"])}</a></td>' if m!='reserved' else '<td class="reserved">RESERVED</td>')
 maprows.append(f'<tr><th>{row:X}_</th>'+''.join(cells)+'</tr>')
opmap='<section id="opcodes"><p class="kicker">APPENDIX / EVERY BYTE AT A GLANCE</p><h2>The 16 × 16 opcode map.</h2><p>High nibble down the left, low nibble across the top. Scroll the map horizontally on a small screen; select a cell for the instruction explanation. A5 is deliberately reserved.</p><div class="tablewrap opcodewrap" tabindex="0"><table class="opmap"><thead><tr><th>HEX</th>'+''.join(f'<th>_{i:X}</th>' for i in range(16))+'</tr></thead><tbody>'+''.join(maprows)+'</tbody></table></div></section>'
product='/samlesaet-hobbyelektronik-og-ic-er-philips-p80c31sfpn-80c31-8051-microcontroller-dip40.htm?language=en'
page='''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The Ultimate 8051 Assembly Guide | DOS/51</title><meta name="description" content="Learn 8051 assembly: all 44 mnemonics, 111 operand forms and 255 opcodes, Philips P80C31SFPN peripherals, working patterns and an ASCII SD-card field manual."><link rel="canonical" href="https://www.imania.dk/dos51/guide/"><link rel="stylesheet" href="guide.css"><meta name="theme-color" content="#101c25"><link rel="icon" href="data:,"></head><body><header class="mast"><a href="../">← DOS/51 emulator</a><span>IMANIA / TECHNICAL FIELD MANUALS</span><a href="8051-field-manual.zip" download>ASCII edition ↓</a></header><main><div class="hero"><div><p class="kicker">VOLUME 01 / MCS-51 / FROM THE FIRST BYTE TO THE BUS</p><h1>The Ultimate<br><em>8051</em><br>Assembly Guide<span>.</span></h1><p class="lede">Small machine. Complete instruction set.<br>A practical field manual for the ROMless 80C31.</p><div class="heroactions"><a class="button" href="#start">Start reading ↗</a><a href="../">Open the DOS/51 lab →</a></div><div class="metrics"><span><b>44</b> mnemonics</span><span><b>111</b> operand forms</span><span><b>255</b> defined opcodes</span></div></div><aside class="archive"><div class="archive-top">REMOVABLE KNOWLEDGE / FAT16</div><div class="sdchip"><span>iM / FIELD ARCHIVE</span><strong>8051</strong><small>ASSEMBLY + HARDWARE<br>ASCII FIELD EDITION</small><div class="contacts">▌▌▌▌▌▌▌▌▌</div></div><pre>dos51$ sdls
GUIDE51.TXT   [START HERE]
INST1.TXT     ACALL → LJMP
INST2.TXT     MOV   → XRL
CHIP51.TXT    THE REAL CHIP

&gt; KNOWLEDGE, NOT JUST STORAGE_</pre><a href="8051-field-manual.zip" download>↓ Download the complete ASCII edition</a><p>Included on new emulator SD cards. Existing card? Use <b>Install field manual</b> in DOS/51. Your files stay yours.</p></aside></div><div class="book"><nav aria-label="Guide chapters"><p class="kicker">CONTENTS</p>'''+nav+'''<a href="#opcodes">09 / Opcode map</a><a href="#sources">10 / Sources & scope</a></nav><div class="chapters">'''+''.join(parts)+opmap+f'''<section id="sources"><p class="kicker">10 / PRIMARY SOURCES & SCOPE</p><h2>Know which machine you mean.</h2><p>Written for the <a href="{product}">Philips P80C31SFPN stocked at iMania</a>, with standard instruction semantics checked against Intel’s original instruction descriptions. This is an independently written teaching guide, not a reproduction of a manufacturer manual. Hardware extensions are attributed to the dated Philips specification and separated from emulator support; no physical chip bench-validation is claimed.</p><ul><li><a href="https://www.rsp-italy.it/Electronics/uP/_contents/Intel/8051/8051%20Instruction%20Manual.pdf">Intel MCS-51 Family User’s Manual — architecture, instruction descriptions and encoding/timing tables</a></li><li><a href="https://www.keil.com/support/man/docs/is51/is51_instructions.asp">Arm/Keil 8051 instruction-set reference</a></li><li><a href="https://www.keil.com/dd/docs/datashts/philips/8xc5x_ds.pdf">Philips 80C31/80C32 specification, 7 August 2000 — ordering p.3, pinout p.5, SFRs p.7, timer/UART/priority/DPTR sections</a></li><li><a href="https://github.com/AndersBNielsen/ABN8051/tree/main/emulator">ABN8051 emulator and DOS/51 firmware source</a> — board mapping, supported SFRs, shell commands and assembler</li></ul><p>Edition 2026-11-14. Classic CPU timings are hardware reference values; browser speed and modeled peripheral coverage are separate matters. The Philips shared-family datasheet contains revision-sensitive extensions: see chapter 07 instead of assuming every generic 8051, emulator or old 80C31 has them.</p><a class="button" href="../">Back to the machine →</a></section></div></div></main><footer>IMANIA / THE ULTIMATE 8051 ASSEMBLY GUIDE <a href="#">↑ Back to top</a></footer><script src="guide.js"></script></body></html>'''
(out/'index.html').write_text(page)
print(f'Built guide: {len(forms)} forms, {len(ops)-1} defined opcode bytes, {len(manifest)} ASCII files, {sum(x["bytes"] for x in manifest)} bytes')
