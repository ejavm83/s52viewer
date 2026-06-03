// Zero-dependency static file server for the S-52 viewer.
// Usage:  node serve.js [port]
//   Port: CLI 인자 > 환경 변수 PORT > 기본 8000
// Binds 0.0.0.0 so other machines on the LAN can open http://<this-host-ip>:<port>/
import http from "node:http";
import os from "node:os";
import { readFile, existsSync } from "node:fs";
import { mkdir, writeFile, readFile as readFileP } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCellIndex, listEncCellNames } from "./lib/cell-index.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8000;
const fromArg = parseInt(process.argv[2], 10);
const fromEnv = parseInt(process.env.PORT ?? "", 10);
const port =
  Number.isFinite(fromArg) && fromArg > 0 && fromArg <= 65535
    ? fromArg
    : Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv <= 65535
      ? fromEnv
      : DEFAULT_PORT;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".000": "application/octet-stream",
};

const rootResolved = path.resolve(root);

/** URL 경로(쿼리 제외) → 디스크 절대 경로. 디렉터리 탈출 시 null. */
function resolvedStaticFile(urlPathNoQuery) {
  let rel = urlPathNoQuery;
  if (rel === "/" || rel === "") rel = "index.html";
  else rel = rel.replace(/^\/+/u, "");
  const abs = path.resolve(rootResolved, rel);
  const relToRoot = path.relative(rootResolved, abs);
  if (relToRoot.startsWith(".." + path.sep) || relToRoot === ".." || path.isAbsolute(relToRoot)) return null;
  return abs;
}

// ─── ENC raster tile endpoint: server-side S-52 render → PNG, disk-cached ───
// node-canvas는 첫 타일 요청 때만 동적 import해 정적 서버 시작을 가볍게 유지한다.
// 같은 타일의 동시 렌더는 coalesce하고, 렌더 결과는 tiles/{z}/{x}/{y}.png로 디스크
// 캐시(재요청·재방문 시 렌더 0회). 레퍼런스 WMS처럼 "한 번 굽고 캐시" 방식.
let _renderTile = null;
const _tileInflight = new Map(); // "z/x/y" -> Promise<Buffer>
const TILE_DIR = path.join(root, "tiles");

// 쿼리스트링 → S-52 설정. 기본값은 예열된 'day' 타일과 일치(palette day, 표시 standard,
// 등고선 2/10/20, SCAMIN on)하도록 잡아, 기본 요청은 디스크 캐시를 그대로 쓴다.
function tileSettings(q) {
  const g = (re) => { const m = q.match(re); return m ? m[1] : null; };
  const num = (re, d) => { const v = g(re); return v != null ? +v : d; };
  return {
    palette: g(/(?:^|&)p=(day|dusk|night)/) || "day",
    display: g(/(?:^|&)disp=(base|standard|other)/) || "standard",
    shallow: num(/(?:^|&)shallow=(\d+(?:\.\d+)?)/, 2),
    safety: num(/(?:^|&)safety=(\d+(?:\.\d+)?)/, 10),
    deep: num(/(?:^|&)deep=(\d+(?:\.\d+)?)/, 20),
    scamin: !/(?:^|&)scamin=0/.test(q),
  };
}
function settingsKey(s) {
  let k = s.palette;
  const x = [];
  if (s.display !== "standard") x.push(s.display);
  if (!(s.shallow === 2 && s.safety === 10 && s.deep === 20)) x.push(`c${s.shallow}-${s.safety}-${s.deep}`);
  if (!s.scamin) x.push("nsc");
  return x.length ? `${k}__${x.join("_")}` : k;
}

async function getTilePng(z, x, y, settings) {
  const key = settingsKey(settings);
  const file = path.join(TILE_DIR, key, String(z), String(x), `${y}.png`);
  try { return await readFileP(file); } catch { /* cache miss → render */ }
  const ck = `${key}/${z}/${x}/${y}`;
  if (_tileInflight.has(ck)) return _tileInflight.get(ck);
  const job = (async () => {
    if (!_renderTile) ({ renderTile: _renderTile } = await import("./lib/render-tile.mjs"));
    const png = await _renderTile(z, x, y, { tileSize: 256, ...settings });
    try { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, png); } catch { /* best-effort */ }
    return png;
  })();
  _tileInflight.set(ck, job);
  try { return await job; } finally { _tileInflight.delete(ck); }
}

http
  .createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (urlPath === "/api/cells") {
      const files = listEncCellNames();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(files));
      return;
    }
    if (urlPath === "/api/index") {
      const idx = buildCellIndex();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(idx));
      return;
    }
    if (urlPath === "/cell-index.json") {
      const prebuilt = path.join(root, "cell-index.json");
      readFile(prebuilt, (err, data) => {
        if (!err) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(data);
          return;
        }
        const idx = buildCellIndex();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(idx));
      });
      return;
    }
    const mTile = urlPath.match(/^\/tile\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (mTile) {
      const settings = tileSettings(req.url.split("?")[1] || "");
      const z = +mTile[1], x = +mTile[2], y = +mTile[3];
      getTilePng(z, x, y, settings).then((png) => {
        // CORS: 별도 타일 서버일 때 Vercel 등 다른 출처의 앱이 타일을 가져올 수 있게 허용
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable", "Access-Control-Allow-Origin": "*" });
        res.end(png);
      }).catch((err) => {
        res.writeHead(500, { "Access-Control-Allow-Origin": "*" }); res.end("tile render error: " + (err && err.message || err));
      });
      return;
    }
    const filePath = resolvedStaticFile(urlPath);
    if (filePath == null) { res.writeHead(403); res.end("forbidden"); return; }
    readFile(filePath, (err, data) => {
      if (err) {
        const ext404 = path.extname(path.basename(urlPath)).toLowerCase();
        const ct = MIME[ext404] || "text/plain; charset=utf-8";
        res.writeHead(404, { "Content-Type": ct });
        res.end(ext404 === ".css" ? "/* not found on server */\n" : "not found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
      // 변하지 않는 정적 자산(ENC 셀·심볼·카탈로그)은 장기 캐시 → 재방문 시 네트워크 0.
      if (ext === ".000" || ext === ".png" || ext === ".csv" || ext === ".xml") {
        headers["Cache-Control"] = "public, max-age=31536000, immutable";
      } else if (ext === ".js" || ext === ".mjs") {
        headers["Cache-Control"] = "public, max-age=86400"; // ?v= 쿼리로 무효화하므로 안전
      }
      res.writeHead(200, headers);
      res.end(data);
    });
  })
  .listen(port, "0.0.0.0", () => {
    for (const v of ["vendor/ol.css", "vendor/ol.js"]) {
      if (!existsSync(path.join(root, v))) {
        console.error(`[serve] missing ${v} — OpenLayers will not load; commit vendor/ and redeploy.`);
      }
    }
    // 타일 렌더 엔진을 백그라운드로 예열 — 첫 타일 요청의 일회성 init 지연을 숨긴다.
    // 정적 서빙만 쓰는 경우에도 실패는 무시(node-canvas 미설치 환경 등).
    import("./lib/render-tile.mjs").then((m) => m.warmup()).then(
      () => console.log("tile render engine ready (/tile/{z}/{x}/{y}.png)")
    ).catch((e) => console.log("tile engine warmup skipped:", e && e.message || e));
    console.log(`S-52 viewer (this machine): http://localhost:${port}/`);
    const nets = os.networkInterfaces();
    const addrs = [];
    for (const list of Object.values(nets)) {
      if (!list) continue;
      for (const n of list) {
        if (n.internal) continue;
        if (n.family === "IPv4" || n.family === 4) addrs.push(n.address);
      }
    }
    if (addrs.length) {
      console.log("Same LAN / intranet — open in a browser:");
      for (const a of addrs) console.log(`  http://${a}:${port}/`);
    } else {
      console.log("No non-loopback IPv4 found; use this host's IP manually.");
    }
  });
