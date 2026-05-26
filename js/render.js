// Canvas renderer. Projects lon/lat to screen (Web Mercator) and draws the
// resolved S-52 draw ops in layered passes: area fills, then lines, then point
// symbols / text. Symbols are blitted from the OpenCPN raster atlas.
//
// Performance: the Mercator projection of each coordinate is constant, so it is
// computed once per feature (mercator units cached on the feature) and only a
// cheap linear scale/translate runs per frame. Symbology resolution is also
// cached (re-run only when the colour table changes), and features whose
// bounding box is off-screen are culled before drawing.

const DISP_ORDER = [
  "No data", "Group 1", "Area 1", "Area 2",
  "Line Symbol", "Area Symbol", "Point Symbol", "Routing", "Hazards", "Mariners",
];
function prioIndex(p) {
  const i = DISP_ORDER.indexOf(p);
  return i < 0 ? 5 : i;
}

const DASH = [6, 4], DOTT = [1, 3], EMPTY_DASH = [];
/** Min squared screen-space edge length (px²) for path decimation; see _path(). */
const MIN_SEG2 = 1;

/**
 * S-52 아틀라스 심볼 접두: TSS·항로·추천항적·심수로·조류/만조 등 **방향 화살표**류.
 * 겹침제거(declutter) 시 픽셀 거리 < FLOW_ARROW_MIN_DIST_PX 이내의 화살표는 하나만 남긴다.
 *
 * - 동일 앵커에 CS 규칙이 두 번 SY를 내는 경우(TSSLPT+DWRTPT)와 인접 ENC 셀이 같은 항로를 양쪽
 *   에서 가져오는 경우는 거리 0~5 px이라 어떤 임계값으로도 제거된다.
 * - 같은 항로의 연속 위치 마커들(여수해만 DW 1호/3호/6호처럼 ~50~80 px 간격으로 줄지어 박힌
 *   화살표)은 OpenCPN 표기와 맞추기 위해 묶어 표현. 64 px 임계값이면 항로당 6~8개 정도로
 *   띄엄띄엄 남는다.
 * - TSS 평행 차선은 보통 80~150 px 이상 떨어져 있으므로 양방향이 모두 표시된다.
 */
const FLOW_ARROW_SYMBOL_RE = /^(TSSLPT|TWRTPT|RECTRC|DWRTPT|RCTLPT|TSSRON|DWRUTE|CURENT|FLDSTR|EBBSTR|TIDSTR|CURDEF)/i;
const FLOW_ARROW_MIN_DIST_PX = 64;

/** S-57 메타 경계(M_COVR·M_CSCL) — UI 격자와 함께 켜고 끔. 표시범주 Other라 Standard에서도 격자 ON이면 허용 */
const ENC_BOUNDARY_WITH_GRID = new Set(["M_COVR", "M_CSCL"]);

// Web Mercator. Both axes must share the same units (radians) or the aspect
// ratio is wrong, so X is longitude in radians — not degrees.
function mercX(lonDeg) {
  return (lonDeg * Math.PI) / 180;
}
function mercY(latDeg) {
  const lat = (latDeg * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + lat / 2));
}

class Viewport {
  constructor(canvas) {
    this.canvas = canvas;
    this.scale = 1;
    this.cx = 0; // center in mercX units
    this.cy = 0; // center in mercY units
  }
  fit(bounds) {
    const w = this.canvas.width, h = this.canvas.height;
    if (w < 1 || h < 1) return;
    const x0 = mercX(bounds.minX), x1 = mercX(bounds.maxX);
    const y0 = mercY(bounds.minY), y1 = mercY(bounds.maxY);
    const dx = x1 - x0 || 1e-4, dy = y1 - y0 || 1e-4;
    this.scale = Math.min(w / dx, h / dy) * 0.92;
    this.cx = (x0 + x1) / 2;
    this.cy = (y0 + y1) / 2;
  }
  // mercator units -> screen pixels (the per-frame hot path: no transcendentals)
  sx(mx) { return (mx - this.cx) * this.scale + this.canvas.width / 2; }
  sy(my) { return this.canvas.height / 2 - (my - this.cy) * this.scale; }
  project(lon, lat) { return [this.sx(mercX(lon)), this.sy(mercY(lat))]; }
  centerLat() {
    return (2 * Math.atan(Math.exp(this.cy)) - Math.PI / 2) * 180 / Math.PI;
  }
  // Representative display-scale denominator (1:N) for SCAMIN comparison.
  scaleDenominator() {
    const R = 6378137; // earth radius (m)
    const phi = (this.centerLat() * Math.PI) / 180;
    const metresPerPixel = (R * Math.cos(phi)) / this.scale;
    return metresPerPixel / (0.0254 / 96); // assume ~96 dpi
  }
  /** Mercator 캐시 좌표(mx,my) — `sx`/`sy`의 역변환(픽셀은 캔버스 좌상단 기준). */
  mercFromScreen(px, py) {
    const w = this.canvas.width, h = this.canvas.height;
    const mx = this.cx + (px - w / 2) / this.scale;
    const my = this.cy + (h / 2 - py) / this.scale;
    return [mx, my];
  }
  /** (px,py) 화면점이 가리키는 지점을 고정한 채 스케일만 newScale로 바꿈(핀치/커서 줌). */
  zoomAtScreen(px, py, newScale) {
    const w = this.canvas.width, h = this.canvas.height;
    const [wx, wy] = this.mercFromScreen(px, py);
    this.scale = newScale;
    this.cx = wx - (px - w / 2) / this.scale;
    this.cy = wy - (h / 2 - py) / this.scale;
  }
}

class Renderer {
  constructor(canvas, s52, atlas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.s52 = s52;
    this.atlas = atlas;
    this.vp = new Viewport(canvas);
    this.showText = true;
    this.showSoundings = true;
    this.respectScamin = true;
    this.declutter = true;
    this.scaleDisplay = true;
    this.scaleOutFactor = 16;
    this.minDisplayCat = "Standard";
    this.depthUnit = "m"; // m | ft | fathom — sounding display unit
    this.hiddenClasses = new Set(); // object-class acronyms hidden by the user
    this._labelBoxes = [];
    this.cells = new Map();
    this.grid = [];
    this.showGrid = false;
    /** 화면에 위도·경도 등간격 눈금선(경위도선) */
    this.showGraticule = false;
    /** 사이드바/지도에서 마지막으로 포커스한 셀 — 격자 표시 시 경계를 강조 */
    this.gridFocusName = null;
    this.lastStats = null;
  }

  /** 격자를 켤 때 이전 S-52 해석으로 빈 ops가 남은 M_COVR/M_CSCL만 재해석하도록 캐시 무효화 */
  invalidateEncBoundaryResIfStale() {
    for (const cell of this.cells.values()) {
      if (!cell.features) continue;
      for (const feat of cell.features) {
        if (!ENC_BOUNDARY_WITH_GRID.has(feat.acronym)) continue;
        const ops = feat._res && feat._res.ops;
        if (!ops || !ops.length) {
          feat._resTable = undefined;
          feat._res = undefined;
        }
      }
    }
  }

  _place(x, y, w, h) {
    if (!this.declutter) return true;
    for (const b of this._labelBoxes) {
      if (x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y) return false;
    }
    this._labelBoxes.push({ x, y, w, h });
    return true;
  }

  catAllowed(cat) {
    const rank = { Displaybase: 0, Standard: 1, Other: 2, Mariners: 3 };
    const lim = rank[this.minDisplayCat] ?? 2;
    return (rank[cat] ?? 1) <= lim;
  }

  // Precompute the Mercator-projected geometry, label anchor and bounding box
  // for a feature, once. Cached on the feature (projection never changes).
  _prep(feat) {
    if (feat._pg !== undefined) return; // already projected (by worker or earlier)
    projectFeature(feat); // fallback path (main-thread parse); workers pre-project
  }

  /** Mercator 뷰 창 → 도 단위 lon/lat 박스 (경계 포함). */
  _mercWinToLonLat(winMinX, winMaxX, winMinY, winMaxY) {
    const RAD = 180 / Math.PI;
    const lonMin = winMinX * RAD, lonMax = winMaxX * RAD;
    const latMin = (2 * Math.atan(Math.exp(winMinY)) - Math.PI / 2) * RAD;
    const latMax = (2 * Math.atan(Math.exp(winMaxY)) - Math.PI / 2) * RAD;
    return { lonMin, lonMax, latMin, latMax };
  }

  // Among loaded+visible cells overlapping the given lon/lat rectangle, the CSCL
  // whose log is nearest log(view denom). Used for scale-band filtering.
  // Must use the same "too detailed" rule as the render loop: a cell excluded by
  // scaleOutFactor must not set refCscl, or coarser cells lose the band and nothing draws.
  _refScaleInLonLatBox(denom, lonMin, lonMax, latMin, latMax) {
    const lnD = Math.log(denom);
    const outLim = this.scaleOutFactor;
    let best = null, bestDiff = Infinity;
    for (const cell of this.cells.values()) {
      if (!cell.visible || !cell.loaded) continue;
      const b = cell.bounds, cscl = b && b.cscl;
      if (!cscl) continue;
      if (denom > cscl * outLim) continue;
      if (b.maxX < lonMin || b.minX > lonMax || b.maxY < latMin || b.minY > latMax) continue;
      const diff = Math.abs(Math.log(cscl) - lnD);
      if (diff < bestDiff) { bestDiff = diff; best = cscl; }
    }
    return best;
  }

  // Whole-viewport ref scale (e.g. diagnostics). Prefer per-cell intersection
  // in render() so mixed-scale views do not leave rectangular holes.
  _refScale(denom, winMinX, winMaxX, winMinY, winMaxY) {
    const { lonMin, lonMax, latMin, latMax } = this._mercWinToLonLat(winMinX, winMaxX, winMinY, winMaxY);
    return this._refScaleInLonLatBox(denom, lonMin, lonMax, latMin, latMax);
  }

  // Tally object classes -> feature count. With no argument: all loaded+visible
  // cells combined. With a cell name: just that one cell (even if not visible),
  // so a single .000 file's object composition can be inspected.
  classStats(cellName) {
    const m = new Map();
    const cells = cellName
      ? [this.cells.get(cellName)].filter(Boolean)
      : [...this.cells.values()].filter((c) => c.visible);
    for (const cell of cells) {
      if (!cell.loaded || !cell.features) continue;
      for (const feat of cell.features) {
        if (!feat.geom && !feat.soundings) continue;
        m.set(feat.acronym, (m.get(feat.acronym) || 0) + 1);
      }
    }
    return m;
  }

  render() {
    const ctx = this.ctx, vp = this.vp;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.fillStyle = this.s52.color("DEPDW");
    ctx.fillRect(0, 0, w, h);

    this._labelBoxes = [];
    /** 통항·조류 방향 화살표 디클러터: 버킷(28 px 격자) → 해당 버킷에 배치된 점들의 [x,y,...] */
    this._flowArrowGrid = new Map();
    this._pointSymbolGrid = new Map();
    const denom = vp.scaleDenominator();
    const table = this.s52.currentTable;
    // visible Mercator window for culling (small margin)
    const halfW = (w / 2) / vp.scale * 1.05, halfH = (h / 2) / vp.scale * 1.05;
    const winMinX = vp.cx - halfW, winMaxX = vp.cx + halfW;
    const winMinY = vp.cy - halfH, winMaxY = vp.cy + halfH;

    let drawn = 0, culled = 0;
    const resolved = [];
    for (const cell of this.cells.values()) {
      if (!cell.visible || !cell.loaded || !cell.features) continue;
      const cscl = cell.bounds && cell.bounds.cscl;
      // Drop only charts far too detailed for the view. We do NOT restrict to a
      // single scale band: that blanks regions whose only coverage is a cell of
      // a different scale. Instead cells draw coarse->fine (insertion order), so
      // finer charts paint over coarser ones where they exist and coarser charts
      // back-fill everywhere else — full coverage, no holes.
      if (this.scaleDisplay && cscl && denom > cscl * this.scaleOutFactor) continue;
      for (const feat of cell.features) {
        if (!feat.geom && !feat.soundings) continue;
        if (this.hiddenClasses.has(feat.acronym)) continue; // per-object-class toggle
        if (!this.showGrid && ENC_BOUNDARY_WITH_GRID.has(feat.acronym)) continue;
        if (this.respectScamin) {
          const sc = parseFloat(feat.attrs.SCAMIN);
          if (!Number.isNaN(sc) && denom > sc) continue;
        }
        // cached symbology resolution (only colours depend on the table)
        if (feat._resTable !== table) {
          const r = this.s52.resolve(feat, "Simplified");
          feat._res = { ops: r.ops, displayCat: r.displayCat, prio: prioIndex(r.dispPrio) };
          feat._resTable = table;
        }
        const res = feat._res;
        const encBoundaryWithGrid =
          this.showGrid && ENC_BOUNDARY_WITH_GRID.has(feat.acronym);
        if (!feat.soundings && !this.catAllowed(res.displayCat) && !encBoundaryWithGrid) continue;
        this._prep(feat);
        const b = feat._bbox;
        if (b) {
          // off-screen
          if (b[2] < winMinX || b[0] > winMaxX || b[3] < winMinY || b[1] > winMaxY) {
            culled++; continue;
          }
          // sub-pixel area/line at this scale: invisible, skip (points/soundings exempt)
          const t = feat._pg && feat._pg.type;
          if ((t === "Area" || t === "Line") &&
              (b[2] - b[0]) * vp.scale < 1.5 && (b[3] - b[1]) * vp.scale < 1.5) {
            culled++; continue;
          }
        }
        drawn++;
        resolved.push({ feat, ops: res.ops, prio: res.prio });
      }
    }
    resolved.sort((a, b) => a.prio - b.prio);

    // pass 1: area fills
    for (const r of resolved) {
      if (ENC_BOUNDARY_WITH_GRID.has(r.feat.acronym)) continue; // M_COVR/M_CSCL: 그리드 오버레이가 대신 표현
      const pg = r.feat._pg;
      if (!pg || pg.type !== "Area") continue;
      for (const op of r.ops) {
        if (op.op === "AC") this._fillArea(pg.rings, op.color, 1);
        else if (op.op === "AP") this._fillArea(pg.rings, op.color, 0.12);
        else if (op.op === "AP_ACHARE") this._fillAchareHatch(pg.rings);
      }
    }
    // pass 2: lines — batched by style so thousands of features stroke in a
    // handful of draw calls instead of one beginPath/stroke each.
    const lineGroups = new Map(); // "color|width|style" -> {op, rings:[...]}
    for (const r of resolved) {
      if (ENC_BOUNDARY_WITH_GRID.has(r.feat.acronym)) continue; // M_COVR/M_CSCL: 검정 윤곽 제거
      const pg = r.feat._pg;
      if (!pg || pg.type === "Point") continue;
      for (const op of r.ops) {
        if (op.op !== "LS") continue;
        const key = op.color + "|" + (op.width || 1) + "|" + (op.style || "");
        let grp = lineGroups.get(key);
        if (!grp) { grp = { op, rings: [] }; lineGroups.set(key, grp); }
        for (const ring of pg.rings) grp.rings.push(ring);
      }
    }
    for (const grp of lineGroups.values()) this._strokePolys(grp.rings, grp.op);
    // pass 3: point symbols, soundings, text
    for (const r of resolved) {
      for (const op of r.ops) {
        if (op.op === "SY") this._symbolFeature(r.feat, op.sym, op.rot);
        else if (op.op === "SOUNDG" && this.showSoundings) this._soundings(r.feat);
        else if (op.op === "TX" && this.showText) this._text(r.feat, op);
      }
    }

    if (this.showGrid) this._drawGrid();
    if (this.showGraticule) this._drawGraticule(winMinX, winMaxX, winMinY, winMaxY);
    this.lastStats = { drawn, culled, denom: Math.round(denom) };
  }

  // --- fast pan: snapshot the last full frame, then blit it translated while
  // the user drags, deferring the (expensive) full re-render until they stop.
  beginPan() {
    if (!this._snap) this._snap = document.createElement("canvas");
    this._snap.width = this.canvas.width;
    this._snap.height = this.canvas.height;
    this._snap.getContext("2d").drawImage(this.canvas, 0, 0);
  }
  previewPan(ox, oy) {
    const ctx = this.ctx;
    ctx.fillStyle = this.s52.color("DEPDW");
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (this._snap) ctx.drawImage(this._snap, ox, oy);
  }

  _drawGrid() {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = "10px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const focus = this.gridFocusName;
    for (const g of this.grid) {
      if (focus && g.name === focus) continue;
      this._drawGridCell(g, false);
    }
    if (focus) {
      const g = this.grid.find((e) => e.name === focus);
      if (g) this._drawGridCell(g, true);
    }
    ctx.restore();
  }

  /** 화면 가시 Mercator 창 → 도 단위 경계(눈금 간격·라벨용) */
  _viewLonLatDeg(winMinX, winMaxX, winMinY, winMaxY) {
    const RAD = 180 / Math.PI;
    const lonMin = winMinX * RAD;
    const lonMax = winMaxX * RAD;
    const latMin = (2 * Math.atan(Math.exp(winMinY)) - Math.PI / 2) * RAD;
    const latMax = (2 * Math.atan(Math.exp(winMaxY)) - Math.PI / 2) * RAD;
    return { lonMin, lonMax, latMin, latMax };
  }

  /** 화면에 대략 `targetLines`개 안팎의 눈금이 나오도록 도 단위 간격 선택 */
  _graticuleStep(degSpan) {
    if (!(degSpan > 0)) return 1;
    const targetLines = 18;
    const raw = degSpan / targetLines;
    const pow10 = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / pow10;
    let nice = 10;
    if (norm < 1.2) nice = 1;
    else if (norm < 1.85) nice = 1.5;
    else if (norm < 3.2) nice = 2;
    else if (norm < 4.8) nice = 2.5;
    else if (norm < 7.2) nice = 5;
    return nice * pow10;
  }

  _graticuleLabelDecimals(stepDeg) {
    if (stepDeg >= 5) return 1;
    if (stepDeg >= 1) return 2;
    const dec = 2 - Math.floor(Math.log10(stepDeg));
    return Math.min(5, Math.max(2, dec));
  }

  _formatLonLabel(deg, stepDeg) {
    const hem = deg >= 0 ? "E" : "W";
    const a = Math.abs(deg);
    const dec = this._graticuleLabelDecimals(stepDeg);
    const s = String(Number(a.toFixed(dec)));
    return `${s}°${hem}`;
  }

  _formatLatLabel(deg, stepDeg) {
    const hem = deg >= 0 ? "N" : "S";
    const a = Math.abs(deg);
    const dec = this._graticuleLabelDecimals(stepDeg);
    const s = String(Number(a.toFixed(dec)));
    return `${s}°${hem}`;
  }

  /** 가느다란 선 + 약한 헤일로(밝은 배경에서도 식별) */
  _strokeGraticuleSegment(ctx, x0, y0, x1, y1) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.setLineDash(EMPTY_DASH);
    ctx.strokeStyle = "rgba(8,32,58,0.42)";
    ctx.lineWidth = 1.15;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.strokeStyle = "rgba(255,255,255,0.78)";
    ctx.lineWidth = 0.65;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
  }

  _drawGraticuleLabel(ctx, text, x, y, alignBaseline) {
    ctx.font = "600 10px ui-monospace, Consolas, monospace";
    const padX = 5, padY = 3;
    const m = ctx.measureText(text);
    const tw = Math.ceil(m.width) + padX * 2;
    const th = 14 + padY * 2;
    let bx = x, by = y;
    if (alignBaseline === "bottom") {
      bx = x - tw / 2;
      by = y - th;
    } else {
      /* 왼쪽 가장자리 고정(위도 라벨) */
      bx = x;
      by = y - th / 2;
    }
    bx = Math.max(2, Math.min(bx, this.canvas.width - tw - 2));
    by = Math.max(2, Math.min(by, this.canvas.height - th - 2));
    ctx.fillStyle = "rgba(6,22,42,0.88)";
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.setLineDash(EMPTY_DASH);
    const r = 3;
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(bx, by, tw, th, r);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(bx, by, tw, th);
    }
    ctx.fillStyle = "#f2f8ff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, bx + tw / 2, by + th / 2);
    ctx.textAlign = "left";
  }

  _drawGraticule(winMinX, winMaxX, winMinY, winMaxY) {
    const ctx = this.ctx, vp = this.vp;
    const { lonMin, lonMax, latMin, latMax } = this._viewLonLatDeg(winMinX, winMaxX, winMinY, winMaxY);
    const lonSpan = lonMax - lonMin;
    const latSpan = latMax - latMin;
    const lonStep = this._graticuleStep(lonSpan);
    const latStep = this._graticuleStep(latSpan);
    const h = this.canvas.height;
    const lonStart = Math.ceil(lonMin / lonStep) * lonStep;
    const lonVisible = [];
    for (let L = lonStart; L <= lonMax + 1e-9; L += lonStep) {
      const mx = mercX(L);
      if (mx >= winMinX - 1e-6 && mx <= winMaxX + 1e-6) lonVisible.push(L);
    }
    const latStart = Math.ceil(latMin / latStep) * latStep;
    const latVisible = [];
    for (let La = latStart; La <= latMax + 1e-9; La += latStep) {
      const my = mercY(La);
      if (my >= winMinY - 1e-6 && my <= winMaxY + 1e-6) latVisible.push(La);
    }
    const lonLabelEvery = Math.max(1, Math.ceil(lonVisible.length / 14));
    const latLabelEvery = Math.max(1, Math.ceil(latVisible.length / 12));

    ctx.save();

    for (let i = 0; i < lonVisible.length; i++) {
      const L = lonVisible[i];
      const x = vp.sx(mercX(L));
      const y0 = vp.sy(winMinY), y1 = vp.sy(winMaxY);
      this._strokeGraticuleSegment(ctx, x, y0, x, y1);
      if (i % lonLabelEvery === 0) {
        const lab = this._formatLonLabel(L, lonStep);
        this._drawGraticuleLabel(ctx, lab, x, h - 2, "bottom");
      }
    }

    for (let i = 0; i < latVisible.length; i++) {
      const La = latVisible[i];
      const y = vp.sy(mercY(La));
      const x0 = vp.sx(winMinX), x1 = vp.sx(winMaxX);
      this._strokeGraticuleSegment(ctx, x0, y, x1, y);
      if (i % latLabelEvery === 0) {
        const lab = this._formatLatLabel(La, latStep);
        this._drawGraticuleLabel(ctx, lab, 6, y, "left");
      }
    }

    ctx.setLineDash(EMPTY_DASH);
    ctx.restore();
  }

  _drawGridCell(g, focused) {
    const ctx = this.ctx, vp = this.vp;
    const cell = this.cells.get(g.name);
    const on = cell && cell.visible;
    const col = BAND_COLORS[bandOf(g.name)] || "rgba(120,120,120,0.9)";
    const x0 = vp.project(g.minX, g.maxY), x1 = vp.project(g.maxX, g.minY);
    const x = Math.min(x0[0], x1[0]), y = Math.min(x0[1], x1[1]);
    const ww = Math.abs(x1[0] - x0[0]), hh = Math.abs(x1[1] - x0[1]);
    if (ww < 3 && hh < 3) return;
    if (x + ww < 0 || y + hh < 0 || x > this.canvas.width || y > this.canvas.height) return;
    // 포커스 셀만 테두리 표시; 나머지 셀은 테두리 없이 배경 채움+라벨만
    if (focused) {
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.lineWidth = 4;
      ctx.setLineDash([]);
      ctx.strokeRect(x, y, ww, hh);
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, ww, hh);
    }
    if (on) { ctx.fillStyle = col.replace(/[\d.]+\)$/, "0.06)"); ctx.fillRect(x, y, ww, hh); }
    if (ww > 36 && hh > 14) {
      const label = g.name.replace(/\.000$/i, "");
      ctx.fillStyle = col;
      ctx.fillRect(x + 1, y + 1, label.length * 6 + 4, 12);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, x + 3, y + 2);
    }
  }

  _fillArea(rings, color, alpha) {
    if (!rings || !rings.length) return;
    const ctx = this.ctx;
    if (alpha !== 1) ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const ring of rings) { if (ring.length >= 6) this._path(ring); } // >=3 points (flat)
    ctx.fill("evenodd");
    if (alpha !== 1) ctx.globalAlpha = 1;
  }

  /** ACHARE 면 내부: S-52 PL의 × 패턴을 화면 픽셀 격자로 근사(클립 후 선분만). */
  _fillAchareHatch(rings) {
    if (!rings || !rings.length) return;
    const ctx = this.ctx;
    const vp = this.vp;
    let sx0 = Infinity;
    let sy0 = Infinity;
    let sx1 = -Infinity;
    let sy1 = -Infinity;
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i += 2) {
        const px = vp.sx(ring[i]);
        const py = vp.sy(ring[i + 1]);
        if (px < sx0) sx0 = px;
        if (py < sy0) sy0 = py;
        if (px > sx1) sx1 = px;
        if (py > sy1) sy1 = py;
      }
    }
    if (!(sx1 > sx0) || !(sy1 > sy0)) return;

    ctx.save();
    ctx.beginPath();
    for (const ring of rings) {
      if (ring.length >= 6) this._path(ring);
    }
    ctx.clip("evenodd");

    const step = 10;
    const arm = 4;
    const col = this.s52.color("CHBLK");
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.42;
    ctx.lineWidth = 0.9;
    ctx.lineCap = "butt";
    ctx.beginPath();
    const pad = step * 2;
    const gx0 = Math.floor((sx0 - pad) / step) * step;
    const gy0 = Math.floor((sy0 - pad) / step) * step;
    for (let gx = gx0; gx <= sx1 + pad; gx += step) {
      for (let gy = gy0; gy <= sy1 + pad; gy += step) {
        ctx.moveTo(gx - arm, gy - arm);
        ctx.lineTo(gx + arm, gy + arm);
        ctx.moveTo(gx - arm, gy + arm);
        ctx.lineTo(gx + arm, gy - arm);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  _strokePolys(rings, op) {
    const ctx = this.ctx;
    this._applyStroke(op);
    ctx.beginPath();
    for (const ring of rings) this._path(ring);
    ctx.stroke();
    ctx.setLineDash(EMPTY_DASH);
  }

  _applyStroke(op) {
    const ctx = this.ctx;
    ctx.strokeStyle = op.color;
    ctx.lineWidth = op.width || 1;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (op.style === "DASH") ctx.setLineDash(DASH);
    else if (op.style === "DOTT") ctx.setLineDash(DOTT);
    else ctx.setLineDash(EMPTY_DASH);
  }

  // Build a path, decimating vertices that land within ~1px of the previous
  // one at the current scale (invisible detail). The final vertex is always
  // emitted so rings stay closed.
  // arr: flat Float64Array [x0,y0,x1,y1,…] in Mercator units.
  _path(arr) {
    const ctx = this.ctx, vp = this.vp;
    const n = arr.length;
    let lx = vp.sx(arr[0]), ly = vp.sy(arr[1]);
    ctx.moveTo(lx, ly);
    for (let i = 2; i < n; i += 2) {
      const x = vp.sx(arr[i]), y = vp.sy(arr[i + 1]);
      const dx = x - lx, dy = y - ly;
      if (i === n - 2 || dx * dx + dy * dy >= MIN_SEG2) {
        ctx.lineTo(x, y);
        lx = x; ly = y;
      }
    }
  }

  _symbolFeature(feat, symName, rot) {
    const a = feat._pg && feat._pg.anchor;
    if (!a) return;
    // ── 다중 축척 셀 중첩 심볼 제거 ──
    // 동일 심볼이 화면상 PT_DEDUP_PX 이내에 이미 그려졌으면 건너뛴다.
    // 서로 다른 축척의 ENC 셀이 같은 항행보조시설(부이·등대·비컨 등)을 중복
    // 수록할 때, 좌표 정밀도 차이로 ~수 픽셀 어긋나 박히는 잔상까지 잡는다.
    {
      const PT_DEDUP_PX = 8;
      const sx = this.vp.sx(a[0]), sy = this.vp.sy(a[1]);
      const min2 = PT_DEDUP_PX * PT_DEDUP_PX;
      const bx = Math.floor(sx / PT_DEDUP_PX), by = Math.floor(sy / PT_DEDUP_PX);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const arr = this._pointSymbolGrid.get(`${symName}|${bx + dx},${by + dy}`);
          if (!arr) continue;
          for (let i = 0; i < arr.length; i += 2) {
            const ddx = sx - arr[i], ddy = sy - arr[i + 1];
            if (ddx * ddx + ddy * ddy < min2) return;
          }
        }
      }
      const key = `${symName}|${bx},${by}`;
      let arr = this._pointSymbolGrid.get(key);
      if (!arr) { arr = []; this._pointSymbolGrid.set(key, arr); }
      arr.push(sx, sy);
    }
    if (this.declutter && FLOW_ARROW_SYMBOL_RE.test(symName || "")) {
      const x = this.vp.sx(a[0]), y = this.vp.sy(a[1]);
      const g = FLOW_ARROW_MIN_DIST_PX;
      const min2 = g * g;
      const bx = Math.floor(x / g), by = Math.floor(y / g);
      // 3×3 이웃 버킷까지 검사해 격자 경계에서 흔들리는 (∼1 px) 중복도 묶는다.
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const arr = this._flowArrowGrid.get(`${bx + dx},${by + dy}`);
          if (!arr) continue;
          for (let i = 0; i < arr.length; i += 2) {
            const ddx = x - arr[i], ddy = y - arr[i + 1];
            if (ddx * ddx + ddy * ddy < min2) return;
          }
        }
      }
      const key = `${bx},${by}`;
      let arr = this._flowArrowGrid.get(key);
      if (!arr) { arr = []; this._flowArrowGrid.set(key, arr); }
      arr.push(x, y);
    }
    this._blit(symName, a[0], a[1], rot);
  }

  // rot: degrees clockwise from north (S-57 ORIENT). Screen is north-up so the
  // canvas rotation equals the bearing directly.
  _blit(symName, mx, my, rot) {
    const s = this.s52.symbols.get(symName);
    const x = this.vp.sx(mx), y = this.vp.sy(my);
    if (!s || !this.atlas) {
      const ctx = this.ctx;
      ctx.fillStyle = this.s52.color("CHBLK");
      ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
      return;
    }
    if (rot) {
      const ctx = this.ctx;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot * Math.PI / 180);
      ctx.drawImage(this.atlas, s.x, s.y, s.w, s.h, -s.px, -s.py, s.w, s.h);
      ctx.restore();
    } else {
      this.ctx.drawImage(this.atlas, s.x, s.y, s.w, s.h, x - s.px, y - s.py, s.w, s.h);
    }
  }

  _soundings(feat) {
    const ps = feat._ps;
    if (!ps) return;
    const ctx = this.ctx, vp = this.vp;
    ctx.fillStyle = this.s52.color("SNDG2");
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    for (let i = 0; i < ps.length; i += 3) { // flat [x,y,depth,…]
      const x = vp.sx(ps[i]), y = vp.sy(ps[i + 1]);
      if (x < -20 || y < -20 || x > this.canvas.width + 20 || y > this.canvas.height + 20) continue;
      const label = soundingLabel(ps[i + 2], this.depthUnit); // metres
      const w = label.length * 6;
      if (!this._place(x - w / 2, y - 5, w, 11)) continue;
      ctx.fillText(label, x, y + 3);
    }
  }

  _text(feat, op) {
    const a = feat._pg && feat._pg.anchor;
    if (!a) return;
    const x = this.vp.sx(a[0]), y = this.vp.sy(a[1]);
    const w = op.text.length * 6 + 4;
    if (!this._place(x + 4, y - 15, w, 13)) return;
    const ctx = this.ctx;
    ctx.fillStyle = op.color;
    ctx.font = "11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(op.text, x + 4, y - 4);
  }
}

// Format a sounding (stored in metres) for display in the chosen unit, using
// S-52-style precision (a decimal for shoal depths, whole numbers when deeper).
function soundingLabel(metres, unit) {
  let v = metres;
  if (unit === "ft") v = metres * 3.280839895;
  else if (unit === "fathom") v = metres * 0.5468066492;
  if (unit === "ft") return Math.round(v).toString();         // feet: whole
  if (unit === "fathom") return v < 11 ? v.toFixed(1) : Math.round(v).toString();
  return v < 31 ? v.toFixed(1) : Math.round(v).toString();    // metres
}

function bandOf(name) {
  const m = name.match(/^[A-Z]{2}(\d)/i);
  return m ? +m[1] : 0;
}
const BAND_COLORS = {
  1: "rgba(231,76,60,0.9)",
  2: "rgba(230,126,34,0.9)",
  3: "rgba(241,196,15,0.9)",
  4: "rgba(46,204,113,0.9)",
  5: "rgba(52,152,219,0.9)",
  6: "rgba(155,89,182,0.9)",
};

// Project a feature's lon/lat geometry into Mercator and store it compactly as
// flat Float64Arrays (x,y,…), then DROP the original lon/lat arrays to save a
// large amount of memory (array-of-[x,y] objects cost ~10× a typed array, and
// keeping both the source and projected copies doubled it). Run once per
// feature — in the worker at load time, or here as the main-thread fallback.
function projectFeature(feat) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  let pg = null, ps = null;
  const g = feat.geom;
  if (g && g.coords) {
    if (g.type === "Point") {
      const mx = mercX(g.coords[0]), my = mercY(g.coords[1]);
      minx = maxx = mx; miny = maxy = my;
      pg = { type: "Point", anchor: [mx, my] };
    } else {
      const rings = [];
      for (const ring of g.coords) {
        const arr = new Float64Array(ring.length * 2);
        for (let i = 0; i < ring.length; i++) {
          const mx = mercX(ring[i][0]), my = mercY(ring[i][1]);
          arr[2 * i] = mx; arr[2 * i + 1] = my;
          if (mx < minx) minx = mx; if (mx > maxx) maxx = mx;
          if (my < miny) miny = my; if (my > maxy) maxy = my;
        }
        rings.push(arr);
      }
      const r0 = rings[0]; let anchor = [0, 0];
      if (r0 && r0.length) {
        if (g.type === "Area") {
          let sx = 0, sy = 0; const n = r0.length / 2;
          for (let i = 0; i < r0.length; i += 2) { sx += r0[i]; sy += r0[i + 1]; }
          anchor = [sx / n, sy / n];
        } else {
          const m = (((r0.length / 2) >> 1)) * 2;
          anchor = [r0[m], r0[m + 1]];
        }
      }
      pg = { type: g.type, rings, anchor };
    }
  }
  if (feat.soundings && feat.soundings.length) {
    ps = new Float64Array(feat.soundings.length * 3);
    for (let i = 0; i < feat.soundings.length; i++) {
      const s = feat.soundings[i];
      const mx = mercX(s[0]), my = mercY(s[1]);
      ps[3 * i] = mx; ps[3 * i + 1] = my; ps[3 * i + 2] = s[2];
      if (mx < minx) minx = mx; if (mx > maxx) maxx = mx;
      if (my < miny) miny = my; if (my > maxy) maxy = my;
    }
  }
  feat._pg = pg;
  feat._ps = ps;
  feat._bbox = minx === Infinity ? null : [minx, miny, maxx, maxy];
  // keep a tiny truthy geom marker so the "has content" checks still pass
  if (feat.geom) feat.geom = { type: feat.geom.type };
  else if (ps) feat.geom = { type: "Sounding" };
  feat.soundings = null;
}

export { Renderer, Viewport, projectFeature, mercX, mercY };
