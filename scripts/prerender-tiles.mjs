// Pre-render ENC tiles for a lon/lat box across a zoom range into the disk
// cache (tiles/{z}/{x}/{y}.png), so first paint / first pans are instant.
// Usage: node scripts/prerender-tiles.mjs [minLon minLat maxLon maxLat zMin zMax]
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderTile, lonLatToTile } from "../lib/render-tile.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TILE_DIR = path.join(root, "tiles");

const a = process.argv.slice(2).map(Number);
// default: Busan port + approaches
const [minLon, minLat, maxLon, maxLat, zMin, zMax] =
  a.length === 6 ? a : [128.9, 34.95, 129.2, 35.15, 10, 14];

let rendered = 0, cached = 0, t0 = performance.now();
for (let z = zMin; z <= zMax; z++) {
  const a0 = lonLatToTile(minLon, maxLat, z); // NW
  const a1 = lonLatToTile(maxLon, minLat, z); // SE
  const x0 = Math.min(a0.x, a1.x), x1 = Math.max(a0.x, a1.x);
  const y0 = Math.min(a0.y, a1.y), y1 = Math.max(a0.y, a1.y);
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const file = path.join(TILE_DIR, "day", String(z), String(x), `${y}.png`);
      try { await access(file); cached++; continue; } catch {}
      const png = await renderTile(z, x, y, { tileSize: 256 });
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, png);
      rendered++;
    }
  }
  process.stdout.write(`z${z}: x[${x0}-${x1}] y[${y0}-${y1}] → ${rendered} rendered, ${cached} already cached\n`);
}
console.log(`done: ${rendered} rendered + ${cached} cached in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
