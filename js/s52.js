// S-52 presentation library engine.
// Loads chartsymbols.xml (OpenCPN's encoding of the IHO S-52 presentation
// library) and resolves, per feature, the list of drawing commands to execute.
//
// Implements the S-52 command words AC/AP/LS/LC/SY/TX/TE and a pragmatic subset
// of the conditional symbology procedures (CS) that matter most visually
// (depth-area shading, soundings, contours). Unhandled CS fall back to a
// best-effort default so the chart still renders.

class S52 {
  constructor() {
    this.colorTables = new Map(); // tableName -> Map(colorName -> [r,g,b])
    this.lookups = new Map();     // acronym -> [lookup]
    this.symbols = new Map();     // symbolName -> {x,y,w,h,px,py}
    this.lineStyles = new Map();
    this.patterns = new Map();
    this.currentTable = "DAY_BRIGHT";
    // mariner-selectable depth contours (metres) used by SEABED/DEPARE
    this.shallow = 2;
    this.safety = 10;
    this.deep = 20;
  }

  async load(xmlUrl) {
    const txt = await (await fetch(xmlUrl)).text();
    const doc = new DOMParser().parseFromString(txt, "application/xml");
    this._parseColors(doc);
    this._parseLookups(doc);
    this._parseSymbols(doc);
    this._parseLines(doc);
    return this;
  }

  _parseColors(doc) {
    for (const ct of doc.querySelectorAll("color-table")) {
      const name = ct.getAttribute("name");
      const map = new Map();
      for (const c of ct.querySelectorAll("color")) {
        map.set(c.getAttribute("name"), [
          +c.getAttribute("r"), +c.getAttribute("g"), +c.getAttribute("b"),
        ]);
      }
      this.colorTables.set(name, map);
    }
  }

  _parseLookups(doc) {
    for (const lu of doc.querySelectorAll("lookups > lookup")) {
      const name = lu.getAttribute("name");
      const get = (t) => {
        const e = lu.querySelector(t);
        return e ? e.textContent.trim() : "";
      };
      const conds = [];
      for (const ac of lu.querySelectorAll("attrib-code")) {
        const s = ac.textContent.trim();
        conds.push({ acronym: s.slice(0, 6).trim(), value: s.slice(6).trim() });
      }
      const entry = {
        name,
        type: get("type"),               // Point | Line | Area
        dispPrio: get("disp-prio"),
        radarPrio: get("radar-prio"),
        tableName: get("table-name"),    // Plain | Symbolized | ...
        instruction: get("instruction"),
        displayCat: get("display-cat"),
        conds,
      };
      if (!this.lookups.has(name)) this.lookups.set(name, []);
      this.lookups.get(name).push(entry);
    }
  }

  _parseSymbols(doc) {
    for (const sym of doc.querySelectorAll("symbols > symbol")) {
      const name = sym.querySelector("name")?.textContent.trim();
      const bmp = sym.querySelector("bitmap");
      if (!name || !bmp) continue;
      const gl = bmp.querySelector("graphics-location");
      const pv = bmp.querySelector("pivot");
      this.symbols.set(name, {
        w: +bmp.getAttribute("width"),
        h: +bmp.getAttribute("height"),
        x: gl ? +gl.getAttribute("x") : 0,
        y: gl ? +gl.getAttribute("y") : 0,
        px: pv ? +pv.getAttribute("x") : 0,
        py: pv ? +pv.getAttribute("y") : 0,
      });
    }
  }

  _parseLines(doc) {
    for (const ln of doc.querySelectorAll("line-styles > line")) {
      const name = ln.querySelector("name")?.textContent.trim();
      if (name) this.lineStyles.set(name, true);
    }
  }

  /**
   * IHO PL `display-cat` → 순위(낮을수록 Base에 가깝다). `Renderer.catAllowed`와 동일 계열.
   * @param {string} [cat]
   * @returns {number}
   */
  static displayCatRank(cat) {
    const rank = { Displaybase: 0, Standard: 1, Other: 2, Mariners: 3 };
    const c = String(cat ?? "").trim();
    if (!c) return 1;
    if (rank[c] !== undefined) return rank[c];
    if (/display\s*base/i.test(c)) return 0;
    return 1;
  }

  /**
   * 객체 클래스(약어)에 대해 chartsymbols.xml lookup 전체 중 가장 엄격한(낮은) 표시범주 순위.
   * 오브젝트 패널에서 Base / Standard / Other 구간으로 묶을 때 사용.
   * 수심 등고선(DEPCNT)은 PL상 Other인 경우가 많아, 지도 렌더와 같이 Standard 구간으로 본다.
   * @param {string} acronym
   * @returns {number} 0=Displaybase, 1=Standard, 2=Other, 3=Mariners
   */
  minDisplayRankForObjectClass(acronym) {
    const ac = String(acronym || "").trim().toUpperCase();
    if (ac === "DEPCNT") return 1;
    const all = this.lookups.get(acronym);
    if (!all || !all.length) return 1;
    let minR = 99;
    for (const lu of all) {
      const r = S52.displayCatRank(lu.displayCat);
      if (r < minR) minR = r;
    }
    return minR === 99 ? 1 : minR;
  }

  setColorTable(name) {
    if (this.colorTables.has(name)) this.currentTable = name;
  }

  color(name) {
    const t = this.colorTables.get(this.currentTable);
    const c = t && t.get(name);
    return c ? `rgb(${c[0]},${c[1]},${c[2]})` : "#ff00ff";
  }

  // ---- lookup selection (S-52 LUP matching) ----
  // Pick the lookup for a feature: must match geometry type and the most
  // specific set of attribute conditions that the feature satisfies.
  selectLookup(feat, tablePref) {
    const geomType = feat.prim === 1 ? "Point" : feat.prim === 2 ? "Line" : "Area";
    const all = this.lookups.get(feat.acronym);
    if (!all) return null;
    let best = null, bestScore = -1;
    for (const lu of all) {
      if (lu.type !== geomType) continue;
      if (tablePref && lu.tableName !== tablePref &&
          // allow Plain as a fallback if preferred table missing
          !(tablePref === "Symbolized" && lu.tableName === "Plain")) {
        // soft preference, don't hard-skip
      }
      let ok = true, score = 0;
      for (const cond of lu.conds) {
        const have = feat.attrs[cond.acronym];
        if (have === undefined) { ok = false; break; }
        if (cond.value !== "" && String(have).trim() !== cond.value) {
          // allow list membership: ATVL may be "1,2"
          const parts = String(have).split(",").map((s) => s.trim());
          if (!parts.includes(cond.value)) { ok = false; break; }
        }
        score += 2;
      }
      if (!ok) continue;
      // prefer matching the requested table
      if (tablePref && lu.tableName === tablePref) score += 1;
      if (score > bestScore) { bestScore = score; best = lu; }
    }
    return best;
  }

  // Resolve a feature to a list of primitive draw ops:
  //  {op:'AC', color}              area fill
  //  {op:'LS', style, width, color} line
  //  {op:'SY', sym}                point symbol (atlas)
  //  {op:'TX', text, color}        text label
  //  {op:'AP', color}              area pattern (approximated as faint fill)
  resolve(feat, tablePref) {
    const lu = this.selectLookup(feat, tablePref);
    const instr = lu ? lu.instruction : "";
    const ops = [];
    this._runInstruction(instr, feat, ops);
    return { ops, dispPrio: lu ? lu.dispPrio : "", displayCat: lu ? lu.displayCat : "Standard" };
  }

  _runInstruction(instr, feat, ops) {
    if (!instr) return;
    for (const cmd of splitCommands(instr)) {
      const m = cmd.match(/^([A-Z]{2})\((.*)\)$/s);
      if (!m) continue;
      const op = m[1];
      const args = splitArgs(m[2]);
      switch (op) {
        case "AC":
          ops.push({ op: "AC", color: this.color(args[0]) });
          break;
        case "AP":
          // area pattern: approximate with a translucent fill of its color
          ops.push({ op: "AP", color: this.color(patternColor(args[0])) });
          break;
        case "LS": {
          // LS(style,width,color)
          ops.push({
            op: "LS",
            style: args[0],
            width: +args[1] || 1,
            color: this.color(args[2]),
          });
          break;
        }
        case "LC": {
          // complex line: approximate as a solid line in CHBLK
          ops.push({ op: "LS", style: "SOLD", width: 1.5, color: this.color("CHBLK"), complex: args[0] });
          break;
        }
        case "SY": {
          // SY(symbol[,rotation]) — rotation is degrees or an attribute (ORIENT)
          const syOp = { op: "SY", sym: args[0] };
          if (args[1] !== undefined && args[1] !== "") {
            syOp.rot = resolveAngle(args[1], feat);
          }
          ops.push(syOp);
          break;
        }
        case "TX":
        case "TE": {
          const text = this._textValue(op, args, feat);
          if (text) ops.push({ op: "TX", text, color: this.color(textColor(op, args)) });
          break;
        }
        case "CS":
          this._conditional(args[0], feat, ops);
          break;
      }
    }
  }

  _textValue(op, args, feat) {
    // TX('literal'|ATTR, ...) or TE('format', 'ATTR', ...)
    if (op === "TX") {
      let a = args[0] || "";
      if (a.startsWith("'")) return a.replace(/'/g, "");
      const v = attrValue(a, feat);
      return v === undefined ? "" : String(v);
    }
    // TE('%s', 'OBJNAM', ...)
    const fmt = (args[0] || "").replace(/'/g, "");
    const attr = (args[1] || "").replace(/'/g, "");
    const v = attrValue(attr, feat);
    if (v === undefined) return "";
    return fmt.replace(/%[-0-9.]*l?[sdf]/g, String(v));
  }

  // ---- conditional symbology procedures (pragmatic subset) ----
  _conditional(name, feat, ops) {
    const proc = (name || "").replace(/'/g, "");
    if (proc.startsWith("DEPARE")) return this._depare(feat, ops);
    if (proc.startsWith("SEABED")) return this._seabed(feat, ops);
    if (proc.startsWith("DEPCNT")) {
      // 등심선 — OpenCPN 비교 시 너무 옅어 1.0 → 1.3 px로 약간 굵게(가독성).
      // safety contour(VALDCO == this.safety)는 더 굵게 표시해 위험 한계선을 강조.
      const v = parseFloat(feat.attrs.VALDCO);
      const isSafety = !Number.isNaN(v) && v === this.safety;
      ops.push({
        op: "LS",
        style: "SOLD",
        width: isSafety ? 2 : 1.3,
        color: this.color("DEPCN"),
      });
      return;
    }
    if (proc.startsWith("SOUNDG")) { ops.push({ op: "SOUNDG" }); return; }
    if (proc.startsWith("LIGHTS")) { return this._lights(feat, ops); }
    // 수중 위험물 — UDWHAZ 계열 조건부 기호: OBSTRN04(장애물)·UWTROC03(수중암)·
    // WRECKS02·UDWHAZ(난파선/일반). S-52 UDWHAZ를 단순화해, 수심(VALSOU)이 안전수심보다
    // 얕거나 불명이면 **고립 위험**(ISODGR01 — 점선 자홍 원 + ×, CARIS의 그 동그란 객체)으로,
    // 충분히 깊으면 평범한 장애물/수중암 심볼로 표기한다. (UWTROC는 기존에 미처리였음.)
    if (proc.startsWith("OBSTRN") || proc.startsWith("WRECKS") ||
        proc.startsWith("UDWHAZ") || proc.startsWith("UWTROC")) {
      const vs = num(feat.attrs.VALSOU);
      const ac = String(feat.acronym || "").toUpperCase();
      const isRock = proc.startsWith("UWTROC") || ac === "UWTROC";
      // VALSOU가 없을 때마다 ISODGR01(자홍 원+X)을 쓰면 양식·어구 등 일반
      // OBSTRN이 전부 "고립 위험"처럼 보인다. 얕은 수심이 **확정**됐을 때와
      // 난파선·암석(UWTROC)·미기재 난파선만 고립 위험으로 둔다.
      let danger = vs !== null && vs <= this.safety;
      if (!danger && vs === null) {
        if (isRock || ac === "WRECKS" || proc.startsWith("WRECKS")) danger = true;
      }
      ops.push({ op: "SY", sym: danger ? "ISODGR01" : (isRock ? "UWTROC04" : "OBSTRN01") });
      return;
    }
    if (proc.startsWith("DATCVR")) {
      // M_COVR/M_CSCL 외곽: S-52 PL은 CHBLK 선을 내지만, 본 뷰어는 render.js에서
      // 셀 격자·인덱스로만 표현하고 벡터 윤곽은 그리지 않는다(검정 격자선 누수 방지).
      return;
    }
    if (proc.startsWith("RESARE")) {
      ops.push({ op: "LS", style: "DASH", width: 2, color: this.color("CHMGD") });
      return;
    }
    // 정박 구역(ACHARE) 면: PL의 CS(RESTRN01)가 내부 × 패턴을 담당 — CARIS 등과 유사하게 근사
    if (
      proc.startsWith("RESTRN01") &&
      String(feat.acronym || "").toUpperCase() === "ACHARE" &&
      feat.prim === 3
    ) {
      ops.push({ op: "AP_ACHARE" });
      return;
    }
    if (proc.startsWith("QUAPOS") || proc.startsWith("SLCONS")) {
      ops.push({ op: "LS", style: "SOLD", width: 1.5, color: this.color("CSTLN") });
      return;
    }
    // unhandled CS: leave whatever literal ops were already added
  }

  _seabed(feat, ops) {
    const d1 = num(feat.attrs.DRVAL1), d2 = num(feat.attrs.DRVAL2);
    ops.unshift({ op: "AC", color: this.color(this._depthColor(d1, d2)) });
  }

  _depare(feat, ops) {
    const d1 = num(feat.attrs.DRVAL1), d2 = num(feat.attrs.DRVAL2);
    ops.push({ op: "AC", color: this.color(this._depthColor(d1, d2)) });
  }

  _depthColor(d1, d2) {
    // d1 = shoalest depth in the area (min), d2 = deepest
    if (d1 === null && d2 === null) return "DEPVS";
    const d = d1 !== null ? d1 : d2;
    if (d < 0) return "DEPIT";        // intertidal / drying
    if (d < this.shallow) return "DEPVS";
    if (d < this.safety) return "DEPMS";
    if (d < this.deep) return "DEPMD";
    return "DEPDW";
  }

  _lights(feat, ops) {
    // generic light flare; colour by COLOUR attribute (1 white,3 red,4 green)
    const col = String(feat.attrs.COLOUR || "").split(",")[0];
    let sym = "LIGHTS11";
    if (col === "3") sym = "LIGHTS12";       // red
    else if (col === "4") sym = "LIGHTS13";  // green
    ops.push({ op: "SY", sym });
  }
}

function num(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

// Prefer the national-language attribute (Korean NOBJNM/NINFOM) when present,
// falling back to the romanized/English OBJNAM/INFORM.
const NATIONAL_OF = { OBJNAM: "NOBJNM", INFORM: "NINFOM" };
function attrValue(acronym, feat) {
  const nat = NATIONAL_OF[acronym];
  if (nat) {
    const nv = feat.attrs[nat];
    if (nv !== undefined && nv !== "") return nv;
  }
  return feat.attrs[acronym];
}

// Resolve an SY rotation argument: a literal number of degrees, or an S-57
// attribute acronym (e.g. ORIENT) whose value is read from the feature.
function resolveAngle(arg, feat) {
  if (/^[A-Z]{6}$/.test(arg)) {
    const n = parseFloat(feat.attrs[arg]);
    return Number.isNaN(n) ? 0 : n;
  }
  const n = parseFloat(arg);
  return Number.isNaN(n) ? 0 : n;
}

function splitCommands(instr) {
  // split on ';' but not inside quotes/parens
  const out = [];
  let depth = 0, q = false, cur = "";
  for (const ch of instr) {
    if (ch === "'") q = !q;
    if (!q) { if (ch === "(") depth++; else if (ch === ")") depth--; }
    if (ch === ";" && depth === 0 && !q) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function splitArgs(s) {
  const out = [];
  let q = false, depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "'") q = !q;
    if (!q) { if (ch === "(") depth++; else if (ch === ")") depth--; }
    if (ch === "," && !q && depth === 0) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  if (cur.length) out.push(cur.trim());
  return out;
}

// area patterns: map a few common pattern names to a representative colour
function patternColor(p) {
  if (/DIAMOND|MARSH|FOUL/.test(p)) return "CHGRD";
  if (/AIRARE/.test(p)) return "CHGRF";
  return "CHGRF";
}

function textColor(op, args) {
  // TE color is one of the later args; default CHBLK
  for (const a of args) {
    if (/^[A-Z]{5}$/.test(a)) return a;
  }
  return "CHBLK";
}

export { S52 };
