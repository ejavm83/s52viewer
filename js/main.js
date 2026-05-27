import { DDF } from "./iso8211.js";
import { S57 } from "./s57.js";
import { S52 } from "./s52.js";
import { loadCatalog } from "./catalog.js";
import { Renderer } from "./render.js?v=23";

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
const scaleBarLabel = document.getElementById("scale-bar-label");
const scaleBarTrack = document.getElementById("scale-bar-track");
const sidebarEl = document.getElementById("sidebar");
const sidebarResizerEl = document.getElementById("sidebar-resizer");

const SIDEBAR_WIDTH_STORAGE = "encViewerSidebarWidth";
const SIDEBAR_MIN_PX = 200;
const SIDEBAR_MAX_CAP_PX = 900;

function clampSidebarWidthPx(px) {
  const max = Math.min(window.innerWidth * 0.85, SIDEBAR_MAX_CAP_PX);
  return Math.round(Math.min(max, Math.max(SIDEBAR_MIN_PX, px)));
}

function applySidebarWidthPx(px) {
  const w = clampSidebarWidthPx(px);
  document.documentElement.style.setProperty("--sidebar-width", `${w}px`);
  return w;
}

function readStoredSidebarWidthPx() {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE);
    if (raw == null) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function persistSidebarWidthPx(w) {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE, String(w));
  } catch {
    /* private mode 등 */
  }
}

const _storedSidebarW = readStoredSidebarWidthPx();
if (_storedSidebarW != null) applySidebarWidthPx(_storedSidebarW);

if (sidebarResizerEl && sidebarEl) {
  sidebarResizerEl.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarEl.getBoundingClientRect().width;
    sidebarResizerEl.classList.add("resizing");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev) => {
      applySidebarWidthPx(startW + ev.clientX - startX);
      resize();
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      sidebarResizerEl.classList.remove("resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      persistSidebarWidthPx(sidebarEl.getBoundingClientRect().width);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

const R_EARTH = 6378137;
const NM = 1852;

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

function isMobileLayout() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function setStatus(t) { statusEl.textContent = t; }

function setMapLoading(msg) {
  if (!mapLoadingEl) return;
  mapLoadingEl.classList.remove("map-load-error");
  if (!msg) {
    mapLoadingEl.hidden = true;
    mapLoadingEl.textContent = "로딩 중…";
  } else {
    mapLoadingEl.hidden = false;
    mapLoadingEl.textContent = msg;
  }
}

/** 모바일 등에서 #status가 숨겨져 있을 때 사용자에게 보이는 오류 */
function showInitError(msg) {
  const text = msg ? `시작 실패: ${msg}` : "시작 실패";
  console.error(text);
  if (mapLoadingEl) {
    mapLoadingEl.classList.add("map-load-error");
    mapLoadingEl.hidden = false;
    mapLoadingEl.textContent = text;
  } else if (statusEl) {
    statusEl.textContent = text;
  } else {
    window.alert(text);
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
  rebuildCellList();
  await waitForNonemptyCanvas();
  syncCanvasPixelSizeFromContainer();
  if (isMobileLayout()) state.renderer.vp.fit(MOBILE_INITIAL_BOUNDS);
  else state.renderer.vp.fit(state.globalBounds);
  clampVpScaleForEncOverview(idx);
  state.fitted = true;
  resize();

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

/**
 * 원근간략화(scaleDisplay)일 때 전역 맞춤으로 너무 축소되면 표시 축척 분모(denom)가
 * 모든 셀의 CSCL×scaleOutFactor를 넘겨 피처가 전부 생략될 수 있음.
 * 인덱스에서 가장 개략인 도(max CSCL) 기준으로 최소 scale을 올려 개략도가 보이게 함.
 */
function clampVpScaleForEncOverview(grid) {
  if (!state.renderer?.scaleDisplay || !grid?.length) return;
  let maxCscl = 0;
  for (const g of grid) {
    if (g.cscl && Number.isFinite(g.cscl) && g.cscl > maxCscl) maxCscl = g.cscl;
  }
  if (maxCscl <= 0) return;
  const vp = state.renderer.vp;
  const phi = (vp.centerLat() * Math.PI) / 180;
  const dpi = 96 / 0.0254;
  const f = state.renderer.scaleOutFactor;
  const minScale = (R_EARTH * Math.cos(phi) * dpi) / (maxCscl * f);
  if (vp.scale < minScale) vp.scale = minScale;
}

function syncCanvasPixelSizeFromContainer() {
  const wrap = canvas.parentElement;
  if (!wrap) return;
  const w = Math.max(0, Math.round(wrap.clientWidth));
  const h = Math.max(0, Math.round(wrap.clientHeight));
  canvas.width = w;
  canvas.height = h;
}

/** 모바일·내부망 등에서 첫 레이아웃 전 캔버스가 0×0일 때 fit/load가 깨지지 않도록 대기 */
async function waitForNonemptyCanvas(maxAttempts = 72) {
  for (let i = 0; i < maxAttempts; i++) {
    syncCanvasPixelSizeFromContainer();
    if (canvas.width >= 2 && canvas.height >= 2) return true;
    await new Promise((r) => requestAnimationFrame(r));
  }
  return canvas.width >= 2 && canvas.height >= 2;
}

let _fillViewportEncTimer = null;
/** 첫 표시 후 캔버스 크기가 생겼는데 아직 ENC가 0개면 화면 겹침 셀만 보충 로드 */
function scheduleMaybeFillViewportEnc() {
  clearTimeout(_fillViewportEncTimer);
  _fillViewportEncTimer = setTimeout(() => void maybeFillViewportEncIfEmpty(), 100);
}

async function maybeFillViewportEncIfEmpty() {
  _fillViewportEncTimer = null;
  if (!state.renderer?.grid?.length || !state.fitted) return;
  if (canvas.width < 2 || canvas.height < 2) return;
  const vis = [...state.renderer.cells.values()].filter((c) => c.visible).length;
  if (vis > 0) return;
  const names = namesIntersectingViewport();
  if (!names.length) return;
  await loadMany(names, { mobileLabel: "화면 영역 ENC" });
}

function resize() {
  syncCanvasPixelSizeFromContainer();
  // 첫 뷰 맞춤은 init() / openFiles()에서만 수행 (모바일 전역 fit 덮어쓰기 방지)
  draw();
  scheduleMaybeFillViewportEnc();
}
window.addEventListener("resize", resize);
window.addEventListener("orientationchange", () => {
  requestAnimationFrame(() => resize());
});

const _stageEl = canvas.parentElement;
if (_stageEl && typeof ResizeObserver !== "undefined") {
  let _roTick = null;
  const ro = new ResizeObserver(() => {
    if (_roTick != null) cancelAnimationFrame(_roTick);
    _roTick = requestAnimationFrame(() => {
      _roTick = null;
      resize();
    });
  });
  ro.observe(_stageEl);
}

let _rafPending = false;
function draw() {
  if (!state.renderer || _rafPending) return;
  _rafPending = true;
  requestAnimationFrame(() => {
    _rafPending = false;
    state.renderer.render();
    updateScaleBar();
    applyCellListFilter();
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

// ---- cell list UI (경로 `/` 기준 트리: 폴더 선택·드롭 시 상위 폴더 아래에 셀 배치) ----
const rows = new Map(); // name -> {checkbox, el}

function pathTreeRoot() {
  return { subs: new Map(), leaves: [] };
}

function addGridEntryToPathTree(root, g) {
  const parts = g.name.replace(/\\/g, "/").split("/").filter((s) => s.length > 0);
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i === parts.length - 1) {
      cur.leaves.push({ segment: p, g });
    } else {
      let next = cur.subs.get(p);
      if (!next) {
        next = pathTreeRoot();
        cur.subs.set(p, next);
      }
      cur = next;
    }
  }
}

function countCellsUnderPathNode(node) {
  let n = node.leaves.length;
  for (const ch of node.subs.values()) n += countCellsUnderPathNode(ch);
  return n;
}

function leafFileName(cellKey) {
  const s = cellKey.replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

function makeCellListRow(g) {
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
  const leaf = leafFileName(g.name);
  txt.textContent = leaf.replace(/\.000$/i, "");
  txt.title = `${g.name} — 1:${g.cscl || "?"}  [${g.minX.toFixed(2)},${g.minY.toFixed(2)}]→[${g.maxX.toFixed(2)},${g.maxY.toFixed(2)}]`;
  row.append(cb, dot, txt);
  row.addEventListener("click", () => {
    focusViewportToCellName(g.name);
    setObjScopeTo(g.name);
  });
  rows.set(g.name, { checkbox: cb, el: row });
  return row;
}

function renderPathTreeNode(node, container, depth) {
  const subKeys = [...node.subs.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  for (const key of subKeys) {
    const ch = node.subs.get(key);
    const folder = document.createElement("div");
    folder.className = "celltree-folder";
    folder.dataset.depth = String(depth);
    const head = document.createElement("div");
    head.className = "celltree-head expanded";
    head.setAttribute("role", "button");
    head.setAttribute("tabindex", "0");
    head.setAttribute("aria-expanded", "true");
    const twist = document.createElement("span");
    twist.className = "twist";
    twist.setAttribute("aria-hidden", "true");
    twist.textContent = "▼";
    const dn = document.createElement("span");
    dn.className = "dirname";
    dn.textContent = key;
    const badge = document.createElement("span");
    badge.className = "celltree-count";
    const cnt = countCellsUnderPathNode(ch);
    if (cnt > 0) badge.textContent = ` (${cnt})`;
    head.append(twist, dn, badge);
    const kids = document.createElement("div");
    kids.className = "celltree-children";
    const toggle = () => {
      const exp = head.classList.toggle("expanded");
      kids.style.display = exp ? "" : "none";
      twist.textContent = exp ? "▼" : "▶";
      head.setAttribute("aria-expanded", exp ? "true" : "false");
    };
    head.addEventListener("click", (e) => {
      e.preventDefault();
      toggle();
    });
    head.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
    renderPathTreeNode(ch, kids, depth + 1);
    folder.append(head, kids);
    container.appendChild(folder);
  }
  const leaves = [...node.leaves].sort((a, b) =>
    a.g.name.localeCompare(b.g.name, undefined, { sensitivity: "base" })
  );
  for (const { g } of leaves) container.appendChild(makeCellListRow(g));
}

/** 그리드(`state.renderer.grid`) 기준으로 좌측 셀 목록 DOM을 다시 구성합니다. */
function rebuildCellList() {
  if (!listEl || !state.renderer?.grid) return;
  rows.clear();
  listEl.replaceChildren();
  const root = pathTreeRoot();
  for (const g of state.renderer.grid) addGridEntryToPathTree(root, g);
  const frag = document.createDocumentFragment();
  renderPathTreeNode(root, frag, 0);
  listEl.appendChild(frag);
  for (const name of rows.keys()) syncRow(name);
  applyCellListFilter();
}

function ensureCellRowAncestorsExpanded(rowEl) {
  let el = rowEl.parentElement;
  while (el && el !== listEl) {
    if (el.classList.contains("celltree-children")) {
      el.style.display = "";
      const head = el.previousElementSibling;
      if (head?.classList.contains("celltree-head")) {
        head.classList.add("expanded");
        head.setAttribute("aria-expanded", "true");
        const twist = head.querySelector(".twist");
        if (twist) twist.textContent = "▼";
      }
    }
    el = el.parentElement;
  }
}

function applyCellListFilter() {
  const inp = document.getElementById("filter");
  const q = (inp?.value || "").trim().toUpperCase();
  const inView = new Set(state.renderer ? namesIntersectingViewport() : []);
  for (const [name, r] of rows) {
    const textOk = name.toUpperCase().includes(q);
    const viewOk = inView.has(name);
    r.el.style.display = textOk && viewOk ? "" : "none";
  }
  const folders = [...listEl.querySelectorAll(".celltree-folder")];
  folders.sort((a, b) => (+b.dataset.depth || 0) - (+a.dataset.depth || 0));
  for (const f of folders) {
    const kids = f.querySelector(":scope > .celltree-children");
    if (!kids) continue;
    const rowHit = [...kids.querySelectorAll(".cellrow")].some((row) => row.style.display !== "none");
    const subHit = [...kids.querySelectorAll(":scope > .celltree-folder")].some((sub) => sub.style.display !== "none");
    f.style.display = rowHit || subHit ? "" : "none";
  }
}
function syncRow(name) {
  const r = rows.get(name);
  const cell = state.renderer.cells.get(name);
  if (r && cell) { r.checkbox.checked = cell.visible; r.el.classList.toggle("on", cell.visible); }
}

/** 지도·목록에서 마지막으로 포커스한 셀(.000) — 툴바·셀 목록 강조 */
const focusedCellEl = document.getElementById("focused-cell");
function syncCellListFocus(scrollList = true) {
  const name = state.renderer?.gridFocusName || "";
  for (const [n, r] of rows) r.el.classList.toggle("focus", n === name);
  if (focusedCellEl) {
    focusedCellEl.textContent = name ? `보는 셀: ${name}` : "";
    focusedCellEl.title = name ? `현재 ENC: ${name}` : "지도에서 마지막으로 포커스한 ENC 셀(.000)";
  }
  if (scrollList) {
    const r = name ? rows.get(name) : null;
    if (r?.el) {
      ensureCellRowAncestorsExpanded(r.el);
      r.el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }
}
function bandColor(name) {
  const base = leafFileName(name);
  const m = base.match(/^[A-Z]{2}(\d)/i);
  const b = m ? +m[1] : 0;
  return ({ 1: "#e74c3c", 2: "#e67e22", 3: "#f1c40f", 4: "#2ecc71", 5: "#3498db", 6: "#9b59b6" })[b] || "#888";
}

// filter box
document.getElementById("filter").addEventListener("input", () => applyCellListFilter());

/** 모바일: 팬·줌이 멈춘 뒤 화면과 겹치는 셀만 로드. 뷰 밖 셀은 표시 끔(메모리는 유지). */
let _mobileVpSyncTimer = null;
/** 디바운스 타이머가 만료된 뒤 한 번 더 돌릴지(로딩 중 제스처가 있었을 때). */
let _mobileVpSyncNeedsFlush = false;
/** 동시에 여러 `loadMany`가 겹치지 않도록 직렬화. */
let _mobileVpSyncFlushChain = Promise.resolve();

function scheduleMobileViewportSync() {
  if (!isMobileLayout() || !state.renderer) return;
  _mobileVpSyncNeedsFlush = true;
  clearTimeout(_mobileVpSyncTimer);
  _mobileVpSyncTimer = setTimeout(() => {
    _mobileVpSyncTimer = null;
    _mobileVpSyncFlushChain = _mobileVpSyncFlushChain
      .catch(() => {})
      .then(() => flushMobileViewportSync());
  }, 220);
}

async function flushMobileViewportSync() {
  while (_mobileVpSyncNeedsFlush) {
    _mobileVpSyncNeedsFlush = false;
    const keep = new Set(namesIntersectingViewport());
    for (const cell of state.renderer.cells.values()) {
      if (keep.has(cell.name)) continue;
      cell.visible = false;
      syncRow(cell.name);
    }
    await loadMany([...keep], { mobileLabel: "화면 영역 ENC" });
  }
}

/** 셀 커버리지가 현재 캔버스 뷰포트와 겹치는 셀 이름 목록 */
function namesIntersectingViewport() {
  const vp = state.renderer.vp;
  const w = canvas.width, h = canvas.height;
  if (w < 1 || h < 1) return [];
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
  state.renderer.vp.fit(state.globalBounds);
  clampVpScaleForEncOverview(state.renderer.grid);
  draw();
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

// ---- file open / drag&drop (adds a cell; 다중 선택·드롭 지원) ----
function unionBounds(boundsList) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const b of boundsList) {
    if (!b) continue;
    minX = Math.min(minX, b.minX);
    maxX = Math.max(maxX, b.maxX);
    minY = Math.min(minY, b.minY);
    maxY = Math.max(maxY, b.maxY);
  }
  if (minX === Infinity) return null;
  return { minX, maxX, minY, maxY };
}

/** 폴더 선택 시 하위 경로로 셀 키를 구분(동일 파일명 충돌 방지). 일반 파일 선택은 leaf 이름만 사용. */
function localEncFileKey(file) {
  const rel = file.webkitRelativePath;
  if (rel && rel.length > 0) return rel.replace(/\\/g, "/");
  return file.name;
}

function collectDot000Files(fileList) {
  const list = [...fileList].filter((f) => f.name.toLowerCase().endsWith(".000"));
  list.sort((a, b) => localEncFileKey(a).localeCompare(localEncFileKey(b), undefined, { sensitivity: "base" }));
  return list;
}

async function ingestLocalEncFromFile(file) {
  const cellKey = localEncFileKey(file);
  const buf = await file.arrayBuffer();
  const chart = await loader.parse(buf); // parsed in a worker
  let cell = state.renderer.cells.get(cellKey);
  if (!cell) {
    cell = { name: cellKey, bounds: chart.bounds, visible: true, loaded: true, features: chart.features, chartBounds: chart.bounds };
    state.renderer.cells.set(cellKey, cell);
    state.renderer.grid.push({ name: cellKey, ...chart.bounds, cscl: chart.comf ? null : null });
  } else {
    cell.features = chart.features; cell.loaded = true; cell.visible = true; cell.chartBounds = chart.bounds;
  }
  return { bounds: chart.bounds, featuresLen: chart.features.length };
}

// ENC 열기: 파일·폴더 단일 드롭다운 버튼. 실제 input[type=file]은 시각적으로 숨기고
// 메뉴 항목 클릭 시 해당 입력의 click()을 위임 호출한다.
(function wireOpenEncMenu() {
  const btn = document.getElementById("openEncBtn");
  const menu = document.getElementById("openEncMenu");
  const fileInput = document.getElementById("file");
  const folderInput = document.getElementById("folder");
  if (!btn || !menu || !fileInput || !folderInput) return;

  // 폴더 픽커 미지원 환경(iOS Safari 등): 해당 메뉴 항목 비활성화
  const folderSupported = "webkitdirectory" in document.createElement("input");
  const folderItem = menu.querySelector('button[data-action="folder"]');
  if (folderItem && !folderSupported) {
    folderItem.disabled = true;
    folderItem.title = "이 브라우저는 폴더 선택을 지원하지 않습니다.";
  }

  function openMenu() {
    menu.dataset.open = "1";
    btn.setAttribute("aria-expanded", "true");
    setTimeout(() => {
      window.addEventListener("mousedown", onOutside, { capture: true });
      window.addEventListener("keydown", onEsc, true);
    }, 0);
  }
  function closeMenu() {
    delete menu.dataset.open;
    btn.setAttribute("aria-expanded", "false");
    window.removeEventListener("mousedown", onOutside, { capture: true });
    window.removeEventListener("keydown", onEsc, true);
  }
  function onOutside(e) {
    if (menu.contains(e.target) || btn.contains(e.target)) return;
    closeMenu();
  }
  function onEsc(e) {
    if (e.key === "Escape") { e.preventDefault(); closeMenu(); btn.focus(); }
  }
  btn.addEventListener("click", () => {
    if (menu.dataset.open) closeMenu(); else openMenu();
  });
  menu.addEventListener("click", (e) => {
    const item = e.target.closest("button[data-action]");
    if (!item || item.disabled) return;
    closeMenu();
    if (item.dataset.action === "files") fileInput.click();
    else if (item.dataset.action === "folder") folderInput.click();
  });
})();

document.getElementById("file").addEventListener("change", (e) => {
  const el = e.target;
  const files = el.files;
  if (!files?.length) return;
  void openFiles(files).finally(() => { el.value = ""; });
});
document.getElementById("folder").addEventListener("change", (e) => {
  const el = e.target;
  const files = el.files;
  if (!files?.length) return;
  const enc = collectDot000Files(files);
  if (!enc.length) {
    setStatus("선택한 폴더에 .000 파일이 없습니다.");
    el.value = "";
    return;
  }
  void openFiles(enc).finally(() => { el.value = ""; });
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer.files?.length) void openFiles(e.dataTransfer.files);
});

async function openFiles(files) {
  const list = [...files];
  if (!list.length) return;
  const CONC = Math.min(4, navigator.hardwareConcurrency || 4);
  const allBounds = [];
  let lastOkName = "";
  let featureSum = 0;
  const errors = [];

  for (let i = 0; i < list.length; i += CONC) {
    const chunk = list.slice(i, i + CONC);
    const from = i + 1;
    const to = Math.min(i + chunk.length, list.length);
    setStatus(`${from}–${to}/${list.length} 파일 파싱 중…`);
    const settled = await Promise.allSettled(chunk.map((file) => ingestLocalEncFromFile(file)));
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      const file = chunk[j];
      const id = localEncFileKey(file);
      if (s.status === "fulfilled") {
        allBounds.push(s.value.bounds);
        lastOkName = id;
        featureSum += s.value.featuresLen;
      } else {
        errors.push({ name: id, err: s.reason });
        console.error(id, s.reason);
      }
    }
    draw();
  }

  const u = unionBounds(allBounds);
  if (u) {
    state.renderer.vp.fit(u);
    state.fitted = true;
  }
  if (lastOkName) state.renderer.gridFocusName = lastOkName;
  draw();
  rebuildCellList();
  syncCellListFocus();

  if (errors.length) {
    const msg0 = errors[0].err && errors[0].err.message ? errors[0].err.message : String(errors[0].err);
    if (errors.length === list.length) {
      setStatus(`열기 실패 (${list.length}개): ${errors[0].name} — ${msg0}`);
    } else {
      setStatus(`${allBounds.length}개 성공, ${errors.length}개 실패 (예: ${errors[0].name} — ${msg0})`);
    }
  } else if (list.length === 1) {
    setStatus(`${lastOkName}: 피처 ${featureSum}개`);
  } else {
    setStatus(`${list.length}개 파일 — 총 피처 ${featureSum}개`);
  }
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
  if (moved) applyCellListFilter();
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

// ---- 뷰포트 즐겨찾기 (1~9) ----
// Ctrl+숫자로 현재 위치·축척 저장, 숫자만 눌러 복원. localStorage에 영구 보관.
const BOOKMARK_STORAGE = "encViewerBookmarks";
function loadBookmarks() {
  try { return JSON.parse(localStorage.getItem(BOOKMARK_STORAGE)) || {}; } catch { return {}; }
}
function saveBookmarks(bm) {
  try { localStorage.setItem(BOOKMARK_STORAGE, JSON.stringify(bm)); } catch { /* private mode */ }
}

window.addEventListener("keydown", (e) => {
  if (!state.renderer || keyboardTargetIgnoresMapKeys(e.target)) return;
  const vp = state.renderer.vp;

  // 즐겨찾기: Ctrl+1~9 저장 / 1~9 복원
  const digit = e.code.match(/^(?:Digit|Numpad)(\d)$/)?.[1];
  if (digit && digit >= "1" && digit <= "9" && !e.altKey) {
    if (e.ctrlKey || e.metaKey) {
      // 저장
      const bm = loadBookmarks();
      bm[digit] = { cx: vp.cx, cy: vp.cy, scale: vp.scale };
      saveBookmarks(bm);
      setStatus(`즐겨찾기 ${digit}번에 현재 뷰 저장`);
      e.preventDefault();
      return;
    }
    if (!e.shiftKey) {
      // 복원
      const bm = loadBookmarks();
      const slot = bm[digit];
      if (slot) {
        vp.cx = slot.cx; vp.cy = slot.cy; vp.scale = slot.scale;
        setStatus(`즐겨찾기 ${digit}번 복원`);
        draw();
        if (isMobileLayout()) scheduleMobileViewportSync();
      } else {
        setStatus(`즐겨찾기 ${digit}번이 비어 있습니다 (Ctrl+${digit}로 저장)`);
      }
      e.preventDefault();
      return;
    }
  }

  if (e.ctrlKey || e.metaKey || e.altKey) return;
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

init()
  .then(async () => {
    const cell = new URLSearchParams(location.search).get("cell");
    if (cell) {
      await loadFromUrl(cell);
      return;
    }
    await loadMany(namesIntersectingViewport(), { mobileLabel: "화면 영역 ENC" });
    scheduleMaybeFillViewportEnc();
  })
  .catch((err) => {
    const msg = err && err.message ? err.message : String(err);
    showInitError(msg);
  });
