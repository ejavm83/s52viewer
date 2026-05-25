// Writes public/cell-index.json for static hosting (e.g. Vercel).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCellIndex } from "../lib/cell-index.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "public");
const outFile = path.join(outDir, "cell-index.json");

mkdirSync(outDir, { recursive: true });
const idx = buildCellIndex();
writeFileSync(outFile, JSON.stringify(idx));
console.log(`Wrote ${outFile} (${idx.length} cells)`);
