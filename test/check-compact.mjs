import { readFileSync } from "fs";
import { DDF } from "../js/iso8211.js";
import { S57 } from "../js/s57.js";
import { projectFeature, mercX, mercY } from "../js/render.js";
function csv(t){const r=[];let row=[],c="",q=false;for(let i=0;i<t.length;i++){const ch=t[i];if(q){if(ch==='"'){if(t[i+1]==='"'){c+='"';i++}else q=false}else c+=ch}else if(ch==='"')q=true;else if(ch===","){row.push(c);c=""}else if(ch==="\n"){row.push(c);r.push(row);row=[];c=""}else if(ch==="\r"){}else c+=ch}if(c.length||row.length){row.push(c);r.push(row)}return r}
const oc=new Map(),ac=new Map();
for(const r of csv(readFileSync("assets/s57objectclasses.csv","utf8")).slice(1))if(r.length>=3&&!isNaN(+r[0]))oc.set(+r[0],r[2].trim());
for(const r of csv(readFileSync("assets/s57attributes.csv","utf8")).slice(1))if(r.length>=4&&!isNaN(+r[0]))ac.set(+r[0],{acronym:r[2].trim(),type:r[3].trim()});
const b=readFileSync("000/KR5F4H31.000");const ab=b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
const chart=S57.build(DDF.parse(ab),{objClasses:oc,attrCodes:ac});
// pick an Area and a Line feature, remember first original coord
const area=chart.features.find(f=>f.geom&&f.geom.type==="Area"&&f.geom.coords[0]&&f.geom.coords[0].length>2);
const line=chart.features.find(f=>f.geom&&f.geom.type==="Line"&&f.geom.coords[0]);
const snd=chart.features.find(f=>f.soundings&&f.soundings.length);
const a0=area.geom.coords[0][0].slice(); const expMX=mercX(a0[0]),expMY=mercY(a0[1]);
for(const f of chart.features) projectFeature(f);
console.log("area _pg type:",area._pg.type,"ring0 is Float64Array:",area._pg.rings[0] instanceof Float64Array,"len:",area._pg.rings[0].length);
console.log("first projected pt:",area._pg.rings[0][0].toFixed(6),area._pg.rings[0][1].toFixed(6)," expected:",expMX.toFixed(6),expMY.toFixed(6));
console.log("area.geom.coords dropped:",area.geom.coords===undefined,"geom marker:",JSON.stringify(area.geom));
console.log("line _pg type:",line._pg.type,"rings:",line._pg.rings.length);
console.log("sounding _ps is Float64Array:",snd._ps instanceof Float64Array,"count:",snd._ps.length/3,"soundings dropped:",snd.soundings===null,"geom marker:",JSON.stringify(snd.geom));
console.log("bbox:",area._bbox.map(v=>v.toFixed(4)));
