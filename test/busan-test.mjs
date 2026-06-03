import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderTile, lonLatToTile } from "../lib/render-tile.mjs";
import { buildCellIndex } from "../lib/cell-index.mjs";

const idx = buildCellIndex();
const lon = 129.04, lat = 35.08;
const covering = idx.filter((c) => c.minX <= lon && c.maxX >= lon && c.minY <= lat && c.maxY >= lat).sort((a, b) => a.cscl - b.cscl);
console.log("cells over Busan:", covering.map((c) => c.name + " 1:" + c.cscl).join(", "));
const dir = os.tmpdir();
for (const z of [10, 12, 14]) {
  const { x, y } = lonLatToTile(lon, lat, z);
  const t0 = performance.now();
  const png = await renderTile(z, x, y, { tileSize: 256 });
  const out = path.join(dir, `busan_z${z}_x${x}_y${y}.png`);
  writeFileSync(out, png);
  console.log(`z${z} x${x} y${y}: ${png.length}B ${(performance.now() - t0).toFixed(0)}ms -> ${out}`);
}
