// Render a few ENC tiles server-side and save PNGs to /tmp for eyeballing.
import { writeFileSync } from "node:fs";
import { renderTile, lonLatToTile, tileLonLatBbox } from "../lib/render-tile.mjs";
import { buildCellIndex } from "../lib/cell-index.mjs";

const index = buildCellIndex();
// most detailed cell (smallest cscl) with a finite extent
const detailed = index
  .filter((c) => c.cscl && Number.isFinite(c.minX))
  .sort((a, b) => a.cscl - b.cscl)[0];
console.log("most detailed cell:", detailed.name, "cscl 1:" + detailed.cscl,
  "bbox", [detailed.minX.toFixed(3), detailed.minY.toFixed(3), detailed.maxX.toFixed(3), detailed.maxY.toFixed(3)]);

const lon = (detailed.minX + detailed.maxX) / 2;
const lat = (detailed.minY + detailed.maxY) / 2;
// zoom where this cell's scale shows: denom(z) ≈ 458e6 / 2^z ≈ cscl
const zBase = Math.round(Math.log2(458e6 / detailed.cscl));
console.log("center lon/lat:", lon.toFixed(4), lat.toFixed(4), "| zBase:", zBase);

const outDir = process.env.TEMP || "/tmp";
for (const z of [zBase - 1, zBase, zBase + 1]) {
  const { x, y } = lonLatToTile(lon, lat, z);
  const t0 = performance.now();
  const png = await renderTile(z, x, y, { tileSize: 256 });
  const ms = (performance.now() - t0).toFixed(1);
  const out = `${outDir}\\tile_z${z}_x${x}_y${y}.png`;
  writeFileSync(out, png);
  const bb = tileLonLatBbox(z, x, y);
  console.log(`z${z} x${x} y${y}: ${png.length}B in ${ms}ms -> ${out}  bbox lon[${bb.minLon.toFixed(3)},${bb.maxLon.toFixed(3)}] lat[${bb.minLat.toFixed(3)},${bb.maxLat.toFixed(3)}]`);
}
console.log("done");
