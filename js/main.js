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
  chart: null,
  renderer: null,
  atlas: {},
};

const canvas = document.getElementById("chart");
const statusEl = document.getElementById("status");
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
  setStatus(
    `준비 완료 — 색상표 ${state.s52.colorTables.size}종, 룩업 ${state.s52.lookups.size}객체, 심볼 ${state.s52.symbols.size}개. .000 파일을 열어주세요.`
  );
  resize();
}

function resize() {
  const wrap = canvas.parentElement;
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  if (state.chart) {
    state.renderer.vp.fit(state.chart.bounds);
    draw();
  }
}
window.addEventListener("resize", resize);

async function loadFromUrl(url) {
  setStatus(`${url} 불러오는 중…`);
  const buf = await (await fetch(url)).arrayBuffer();
  await openBuffer(buf, url.split("/").pop());
}

async function openFile(file) {
  const buf = await file.arrayBuffer();
  await openBuffer(buf, file.name);
}

async function openBuffer(buf, name) {
  setStatus(`${name} 파싱 중…`);
  const file = { name };
  try {
    const ddf = DDF.parse(buf);
    const chart = S57.build(ddf, state.catalog);
    state.chart = chart;
    const geomCount = chart.features.filter((f) => f.geom || f.soundings).length;
    state.renderer.vp.fit(chart.bounds);
    draw();
    const cls = new Set(chart.features.map((f) => f.acronym));
    setStatus(
      `${file.name}: 피처 ${chart.features.length}개 (지오메트리 ${geomCount}), 객체종류 ${cls.size}, ` +
      `범위 [${chart.bounds.minX.toFixed(3)}, ${chart.bounds.minY.toFixed(3)}] → ` +
      `[${chart.bounds.maxX.toFixed(3)}, ${chart.bounds.maxY.toFixed(3)}]`
    );
  } catch (e) {
    console.error(e);
    setStatus("파싱 오류: " + e.message);
  }
}

function draw() {
  if (state.chart) state.renderer.render(state.chart);
}

// ---- UI wiring ----
document.getElementById("file").addEventListener("change", (e) => {
  if (e.target.files[0]) openFile(e.target.files[0]);
});

// populate the cell list from the 000/ folder (served by serve.js)
const cellSel = document.getElementById("cells");
fetch("/api/cells")
  .then((r) => r.json())
  .then((files) => {
    for (const f of files) {
      const o = document.createElement("option");
      o.value = "000/" + f;
      o.textContent = f;
      cellSel.appendChild(o);
    }
  })
  .catch(() => {});
cellSel.addEventListener("change", (e) => {
  if (e.target.value) loadFromUrl(e.target.value);
});

// drag & drop
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) openFile(f);
});

document.getElementById("palette").addEventListener("change", async (e) => {
  const t = e.target.value;
  state.s52.setColorTable(t);
  const src = ATLAS_BY_TABLE[t];
  if (!state.atlas[t]) state.atlas[t] = await loadImage(src);
  state.renderer.atlas = state.atlas[t];
  draw();
});

document.getElementById("dispcat").addEventListener("change", (e) => {
  state.renderer.minDisplayCat = e.target.value;
  draw();
});
document.getElementById("text").addEventListener("change", (e) => {
  state.renderer.showText = e.target.checked; draw();
});
document.getElementById("sound").addEventListener("change", (e) => {
  state.renderer.showSoundings = e.target.checked; draw();
});
document.getElementById("scamin").addEventListener("change", (e) => {
  state.renderer.respectScamin = e.target.checked; draw();
});
document.getElementById("declutter").addEventListener("change", (e) => {
  state.renderer.declutter = e.target.checked; draw();
});

// ---- pan & zoom ----
let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener("mousedown", (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener("mouseup", () => { dragging = false; });
window.addEventListener("mousemove", (e) => {
  if (!dragging || !state.chart) return;
  const vp = state.renderer.vp;
  vp.cx -= (e.clientX - lastX) / vp.scale;
  vp.cy += (e.clientY - lastY) / vp.scale;
  lastX = e.clientX; lastY = e.clientY;
  draw();
});
canvas.addEventListener("wheel", (e) => {
  if (!state.chart) return;
  e.preventDefault();
  const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  state.renderer.vp.scale *= f;
  draw();
}, { passive: false });

window.s52app = { state, loadFromUrl, draw };

init().then(() => {
  const cell = new URLSearchParams(location.search).get("cell");
  if (cell) loadFromUrl(cell);
});
