import { readFileSync, readdirSync } from "fs";
import { DDF } from "../js/iso8211.js";
import { S57 } from "../js/s57.js";

function parseCSV(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (c === "\r") {} else cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
const objClasses = new Map(), attrCodes = new Map();
for (const r of parseCSV(readFileSync("assets/s57objectclasses.csv", "utf8")).slice(1))
  if (r.length >= 3 && !Number.isNaN(+r[0])) objClasses.set(+r[0], r[2].trim());
for (const r of parseCSV(readFileSync("assets/s57attributes.csv", "utf8")).slice(1))
  if (r.length >= 4 && !Number.isNaN(+r[0])) attrCodes.set(+r[0], { acronym: r[2].trim(), type: r[3].trim() });
const catalog = { objClasses, attrCodes };

const files = readdirSync("000").filter((f) => f.toLowerCase().endsWith(".000"));
const results = [];
for (const f of files) {
  try {
    const buf = readFileSync("000/" + f);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const chart = S57.build(DDF.parse(ab), catalog);
    let land = 0, coal = 0, depare = 0, total = 0;
    for (const ft of chart.features) {
      if (ft.acronym === "LNDARE") land++;
      else if (ft.acronym === "COALNE") coal++;
      else if (ft.acronym === "DEPARE") depare++;
      if (ft.geom || ft.soundings) total++;
    }
    results.push({ f, land, coal, depare, total, bytes: buf.length });
  } catch (e) {
    results.push({ f, err: e.message });
  }
}
const ok = results.filter((r) => !r.err);
const bad = results.filter((r) => r.err);
console.log("files:", files.length, "parsed:", ok.length, "errors:", bad.length);
if (bad.length) console.log("first errors:", bad.slice(0, 5).map((b) => `${b.f}:${b.err}`).join(" | "));
ok.sort((a, b) => (b.land + b.coal) - (a.land + a.coal));
console.log("top coastal cells (land+coast):");
for (const r of ok.slice(0, 12))
  console.log(`  ${r.f}  land=${r.land} coal=${r.coal} depare=${r.depare} total=${r.total} (${r.bytes}B)`);
