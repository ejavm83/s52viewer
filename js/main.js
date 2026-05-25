import { DDF } from "./iso8211.js";
import { S57 } from "./s57.js";
import { S52 } from "./s52.js";
import { loadCatalog } from "./catalog.js";
import { Renderer } from "./render.js?v=7";

const ATLAS_BY_TABLE = {
  DAY_BRIGHT: "assets/rastersymbols-day.png",
  DAY_BLACKBACK: "assets/rastersymbols-day.png",
  DAY_WHITEBACK: "assets/rastersymbols-day.png",
  DUSK: "assets/rastersymbols-dusk.png",
  NIGHT: "assets/rastersymbols-dark.png",
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
  state.renderer.vp.fit(state.globalBounds);
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
  if (!state.fitted && state.globalBounds) {
    state.renderer.vp.fit(state.globalBounds);
    state.fitted = true;
  }
  draw();
}
window.addEventListener("resize", resize);

let _rafPending = false;
function draw() {
  if (!state.renderer || _rafPending) return;
  _rafPending = true;
  requestAnimationFrame(() => {
    _rafPending = false;
    state.renderer.render();
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
    txt.textContent = g.name.replace(/\.000$/i, "");
    txt.title = `1:${g.cscl || "?"}  [${g.minX.toFixed(2)},${g.minY.toFixed(2)}]→[${g.maxX.toFixed(2)},${g.maxY.toFixed(2)}]`;
    row.append(cb, dot, txt);
    row.addEventListener("click", () => {
      state.renderer.gridFocusName = g.name;
      draw();
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

/** 모바일: 팬·줌이 멈춘 뒤 화면과 겹치는 셀만 백그라운드 로드(디바운스) */
let _mobileVpSyncTimer = null;
function scheduleMobileViewportSync() {
  if (!isMobileLayout() || !state.renderer) return;
  clearTimeout(_mobileVpSyncTimer);
  _mobileVpSyncTimer = setTimeout(() => {
    _mobileVpSyncTimer = null;
    const names = namesIntersectingViewport();
    void loadMany(names, { mobileLabel: "화면 영역 ENC" });
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
  draw();
  setStatus(`${file.name}: 피처 ${chart.features.length}개`);
}

async function loadFromUrl(url) {
  const name = url.split("/").pop();
  await setCellVisible(name, true, true);
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
