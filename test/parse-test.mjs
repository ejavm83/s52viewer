// Node-side verification of the ISO-8211 + S-57 parsers (no browser needed).
import { readFileSync } from "fs";
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
function loadCatalog() {
  const objClasses = new Map(), attrCodes = new Map();
  for (const r of parseCSV(readFileSync("assets/s57objectclasses.csv", "utf8")).slice(1))
    if (r.length >= 3 && !Number.isNaN(+r[0])) objClasses.set(+r[0], r[2].trim());
  for (const r of parseCSV(readFileSync("assets/s57attributes.csv", "utf8")).slice(1))
    if (r.length >= 4 && !Number.isNaN(+r[0])) attrCodes.set(+r[0], { acronym: r[2].trim(), type: r[3].trim() });
  return { objClasses, attrCodes };
}

const file = process.argv[2] || "000/KR1O0000.000";
const catalog = loadCatalog();
const buf = readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

console.log("=== file:", file, "(", buf.length, "bytes ) ===");
const ddf = DDF.parse(ab);
console.log("DDF field defs:", ddf.fieldDefs.size, " records:", ddf.records.length);
// show the DDR-defined field tags
console.log("field tags:", [...ddf.fieldDefs.keys()].join(","));

const chart = S57.build(ddf, catalog);
console.log("COMF:", chart.comf, "SOMF:", chart.somf);
console.log("features:", chart.features.length);
console.log("bounds:", JSON.stringify(chart.bounds));

const byClass = new Map();
let pt = 0, ln = 0, ar = 0, snd = 0, noGeom = 0;
for (const f of chart.features) {
  byClass.set(f.acronym, (byClass.get(f.acronym) || 0) + 1);
  if (f.soundings) snd += f.soundings.length;
  if (!f.geom && !f.soundings) noGeom++;
  else if (f.geom?.type === "Point") pt++;
  else if (f.geom?.type === "Line") ln++;
  else if (f.geom?.type === "Area") ar++;
}
console.log(`geom => point:${pt} line:${ln} area:${ar} soundings(pts):${snd} noGeom:${noGeom}`);
const top = [...byClass.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log("top object classes:", top.map(([k, v]) => `${k}:${v}`).join(", "));

// dump a couple of sample features with attrs + first coords
for (const want of ["DEPARE", "COALNE", "LNDARE", "SOUNDG", "BOYLAT", "LIGHTS"]) {
  const f = chart.features.find((x) => x.acronym === want && (x.geom || x.soundings));
  if (!f) continue;
  let sample = "";
  if (f.geom?.type === "Point") sample = JSON.stringify(f.geom.coords);
  else if (f.geom?.type === "Line") sample = `${f.geom.coords.length} lines, first pt ${JSON.stringify(f.geom.coords[0]?.[0])}`;
  else if (f.geom?.type === "Area") sample = `${f.geom.coords.length} rings, ring0 ${f.geom.coords[0]?.length} pts`;
  else if (f.soundings) sample = `${f.soundings.length} soundings, first ${JSON.stringify(f.soundings[0])}`;
  console.log(`  ${want}: attrs=${JSON.stringify(f.attrs)} | ${sample}`);
}
