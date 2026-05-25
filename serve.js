// Zero-dependency static file server for the S-52 viewer.
// Usage:  node serve.js [port]
import http from "node:http";
import { readFile, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DDF } from "./js/iso8211.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = parseInt(process.argv[2], 10) || 8080;

// Lightweight per-cell coverage extent (no feature assembly) for the grid.
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
function buildCellIndex() {
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

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
  ".000": "application/octet-stream",
};

http
  .createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    // list the .000 cells available in the 000/ folder
    if (urlPath === "/api/cells") {
      try {
        const files = readdirSync(path.join(root, "000"))
          .filter((f) => /\.\d{3}$/i.test(f) && f.toLowerCase().endsWith(".000"))
          .sort();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(files));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
      }
      return;
    }
    // coverage index (parsed once, cached) for the cell grid
    if (urlPath === "/api/index") {
      const idx = buildCellIndex();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(idx));
      return;
    }
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = path.join(root, urlPath);
    if (!filePath.startsWith(root)) { res.writeHead(403); res.end("forbidden"); return; }
    readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(data);
    });
  })
  .listen(port, () => console.log(`S-52 viewer at http://localhost:${port}/`));
