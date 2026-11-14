import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHarness } from '../emu/harness.js';
import { SDCard } from '../emu/sdcard.js';
import { formatCard } from '../emu/fatfmt.js';
import { putFat16File } from '../emu/fatfile.js';
import { ROM_PATH, PROMPT, SEC, cmd, upload } from './dos-helpers.js';
const files=JSON.parse(fs.readFileSync(new URL('../site/guide/manifest.json',import.meta.url)));
test('real DOS/51 imports every ASCII manual chapter, preserving unrelated card content',()=>{
 const image=formatCard(16<<20);
 const sentinel=new TextEncoder().encode('visitor-owned card file\r\n');
 putFat16File(image,'MYWORK.TXT',sentinel);
 for(const f of files){
  const data=new Uint8Array(fs.readFileSync(new URL('../site/guide/ascii/'+f.name,import.meta.url)));
  assert.equal(data.length,f.bytes);assert.ok(data.length<10000);
  assert.ok([...data].every(x=>x<128));
  assert.equal(putFat16File(image,f.name,data),true);
 }
 const before=image.slice();
 for(const f of files)assert.equal(putFat16File(image,f.name,new Uint8Array([0])),false);
 assert.deepEqual(image,before);
 const h=createHarness({romPath:ROM_PATH,seed:1});
 new SDCard({image}).attach(h.board);h.waitFor(PROMPT,{timeoutCycles:5*SEC});
 assert.match(cmd(h,'sdls',{timeout:120}),/guide51\.txt/i);
 for(const f of files){
  const name=f.name.toLowerCase();
  const result=cmd(h,`sdget ${name}`,{timeout:120});
  assert.doesNotMatch(result,/error|not found|no space|failed/i);
  const body=cmd(h,`cat ${name}`,{timeout:120});
  assert.match(body,/DOS\/51 FIELD MANUAL/);
  const expected=fs.readFileSync(new URL('../site/guide/ascii/'+f.name,import.meta.url),'ascii').replace(/\r\n/g,'\n');
  assert.ok(body.replace(/\r/g,'').includes(expected.trim()),`${name} must match the full host chapter`);
  cmd(h,`rm ${name}`);
 }
 cmd(h,'sdget mywork.txt',{timeout:120});
 assert.match(cmd(h,'cat mywork.txt'),/visitor-owned card file/);
});
test('the first-program example assembles and returns through the real ROM',()=>{
 const h=createHarness({romPath:ROM_PATH,seed:1});h.waitFor(PROMPT,{timeoutCycles:5*SEC});
 const content=JSON.parse(fs.readFileSync(new URL('../site/guide/content.json',import.meta.url)));
 const text=content.chapters.find(c=>c.id==='start').text;
 const source=text.split('\n\n').find(p=>p.includes('wait_tx:'))+'\n';
 assert.ok(upload(h,'first.asm',source).ok);
 assert.match(cmd(h,'asm -r first.asm',{timeout:120}),/0 error\(s\)[\s\S]*\*/);
});

test('manual installer repairs exact old CRLF editions but preserves user edits',async()=>{
 const {installGuideFile}=await import('../emu/guidefiles.js');
 const image=formatCard(16<<20);
 const fresh=new Uint8Array(fs.readFileSync(new URL('../site/guide/ascii/GUIDE51.TXT',import.meta.url)));
 assert.ok(!fresh.includes(13));
 const old=new TextEncoder().encode(new TextDecoder().decode(fresh).replace(/\n/g,'\r\n'));
 putFat16File(image,'GUIDE51.TXT',old);
 putFat16File(image,'START51.TXT',new TextEncoder().encode('my edited chapter\n'));
 assert.equal(installGuideFile(image,'GUIDE51.TXT',fresh),'repaired');
 assert.equal(installGuideFile(image,'GUIDE51.TXT',fresh),'preserved');
 const before=image.slice();
 assert.equal(installGuideFile(image,'START51.TXT',fresh),'preserved');assert.deepEqual(image,before);
 const h=createHarness({romPath:ROM_PATH,seed:1});new SDCard({image}).attach(h.board);
 h.waitFor(PROMPT,{timeoutCycles:5*SEC});cmd(h,'sdget guide51.txt',{timeout:120});
 const content=cmd(h,'cat guide51.txt',{timeout:120});assert.ok(content.includes('FIELD EDITION'));
 h.send('nano guide51.txt\r');
 const screen=h.waitFor('Loops, arithmetic, BCD, tables and contracts',{timeoutCycles:5*SEC});
 assert.ok(!screen.replace(/\x1b\[[?0-9;]*[A-Za-z]/g,'').includes('?'), 'nano must not render carriage-return question marks');
});
