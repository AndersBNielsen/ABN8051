// Update only byte-for-byte copies of known shipped field-manual editions.
// Caller stages edits on a copy so any validation/allocation error is atomic.
import { putFat16File } from './fatfile.js';
const u16=(a,p)=>a[p]|a[p+1]<<8;
const u32=(a,p)=>(u16(a,p)|u16(a,p+2)<<16)>>>0;
export function installGuideFile(image,name,data,onWrite=()=>{},legacyData=[]) {
  if(putFat16File(image,name,data,onWrite)) return 'added';
  const [base,ext='']=name.toUpperCase().split('.');
  const filename=base.padEnd(8)+ext.padEnd(3);
  const part=image[0]===0xeb?0:u32(image,454),boot=part*512;
  const spc=image[boot+13],nfats=image[boot+16],fatsz=u16(image,boot+22);
  const fat=(part+u16(image,boot+14))*512;
  const entries=u16(image,boot+17),root=fat+nfats*fatsz*512;
  const start=root+Math.ceil(entries*32/512)*512,csize=spc*512;
  let entry=-1;
  for(let p=root;p<root+entries*32;p+=32){
    if([...filename].every((c,i)=>image[p+i]===c.charCodeAt(0))){entry=p;break;}
  }
  if(entry<0)return 'preserved';
  const legacy=[];for(const b of data){if(b===10)legacy.push(13);legacy.push(b);}
  const size=u32(image,entry+28);
  const expected=[new Uint8Array(legacy),...legacyData].filter(bytes=>bytes.length===size);
  if(!expected.length)return 'preserved';
  const actual=new Uint8Array(size);
  const chain=[],seen=new Set();let cluster=u16(image,entry+26),pos=0;
  while(cluster>=2&&cluster<0xfff8){
    if(seen.has(cluster)||fat+cluster*2+1>=root)throw Error('Invalid manual cluster chain');
    seen.add(cluster);chain.push(cluster);
    const off=start+(cluster-2)*csize;
    if(off+csize>image.length)throw Error('Truncated manual file');
    for(let i=0;i<csize&&pos<size;i++,pos++)actual[pos]=image[off+i];
    cluster=u16(image,fat+cluster*2);
  }
  if(pos!==size||cluster<0xfff8||!expected.some(bytes=>bytes.every((value,i)=>value===actual[i])))return 'preserved';
  // Exact shipped edition confirmed: release its chain and re-add the LF edition.
  for(const c of chain)for(let f=0;f<nfats;f++){
    const p=fat+f*fatsz*512+c*2;image[p]=image[p+1]=0;onWrite(p,2);
  }
  image[entry]=0xe5;onWrite(entry,1);
  if(!putFat16File(image,name,data,onWrite))throw Error('Manual repair failed');
  return 'repaired';
}
