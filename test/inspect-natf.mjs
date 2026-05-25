import { readFileSync } from "fs";
import { DDF } from "../js/iso8211.js";
const f=process.argv[2]||"000/KR5F4H31.000";
const b=readFileSync(f);const ab=b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
const ddf=DDF.parse(ab);
// DSSI subfields
for(const rec of ddf.records){const d=rec.fields["DSSI"];if(d){console.log("DSSI:",JSON.stringify(d[0]));break;}}
// NATF def
const def=ddf.fieldDefs.get("NATF");console.log("NATF labels/formats:",JSON.stringify(def&&def.labels),JSON.stringify(def&&def.formats));
// find a record with NATF, show decoded ATVL and char codes
let n=0;
for(const rec of ddf.records){const a=rec.fields["NATF"];if(a&&a.length){for(const row of a){const v=String(row.ATVL||"");const codes=[...v].slice(0,12).map(c=>c.charCodeAt(0));console.log("NATF ATTL=",row.ATTL,"ATVL len",v.length,"codes",codes.join(","),"raw:",JSON.stringify(v.slice(0,20)));}if(++n>=4)break;}}
