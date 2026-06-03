// Coverage prerender: warm the disk tile cache across ALL ENC cells, but only at
// the zoom band appropriate to each cell's compilation scale (cscl), so tile
// counts stay bounded. A 1:5000 harbour cell is baked at close zooms; a 1:250k
// cell at overview zooms. The server then serves these from disk → instant.
//
// Usage: node scripts/prerender-coverage.mjs [zMin zMax] [--dry]
import { mkdir, writeFile, access } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderTile, lonLatToTile } from "../lib/render-tile.mjs";
import { buildCellIndex } from "../lib/cell-index.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TILE_DIR = path.join(root, "tiles");
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const nums = args.filter((a) => /^\d+$/.test(a)).map(Number);
const [zMin, zMax] = nums.length >= 2 ? nums : [6, 13];
// optional lon band filter (for parallel sharding): --lon <min> <max> keeps only
// cells whose CENTRE lon is in [min,max), so each shard parses its own cells once.
const li = args.indexOf("--lon");
const lonBand = li >= 0 ? [parseFloat(args[li + 1]), parseFloat(args[li + 2])] : null;

// cell's "natural" zoom ≈ where denom(z) ≈ cscl. denom(z) ≈ 458e6 / 2^z (lat~35).
// Show band per the renderer's filter (denom ≤ cscl*16 ⇒ z ≥ zNat−4) capped at zNat
// (more-detailed zooms are left to finer cells / on-demand).
const C = 458e6;
const zNatural = (cscl) => Math.log2(C / cscl);

// 사전 빌드 cell-index.json 우선(병렬 자식이 744셀을 각자 재파싱하는 것 방지)
let rawIdx;
try { rawIdx = JSON.parse(readFileSync(path.join(root, "cell-index.json"), "utf8")); }
catch { rawIdx = buildCellIndex(); }
const idx = rawIdx.filter((c) => {
  if (!(c.cscl && Number.isFinite(c.minX))) return false;
  if (lonBand) { const cx = (c.minX + c.maxX) / 2; if (cx < lonBand[0] || cx >= lonBand[1]) return false; }
  return true;
});

// build the unique tile set per zoom
const perZoom = new Map(); // z -> Set("x/y")
for (const c of idx) {
  const zNat = zNatural(c.cscl);
  const zLo = Math.max(zMin, Math.round(zNat - 4));
  const zHi = Math.min(zMax, Math.round(zNat));
  for (let z = zLo; z <= zHi; z++) {
    if (!perZoom.has(z)) perZoom.set(z, new Set());
    const set = perZoom.get(z);
    const a0 = lonLatToTile(c.minX, c.maxY, z), a1 = lonLatToTile(c.maxX, c.minY, z);
    for (let x = Math.min(a0.x, a1.x); x <= Math.max(a0.x, a1.x); x++)
      for (let y = Math.min(a0.y, a1.y); y <= Math.max(a0.y, a1.y); y++)
        set.add(`${x}/${y}`);
  }
}

let total = 0;
const zooms = [...perZoom.keys()].sort((a, b) => a - b);
for (const z of zooms) { console.log(`z${z}: ${perZoom.get(z).size} tiles`); total += perZoom.get(z).size; }
console.log(`TOTAL: ${total} tiles (z${zMin}-${zMax})${dry ? "  [dry run — nothing rendered]" : ""}`);
if (dry) process.exit(0);

let rendered = 0, cached = 0, t0 = performance.now();
for (const z of zooms) {
  for (const xy of perZoom.get(z)) {
    const [x, y] = xy.split("/").map(Number);
    const file = path.join(TILE_DIR, "day", String(z), String(x), `${y}.png`);
    try { await access(file); cached++; continue; } catch {}
    const png = await renderTile(z, x, y, { tileSize: 256 });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, png);
    rendered++;
    if (rendered % 200 === 0) process.stdout.write(`  …${rendered} rendered (${((performance.now() - t0) / 1000).toFixed(0)}s)\n`);
  }
}
console.log(`done: ${rendered} rendered + ${cached} cached in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
