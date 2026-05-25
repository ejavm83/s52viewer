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
    this._labelBoxes = [];
    this.cells = new Map();
    this.grid = [];
    this.showGrid = false;
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
    if (feat._pg !== undefined) return;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    const touch = (mx, my) => {
      if (mx < minx) minx = mx; if (mx > maxx) maxx = mx;
      if (my < miny) miny = my; if (my > maxy) maxy = my;
    };
    let pg = null, ps = null;
    const g = feat.geom;
    if (g) {
      if (g.type === "Point") {
        const mx = mercX(g.coords[0]), my = mercY(g.coords[1]);
        touch(mx, my);
        pg = { type: "Point", anchor: [mx, my] };
      } else {
        const rings = [];
        for (const ring of g.coords) {
          const pr = new Array(ring.length);
          for (let i = 0; i < ring.length; i++) {
            const mx = mercX(ring[i][0]), my = mercY(ring[i][1]);
            pr[i] = [mx, my]; touch(mx, my);
          }
          rings.push(pr);
        }
        let anchor = [0, 0];
        const r0 = rings[0];
        if (r0 && r0.length) {
          anchor = g.type === "Area"
            ? mercCentroid(r0)
            : [r0[(r0.length / 2) | 0][0], r0[(r0.length / 2) | 0][1]];
        }
        pg = { type: g.type, rings, anchor };
      }
    }
    if (feat.soundings) {
      ps = new Array(feat.soundings.length);
      for (let i = 0; i < feat.soundings.length; i++) {
        const s = feat.soundings[i];
        const mx = mercX(s[0]), my = mercY(s[1]);
        ps[i] = [mx, my, s[2]]; touch(mx, my);
      }
    }
    feat._pg = pg;
    feat._ps = ps;
    feat._bbox = minx === Infinity ? null : [minx, miny, maxx, maxy];
  }

  // The loaded cell whose compilation scale (CSCL) is nearest the current view
  // denominator, among cells overlapping the visible window. Used to draw only
  // the best-matching scale band instead of stacking every overlapping chart.
  _refScale(denom, winMinX, winMaxX, winMinY, winMaxY) {
    const RAD = 180 / Math.PI;
    const lonMin = winMinX * RAD, lonMax = winMaxX * RAD;
    const latMin = (2 * Math.atan(Math.exp(winMinY)) - Math.PI / 2) * RAD;
    const latMax = (2 * Math.atan(Math.exp(winMaxY)) - Math.PI / 2) * RAD;
    const lnD = Math.log(denom);
    let best = null, bestDiff = Infinity;
    for (const cell of this.cells.values()) {
      if (!cell.visible || !cell.loaded) continue;
      const b = cell.bounds, cscl = b && b.cscl;
      if (!cscl) continue;
      if (b.maxX < lonMin || b.minX > lonMax || b.maxY < latMin || b.minY > latMax) continue;
      const diff = Math.abs(Math.log(cscl) - lnD);
      if (diff < bestDiff) { bestDiff = diff; best = cscl; }
    }
    return best;
  }

  render() {
    const ctx = this.ctx, vp = this.vp;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.fillStyle = this.s52.color("DEPDW");
    ctx.fillRect(0, 0, w, h);

    this._labelBoxes = [];
    const denom = vp.scaleDenominator();
    const table = this.s52.currentTable;
    // visible Mercator window for culling (small margin)
    const halfW = (w / 2) / vp.scale * 1.05, halfH = (h / 2) / vp.scale * 1.05;
    const winMinX = vp.cx - halfW, winMaxX = vp.cx + halfW;
    const winMinY = vp.cy - halfH, winMaxY = vp.cy + halfH;

    // OpenCPN-style chart selection: when cells of several scales overlap, pick
    // the band whose compilation scale best matches the view, and draw only it
    // (others would just stack and muddy the picture). refCscl = the loaded
    // cell scale nearest the view denominator over the visible window.
    const refCscl = this.scaleDisplay ? this._refScale(denom, winMinX, winMaxX, winMinY, winMaxY) : null;

    let drawn = 0, culled = 0;
    const resolved = [];
    for (const cell of this.cells.values()) {
      if (!cell.visible || !cell.loaded || !cell.features) continue;
      const cscl = cell.bounds && cell.bounds.cscl;
      if (this.scaleDisplay && cscl) {
        if (denom > cscl * this.scaleOutFactor) continue;        // far too detailed
        if (refCscl && (cscl < refCscl / 2.5 || cscl > refCscl * 2.5)) continue; // not the chosen band
      }
      for (const feat of cell.features) {
        if (!feat.geom && !feat.soundings) continue;
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
      const pg = r.feat._pg;
      if (!pg || pg.type !== "Area") continue;
      for (const op of r.ops) {
        if (op.op === "AC") this._fillArea(pg.rings, op.color, 1);
        else if (op.op === "AP") this._fillArea(pg.rings, op.color, 0.12);
      }
    }
    // pass 2: lines — batched by style so thousands of features stroke in a
    // handful of draw calls instead of one beginPath/stroke each.
    const lineGroups = new Map(); // "color|width|style" -> {op, rings:[...]}
    for (const r of resolved) {
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
    if (focused) {
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.lineWidth = 5;
      ctx.setLineDash([]);
      ctx.strokeRect(x, y, ww, hh);
    }
    ctx.lineWidth = focused ? 3 : on ? 2 : 1;
    ctx.strokeStyle = col;
    ctx.setLineDash(focused || on ? [] : [4, 3]);
    ctx.strokeRect(x, y, ww, hh);
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
    for (const ring of rings) { if (ring.length >= 3) this._path(ring); }
    ctx.fill("evenodd");
    if (alpha !== 1) ctx.globalAlpha = 1;
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
  _path(pts) {
    const ctx = this.ctx, vp = this.vp;
    const n = pts.length;
    let lx = vp.sx(pts[0][0]), ly = vp.sy(pts[0][1]);
    ctx.moveTo(lx, ly);
    for (let i = 1; i < n; i++) {
      const x = vp.sx(pts[i][0]), y = vp.sy(pts[i][1]);
      const dx = x - lx, dy = y - ly;
      if (i === n - 1 || dx * dx + dy * dy >= MIN_SEG2) {
        ctx.lineTo(x, y);
        lx = x; ly = y;
      }
    }
  }

  _symbolFeature(feat, symName, rot) {
    const a = feat._pg && feat._pg.anchor;
    if (a) this._blit(symName, a[0], a[1], rot);
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
    for (const s of ps) {
      const x = vp.sx(s[0]), y = vp.sy(s[1]);
      if (x < -20 || y < -20 || x > this.canvas.width + 20 || y > this.canvas.height + 20) continue;
      const label = soundingLabel(s[2], this.depthUnit); // s[2] is metres
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

function mercCentroid(ring) {
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  const n = ring.length || 1;
  return [x / n, y / n];
}

export { Renderer, Viewport };
