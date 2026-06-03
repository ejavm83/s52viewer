// Server-side ENC tile renderer.
//
// Runs the SAME browser S-52 Renderer (js/render.js) under node-canvas to emit
// PNG tiles — the reference site's architecture (a server renders ENC→raster,
// the client just composites images). We reuse our renderer verbatim via three
// tiny browser shims installed before the app modules are imported:
//   fetch  → read local assets from disk
//   DOMParser → linkedom (s52.js parses chartsymbols.xml with querySelectorAll)
//   document.createElement('canvas') → node-canvas (offscreen helpers)
//
// Web-mercator XYZ tiles (EPSG:3857). Each tile's mercator extent is mapped
// pixel-exactly onto a tileSize² canvas, so tiles composite seamlessly.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCanvas, loadImage, Image as CanvasImage } from "canvas";
import { DOMParser as LinkeDOMParser } from "linkedom";
import { buildCellIndex } from "./cell-index.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetPath = (rel) => path.join(root, rel.replace(/^\.?\//, ""));

// ─────────────────────────── browser shims ───────────────────────────
// Installed on globalThis BEFORE importing render.js / s52.js / catalog.js.
globalThis.DOMParser = LinkeDOMParser;
globalThis.Image = CanvasImage;

const _nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  let p = String(url);
  if (p.startsWith("file://")) p = fileURLToPath(p);
  else if (/^https?:\/\//.test(p)) {
    // our own dev-server asset URLs → read from disk; anything else (satellite
    // tiles) is unused server-side, so defer to native fetch if present.
    try { p = path.join(root, new URL(p).pathname); }
    catch { return _nativeFetch ? _nativeFetch(url, opts) : Promise.reject(new Error("no fetch")); }
  } else {
    p = assetPath(p);
  }
  const buf = readFileSync(p);
  return {
    ok: true,
    status: 200,
    async text() { return buf.toString("utf8"); },
    async json() { return JSON.parse(buf.toString("utf8")); },
    async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); },
  };
};

globalThis.document = {
  createElement(tag) {
    if (String(tag).toLowerCase() === "canvas") return createCanvas(1, 1);
    return { style: {}, getContext: () => null, setAttribute() {}, appendChild() {} };
  },
  getElementById() { return null; },
  body: null,
};

// ───────────────────── app modules (see the shims) ─────────────────────
const { Renderer, projectFeature, mercX, mercY } = await import("../js/render.js");
const { S52 } = await import("../js/s52.js");
const { DDF } = await import("../js/iso8211.js");
const { S57 } = await import("../js/s57.js");
const { loadCatalog } = await import("../js/catalog.js");

// ─────────────────────────── one-time engine ───────────────────────────
let _enginePromise = null;
function getEngine() {
  if (_enginePromise) return _enginePromise;
  _enginePromise = (async () => {
    const s52 = await new S52().load("assets/chartsymbols.xml");
    const catalog = await loadCatalog("assets/s57objectclasses.csv", "assets/s57attributes.csv");
    // S-52 팔레트 3종의 심볼 아틀라스(주/박명/야). 색 테이블은 chartsymbols.xml 안에 모두 있다.
    const atlases = {
      day: await loadImage(assetPath("assets/rastersymbols-day.png")),
      dusk: await loadImage(assetPath("assets/rastersymbols-dusk.png")),
      night: await loadImage(assetPath("assets/rastersymbols-dark.png")),
    };
    // 사전 빌드된 cell-index.json이 있으면 그걸 쓴다(744셀 재파싱 회피 → 빠른 기동).
    // 없으면 buildCellIndex()가 셀을 직접 파싱해 같은 형식을 만든다.
    let index;
    try { index = JSON.parse(readFileSync(assetPath("cell-index.json"), "utf8")); }
    catch { index = buildCellIndex(); }
    return { s52, catalog, atlases, index };
  })();
  return _enginePromise;
}

/** 서버 기동 시 백그라운드로 호출해 첫 타일 요청의 일회성 init 지연을 숨긴다. */
export async function warmup() { await getEngine(); }

// ─────────────────── parsed+projected cell cache ───────────────────
// LRU 상한 — 전국 셀(374MB on disk, 파싱 시 1–2GB)을 전부 들고 있으면 OOM이라 최근 사용
// N개만 유지한다. 타일은 영역별로 처리돼 인접 타일이 같은 셀을 공유하므로 적중률이 높고,
// 밀려난 셀은 다음 방문 시 재파싱(약간의 지연)된다. 라이브 서버·예열 양쪽에 적용.
const CELL_CACHE_MAX = Math.max(20, Number(process.env.CELL_CACHE_MAX) || 140); // 소형 RAM 호스트는 낮게(예: 60)
const _cellCache = new Map(); // name -> { name, bounds, features, visible, loaded }
function getCell(name, bounds, catalog) {
  let cell = _cellCache.get(name);
  if (cell) { _cellCache.delete(name); _cellCache.set(name, cell); return cell; } // LRU bump
  const buf = readFileSync(path.join(root, "000", name));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const chart = S57.build(DDF.parse(ab), catalog);
  for (const f of chart.features) projectFeature(f);
  cell = { name, bounds, features: chart.features, visible: true, loaded: true };
  _cellCache.set(name, cell);
  if (_cellCache.size > CELL_CACHE_MAX) _cellCache.delete(_cellCache.keys().next().value);
  return cell;
}

// ─────────────────────────── tile math ───────────────────────────
// XYZ (EPSG:3857). Mercator extent computed directly from z/x/y (no trig
// round-trip) for pixel-exact tile alignment. lon/lat bbox via the inverse.
function tileMercExtent(z, x, y) {
  const n = 2 ** z;
  const mxL = Math.PI * (2 * x / n - 1);
  const mxR = Math.PI * (2 * (x + 1) / n - 1);
  const myTop = Math.PI * (1 - 2 * y / n);
  const myBot = Math.PI * (1 - 2 * (y + 1) / n);
  return { mxL, mxR, myTop, myBot };
}
function tileLonLatBbox(z, x, y) {
  const n = 2 ** z;
  const lonL = x / n * 360 - 180;
  const lonR = (x + 1) / n * 360 - 180;
  const latT = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  const latB = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  return { minLon: lonL, maxLon: lonR, minLat: latB, maxLat: latT };
}
export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { z, x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

// ─────────────────────────── shared renderer ───────────────────────────
const PALETTE_TABLE = { day: "DAY_BRIGHT", dusk: "DUSK", night: "NIGHT" };
const DISPLAY_CAT = { base: "Displaybase", standard: "Standard", other: "Other" };

// 수심 등고선(shallow/safety/deep)은 s52.resolve가 depth-area 색에 구워넣으므로(feat._res),
// 값이 바뀌면 캐시된 모든 셀의 피처 해석을 무효화해 다음 렌더에서 재해석되게 한다.
// (팔레트=색테이블 변경은 render.js가 feat._resTable로 자동 무효화하므로 별도 처리 불필요.)
function invalidateResCache() {
  for (const cell of _cellCache.values())
    if (cell.features) for (const f of cell.features) f._resTable = null;
}

let _renderer = null;
function getRenderer(engine, tileSize) {
  if (!_renderer || _renderer.canvas.width !== tileSize) {
    const canvas = createCanvas(tileSize, tileSize);
    _renderer = new Renderer(canvas, engine.s52, engine.atlases.day);
    _renderer.showSatellite = false;
    _renderer.forceWorldLand = false;
  }
  return _renderer;
}

/**
 * Render one XYZ tile to a PNG Buffer.
 * @param {number} z @param {number} x @param {number} y
 * @param {{tileSize?:number, palette?:string}} [opts]
 */
export async function renderTile(z, x, y, opts = {}) {
  const tileSize = opts.tileSize || 256;
  const palette = PALETTE_TABLE[opts.palette] ? opts.palette : "day";
  const engine = await getEngine();
  const r = getRenderer(engine, tileSize);
  // 팔레트 적용: 색 테이블(주/박명/야) + 해당 심볼 아틀라스. 렌더러는 테이블이 바뀌면
  // feat._res를 자동 재해석하므로 타일마다 팔레트를 바꿔도 정확하다.
  r.s52.setColorTable(PALETTE_TABLE[palette]);
  r.atlas = engine.atlases[palette];

  // 표시범주(base/standard/other)·SCAMIN은 draw-time 필터 — 그냥 세팅(무효화 불필요).
  r.minDisplayCat = DISPLAY_CAT[opts.display] || "Standard";
  r.respectScamin = opts.scamin !== false;
  // 수심 등고선 — 변경 시에만 _res 무효화(보통 기본값이라 비용 없음).
  const shallow = Number.isFinite(opts.shallow) ? opts.shallow : 2;
  const safety = Number.isFinite(opts.safety) ? opts.safety : 10;
  const deep = Number.isFinite(opts.deep) ? opts.deep : 20;
  if (r.s52.shallow !== shallow || r.s52.safety !== safety || r.s52.deep !== deep) {
    r.s52.shallow = shallow; r.s52.safety = safety; r.s52.deep = deep;
    invalidateResCache();
  }

  // cells intersecting this tile (lon/lat), loaded+projected lazily and cached
  const bb = tileLonLatBbox(z, x, y);
  r.cells = new Map();
  for (const g of engine.index) {
    if (g.maxX < bb.minLon || g.minX > bb.maxLon || g.maxY < bb.minLat || g.minY > bb.maxLat) continue;
    const bounds = { minX: g.minX, minY: g.minY, maxX: g.maxX, maxY: g.maxY, cscl: g.cscl, name: g.name };
    r.cells.set(g.name, getCell(g.name, bounds, engine.catalog));
  }

  // map the tile's mercator extent pixel-exactly onto the tileSize² canvas
  const { mxL, mxR, myTop, myBot } = tileMercExtent(z, x, y);
  const vp = r.vp;
  vp.scale = tileSize / (mxR - mxL);
  vp.cx = (mxL + mxR) / 2;
  vp.cy = (myTop + myBot) / 2;

  r._renderMercator();
  return r.canvas.toBuffer("image/png");
}

export { tileLonLatBbox, tileMercExtent };
