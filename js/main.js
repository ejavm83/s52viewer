import { DDF } from "./iso8211.js";
import { S57 } from "./s57.js";
import { S52 } from "./s52.js";
import { loadCatalog } from "./catalog.js";
import { Renderer } from "./render.js?v=10";

const ATLAS_BY_TABLE = {
  DAY_BRIGHT: "assets/rastersymbols-day.png",
  DAY_BLACKBACK: "assets/rastersymbols-day.png",
  DAY_WHITEBACK: "assets/rastersymbols-day.png",
  DUSK: "assets/rastersymbols-dusk.png",
  NIGHT: "assets/rastersymbols-dark.png",
};

/** 모바일 초기 뷰: 부산항·가덕도 일대 (데스크톱 캡처 화면과 유사한 위치·축척) */
const MOBILE_INITIAL_BOUNDS = {
  minX: 128.92,
  maxX: 129.38,
  minY: 34.96,
  maxY: 35.32,
};

const state = {
  s52: null,
  catalog: null,
  renderer: null,
  atlas: {},
  globalBounds: null,
  fitted: false,
};

const canvas = document.getElementById("chart");
const statusEl = document.getElementById("status");
const listEl = document.getElementById("celllist");
const mapLoadingEl = document.getElementById("map-loading");
const minimapCanvas = document.getElementById("minimap");
const minimapWrap = document.getElementById("minimap-wrap");
const scaleBarLabel = document.getElementById("scale-bar-label");
const scaleBarTrack = document.getElementById("scale-bar-track");

const R_EARTH = 6378137;
const NM = 1852;

function mercX(lonDeg) {
  return (lonDeg * Math.PI) / 180;
}
function mercY(latDeg) {
  const lat = (latDeg * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + lat / 2));
}

/** 뷰포트와 동일한 공식: 화면 1픽셀당 지상 거리(m) */
function metresPerPixel(vp) {
  const phi = (vp.centerLat() * Math.PI) / 180;
  return (R_EARTH * Math.cos(phi)) / vp.scale;
}

function niceLengthMeters(maxLen) {
  if (!(maxLen > 0) || !Number.isFinite(maxLen)) return 1000;
  const expFloor = Math.floor(Math.log10(maxLen));
  const norm = maxLen / 10 ** expFloor;
  const mant = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return mant * 10 ** expFloor;
}

function formatScaleLabel(meters) {
  if (meters >= NM * 0.5) {
    const nm = meters / NM;
    return nm >= 10 ? `${Math.round(nm)} NM` : `${Number(nm.toFixed(1))} NM`;
  }
  if (meters >= 1000) {
    const km = meters / 1000;
    return km >= 100 ? `${Math.round(km)} km` : `${km.toFixed(km >= 10 ? 0 : 1)} km`;
  }
  return `${Math.round(meters)} m`;
}

function updateScaleBar() {
  const vp = state.renderer?.vp;
  if (!vp || !scaleBarLabel || !scaleBarTrack) return;
  const mpp = metresPerPixel(vp);
  const maxPx = Math.min(168, Math.max(72, canvas.width * 0.26));
  const rawM = mpp * maxPx;
  const snapM = niceLengthMeters(rawM);
  const barPx = Math.max(28, Math.min(maxPx, snapM / mpp));
  scaleBarLabel.textContent = formatScaleLabel(snapM);
  scaleBarTrack.style.width = `${barPx}px`;
}

function syncMinimapSize() {
  if (!minimapCanvas || !minimapWrap) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(minimapWrap.clientWidth * dpr));
  const h = Math.max(1, Math.round(minimapWrap.clientHeight * dpr));
  if (minimapCanvas.width !== w || minimapCanvas.height !== h) {
    minimapCanvas.width = w;
    minimapCanvas.height = h;
  }
}

/**
 * 전역 범위를 미니맵 캔버스에 맞춤.
 * @returns {{ sx:(mx:number)=>number, sy:(my:number)=>number, inv:(px:number,py:number)=>[number,number], w:number, h:number } | null}
 */
function minimapTransform(gb, padPx) {
  if (!gb || !minimapCanvas) return null;
  const w = minimapCanvas.width;
  const h = minimapCanvas.height;
  const mx0 = mercX(gb.minX);
  const mx1 = mercX(gb.maxX);
  const my0 = mercY(gb.minY);
  const my1 = mercY(gb.maxY);
  const minMx = Math.min(mx0, mx1);
  const maxMx = Math.max(mx0, mx1);
  const minMy = Math.min(my0, my1);
  const maxMy = Math.max(my0, my1);
  const dx = maxMx - minMx || 1e-6;
  const dy = maxMy - minMy || 1e-6;
  const innerW = w - 2 * padPx;
  const innerH = h - 2 * padPx;
  const scale = Math.min(innerW / dx, innerH / dy);
  const cx = (minMx + maxMx) / 2;
  const cy = (minMy + maxMy) / 2;
  const ox = w / 2;
  const oy = h / 2;
  return {
    w,
    h,
    sx: (mx) => ox + (mx - cx) * scale,
    sy: (my) => oy - (my - cy) * scale,
    inv(px, py) {
      return [cx + (px - ox) / scale, cy - (py - oy) / scale];
    },
  };
}

function updateMinimap() {
  if (!state.renderer || !minimapCanvas || !state.globalBounds) return;
  syncMinimapSize();
  const gb = state.globalBounds;
  const dpr = window.devicePixelRatio || 1;
  const pad = Math.round(6 * dpr);
  const tf = minimapTransform(gb, pad);
  if (!tf) return;
  const ctx = minimapCanvas.getContext("2d");
  const { w, h } = tf;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(218, 235, 248, 0.97)";
  ctx.fillRect(0, 0, w, h);

  for (const g of state.renderer.grid) {
    const x0 = tf.sx(mercX(g.minX));
    const y0 = tf.sy(mercY(g.maxY));
    const x1 = tf.sx(mercX(g.maxX));
    const y1 = tf.sy(mercY(g.minY));
    const x = Math.min(x0, x1);
    const y = Math.min(y0, y1);
    const rw = Math.abs(x1 - x0);
    const rh = Math.abs(y1 - y0);
    const cell = state.renderer.cells.get(g.name);
    const vis = cell?.visible;
    ctx.fillStyle = vis ? "rgba(52, 152, 219, 0.32)" : "rgba(255,255,255,0.08)";
    ctx.fillRect(x, y, rw, rh);
    ctx.strokeStyle = vis ? "rgba(32, 102, 148, 0.55)" : "rgba(26, 37, 48, 0.2)";
    ctx.lineWidth = 1 * dpr;
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, rw - 1), Math.max(0, rh - 1));
  }

  const vp = state.renderer.vp;
  const mw = canvas.width;
  const mh = canvas.height;
  const corners = [
    vp.mercFromScreen(0, 0),
    vp.mercFromScreen(mw, 0),
    vp.mercFromScreen(mw, mh),
    vp.mercFromScreen(0, mh),
  ];
  let minPx = Infinity;
  let minPy = Infinity;
  let maxPx = -Infinity;
  let maxPy = -Infinity;
  for (const [mx, my] of corners) {
    const px = tf.sx(mx);
    const py = tf.sy(my);
    if (px < minPx) minPx = px;
    if (py < minPy) minPy = py;
    if (px > maxPx) maxPx = px;
    if (py > maxPy) maxPy = py;
  }
  ctx.strokeStyle = "rgba(192, 57, 43, 0.92)";
  ctx.lineWidth = 2 * dpr;
  ctx.setLineDash([]);
  ctx.strokeRect(minPx, minPy, maxPx - minPx, maxPy - minPy);

  ctx.strokeStyle = "rgba(26, 37, 48, 0.45)";
  ctx.lineWidth = 1 * dpr;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
}

function updateMapOverlays() {
  updateScaleBar();
  updateMinimap();
}

function isMobileLayout() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function setStatus(t) { statusEl.textContent = t; }

function setMapLoading(msg) {
  if (!mapLoadingEl) return;
  if (!msg) {
    mapLoadingEl.hidden = true;
    mapLoadingEl.textContent = "로딩 중…";
  } else {
    mapLoadingEl.hidden = false;
    mapLoadingEl.textContent = msg;
  }
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

async function init() {
  setStatus("S-52 표현 라이브러리 로드 중…");
  state.s52 = await new S52().load("assets/chartsymbols.xml");
  state.catalog = await loadCatalog(
    "assets/s57objectclasses.csv",
    "assets/s57attributes.csv"
  );
  state.atlas.DAY_BRIGHT = await loadImage(ATLAS_BY_TABLE.DAY_BRIGHT);
  state.renderer = new Renderer(canvas, state.s52, state.atlas.DAY_BRIGHT);

  setStatus("셀 커버리지 인덱스 로드 중…");
  let idxRes = await fetch("/cell-index.json", { cache: "no-store" });
  if (!idxRes.ok) idxRes = await fetch("/api/index");
  if (!idxRes.ok) throw new Error("셀 인덱스를 불러오지 못했습니다.");
  const idx = await idxRes.json();
  state.renderer.grid = idx;
  for (const g of idx) {
    state.renderer.cells.set(g.name, {
      name: g.name, bounds: g, visible: false, loaded: false, features: null,
    });
  }
  state.globalBounds = globalBoundsOf(idx);
  buildCellList(idx);
  resize();
  if (isMobileLayout()) state.renderer.vp.fit(MOBILE_INITIAL_BOUNDS);
  else state.renderer.vp.fit(state.globalBounds);
  state.fitted = true;
  draw();

  if (isMobileLayout()) {
    setStatus(`준비 완료 — 셀 ${idx.length}개. 지도를 움직이면 해당 화면 영역의 ENC만 불러옵니다.`);
  } else {
    setStatus(`준비 완료 — 셀 ${idx.length}개. 기본 뷰에서 겹치는 셀을 곧 불러옵니다…`);
  }
}

function globalBoundsOf(idx) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const g of idx) {
    if (g.minX < minX) minX = g.minX; if (g.maxX > maxX) maxX = g.maxX;
    if (g.minY < minY) minY = g.minY; if (g.maxY > maxY) maxY = g.maxY;
  }
  return { minX, minY, maxX, maxY };
}

function resize() {
  const wrap = canvas.parentElement;
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  syncMinimapSize();
  // 첫 뷰 맞춤은 init() / openFile()에서만 수행 (모바일 전역 fit 덮어쓰기 방지)
  draw();
}
window.addEventListener("resize", resize);

if (minimapWrap) {
  minimapWrap.addEventListener("click", (e) => {
    if (!state.renderer?.vp || !state.globalBounds) return;
    const cvs = minimapCanvas;
    if (!cvs) return;
    const rect = cvs.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    syncMinimapSize();
    const tf = minimapTransform(state.globalBounds, Math.round(6 * dpr));
    if (!tf) return;
    const px = ((e.clientX - rect.left) / rect.width) * cvs.width;
    const py = ((e.clientY - rect.top) / rect.height) * cvs.height;
    const [mx, my] = tf.inv(px, py);
    state.renderer.vp.cx = mx;
    state.renderer.vp.cy = my;
    draw();
    if (isMobileLayout()) scheduleMobileViewportSync();
  });
}

let _rafPending = false;
function draw() {
  if (!state.renderer || _rafPending) return;
  _rafPending = true;
  requestAnimationFrame(() => {
    _rafPending = false;
    state.renderer.render();
    updateMapOverlays();
  });
}

// ---- cell loading ----
// Pool of parsing workers: the heavy ISO-8211 + S-57 decode runs off the main
// thread so the UI stays responsive even while loading many large cells.
class CellLoader {
  constructor(size) {
    this.idle = []; this.queue = []; this.jobs = new Map(); this.nextId = 1; this.fallback = false;
    try {
      for (let i = 0; i < size; i++) {
        const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
        w.onmessage = (e) => this._done(w, e.data);
        w.onerror = (e) => console.error("parse worker error:", e.message || e);
        this.idle.push(w);
      }
    } catch (err) {
      console.warn("workers unavailable; parsing on main thread:", err);
    }
    if (this.idle.length === 0) this.fallback = true;
  }
  parse(buffer) {
    // fallback: parse synchronously on the main thread (worker unsupported)
    if (this.fallback) return Promise.resolve(S57.build(DDF.parse(buffer), state.catalog));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.jobs.set(id, { resolve, reject });
      this.queue.push({ id, buffer });
      this._pump();
    });
  }
  _pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop();
      const job = this.queue.shift();
      w.postMessage({ id: job.id, buffer: job.buffer }, [job.buffer]);
    }
  }
  _done(w, data) {
    const job = this.jobs.get(data.id);
    this.jobs.delete(data.id);
    this.idle.push(w);
    this._pump();
    if (!job) return;
    if (data.error) job.reject(new Error(data.error));
    else job.resolve(data.chart);
  }
}
const loader = new CellLoader(Math.min(4, navigator.hardwareConcurrency || 4));

async function ensureLoaded(name) {
  const cell = state.renderer.cells.get(name);
  if (!cell || cell.loaded) return cell;
  if (cell._loading) return cell._loading; // dedupe concurrent requests
  cell._loading = (async () => {
    const buf = await (await fetch("000/" + name)).arrayBuffer();
    const chart = await loader.parse(buf); // parsed in a worker (off main thread)
    cell.features = chart.features;
    cell.chartBounds = chart.bounds;
    cell.loaded = true;
    return cell;
  })();
  return cell._loading;
}

async function setCellVisible(name, on, refit) {
  const cell = state.renderer.cells.get(name);
  if (!cell) return;
  if (on && !cell.loaded) {
    setStatus(`${name} 불러오는 중…`);
    await ensureLoaded(name);
  }
  cell.visible = on;
  syncRow(name);
  if (on && refit && cell.chartBounds) {
    state.renderer.vp.fit(cell.chartBounds);
  }
  draw();
  const vis = [...state.renderer.cells.values()].filter((c) => c.visible).length;
  setStatus(`표시 중 ${vis}개 / 전체 ${state.renderer.cells.size}개`);
  refreshObjects();
}

// ---- cell list UI ----
const rows = new Map(); // name -> {checkbox, el}
function buildCellList(idx) {
  const sorted = [...idx].sort((a, b) => a.name.localeCompare(b.name));
  const frag = document.createDocumentFragment();
  for (const g of sorted) {
    const row = document.createElement("label");
    row.className = "cellrow";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.addEventListener("change", () => setCellVisible(g.name, cb.checked, false));
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = bandColor(g.name);
    const txt = document.createElement("span");
    txt.className = "cellname";
    txt.textContent = g.name.replace(/\.000$/i, "");
    txt.title = `${g.name} — 1:${g.cscl || "?"}  [${g.minX.toFixed(2)},${g.minY.toFixed(2)}]→[${g.maxX.toFixed(2)},${g.maxY.toFixed(2)}]`;
    row.append(cb, dot, txt);
    row.addEventListener("click", () => {
      focusViewportToCellName(g.name);
      setObjScopeTo(g.name); // scope the object panel to the clicked cell
    });
    frag.appendChild(row);
    rows.set(g.name, { checkbox: cb, el: row });
  }
  listEl.appendChild(frag);
}
function syncRow(name) {
  const r = rows.get(name);
  const cell = state.renderer.cells.get(name);
  if (r && cell) { r.checkbox.checked = cell.visible; r.el.classList.toggle("on", cell.visible); }
}

/** 지도·목록에서 마지막으로 포커스한 셀(.000) — 툴바·셀 목록 강조 */
function syncCellListFocus(scrollList = true) {
  const name = state.renderer?.gridFocusName || "";
  for (const [n, r] of rows) r.el.classList.toggle("focus", n === name);
  if (focusedCellEl) {
    focusedCellEl.textContent = name ? `보는 셀: ${name}` : "";
    focusedCellEl.title = name ? `현재 ENC: ${name}` : "지도에서 마지막으로 포커스한 ENC 셀(.000)";
  }
  if (scrollList) {
    const r = name ? rows.get(name) : null;
    if (r?.el) r.el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}
function bandColor(name) {
  const m = name.match(/^[A-Z]{2}(\d)/i);
  const b = m ? +m[1] : 0;
  return ({ 1: "#e74c3c", 2: "#e67e22", 3: "#f1c40f", 4: "#2ecc71", 5: "#3498db", 6: "#9b59b6" })[b] || "#888";
}

// filter box
document.getElementById("filter").addEventListener("input", (e) => {
  const q = e.target.value.trim().toUpperCase();
  for (const [name, r] of rows) r.el.style.display = name.toUpperCase().includes(q) ? "" : "none";
});

/** 모바일: 팬·줌이 멈춘 뒤 화면과 겹치는 셀만 로드. 뷰 밖 셀은 표시 끔(메모리는 유지). */
let _mobileVpSyncTimer = null;
function scheduleMobileViewportSync() {
  if (!isMobileLayout() || !state.renderer) return;
  clearTimeout(_mobileVpSyncTimer);
  _mobileVpSyncTimer = setTimeout(() => {
    _mobileVpSyncTimer = null;
    const keep = new Set(namesIntersectingViewport());
    for (const cell of state.renderer.cells.values()) {
      if (keep.has(cell.name)) continue;
      cell.visible = false;
      syncRow(cell.name);
    }
    void loadMany([...keep], { mobileLabel: "화면 영역 ENC" });
  }, 220);
}

/** 셀 커버리지가 현재 캔버스 뷰포트와 겹치는 셀 이름 목록 */
function namesIntersectingViewport() {
  const vp = state.renderer.vp;
  const w = canvas.width, h = canvas.height;
  const targets = [];
  for (const g of state.renderer.grid) {
    const [x0, y0] = vp.project(g.minX, g.maxY);
    const [x1, y1] = vp.project(g.maxX, g.minY);
    if (Math.max(x0, x1) < 0 || Math.min(x0, x1) > w || Math.max(y0, y1) < 0 || Math.min(y0, y1) > h) continue;
    targets.push(g.name);
  }
  return targets;
}

// bulk actions
document.getElementById("showVisible").addEventListener("click", async () => {
  await loadMany(namesIntersectingViewport());
});
document.getElementById("hideAll").addEventListener("click", () => {
  for (const c of state.renderer.cells.values()) c.visible = false;
  for (const name of rows.keys()) syncRow(name);
  draw();
  setStatus("모두 숨김");
});
document.getElementById("fitAll").addEventListener("click", () => {
  state.renderer.vp.fit(state.globalBounds); draw();
});

// ---- object-class panel: which S-57 classes the loaded cells contain, with
// per-class show/hide. Distinguishes present classes from the full catalog. ----
let objCatalog = null;   // acronym -> human-readable name (English)
let objCatalogKo = null; // acronym (uppercase) -> Korean label
let objCatalogTotal = 0; // total classes in the S-57 catalog
const objListEl = document.getElementById("objlist");
const objStatEl = document.getElementById("objstat");
const objPanelEl = document.getElementById("panelObjs");

function splitCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

async function loadObjCatalog() {
  if (objCatalog) return objCatalog;
  objCatalog = new Map();
  objCatalogKo = new Map();
  try {
    const txt = await (await fetch("assets/s57objectclasses.csv")).text();
    const lines = txt.split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const cols = splitCsvLine(lines[i]);
      if (cols.length < 3 || !cols[2]) continue;
      objCatalog.set(cols[2], cols[1]); // acronym -> ObjectClass name
    }
    objCatalogTotal = objCatalog.size;
  } catch { /* names optional */ }
  try {
    const txtKo = await (await fetch("assets/s57objectclasses-ko.csv")).text();
    const koLines = txtKo.split(/\r?\n/);
    for (let i = 1; i < koLines.length; i++) {
      if (!koLines[i]) continue;
      const cols = splitCsvLine(koLines[i]);
      if (cols.length < 2 || !cols[0]) continue;
      objCatalogKo.set(cols[0].toUpperCase(), cols[1]);
    }
  } catch { /* Korean labels optional */ }
  return objCatalog;
}

function setObjScopeTo(name) {
  populateObjScope();
  const sel = document.getElementById("objscope");
  if (sel) { sel.value = name; refreshObjects(); }
}

/** 인덱스 셀 범위로 뷰 이동(오브젝트 범위 선택·셀 행 클릭 등에서 공통 사용) */
function focusViewportToCellName(name) {
  if (!name || !state.renderer) return;
  const g = state.renderer.grid.find((x) => x.name === name);
  if (!g) return;
  state.renderer.gridFocusName = name;
  state.renderer.vp.fit({
    minX: g.minX,
    minY: g.minY,
    maxX: g.maxX,
    maxY: g.maxY,
  });
  state.fitted = true;
  draw();
  syncCellListFocus();
  if (isMobileLayout()) scheduleMobileViewportSync();
}

let objScopeFilled = false;
function populateObjScope() {
  if (objScopeFilled || !state.renderer) return;
  const sel = document.getElementById("objscope");
  const frag = document.createDocumentFragment();
  for (const name of state.renderer.grid.map((g) => g.name).sort()) {
    const o = document.createElement("option");
    o.value = name; o.textContent = name.replace(/\.000$/i, "");
    frag.appendChild(o);
  }
  sel.appendChild(frag);
  objScopeFilled = true;
}

async function refreshObjects() {
  if (!objPanelEl || objPanelEl.hidden || !state.renderer) return;
  const scope = document.getElementById("objscope").value; // "" = all visible
  if (scope) {
    const cell = state.renderer.cells.get(scope);
    if (cell && !cell.loaded) { objStatEl.textContent = `${scope} 불러오는 중…`; await ensureLoaded(scope); }
  }
  const stats = state.renderer.classStats(scope || undefined); // acronym -> count
  const hidden = state.renderer.hiddenClasses;
  const showAll = document.getElementById("objShowAll").checked;
  const q = document.getElementById("objfilter").value.trim().toUpperCase();

  let acronyms = showAll && objCatalog ? [...objCatalog.keys()] : [...stats.keys()];
  acronyms.sort((a, b) => (stats.get(b) || 0) - (stats.get(a) || 0) || a.localeCompare(b));

  const frag = document.createDocumentFragment();
  for (const ac of acronyms) {
    const cnt = stats.get(ac) || 0;
    const name = (objCatalog && objCatalog.get(ac)) || "";
    const ko = (objCatalogKo && objCatalogKo.get(ac.toUpperCase())) || "";
    if (q && !ac.toUpperCase().includes(q) && !name.toUpperCase().includes(q) && !(ko && ko.toUpperCase().includes(q))) continue;
    const row = document.createElement("label");
    row.className = "objrow" + (cnt === 0 ? " absent" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !hidden.has(ac);
    cb.disabled = cnt === 0;
    cb.addEventListener("change", () => {
      if (cb.checked) hidden.delete(ac); else hidden.add(ac);
      draw();
    });
    const acEl = document.createElement("span"); acEl.className = "ac"; acEl.textContent = ac;
    const nmWrap = document.createElement("span"); nmWrap.className = "nmwrap";
    const nmEl = document.createElement("span"); nmEl.className = "nm"; nmEl.textContent = name;
    nmWrap.appendChild(nmEl);
    if (ko) {
      const koEl = document.createElement("span"); koEl.className = "ko"; koEl.textContent = ko;
      nmWrap.appendChild(koEl);
    }
    const cntEl = document.createElement("span"); cntEl.className = "cnt"; cntEl.textContent = cnt || "";
    row.append(cb, acEl, nmWrap, cntEl);
    frag.appendChild(row);
  }
  objListEl.replaceChildren(frag);

  const present = stats.size;
  const hiddenPresent = [...hidden].filter((h) => stats.has(h)).length;
  const who = scope ? scope.replace(/\.000$/i, "") : "표시 중 전체";
  objStatEl.textContent =
    `${who} — 포함 ${present}종 / 전체 ${objCatalogTotal || "?"}종 · 표시 ${present - hiddenPresent}종`;
}

function showTab(which) {
  const cells = which === "cells";
  document.getElementById("panelCells").hidden = !cells;
  document.getElementById("panelObjs").hidden = cells;
  document.getElementById("tabCells").classList.toggle("active", cells);
  document.getElementById("tabObjs").classList.toggle("active", !cells);
  if (!cells) { populateObjScope(); loadObjCatalog().then(refreshObjects); }
}
document.getElementById("tabCells").addEventListener("click", () => showTab("cells"));
document.getElementById("tabObjs").addEventListener("click", () => showTab("objs"));
document.getElementById("objscope").addEventListener("change", (e) => {
  const v = e.target.value;
  if (v) focusViewportToCellName(v);
  refreshObjects();
});
document.getElementById("objfilter").addEventListener("input", refreshObjects);
document.getElementById("objShowAll").addEventListener("change", refreshObjects);
document.getElementById("objAll").addEventListener("click", () => {
  state.renderer.hiddenClasses.clear(); draw(); refreshObjects();
});
document.getElementById("objNone").addEventListener("click", () => {
  for (const ac of state.renderer.classStats().keys()) state.renderer.hiddenClasses.add(ac);
  draw(); refreshObjects();
});

async function loadMany(names, opts = {}) {
  const mobileLabel = opts.mobileLabel || "ENC 전체";
  const CONC = 4;
  let done = 0;
  const total = names.length;
  for (let i = 0; i < names.length; i += CONC) {
    const chunk = names.slice(i, i + CONC);
    if (isMobileLayout()) setMapLoading(`${mobileLabel} (${done}/${total})…`);
    setStatus(`로딩 ${Math.min(done + 1, total)}/${total}`);
    await Promise.all(chunk.map((n) => ensureLoaded(n)));
    for (const name of chunk) {
      const cell = state.renderer.cells.get(name);
      if (cell) { cell.visible = true; syncRow(name); }
      done++;
    }
    if (done % 8 === 0 || done === total) draw();
  }
  draw();
  const vis = [...state.renderer.cells.values()].filter((c) => c.visible).length;
  setStatus(`표시 중 ${vis}개 / 전체 ${state.renderer.cells.size}개`);
  setMapLoading("");
  refreshObjects();
}

// ---- file open / drag&drop (adds a cell) ----
document.getElementById("file").addEventListener("change", (e) => {
  if (e.target.files[0]) openFile(e.target.files[0]);
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]);
});
async function openFile(file) {
  setStatus(`${file.name} 파싱 중…`);
  const buf = await file.arrayBuffer();
  const chart = await loader.parse(buf); // parsed in a worker
  let cell = state.renderer.cells.get(file.name);
  if (!cell) {
    cell = { name: file.name, bounds: chart.bounds, visible: true, loaded: true, features: chart.features, chartBounds: chart.bounds };
    state.renderer.cells.set(file.name, cell);
    state.renderer.grid.push({ name: file.name, ...chart.bounds, cscl: chart.comf ? null : null });
  } else {
    cell.features = chart.features; cell.loaded = true; cell.visible = true; cell.chartBounds = chart.bounds;
  }
  state.renderer.vp.fit(chart.bounds); state.fitted = true;
  state.renderer.gridFocusName = file.name;
  draw();
  syncCellListFocus();
  setStatus(`${file.name}: 피처 ${chart.features.length}개`);
}

async function loadFromUrl(url) {
  const name = url.split("/").pop();
  await setCellVisible(name, true, true);
  if (state.renderer) {
    state.renderer.gridFocusName = name;
    syncCellListFocus();
  }
}

// ---- view options ----
document.getElementById("palette").addEventListener("change", async (e) => {
  const t = e.target.value;
  state.s52.setColorTable(t);
  if (!state.atlas[t]) state.atlas[t] = await loadImage(ATLAS_BY_TABLE[t]);
  state.renderer.atlas = state.atlas[t];
  draw();
});
document.getElementById("dispcat").addEventListener("change", (e) => { state.renderer.minDisplayCat = e.target.value; draw(); });
document.getElementById("text").addEventListener("change", (e) => { state.renderer.showText = e.target.checked; draw(); });
document.getElementById("sound").addEventListener("change", (e) => { state.renderer.showSoundings = e.target.checked; draw(); });
document.getElementById("scamin").addEventListener("change", (e) => { state.renderer.respectScamin = e.target.checked; draw(); });
document.getElementById("declutter").addEventListener("change", (e) => { state.renderer.declutter = e.target.checked; draw(); });
document.getElementById("grid").addEventListener("change", (e) => {
  state.renderer.showGrid = e.target.checked;
  if (e.target.checked) state.renderer.invalidateEncBoundaryResIfStale();
  draw();
});
document.getElementById("graticule").addEventListener("change", (e) => {
  state.renderer.showGraticule = e.target.checked;
  draw();
});
document.getElementById("scaledisp").addEventListener("change", (e) => { state.renderer.scaleDisplay = e.target.checked; draw(); });
document.getElementById("depthunit").addEventListener("change", (e) => { state.renderer.depthUnit = e.target.value; draw(); });

document.getElementById("sidebarVisible").addEventListener("change", (e) => {
  document.body.classList.toggle("sidebar-collapsed", !e.target.checked);
  resize();
});

// ---- pan & zoom + click-to-toggle a cell on the grid ----
let dragging = false, moved = false, startX = 0, startY = 0, lastX = 0, lastY = 0;
canvas.addEventListener("mousedown", (e) => {
  dragging = true; moved = false;
  startX = lastX = e.clientX; startY = lastY = e.clientY;
  state.renderer.beginPan();
});
window.addEventListener("mouseup", () => {
  if (!dragging) return;
  dragging = false;
  if (moved) {
    draw(); // final full-detail render at the settled position
    if (isMobileLayout()) scheduleMobileViewportSync();
  }
});
window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 2) moved = true;
  const vp = state.renderer.vp;
  vp.cx -= (e.clientX - lastX) / vp.scale; vp.cy += (e.clientY - lastY) / vp.scale;
  lastX = e.clientX; lastY = e.clientY;
  // cheap: blit the snapshot shifted by the total drag, no feature drawing
  state.renderer.previewPan(e.clientX - startX, e.clientY - startY);
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  state.renderer.vp.scale *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
  draw();
  if (isMobileLayout()) scheduleMobileViewportSync();
}, { passive: false });

const ZOOM_KEY_FACTOR = 1.15;
const PAN_STEP_PX = 64;

/** 문자 입력 중인 폼 요소에만 포커스가 있을 때 맵 단축키 무시 (파일·체크박스 등은 제외) */
function keyboardTargetIgnoresMapKeys(el) {
  if (!el || el === document.body) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const t = (el.type || "text").toLowerCase();
    if (["text", "search", "url", "tel", "email", "password", "number"].includes(t)) return true;
  }
  return false;
}

function isZoomInKey(e) {
  const c = e.code;
  return c === "Equal" || c === "NumpadAdd" || e.key === "+" || e.key === "=";
}

function isZoomOutKey(e) {
  const c = e.code;
  return c === "Minus" || c === "NumpadSubtract" || e.key === "-" || e.key === "_";
}

window.addEventListener("keydown", (e) => {
  if (!state.renderer || keyboardTargetIgnoresMapKeys(e.target)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const vp = state.renderer.vp;
  let handled = false;
  const k = e.key;
  if (k === "ArrowUp" || k === "w" || k === "W") {
    vp.cy += PAN_STEP_PX / vp.scale;
    handled = true;
  } else if (k === "ArrowDown" || k === "s" || k === "S") {
    vp.cy -= PAN_STEP_PX / vp.scale;
    handled = true;
  } else if (k === "ArrowLeft" || k === "a" || k === "A") {
    vp.cx -= PAN_STEP_PX / vp.scale;
    handled = true;
  } else if (k === "ArrowRight" || k === "d" || k === "D") {
    vp.cx += PAN_STEP_PX / vp.scale;
    handled = true;
  } else if (isZoomInKey(e)) {
    const cx = canvas.width / 2, cy = canvas.height / 2;
    vp.zoomAtScreen(cx, cy, vp.scale * ZOOM_KEY_FACTOR);
    handled = true;
  } else if (isZoomOutKey(e)) {
    const cx = canvas.width / 2, cy = canvas.height / 2;
    vp.zoomAtScreen(cx, cy, vp.scale / ZOOM_KEY_FACTOR);
    handled = true;
  }
  if (!handled) return;
  e.preventDefault();
  draw();
  if (isMobileLayout()) scheduleMobileViewportSync();
});
// click a grid rectangle to toggle that cell
canvas.addEventListener("click", (e) => {
  if (moved) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const hit = pickCell(mx, my);
  if (hit) {
    state.renderer.gridFocusName = hit;
    syncCellListFocus(false);
    setCellVisible(hit, !state.renderer.cells.get(hit).visible, false);
  }
});

// 터치 패닝 · 핀치 줌 (모바일)
let touchLast = null;
/** @type {{ dist: number, scale: number, cx: number, cy: number } | null } */
let pinch = null;

function touchDistance(a, b) {
  const dx = a.clientX - b.clientX, dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy) || 1;
}

canvas.addEventListener("touchstart", (e) => {
  if (e.touches.length === 2) {
    touchLast = null;
    const t0 = e.touches[0], t1 = e.touches[1];
    const rect = canvas.getBoundingClientRect();
    pinch = {
      dist: touchDistance(t0, t1),
      scale: state.renderer.vp.scale,
      cx: ((t0.clientX + t1.clientX) / 2) - rect.left,
      cy: ((t0.clientY + t1.clientY) / 2) - rect.top,
    };
    dragging = true;
    moved = false;
    return;
  }
  pinch = null;
  if (e.touches.length !== 1) { touchLast = null; return; }
  touchLast = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  dragging = true;
  moved = false;
}, { passive: true });
canvas.addEventListener("touchmove", (e) => {
  if (!state.renderer) return;
  if (e.touches.length === 2 && pinch) {
    e.preventDefault();
    const t0 = e.touches[0], t1 = e.touches[1];
    const rect = canvas.getBoundingClientRect();
    const d = touchDistance(t0, t1);
    const factor = d / pinch.dist;
    const newScale = Math.min(8e7, Math.max(200, pinch.scale * factor));
    const cx = ((t0.clientX + t1.clientX) / 2) - rect.left;
    const cy = ((t0.clientY + t1.clientY) / 2) - rect.top;
    state.renderer.vp.zoomAtScreen(cx, cy, newScale);
    if (Math.abs(factor - 1) > 0.02) moved = true;
    draw();
    return;
  }
  if (!touchLast || e.touches.length !== 1) return;
  e.preventDefault();
  const t = e.touches[0];
  const dx = t.clientX - touchLast.x, dy = t.clientY - touchLast.y;
  if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
  const vp = state.renderer.vp;
  vp.cx -= dx / vp.scale;
  vp.cy += dy / vp.scale;
  touchLast = { x: t.clientX, y: t.clientY };
  draw();
}, { passive: false });
canvas.addEventListener("touchend", (e) => {
  if (moved) e.preventDefault();
  if (e.touches.length < 2) pinch = null;
  if (e.touches.length === 1) {
    const t = e.touches[0];
    touchLast = { x: t.clientX, y: t.clientY };
    dragging = true;
  } else {
    touchLast = null;
    dragging = false;
    if (isMobileLayout() && moved) scheduleMobileViewportSync();
  }
});
canvas.addEventListener("touchcancel", () => {
  touchLast = null;
  pinch = null;
  dragging = false;
  if (isMobileLayout() && moved) scheduleMobileViewportSync();
});
function pickCell(mx, my) {
  // smallest-area covering rectangle under the cursor (favours detailed cells)
  const vp = state.renderer.vp;
  let best = null, bestArea = Infinity;
  for (const g of state.renderer.grid) {
    const [x0, y0] = vp.project(g.minX, g.maxY);
    const [x1, y1] = vp.project(g.maxX, g.minY);
    const x = Math.min(x0, x1), y = Math.min(y0, y1), ww = Math.abs(x1 - x0), hh = Math.abs(y1 - y0);
    if (mx >= x && mx <= x + ww && my >= y && my <= y + hh && ww * hh < bestArea) {
      bestArea = ww * hh; best = g.name;
    }
  }
  return best;
}

window.s52app = { state, loadFromUrl, setCellVisible, draw };

init().then(async () => {
  const cell = new URLSearchParams(location.search).get("cell");
  if (cell) await loadFromUrl(cell);
  else await loadMany(namesIntersectingViewport(), { mobileLabel: "화면 영역 ENC" });
});
