import { readFileSync, readdirSync } from "fs";
import { DDF } from "../js/iso8211.js";
import { S57 } from "../js/s57.js";
function csv(t){const r=[];let row=[],c="",q=false;for(let i=0;i<t.length;i++){const ch=t[i];if(q){if(ch==='"'){if(t[i+1]==='"'){c+='"';i++}else q=false}else c+=ch}else if(ch==='"')q=true;else if(ch===","){row.push(c);c=""}else if(ch==="\n"){row.push(c);r.push(row);row=[];c=""}else if(ch==="\r"){}else c+=ch}if(c.length||row.length){row.push(c);r.push(row)}return r}
const oc=new Map(),ac=new Map();
for(const r of csv(readFileSync("assets/s57objectclasses.csv","utf8")).slice(1))if(r.length>=3&&!isNaN(+r[0]))oc.set(+r[0],r[2].trim());
for(const r of csv(readFileSync("assets/s57attributes.csv","utf8")).slice(1))if(r.length>=4&&!isNaN(+r[0]))ac.set(+r[0],{acronym:r[2].trim(),type:r[3].trim()});
const cat={objClasses:oc,attrCodes:ac};
const files=readdirSync("000").filter(f=>f.toLowerCase().endsWith(".000"));
const hits=[];
for(const f of files){try{const b=readFileSync("000/"+f);const ab=b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);const ch=S57.build(DDF.parse(ab),cat);const t=ch.features.filter(x=>x.acronym==='TSSLPT');if(t.length){const orients=t.map(x=>x.attrs.ORIENT).filter(Boolean);hits.push({f,n:t.length,bytes:b.length,orients:[...new Set(orients)].slice(0,5)})}}catch(e){}}
hits.sort((a,b)=>a.bytes-b.bytes);
console.log("cells with TSSLPT:",hits.length);
for(const h of hits.slice(0,8))console.log(`  ${h.f}  count=${h.n} bytes=${h.bytes} orients=${h.orients.join(",")}`);
