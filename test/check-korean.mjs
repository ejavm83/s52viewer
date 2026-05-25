import { readFileSync } from "fs";
import { DDF } from "../js/iso8211.js";
import { S57 } from "../js/s57.js";
function csv(t){const r=[];let row=[],c="",q=false;for(let i=0;i<t.length;i++){const ch=t[i];if(q){if(ch==='"'){if(t[i+1]==='"'){c+='"';i++}else q=false}else c+=ch}else if(ch==='"')q=true;else if(ch===","){row.push(c);c=""}else if(ch==="\n"){row.push(c);r.push(row);row=[];c=""}else if(ch==="\r"){}else c+=ch}if(c.length||row.length){row.push(c);r.push(row)}return r}
const oc=new Map(),ac=new Map();
for(const r of csv(readFileSync("assets/s57objectclasses.csv","utf8")).slice(1))if(r.length>=3&&!isNaN(+r[0]))oc.set(+r[0],r[2].trim());
for(const r of csv(readFileSync("assets/s57attributes.csv","utf8")).slice(1))if(r.length>=4&&!isNaN(+r[0]))ac.set(+r[0],{acronym:r[2].trim(),type:r[3].trim()});
const f=process.argv[2]||"000/KR5F4H31.000";const b=readFileSync(f);const ab=b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
const ddf=DDF.parse(ab);console.log("NALL=",ddf.nall);
const chart=S57.build(ddf,{objClasses:oc,attrCodes:ac});
let shown=0;for(const ft of chart.features){if(ft.attrs.NOBJNM){console.log(ft.acronym,"OBJNAM=",JSON.stringify(ft.attrs.OBJNAM),"NOBJNM=",JSON.stringify(ft.attrs.NOBJNM));if(++shown>=10)break;}}
console.log("features with NOBJNM:",chart.features.filter(f=>f.attrs.NOBJNM).length);
