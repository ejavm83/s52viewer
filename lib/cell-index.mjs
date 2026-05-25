// Shared ENC cell index for local server, Vercel build, and tests.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DDF } from "../js/iso8211.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function cellExtent(ab) {
  const ddf = DDF.parse(ab);
  let comf = 1e7, cscl = null;
  for (const rec of ddf.records) {
    const d = rec.fields["DSPM"]?.[0];
    if (d) { if (d.COMF) comf = d.COMF; if (d.CSCL) cscl = d.CSCL; break; }
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const rec of ddf.records) {
    if (!rec.fields["VRID"]) continue;
    for (const sg of rec.fields["SG2D"] || []) {
      const x = sg.XCOO / comf, y = sg.YCOO / comf;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    for (const sg of rec.fields["SG3D"] || []) {
      const x = sg.XCOO / comf, y = sg.YCOO / comf;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY, cscl };
}

let cellIndexCache = null;

/** @returns {Array<{name:string,minX:number,minY:number,maxX:number,maxY:number,cscl:number|null,bytes:number}>} */
export function buildCellIndex() {
  if (cellIndexCache) return cellIndexCache;
  const dir = path.join(root, "000");
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".000")).sort();
  const out = [];
  for (const f of files) {
    try {
      const buf = readFileSync(path.join(dir, f));
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const e = cellExtent(ab);
      if (Number.isFinite(e.minX)) out.push({ name: f, ...e, bytes: buf.length });
    } catch { /* skip unreadable */ }
  }
  cellIndexCache = out;
  return out;
}

/** Same filter as legacy /api/cells in serve.js */
export function listEncCellNames() {
  try {
    return readdirSync(path.join(root, "000"))
      .filter((f) => /\.\d{3}$/i.test(f) && f.toLowerCase().endsWith(".000"))
      .sort();
  } catch {
    return [];
  }
}

export function getProjectRoot() {
  return root;
}
