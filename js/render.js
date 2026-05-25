// Canvas renderer. Projects lon/lat to screen (Web Mercator) and draws the
// resolved S-52 draw ops in layered passes: area fills, then lines, then point
// symbols / text. Symbols are blitted from the OpenCPN raster atlas.

const DISP_ORDER = [
  "No data", "Group 1", "Area 1", "Area 2",
  "Line Symbol", "Area Symbol", "Point Symbol", "Routing", "Hazards", "Mariners",
];
function prioIndex(p) {
  const i = DISP_ORDER.indexOf(p);
  return i < 0 ? 5 : i;
}

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
    this.cx = 0; // center lon
    this.cy = 0; // center mercY
  }
  fit(bounds) {
    const w = this.canvas.width, h = this.canvas.height;
    const x0 = mercX(bounds.minX), x1 = mercX(bounds.maxX);
    const y0 = mercY(bounds.minY), y1 = mercY(bounds.maxY);
    const dx = x1 - x0 || 1e-4, dy = y1 - y0 || 1e-4;
    const sx = w / dx, sy = h / dy;
    this.scale = Math.min(sx, sy) * 0.92;
    this.cx = (x0 + x1) / 2; // center in mercX units
    this.cy = (y0 + y1) / 2; // center in mercY units
  }
  project(lon, lat) {
    const w = this.canvas.width, h = this.canvas.height;
    const x = (mercX(lon) - this.cx) * this.scale + w / 2;
    const y = h / 2 - (mercY(lat) - this.cy) * this.scale;
    return [x, y];
  }
  centerLat() {
    return (2 * Math.atan(Math.exp(this.cy)) - Math.PI / 2) * 180 / Math.PI;
  }
  // Representative display-scale denominator (1:N) for SCAMIN comparison.
  scaleDenominator() {
    const R = 6378137; // earth radius (m)
    const phi = (this.centerLat() * Math.PI) / 180;
    const metresPerPixel = (R * Math.cos(phi)) / this.scale; // proj-radian -> m, /px
    const screenMetresPerPixel = 0.0254 / 96; // assume ~96 dpi
    return metresPerPixel / screenMetresPerPixel;
  }
}

class Renderer {
  constructor(canvas, s52, atlas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.s52 = s52;
    this.atlas = atlas; // HTMLImageElement
    this.vp = new Viewport(canvas);
    this.showText = true;
    this.showSoundings = true;
    this.respectScamin = true;     // suppress features below their SCAMIN
    this.declutter = true;         // skip overlapping labels/soundings
    this.minDisplayCat = "Other"; // Displaybase|Standard|Other|Mariners
    this._labelBoxes = [];
  }

  // returns false if [x,y,w,h] overlaps an already-placed label box
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

  render(chart) {
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    // background = NODTA / water
    ctx.fillStyle = this.s52.color("DEPDW");
    ctx.fillRect(0, 0, w, h);

    this._labelBoxes = [];
    const denom = this.vp.scaleDenominator();

    // resolve every feature once and bucket by op pass
    const resolved = [];
    for (const feat of chart.features) {
      if (!feat.geom && !feat.soundings) continue;
      // SCAMIN: hide the feature when zoomed out beyond its minimum scale
      if (this.respectScamin) {
        const sc = parseFloat(feat.attrs.SCAMIN);
        if (!Number.isNaN(sc) && denom > sc) continue;
      }
      const r = this.s52.resolve(feat, this._tablePref());
      if (!this.catAllowed(r.displayCat)) continue;
      resolved.push({ feat, ops: r.ops, prio: prioIndex(r.dispPrio) });
    }
    resolved.sort((a, b) => a.prio - b.prio);

    // pass 1: area fills (AC/AP)
    for (const r of resolved) {
      if (r.feat.geom?.type !== "Area") continue;
      for (const op of r.ops) {
        if (op.op === "AC") this._fillArea(r.feat.geom.coords, op.color, 1);
        else if (op.op === "AP") this._fillArea(r.feat.geom.coords, op.color, 0.35);
      }
    }
    // pass 2: lines (area boundaries + line features)
    for (const r of resolved) {
      const g = r.feat.geom;
      if (!g) continue;
      for (const op of r.ops) {
        if (op.op !== "LS") continue;
        if (g.type === "Area") this._strokeRings(g.coords, op);
        else if (g.type === "Line") this._strokeLines(g.coords, op);
      }
    }
    // pass 3: point symbols, soundings, text
    for (const r of resolved) {
      const g = r.feat.geom;
      for (const op of r.ops) {
        if (op.op === "SY") this._symbolFeature(r.feat, op.sym);
        else if (op.op === "SOUNDG" && this.showSoundings) this._soundings(r.feat);
        else if (op.op === "TX" && this.showText) this._text(r.feat, op);
      }
    }
  }

  _tablePref() {
    return "Simplified"; // point symbol style; falls back to Plain/Paper
  }

  _fillArea(rings, color, alpha) {
    if (!rings || !rings.length) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const ring of rings) {
      if (ring.length < 3) continue;
      this._path(ring);
    }
    ctx.fill("evenodd");
    ctx.restore();
  }

  _strokeRings(rings, op) {
    const ctx = this.ctx;
    ctx.save();
    this._applyStroke(op);
    ctx.beginPath();
    for (const ring of rings) this._path(ring);
    ctx.stroke();
    ctx.restore();
  }

  _strokeLines(lines, op) {
    const ctx = this.ctx;
    ctx.save();
    this._applyStroke(op);
    ctx.beginPath();
    for (const line of lines) this._path(line);
    ctx.stroke();
    ctx.restore();
  }

  _applyStroke(op) {
    const ctx = this.ctx;
    ctx.strokeStyle = op.color;
    ctx.lineWidth = op.width || 1;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (op.style === "DASH") ctx.setLineDash([6, 4]);
    else if (op.style === "DOTT") ctx.setLineDash([1, 3]);
    else ctx.setLineDash([]);
  }

  _path(pts) {
    const ctx = this.ctx;
    let started = false;
    for (const p of pts) {
      const [x, y] = this.vp.project(p[0], p[1]);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
  }

  _symbolFeature(feat, symName) {
    const g = feat.geom;
    if (!g) return;
    let lon, lat;
    if (g.type === "Point") { lon = g.coords[0]; lat = g.coords[1]; }
    else if (g.type === "Line" && g.coords[0]?.length) {
      const line = g.coords[0]; const m = line[Math.floor(line.length / 2)];
      lon = m[0]; lat = m[1];
    } else if (g.type === "Area" && g.coords[0]?.length) {
      const c = centroid(g.coords[0]); lon = c[0]; lat = c[1];
    } else return;
    this._blit(symName, lon, lat);
  }

  _blit(symName, lon, lat) {
    const s = this.s52.symbols.get(symName);
    const [x, y] = this.vp.project(lon, lat);
    if (!s || !this.atlas) {
      // fallback marker
      const ctx = this.ctx;
      ctx.fillStyle = this.s52.color("CHBLK");
      ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
      return;
    }
    this.ctx.drawImage(this.atlas, s.x, s.y, s.w, s.h, x - s.px, y - s.py, s.w, s.h);
  }

  _soundings(feat) {
    if (!feat.soundings) return;
    const ctx = this.ctx;
    ctx.fillStyle = this.s52.color("SNDG2");
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    for (const s of feat.soundings) {
      const [x, y] = this.vp.project(s[0], s[1]);
      const d = s[2];
      const label = d < 31 ? d.toFixed(1) : Math.round(d).toString();
      const w = label.length * 6;
      if (!this._place(x - w / 2, y - 5, w, 11)) continue;
      ctx.fillText(label, x, y + 3);
    }
  }

  _text(feat, op) {
    const g = feat.geom;
    if (!g) return;
    let lon, lat;
    if (g.type === "Point") { lon = g.coords[0]; lat = g.coords[1]; }
    else if (g.type === "Area" && g.coords[0]) { const c = centroid(g.coords[0]); lon = c[0]; lat = c[1]; }
    else if (g.type === "Line" && g.coords[0]?.length) { const m = g.coords[0][0]; lon = m[0]; lat = m[1]; }
    else return;
    const [x, y] = this.vp.project(lon, lat);
    const w = op.text.length * 6 + 4;
    if (!this._place(x + 4, y - 15, w, 13)) return;
    const ctx = this.ctx;
    ctx.fillStyle = op.color;
    ctx.font = "11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(op.text, x + 4, y - 4);
  }
}

function centroid(ring) {
  let x = 0, y = 0, n = 0;
  for (const p of ring) { x += p[0]; y += p[1]; n++; }
  return n ? [x / n, y / n] : [0, 0];
}

export { Renderer, Viewport };
