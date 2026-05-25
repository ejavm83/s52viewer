import { readFileSync } from "fs";
import { DDF } from "../js/iso8211.js";
const buf = readFileSync(process.argv[2] || "000/KR1O0000.000");
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const ddf = DDF.parse(ab);
for (const tag of ["FRID","ATTF","SG2D","SG3D","VRID","VRPT","FSPT","DSPM"]) {
  const d = ddf.fieldDefs.get(tag);
  if (!d) { console.log(tag, "MISSING"); continue; }
  console.log(`${tag}  name="${d.name}"`);
  console.log("   labels:", JSON.stringify(d.labels));
  console.log("   formats:", JSON.stringify(d.formats));
}
// show one ATTF + one SG2D raw decoded row
const rec = ddf.records.find(r => r.fields["SG2D"]);
console.log("sample SG2D row:", JSON.stringify(rec?.fields["SG2D"]?.[0]));
const arec = ddf.records.find(r => r.fields["ATTF"]);
console.log("sample ATTF rows:", JSON.stringify(arec?.fields["ATTF"]?.slice(0,3)));
