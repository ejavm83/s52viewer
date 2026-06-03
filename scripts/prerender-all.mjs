// Parallel full-coverage prerender: split the Korean ENC lon span into bands and
// run one prerender-coverage child per band concurrently (each parses only its
// band's cells once). Usage: node scripts/prerender-all.mjs [zMin zMax]
import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const coverage = path.join(here, "prerender-coverage.mjs");
const nums = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
const [zMin, zMax] = nums.length >= 2 ? nums : [5, 14];

// Band edges over the ENC lon span (~125–132.5). Dense west/south coast gets
// narrower bands so the ~20 cores load-balance; sparse east-sea bands finish fast.
const edges = [125, 125.8, 126.4, 126.8, 127.2, 127.7, 128.2, 128.6, 129.0, 129.4, 130, 131, 132.6];
const bands = [];
for (let i = 0; i < edges.length - 1; i++) bands.push([edges[i], edges[i + 1]]);

console.log(`prerender-all: z${zMin}-${zMax}, ${bands.length} lon bands in parallel`);
const start = performance.now();
let finished = 0;

await Promise.all(bands.map((b) => new Promise((resolve) => {
  const child = fork(coverage, [String(zMin), String(zMax), "--lon", String(b[0]), String(b[1])],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let last = "";
  child.stdout.on("data", (d) => { const t = d.toString().trim(); if (t) last = t.split("\n").pop(); });
  child.stderr.on("data", (d) => process.stderr.write(`[${b[0]}] ${d}`));
  child.on("exit", () => { finished++; console.log(`  band [${b[0]},${b[1]}) ✓ (${finished}/${bands.length})  ${last}`); resolve(); });
})));

console.log(`ALL DONE: ${bands.length} bands, z${zMin}-${zMax} in ${((performance.now() - start) / 60000).toFixed(1)} min`);
