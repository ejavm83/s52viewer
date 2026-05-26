// Parsing web worker. Runs the CPU-heavy ISO-8211 + S-57 decode off the main
// thread so loading large cells never freezes the UI. The catalog (object /
// attribute code tables) is loaded once and reused for every cell.
import { DDF } from "./iso8211.js";
import { S57 } from "./s57.js";
import { loadCatalog } from "./catalog.js";
import { projectFeature } from "./render.js";

let catalogPromise = null;
function getCatalog() {
  if (!catalogPromise) {
    catalogPromise = loadCatalog(
      new URL("../assets/s57objectclasses.csv", import.meta.url).href,
      new URL("../assets/s57attributes.csv", import.meta.url).href
    );
  }
  return catalogPromise;
}

self.onmessage = async (e) => {
  const { id, buffer } = e.data;
  try {
    const catalog = await getCatalog();
    const chart = S57.build(DDF.parse(buffer), catalog);
    // Project to Mercator (flat Float64Arrays) and drop the bulky lon/lat
    // source arrays here, so the main thread receives the compact form and
    // never holds the memory-heavy original (prevents out-of-memory with many
    // cells loaded). The structured clone of typed arrays is cheap.
    for (const f of chart.features) projectFeature(f);
    self.postMessage({ id, chart });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
