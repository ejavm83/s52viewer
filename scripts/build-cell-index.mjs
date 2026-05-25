// Writes cell-index.json at repo root for static hosting (e.g. Vercel).
// Keep this OUT of public/ — Vercel may set Output Directory to public/ and then
// index.html at the repo root is not deployed, which yields 404 on /.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCellIndex } from "../lib/cell-index.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFile = path.join(root, "cell-index.json");

const idx = buildCellIndex();
writeFileSync(outFile, JSON.stringify(idx));
console.log(`Wrote ${outFile} (${idx.length} cells)`);
