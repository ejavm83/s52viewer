import { DDF } from "./iso8211.js";
import { S57 } from "./s57.js";
import { S52 } from "./s52.js";
import { loadCatalog } from "./catalog.js";
import { Renderer } from "./render.js";

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
function setStatus(t) { statusEl.textContent = t; }

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
  setStatus(`준비 완료 — 셀 ${idx.length}개. 격자에서 셀을 클릭하거나 목록에서 선택해 표시하세요.`);
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
async function ensureLoaded(name) {
  const cell = state.renderer.cells.get(name);
  if (!cell || cell.loaded) return cell;
  const buf = await (await fetch("000/" + name)).arrayBuffer();
  const chart = S57.build(DDF.parse(buf), state.catalog);
  cell.features = chart.features;
  cell.chartBounds = chart.bounds;
  cell.loaded = true;
  return cell;
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

// bulk actions
document.getElementById("showVisible").addEventListener("click", async () => {
  // enable every cell whose coverage intersects the current viewport
  const vp = state.renderer.vp;
  const w = canvas.width, h = canvas.height;
  const targets = [];
  for (const g of state.renderer.grid) {
    const [x0, y0] = vp.project(g.minX, g.maxY);
    const [x1, y1] = vp.project(g.maxX, g.minY);
    if (Math.max(x0, x1) < 0 || Math.min(x0, x1) > w || Math.max(y0, y1) < 0 || Math.min(y0, y1) > h) continue;
    targets.push(g.name);
  }
  await loadMany(targets);
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

async function loadMany(names) {
  let i = 0;
  for (const name of names) {
    i++;
    setStatus(`로딩 ${i}/${names.length}: ${name}`);
    await ensureLoaded(name);
    const cell = state.renderer.cells.get(name);
    cell.visible = true; syncRow(name);
    if (i % 3 === 0) draw(); // periodic repaint
  }
  draw();
  setStatus(`표시 중 ${[...state.renderer.cells.values()].filter((c) => c.visible).length}개`);
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
  const chart = S57.build(DDF.parse(buf), state.catalog);
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
document.getElementById("grid").addEventListener("change", (e) => { state.renderer.showGrid = e.target.checked; draw(); });
document.getElementById("scaledisp").addEventListener("change", (e) => { state.renderer.scaleDisplay = e.target.checked; draw(); });

// ---- pan & zoom + click-to-toggle a cell on the grid ----
let dragging = false, moved = false, lastX = 0, lastY = 0;
canvas.addEventListener("mousedown", (e) => { dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener("mouseup", () => { dragging = false; });
window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
  const vp = state.renderer.vp;
  vp.cx -= dx / vp.scale; vp.cy += dy / vp.scale;
  lastX = e.clientX; lastY = e.clientY;
  draw();
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  state.renderer.vp.scale *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
  draw();
}, { passive: false });
// click a grid rectangle to toggle that cell
canvas.addEventListener("click", (e) => {
  if (moved) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const hit = pickCell(mx, my);
  if (hit) setCellVisible(hit, !state.renderer.cells.get(hit).visible, false);
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

init().then(() => {
  const cell = new URLSearchParams(location.search).get("cell");
  if (cell) loadFromUrl(cell);
});
