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

/**
 * 항행보조 시설(부이·비컨·등화·표지 등) 약어 접두 — 다중 축척 셀의 중복
 * 표시를 묶어 잡을 dedup 대상. 좁게 잡아 어로구역·계류부표 등 개체 식별이
 * 중요한 객체는 제외한다.
 */
const NAVAID_ACRONYM_RE = /^(BOY|BCN|LIGHTS|MORFAC|LNDMRK|TOPMAR|DAYMAR|RTPBCN|RDOSTA|RADRFL|RADSTA|RTPSTA|RSCSTA|SISTAT|SISTAW|SBDARE|PILBOP|PILPNT|OFSPLF|RETRFL|SLCONS)/;
const NAVAID_DEDUP_PX = 24;
/** 동일 문자열 라벨(예: "안좌도")이 화면상 이 거리 안에 이미 있으면 중복 표기로 보고 스킵. */
const TEXT_DEDUP_PX = 60;

/**
 * navaid dedup 그룹 키 — 같은 그룹의 심볼이 NAVAID_DEDUP_PX 이내에 이미
 * 그려졌으면 건너뛴다.
 *  - LIGHTS: 색을 키에 포함해 좌·우현 등화 한 쌍은 보존
 *  - BOY·/BCN·: 접두 3글자(BOYSPP/BOYLAT/BOYSAW 등 분류 차이 흡수)
 *  - 그 외: 약어 전체
 */
function navaidGroupKey(feat) {
  const ac = (feat.acronym || "").toUpperCase();
  if (!NAVAID_ACRONYM_RE.test(ac)) return null;
  if (ac === "LIGHTS") {
    const col = String(feat.attrs.COLOUR || "").split(",")[0] || "";
    return `LIGHTS:${col}`;
  }
  if (ac.startsWith("BOY") || ac.startsWith("BCN")) return ac.slice(0, 3);
  return ac;
}

/**
 * 공간 해시(Map<bucketKey, number[]>)에 점 (x, y)가 이미 존재하면(거리 < min)
 * true 반환. 없으면 격자에 등록하고 false. 3×3 이웃 버킷까지 검사해
 * 셀 경계에서 ~1 px 흔들리는 중복도 잡는다.
 * - grid:   Map 인스턴스 (호출자가 프레임마다 초기화)
 * - prefix: 같은 grid에 여러 그룹을 공유할 때 키 접두(없으면 빈 문자열)
 * - g:      격자 한 칸 크기(px), min: 임계 거리(px). 보통 g===min.
 */
function spatialDedup(grid, prefix, x, y, g, min) {
  const min2 = min * min;
  const bx = Math.floor(x / g), by = Math.floor(y / g);
  const pre = prefix ? `${prefix}|` : "";
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const arr = grid.get(`${pre}${bx + dx},${by + dy}`);
      if (!arr) continue;
      for (let i = 0; i < arr.length; i += 2) {
        const ddx = x - arr[i], ddy = y - arr[i + 1];
        if (ddx * ddx + ddy * ddy < min2) return true;
      }
    }
  }
  const key = `${pre}${bx},${by}`;
  let arr = grid.get(key);
  if (!arr) { arr = []; grid.set(key, arr); }
  arr.push(x, y);
  return false;
}

/** S-57 메타 경계(M_COVR·M_CSCL) — UI 격자와 함께 켜고 끔. 표시범주 Other라 Standard에서도 격자 ON이면 허용 */
const ENC_BOUNDARY_WITH_GRID = new Set(["M_COVR", "M_CSCL"]);
/**
 * ENC 셀 메타 경계(M_COVR·M_CSCL) — 카탈로그 미매칭(`OBJ302`/`OBJ301`),
 * OBJL 타입 불일치(문자열 "302"), 또는 약어만 비정상일 때도 식별해
 * DATCVR(CHBLK) 윤곽이 선 패스로 새는 것을 막는다.
 */
function isEncBoundaryFeat(feat) {
  if (!feat) return false;
  const ac = String(feat.acronym || "").trim().toUpperCase();
  if (ENC_BOUNDARY_WITH_GRID.has(ac)) return true;
  const objM = /^OBJ(\d+)$/.exec(ac);
  if (objM) {
    const code = parseInt(objM[1], 10);
    if (code === 301 || code === 302) return true;
  }
  const o = feat.objl;
  const n = typeof o === "number" && Number.isFinite(o) ? o : parseInt(String(o), 10);
  if (n === 301 || n === 302) return true;
  const attrs = feat.attrs;
  if (attrs && Object.prototype.hasOwnProperty.call(attrs, "CATCOV")) return true;
  return false;
}

/**
 * M_NSYS(306): chartsymbols.xml 일부 룩업이 `LC(MARSYS51)`을 CHBLK 실선 LS로 근사한다.
 * 다수 ENC를 동시에 켜면 셀마다 큰 직사각형이 겹쳐 "검정 격자"처럼 보이므로 CHBLK LS만 끈다.
 * (CHYLW·CHGRD 등 다른 M_NSYS 선은 그대로 유지)
 */
function isMnsysFeat(feat) {
  if (!feat) return false;
  const ac = String(feat.acronym || "").trim().toUpperCase();
  if (ac === "M_NSYS") return true;
  if (/^OBJ306$/i.test(ac)) return true;
  const o = feat.objl;
  const n = typeof o === "number" && Number.isFinite(o) ? o : parseInt(String(o), 10);
  return n === 306;
}
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
    this.cx = 0; // center in mercX units (radians of longitude)
    this.cy = 0; // center in mercY units
    // ── 3D 지구본 모드 ──
    // mode === "globe"이면 직교투영(orthographic)으로 구체를 그리고, 드래그는
    // 회전으로 동작한다. auto3D가 true이면 충분히 축소(=scale 작아짐)됐을 때
    // 자동으로 globe ↔ mercator를 전환한다.
    this.mode = "mercator";        // "mercator" | "globe"
    this.auto3D = true;            // 임계 scale 아래면 자동 globe
    this._globeLat = 0;            // globe 중심 위도(라디안)
    /** fit 등으로 맞춘 뷰보다 휠/키로 더 축소(scale 더 감소)하지 못하게 하는 하한. null이면 미사용. */
    this.zoomOutMinScale = null;
  }
  /**
   * 범위 맞춤(fit) 직후 호출: 지금 scale만큼은 축소해 둘 수 있게 허용 하한을 넓힌다.
   * (셀 맞춤처럼 확대된 fit은 min을 낮추지 않는다 — Math.min으로 이전 전역 맞춤 한계 유지.)
   */
  applyZoomOutLimitAfterFit() {
    const s = this.scale;
    if (!Number.isFinite(s) || s <= 0) return;
    this.zoomOutMinScale = this.zoomOutMinScale == null ? s
      : Math.min(this.zoomOutMinScale, s);
  }
  /** 사용자 줌 입력용: zoomOutMinScale 미만으로 내려가지 않게 한다. */
  clampScaleForUserZoom(s) {
    if (this.zoomOutMinScale == null || !Number.isFinite(s)) return s;
    return Math.max(s, this.zoomOutMinScale);
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
    this._globeLat = this.centerLatRad();
  }
  // mercator units -> screen pixels (the per-frame hot path: no transcendentals)
  sx(mx) { return (mx - this.cx) * this.scale + this.canvas.width / 2; }
  sy(my) { return this.canvas.height / 2 - (my - this.cy) * this.scale; }
  project(lon, lat) { return [this.sx(mercX(lon)), this.sy(mercY(lat))]; }
  centerLat() {
    return (2 * Math.atan(Math.exp(this.cy)) - Math.PI / 2) * 180 / Math.PI;
  }
  centerLatRad() {
    return 2 * Math.atan(Math.exp(this.cy)) - Math.PI / 2;
  }

  // ── 3D 지구본 모드 헬퍼 ──

  /**
   * 원근 투영의 카메라 초점 거리(px). 구체 표면에서 각도 1 rad가 화면 중심에서
   * 차지하는 픽셀이 곧 scale이 되도록 D = 1 + f/scale 로 카메라 거리를 정한다.
   * f가 곧 90° FoV 기준의 픽셀 폭.
   */
  globeFocalLength() {
    return Math.min(this.canvas.width, this.canvas.height) * 0.5;
  }
  /** 원근 카메라의 구체 중심으로부터의 거리(단위 = 구체 반지름). 1이면 표면에 접함, ∞면 직교투영. */
  globeCameraDistance() {
    return 1 + this.globeFocalLength() / Math.max(1, this.scale);
  }
  /**
   * D가 1에 가까워지면(=카메라가 표면에 매우 가까워지면) 보이는 패치가 거의 평면.
   * 그 시점에서 머케이터로 전환하면 같은 위치·축척의 패치가 그대로 이어져 시각적 점프가 사라진다.
   * D=1.1 ↔ scale = f*10.
   */
  globeThresholdScale() {
    return this.globeFocalLength() * 10;
  }
  /** 현재 표시 모드가 globe인지(명시 모드 우선, 자동 모드면 scale 기준) */
  isGlobeView() {
    if (this.mode === "globe") return true;
    if (this.mode === "mercator") return false; // 명시적으로 평면 고정
    // mode === "auto" 등은 미사용 — auto3D 플래그로 통제
    return false;
  }
  /** scale 기반 자동 전환: auto3D일 때만 동작. 호출 측에서 매 입력 직후 부른다. */
  syncAutoMode() {
    if (!this.auto3D) return;
    const t = this.globeThresholdScale();
    if (this.scale < t && this.mode !== "globe") this.enterGlobe();
    else if (this.scale >= t && this.mode === "globe") this.exitGlobe();
  }
  enterGlobe() {
    this._globeLat = this.centerLatRad();
    this.mode = "globe";
  }
  exitGlobe() {
    // globe 중심 위·경도를 mercator 좌표로 되돌린다.
    this.cy = mercY(this._globeLat * 180 / Math.PI);
    this.mode = "mercator";
  }
  /**
   * 화면에 보이는 구체의 외관상 반지름(px). 원근 투영에서는 카메라가 가까울수록 커진다.
   * 식: r_screen = f / sqrt(D² - 1) (구체 림이 카메라에서 보이는 각의 사인이 1/D 인 데서 유도).
   */
  globeRadius() {
    const f = this.globeFocalLength();
    const D = this.globeCameraDistance();
    const d2 = D * D - 1;
    return f / Math.sqrt(Math.max(1e-6, d2));
  }
  /**
   * 구체 표면 위의 (lon, lat) → 화면 픽셀. **원근 투영**.
   * 카메라가 (0,0,D) 에서 구체 중심을 바라보고, 표면 위 점을 1점 초점 사영으로 옮긴다.
   * - 매우 큰 D(축소): 직교투영(orthographic) 과 동일 외관 — 지구본 전체가 작게 보임.
   * - D가 1로 갈수록(확대): 카메라가 표면에 접근, 보이는 패치가 평면에 가까워짐 →
   *   머케이터로 끊김 없이 전환되는 경계.
   * 가시 판정: 회전 좌표계의 z (=시선 방향) 가 1/D 보다 커야 함(구체에 가려지지 않음).
   */
  projPerspective(lonRad, latRad) {
    const cLon = this.cx;
    const cLat = this._globeLat;
    const f = this.globeFocalLength();
    const D = this.globeCameraDistance();
    const cosLat = Math.cos(latRad), sinLat = Math.sin(latRad);
    const cosCLat = Math.cos(cLat), sinCLat = Math.sin(cLat);
    const dLon = lonRad - cLon;
    const cosDLon = Math.cos(dLon), sinDLon = Math.sin(dLon);
    // 시선축 기준 회전된 좌표(unit sphere)
    const xv = cosLat * sinDLon;
    const yv = cosCLat * sinLat - sinCLat * cosLat * cosDLon;
    const zv = sinCLat * sinLat + cosCLat * cosLat * cosDLon;
    const cx = this.canvas.width / 2, cy = this.canvas.height / 2;
    if (zv > 1 / D) {
      const denom = D - zv;
      return { x: cx + xv * f / denom, y: cy - yv * f / denom, visible: true };
    }
    // 뒷면 — 림(외관상 반지름)으로 안정적 사영(폴리곤 경로가 끊기지 않게)
    const mag = Math.hypot(xv, yv) || 1e-9;
    const r = this.globeRadius();
    return { x: cx + xv / mag * r, y: cy - yv / mag * r, visible: false };
  }
  /**
   * 천구 방향(lon,lat)을 `projPerspective`와 동일한 (xv,yv,zv) 회전으로 뷰 축에 맞춘 뒤,
   * **구 림의 방위각**으로만 화면에 놓는다. 반지름은 `rhoMin`~**캔버스 모서리**(`hypot(cx,cy)`)까지
   * 제곱 보간으로 채워 얇은 고리가 되지 않게 한다.
   * 무한 원근으로 “하늘”에 두면 대부분의 방향이 지구 디스크 안에 사영되어 별이 사라지는
   * 문제를 피하면서, 지구본 회전에 따라 별 위치가 같이 바뀐다.
   * @param skyT [0,1] — 고리 안쪽·바깥쪽 반지름 보간
   * @returns {{ x: number, y: number } | null} 시선축 극 근처(mag≈0)면 null
   */
  globeCelestialToSkyRing(lonRad, latRad, skyT) {
    const cLon = this.cx;
    const cLat = this._globeLat;
    const cosLat = Math.cos(latRad), sinLat = Math.sin(latRad);
    const cosCLat = Math.cos(cLat), sinCLat = Math.sin(cLat);
    const dLon = lonRad - cLon;
    const cosDLon = Math.cos(dLon), sinDLon = Math.sin(dLon);
    const xv = cosLat * sinDLon;
    const yv = cosCLat * sinLat - sinCLat * cosLat * cosDLon;
    const mag = Math.hypot(xv, yv);
    if (mag < 1e-5) return null;
    const R = this.globeRadius();
    const cx = this.canvas.width / 2, cy = this.canvas.height / 2;
    const t = Math.max(0, Math.min(1, skyT));
    const rhoMin = R * 1.03;
    // 모서리까지 넓은 하늘(이전: min(w,h)*0.49 ≈ R에 가까워 얇은 띠만 생김)
    const rhoMax = Math.hypot(cx, cy) * 0.96;
    const r0 = rhoMin * rhoMin;
    const r1 = rhoMax * rhoMax;
    const rho = r1 > r0 ? Math.sqrt(r0 + t * (r1 - r0)) : rhoMin;
    // `projPerspective` 뒷면 림과 동일한 방위: (xv/mag, -yv/mag) × rho
    return { x: cx + (xv / mag) * rho, y: cy - (yv / mag) * rho };
  }
  /** 구버전 이름 호환(globe 렌더링 코드가 이 이름을 호출) */
  projOrtho(lonRad, latRad) { return this.projPerspective(lonRad, latRad); }
  /**
   * globe 모드에서 마우스 회전. dx, dy 는 픽셀 변위.
   * 원근 투영의 화면 중심 픽셀당 각도는 1/scale 라디안 (정의상)이므로 그대로 1:1 변환.
   */
  rotateGlobeByPixels(dx, dy) {
    const s = Math.max(1, this.scale);
    this.cx -= dx / s;
    this._globeLat = Math.max(-Math.PI / 2 + 0.01,
                     Math.min(Math.PI / 2 - 0.01, this._globeLat + dy / s));
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
    newScale = this.clampScaleForUserZoom(newScale);
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
        if (!isEncBoundaryFeat(feat)) continue;
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
    // 축척만 바뀌고 syncAutoMode가 빠지는 경로(초기 fit, 터치 핀치 등)에서도
    // 자동 지구본 전환이 되도록 매 프레임 동기화(비용은 비교·분기 수준).
    if (this.vp.auto3D) this.vp.syncAutoMode();
    // 3D 지구본 모드는 별도 경로로 그린다(머케이터 파이프라인을 우회).
    if (this.vp.isGlobeView()) { this._renderGlobe(); return; }
    const ctx = this.ctx, vp = this.vp;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.fillStyle = this.s52.color("DEPDW");
    ctx.fillRect(0, 0, w, h);

    this._labelBoxes = [];
    /** 통항·조류 방향 화살표 디클러터: 버킷(28 px 격자) → 해당 버킷에 배치된 점들의 [x,y,...] */
    this._flowArrowGrid = new Map();
    this._pointSymbolGrid = new Map();
    this._textDedupGrid = new Map();
    const denom = vp.scaleDenominator();
    // 동적 라벨/사운딩 글자 크기: 축척이 커질수록(=축소될수록) 글자를 줄여
    // 화면이 라벨로 덮이는 것을 막고, 확대할수록 글자를 키워 가독성을 높인다.
    // denom 1:5k≈14px, 1:75k≈13px, 1:500k≈11px, 1:5M≈10px
    this._labelFontPx = Math.max(9, Math.min(16,
      Math.round(20 - 1.5 * Math.log10(Math.max(1, denom)))));
    this._soundingFontPx = Math.max(8, Math.min(14, this._labelFontPx - 1));
    const table = this.s52.currentTable;
    // visible Mercator window for culling (small margin)
    const halfW = (w / 2) / vp.scale * 1.05, halfH = (h / 2) / vp.scale * 1.05;
    const winMinX = vp.cx - halfW, winMaxX = vp.cx + halfW;
    const winMinY = vp.cy - halfH, winMaxY = vp.cy + halfH;

    // 세계 대륙·국경 — ENC가 없는 영역에 위치 컨텍스트를 주는 배경.
    // 캐시된 폴리곤 bbox로 화면 밖은 통째 컬링하고, 매우 확대된 경우 스킵.
    this._drawMercatorWorldOverlay(winMinX, winMaxX, winMinY, winMaxY);

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
      // ── 셀 단위 뷰포트 컬링 ──
      // 셀 경계가 화면 밖이면 그 안의 모든 피처가 어차피 bbox 컬링될 것이므로 통째 스킵.
      // 744개 셀 중 화면에 보이는 건 보통 수십 개 이하 — 큰 성능 이득.
      const cmb = this._cellMercBbox(cell);
      if (cmb && (cmb[1] < winMinX || cmb[0] > winMaxX || cmb[3] < winMinY || cmb[2] > winMaxY)) {
        culled++; continue;
      }
      for (const feat of cell.features) {
        if (!feat.geom && !feat.soundings) continue;
        if (this.hiddenClasses.has(feat.acronym)) continue; // per-object-class toggle
        if (!this.showGrid && isEncBoundaryFeat(feat)) continue;
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
          this.showGrid && isEncBoundaryFeat(feat);
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
        resolved.push({ feat, ops: res.ops, prio: res.prio, cellCscl: cscl || Infinity });
      }
    }
    resolved.sort((a, b) => a.prio - b.prio);

    // 점 심볼/사운딩용 셀 우선순위 인덱스 — 같은 위치를 여러 축척 셀이 덮을 때
    // 가장 상세한 셀의 부이·등화·사운딩만 그리도록 위치별 최소 CSCL을 조회.
    this._bestCsclAt = this._buildCsclLookup(denom, winMinX, winMaxX, winMinY, winMaxY);

    // pass 1: area fills
    for (const r of resolved) {
      if (isEncBoundaryFeat(r.feat)) continue; // M_COVR/M_CSCL: 그리드 오버레이가 대신 표현
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
    const chblkRgb = this.s52.color("CHBLK");
    for (const r of resolved) {
      if (isEncBoundaryFeat(r.feat)) continue; // M_COVR/M_CSCL: 검정 윤곽 제거
      const pg = r.feat._pg;
      if (!pg || pg.type === "Point") continue;
      for (const op of r.ops) {
        if (op.op !== "LS") continue;
        if (isMnsysFeat(r.feat) && op.color === chblkRgb) continue;
        const key = op.color + "|" + (op.width || 1) + "|" + (op.style || "");
        let grp = lineGroups.get(key);
        if (!grp) { grp = { op, rings: [] }; lineGroups.set(key, grp); }
        for (const ring of pg.rings) grp.rings.push(ring);
      }
    }
    for (const grp of lineGroups.values()) this._strokePolys(grp.rings, grp.op);
    // pass 3: point symbols, soundings, text
    // 점 심볼/사운딩은 OpenCPN과 동일하게 "위치별 최상세 셀"만 그린다.
    // r.cellCscl > bestCsclAt(앵커) × CSCL_TOL 이면 더 상세한 셀이 그 위치를
    // 덮고 있으므로 이 셀의 점 심볼은 잔상으로 보고 생략.
    const CSCL_TOL = 1.5;
    for (const r of resolved) {
      for (const op of r.ops) {
        if (op.op === "SY") {
          if (this.declutter && r.cellCscl !== Infinity) {
            const a = r.feat._pg && r.feat._pg.anchor;
            if (a) {
              const best = this._bestCsclAt(a[0], a[1]);
              if (best !== Infinity && r.cellCscl > best * CSCL_TOL) continue;
            }
          }
          this._symbolFeature(r.feat, op.sym, op.rot);
        } else if (op.op === "SOUNDG" && this.showSoundings) {
          if (this.declutter && r.cellCscl !== Infinity && r.feat._bbox) {
            const cx = (r.feat._bbox[0] + r.feat._bbox[2]) / 2;
            const cy = (r.feat._bbox[1] + r.feat._bbox[3]) / 2;
            const best = this._bestCsclAt(cx, cy);
            if (best !== Infinity && r.cellCscl > best * CSCL_TOL) continue;
          }
          this._soundings(r.feat);
        } else if (op.op === "TX" && this.showText) {
          // (1) 다중 축척 셀의 동일 라벨 중복: 위치별 최상세 셀의 라벨만 그림
          if (this.declutter && r.cellCscl !== Infinity) {
            const a = r.feat._pg && r.feat._pg.anchor;
            if (a) {
              const best = this._bestCsclAt(a[0], a[1]);
              if (best !== Infinity && r.cellCscl > best * CSCL_TOL) continue;
            }
          }
          // (2) 같은 문자열이 화면상 가까운 위치(±TEXT_DEDUP_PX)에 이미 그려졌으면 스킵
          if (this.declutter) {
            const a = r.feat._pg && r.feat._pg.anchor;
            if (a && op.text) {
              const sx = this.vp.sx(a[0]), sy = this.vp.sy(a[1]);
              if (spatialDedup(this._textDedupGrid, op.text, sx, sy, TEXT_DEDUP_PX, TEXT_DEDUP_PX)) continue;
            }
          }
          this._text(r.feat, op);
        }
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
    // globe 모드는 회전(orthographic)이라 평면 이동 프리뷰가 어색하므로 매번 풀 렌더.
    if (this.vp.isGlobeView()) { this.render(); return; }
    const ctx = this.ctx;
    ctx.fillStyle = this.s52.color("DEPDW");
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (this._snap) ctx.drawImage(this._snap, ox, oy);
  }

  /**
   * 3D 지구본(직교투영) 렌더링.
   * 머케이터로는 표현이 어색해지는 매우 축소된 뷰에서 사용한다. 구체 배경 + 위·경도 그리드 +
   * 로드된 셀의 외곽 사각형(육안 식별용)을 그린다. 자세한 피처 도형은 이 축척에선 한 픽셀
   * 미만이라 의미가 없어 생략.
   */
  _renderGlobe() {
    const ctx = this.ctx, vp = this.vp;
    const w = this.canvas.width, h = this.canvas.height;
    const cx = w / 2, cy = h / 2;
    const R = vp.globeRadius();

    // 비동기 대륙 데이터 — 처음 호출 시 받기 시작하고, 도착하면 onWorldLandReady로 재렌더링.
    this._ensureWorldLand();

    // 별이 박힌 검정 배경
    ctx.fillStyle = "#05080d";
    ctx.fillRect(0, 0, w, h);
    this._drawStars();

    // 대기 글로우 — 구체 림 바깥쪽에 부드러운 푸른 빛
    const glow = ctx.createRadialGradient(cx, cy, R * 0.98, cx, cy, R * 1.18);
    glow.addColorStop(0, "rgba(120, 180, 240, 0.55)");
    glow.addColorStop(0.5, "rgba(70, 130, 200, 0.25)");
    glow.addColorStop(1, "rgba(20, 50, 100, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.18, 0, Math.PI * 2); ctx.fill();

    // 구체 디스크 — 단색. Canvas 방사 그라데이션(특히 편심)은 원과 맞지 않는 등색선으로
    // 사선·띠가 보이기 쉬우며, 동심 그라데이션도 정지점에서 띠가 남을 수 있어 단색으로 둔다.
    // 림의 푸른 톤은 위「대기 글로우」가 담당한다.
    ctx.fillStyle = "#1f4d80";
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

    // 클리핑 — 이 시점부터 구체 안쪽만 그리기
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();

    // 대륙
    this._drawGlobeLand();
    // 국경(옅게)
    this._drawGlobeCountries();
    // 위·경도 그리드(대륙 위에 옅게)
    this._drawGlobeGraticule();
    // 로드된 ENC 셀의 경계 사각형(그 위에)
    this._drawGlobeCells();

    ctx.restore();

    // 중앙 크로스헤어(회전 중심 표시)
    ctx.strokeStyle = "rgba(220,40,40,0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy); ctx.lineTo(cx + 10, cy);
    ctx.moveTo(cx, cy - 10); ctx.lineTo(cx, cy + 10);
    ctx.stroke();

    this.lastStats = { drawn: this.cells.size, culled: 0, denom: Math.round(vp.scaleDenominator()) };
  }

  /**
   * 세계 육지·국경 GeoJSON(Natural Earth 110m)을 한 번만 로드.
   * `assets/ne_110m_land.geojson` (대륙 면, 127 폴리곤)
   * `assets/ne_110m_countries.geojson` (국가 경계, 177 폴리곤) — 옅은 윤곽 표시용.
   * 로드 완료 시 onWorldLandReady() 콜백으로 재렌더링 신호.
   */
  _ensureWorldLand() {
    if (this._worldLand === undefined && !this._worldLandLoading) {
      this._worldLandLoading = true;
      (async () => {
        try {
          const r = await fetch("assets/ne_110m_land.geojson", { cache: "force-cache" });
          if (r.ok) {
            const j = await r.json();
            this._worldLand = this._normalizeWorldLand(j);
            if (typeof this.onWorldLandReady === "function") this.onWorldLandReady();
            return;
          }
        } catch (_e) { /* fall through */ }
        this._worldLand = null;
      })();
    }
    if (this._worldCountries === undefined && !this._worldCountriesLoading) {
      this._worldCountriesLoading = true;
      (async () => {
        try {
          const r = await fetch("assets/ne_110m_countries.geojson", { cache: "force-cache" });
          if (r.ok) {
            const j = await r.json();
            this._worldCountries = this._normalizeWorldLand(j);
            if (typeof this.onWorldLandReady === "function") this.onWorldLandReady();
            return;
          }
        } catch (_e) { /* fall through */ }
        this._worldCountries = null;
      })();
    }
  }

  /** GeoJSON FeatureCollection을 폴리곤 리스트로 평탄화: [[ ring, ... ], ...] */
  _normalizeWorldLand(geojson) {
    const polys = [];
    for (const f of geojson.features || []) {
      const g = f.geometry;
      if (!g) continue;
      if (g.type === "Polygon") polys.push(g.coordinates);
      else if (g.type === "MultiPolygon") {
        for (const p of g.coordinates) polys.push(p);
      }
    }
    return polys;
  }

  /**
   * 머케이터 좌표로 미리 사영한 대륙 폴리곤 캐시(한 번만 계산).
   * 머케이터 위·아래 발산을 막기 위해 위도를 ±85°로 클립.
   * 결과 형태: [[Float64Array(x,y,...), ...], ...]
   * (주의: 첫 호출 시 데이터가 아직 비동기 로드 중이면 캐시를 채우지 않고 반환 —
   * 다음 프레임에 다시 시도해 데이터가 도착하면 그때 계산됨)
   */
  _prepWorldLandMerc() {
    if (this._worldLandMerc) return;   // 이미 준비됨
    if (!this._worldLand) return;      // 아직 로딩 중 — 다음 프레임에 다시
    this._worldLandMerc = this._geojsonToMerc(this._worldLand);
  }

  /**
   * 정규화된 GeoJSON 폴리곤 리스트를 머케이터 좌표 + 폴리곤별 bbox로 변환.
   * 결과 형태: [{ rings: [Float64Array(x,y,...), ...], bbox: [mnx,mxx,mny,mxy] }, ...]
   * 매 프레임 vertex sx/sy로 bbox를 다시 계산할 필요가 없어 컬링 비용이 사라진다.
   */
  _geojsonToMerc(polys) {
    const out = [];
    for (const rings of polys) {
      const r2 = [];
      let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
      for (const ring of rings) {
        const n = ring.length;
        const flat = new Float64Array(n * 2);
        for (let i = 0; i < n; i++) {
          const lon = ring[i][0];
          const lat = Math.max(-85, Math.min(85, ring[i][1]));
          const mx = mercX(lon), my = mercY(lat);
          flat[i * 2] = mx; flat[i * 2 + 1] = my;
          if (mx < mnx) mnx = mx; if (mx > mxx) mxx = mx;
          if (my < mny) mny = my; if (my > mxy) mxy = my;
        }
        r2.push(flat);
      }
      out.push({ rings: r2, bbox: [mnx, mxx, mny, mxy] });
    }
    return out;
  }

  /**
   * 머케이터 평면 모드에서 세계 대륙을 그린다.
   * 우선 ENC 영역 색이 위를 덮으므로 ENC가 있는 곳에는 보이지 않고, 빈 바다·해외에만 노출됨.
   * 매 프레임 사영은 캐시된 머케이터 좌표에 vp.sx/sy 선형 변환만 적용해 빠르다.
   */
  /** 국가 경계도 머케이터 좌표 + bbox로 캐시(처음 한 번). */
  _prepWorldCountriesMerc() {
    if (this._worldCountriesMerc) return;
    if (!this._worldCountries) return;
    this._worldCountriesMerc = this._geojsonToMerc(this._worldCountries);
  }

  /**
   * 머케이터에서 세계 대륙(채움) + 국경(라인)을 그린다.
   * - 폴리곤별 mercator bbox는 한 번만 계산해 캐시되어, 매 프레임 컬링은 단순 비교 4번.
   * - 매우 축소·확대된 경우 화면 밖 폴리곤은 통째 스킵 → 한국 줌에서 아프리카·남미 등 무관 폴리곤 제거.
   * - 줌이 너무 들어와 ENC가 화면을 채우면(scale > MAX_WORLD_SCALE) 세계 데이터 자체를 그리지 않음
   *   — 어차피 ENC 면 채움이 덮어 보이지 않으므로 CPU 낭비.
   */
  _drawMercatorWorldOverlay(winMinX, winMaxX, winMinY, winMaxY) {
    this._ensureWorldLand();
    if (this.vp.scale > 30000) return; // 항만 상세 줌 이상 — 세계 지도 의미 없음
    this._prepWorldLandMerc();
    this._prepWorldCountriesMerc();
    const ctx = this.ctx, vp = this.vp;
    // 1) 대륙 면
    const lands = this._worldLandMerc;
    if (lands && lands.length) {
      const landFill = this.s52.color("LANDA") !== "#ff00ff"
        ? this.s52.color("LANDA")
        : "#dfd0a8";
      ctx.fillStyle = landFill;
      ctx.strokeStyle = "rgba(80,60,30,0.4)";
      ctx.lineWidth = 0.6;
      for (const item of lands) {
        const bb = item.bbox;
        if (bb[1] < winMinX || bb[0] > winMaxX || bb[3] < winMinY || bb[2] > winMaxY) continue;
        ctx.beginPath();
        for (const flat of item.rings) {
          const n = flat.length;
          if (n < 4) continue;
          ctx.moveTo(vp.sx(flat[0]), vp.sy(flat[1]));
          for (let i = 2; i < n; i += 2) ctx.lineTo(vp.sx(flat[i]), vp.sy(flat[i + 1]));
          ctx.closePath();
        }
        ctx.fill("evenodd");
        ctx.stroke();
      }
    }
    // 2) 국가 경계선
    const countries = this._worldCountriesMerc;
    if (countries && countries.length) {
      ctx.strokeStyle = "rgba(80,60,30,0.45)";
      ctx.lineWidth = 0.5;
      for (const item of countries) {
        const bb = item.bbox;
        if (bb[1] < winMinX || bb[0] > winMaxX || bb[3] < winMinY || bb[2] > winMaxY) continue;
        ctx.beginPath();
        for (const flat of item.rings) {
          const n = flat.length;
          if (n < 4) continue;
          ctx.moveTo(vp.sx(flat[0]), vp.sy(flat[1]));
          for (let i = 2; i < n; i += 2) ctx.lineTo(vp.sx(flat[i]), vp.sy(flat[i + 1]));
          ctx.closePath();
        }
        ctx.stroke();
      }
    }
  }

  /**
   * 폴리곤의 가시 정보를 한 번에 계산.
   * 반환: { allFront, anyFront, vis[], proj[] }
   *   vis[i]  = i번째 정점이 카메라 시선상 앞면(z > 1/D)인지
   *   proj[i] = 앞면이면 화면 좌표 {x, y}, 뒷면이면 null
   *
   * 모든 정점이 앞면이면 정상적으로 채울 수 있고, 뒷면이 섞이면 수평선 안에서만 윤곽선을 그어
   * 림으로의 잘못된 사영이 디스크 전체를 노란색으로 뒤덮는 문제를 피한다.
   *
   * (참고: 대륙 **면 채움**은 뷰 공간에서 z ≥ limbCos 반구로 클립한 뒤
   * `_appendGlobeFillRing`으로 화면에 올린다. 국경 **선**은 `_pathGlobeRing`.)
   */
  _projectRingPerspective(ring) {
    const vp = this.vp;
    const cLon = vp.cx, cLat = vp._globeLat;
    const D = vp.globeCameraDistance();
    const limbCos = 1 / D;
    const cosCLat = Math.cos(cLat), sinCLat = Math.sin(cLat);
    const n = ring.length;
    const vis = new Uint8Array(n);
    const proj = new Array(n);
    let allFront = true, anyFront = false;
    for (let i = 0; i < n; i++) {
      const c = ring[i];
      const lon = c[0] * Math.PI / 180;
      const lat = c[1] * Math.PI / 180;
      const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
      const dLon = lon - cLon;
      const cosC = sinCLat * sinLat + cosCLat * cosLat * Math.cos(dLon);
      if (cosC > limbCos) {
        vis[i] = 1; anyFront = true;
        proj[i] = vp.projPerspective(lon, lat);
      } else {
        allFront = false;
        proj[i] = null;
      }
    }
    return { allFront, anyFront, vis, proj };
  }

  /**
   * globe 모드에서 **앞면** 정점의 연속 구간만 잇는 부분 경로를 그린다(국경 선 등).
   * 뒷면은 null이라 끊긴다.
   */
  _pathGlobeRing(proj, vis) {
    const ctx = this.ctx;
    const n = vis.length;
    let pen = false;
    for (let i = 0; i < n; i++) {
      if (vis[i]) {
        const p = proj[i];
        if (!pen) { ctx.moveTo(p.x, p.y); pen = true; }
        else ctx.lineTo(p.x, p.y);
      } else {
        pen = false;
      }
    }
  }

  /**
   * (lon,lat) 라디안 → `projPerspective`와 동일 회전의 단위구면 (x,y,z). z가 클수록 카메라 앞.
   */
  _lonLatToViewUnit(vp, lonRad, latRad) {
    const cLon = vp.cx, cLat = vp._globeLat;
    const cosLat = Math.cos(latRad), sinLat = Math.sin(latRad);
    const cosCLat = Math.cos(cLat), sinCLat = Math.sin(cLat);
    const dLon = lonRad - cLon;
    const cosDLon = Math.cos(dLon), sinDLon = Math.sin(dLon);
    return {
      x: cosLat * sinDLon,
      y: cosCLat * sinLat - sinCLat * cosLat * cosDLon,
      z: sinCLat * sinLat + cosCLat * cosLat * cosDLon,
    };
  }

  /** 뷰 단위구면 점 → globe 화면 좌표(원근; 경계는 림으로). */
  _viewUnitToGlobeScreen(vp, v) {
    const f = vp.globeFocalLength();
    const D = vp.globeCameraDistance();
    const cx = vp.canvas.width / 2, cy = vp.canvas.height / 2;
    const { x: xv, y: yv, z: zv } = v;
    if (zv > 1 / D + 1e-9) {
      const denom = D - zv;
      return { x: cx + (xv * f) / denom, y: cy - (yv * f) / denom };
    }
    const mag = Math.hypot(xv, yv) || 1e-9;
    const r = vp.globeRadius();
    return { x: cx + (xv / mag) * r, y: cy - (yv / mag) * r };
  }

  /**
   * 단위구면 다각형(링)을 z ≥ limbCos 반공간으로 Sutherland–Hodgman 클립.
   * 뒷면 꼭짓점을 림으로 직선 연결하면 경로가 자기교차해 evenodd fill이 바다색으로 번지므로,
   * 면 채움 전용으로 사용한다.
   */
  _clipViewRingToGlobeFront(vp, verts) {
    const limbCos = 1 / vp.globeCameraDistance();
    const EPS = 1e-7;
    const inside = (p) => p.z >= limbCos - EPS;
    const inter = (A, B) => {
      const dz = B.z - A.z;
      if (Math.abs(dz) < 1e-11) return null;
      const t = (limbCos - A.z) / dz;
      if (t < -1e-7 || t > 1 + 1e-7) return null;
      const x = A.x + t * (B.x - A.x);
      const y = A.y + t * (B.y - A.y);
      const z = A.z + t * (B.z - A.z);
      const L = Math.hypot(x, y, z) || 1e-9;
      return { x: x / L, y: y / L, z: z / L };
    };
    const n = verts.length;
    if (n < 2) return null;
    const out = [];
    let S = verts[n - 1];
    for (let i = 0; i < n; i++) {
      const E = verts[i];
      const Sin = inside(S), Ein = inside(E);
      if (Ein) {
        if (!Sin) {
          const I = inter(S, E);
          if (I) out.push(I);
        }
        out.push(E);
      } else if (Sin) {
        const I = inter(S, E);
        if (I) out.push(I);
      }
      S = E;
    }
    if (out.length < 3) return null;
    return out;
  }

  /** GeoJSON 링 [lon,lat]° → 닫힘 중복 제거 후 뷰 단위구면 꼭짓점 배열. */
  _ringLonLatToViewVerts(vp, ring) {
    const n0 = ring.length;
    let end = n0;
    if (n0 >= 2) {
      const a = ring[0], b = ring[n0 - 1];
      if (Math.abs(a[0] - b[0]) < 1e-8 && Math.abs(a[1] - b[1]) < 1e-8) end = n0 - 1;
    }
    const verts = [];
    for (let i = 0; i < end; i++) {
      const c = ring[i];
      verts.push(this._lonLatToViewUnit(vp, (c[0] * Math.PI) / 180, (c[1] * Math.PI) / 180));
    }
    if (verts.length < 2) return null;
    return verts;
  }

  /**
   * globe **면 채움**: 반구 클립 후 화면 폴리곤(자기교차 없음).
   */
  _appendGlobeFillRing(ctx, ring) {
    const vp = this.vp;
    const raw = this._ringLonLatToViewVerts(vp, ring);
    if (!raw) return;
    const clipped = this._clipViewRingToGlobeFront(vp, raw);
    if (!clipped) return;
    const p0 = this._viewUnitToGlobeScreen(vp, clipped[0]);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < clipped.length; i++) {
      const p = this._viewUnitToGlobeScreen(vp, clipped[i]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
  }

  _drawGlobeCountries() {
    const polys = this._worldCountries;
    if (!polys || !polys.length) return;
    const ctx = this.ctx;
    ctx.strokeStyle = "rgba(80,60,30,0.55)";
    ctx.lineWidth = 0.6;
    for (const rings of polys) {
      // 외곽 링만 가시성 빠르게 확인 — 모두 뒷면이면 통째 스킵(앞면 폴리곤만 그림)
      let anyFront = false;
      const outer = rings[0];
      const D = this.vp.globeCameraDistance();
      const limbCos = 1 / D;
      const cosCLat = Math.cos(this.vp._globeLat), sinCLat = Math.sin(this.vp._globeLat);
      for (const c of outer) {
        const lat = c[1] * Math.PI / 180;
        const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
        const cosC = sinCLat * sinLat + cosCLat * cosLat * Math.cos(c[0] * Math.PI / 180 - this.vp.cx);
        if (cosC > limbCos) { anyFront = true; break; }
      }
      if (!anyFront) continue;
      ctx.beginPath();
      for (const ring of rings) {
        const r = this._projectRingPerspective(ring);
        this._pathGlobeRing(r.proj, r.vis);
      }
      ctx.stroke();
    }
  }

  _drawGlobeLand() {
    const polys = this._worldLand;
    if (!polys || !polys.length) return;
    const ctx = this.ctx;
    const landFill = this.s52.color("LANDA") !== "#ff00ff"
      ? this.s52.color("LANDA")
      : "#dfd0a8";
    ctx.fillStyle = landFill;
    ctx.strokeStyle = "rgba(80,60,30,0.5)";
    ctx.lineWidth = 0.6;
    for (const rings of polys) {
      const r0 = this._projectRingPerspective(rings[0]);
      if (!r0.anyFront) continue; // 통째 뒷면 — 스킵
      ctx.beginPath();
      for (const ring of rings) {
        this._appendGlobeFillRing(ctx, ring);
      }
      ctx.fill("evenodd");
      // 윤곽은 앞면 구간만 — 연속 링 전체를 stroke 하면 림 근처에 뒷면 꼭짓점 연결 잡선이 난다.
      ctx.beginPath();
      this._pathGlobeRing(r0.proj, r0.vis);
      for (let i = 1; i < rings.length; i++) {
        const r = this._projectRingPerspective(rings[i]);
        this._pathGlobeRing(r.proj, r.vis);
      }
      ctx.stroke();
    }
  }

  /**
   * 결정론적 별 점들 — 매 프레임 동일한 패턴(LCG 시드 고정).
   * globe:
   *  (0) **심우주** — 화면 전체에 작은 별(지구 디스크 안만 비움). 회전과 무관한 먼 배경.
   *  (1) 천구 고리 — `globeCelestialToSkyRing`, 지구본 회전에 따라 방위 이동.
   *  (2) 밝은 별 — 소수, 글로우·스파이크(천구 고리 위치).
   * mercator: (1)(2)와 동일하되 전 화면 랜덤.
   */
  _drawStars() {
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    const vp = this.vp;
    const globe = vp.isGlobeView();
    const cx = w / 2, cy = h / 2;
    const Rglobe = globe ? vp.globeRadius() : 0;
    const R2cut = Rglobe > 0 ? (Rglobe * Rglobe) * 0.97 : -1;
    const insideGlobe = (x, y) => {
      if (R2cut < 0) return false;
      const dx = x - cx, dy = y - cy;
      return dx * dx + dy * dy < R2cut;
    };
    // 결정론적 LCG
    let s = 1234567;
    const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff;
    /** 천구 + 하늘 고리(회전 동기) */
    const starXYRing = () => {
      if (!globe) return { x: rand() * w, y: rand() * h };
      const lon = rand() * Math.PI * 2;
      const lat = Math.asin(Math.max(-1, Math.min(1, 2 * rand() - 1)));
      return vp.globeCelestialToSkyRing(lon, lat, rand());
    };

    // (0) 심우주 — 전 화면 밀도(지구 뒤만 비움), 우주 느낌
    if (globe) {
      const deep = Math.floor((w * h) / 900);
      for (let i = 0; i < deep; i++) {
        let x, y;
        for (let k = 0; k < 16; k++) {
          x = rand() * w;
          y = rand() * h;
          if (!insideGlobe(x, y)) break;
        }
        if (insideGlobe(x, y)) continue;
        const a = 0.12 + rand() * 0.42;
        const pr = 0.25 + rand() * 0.55;
        ctx.fillStyle = `rgba(210,218,235,${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x, y, pr, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // (1) 배경 별 — 다수, 작고 옅음(천구 고리 / 평면 랜덤)
    const dim = Math.floor((w * h) / (globe ? 3800 : 2200));
    for (let i = 0; i < dim; i++) {
      let x, y;
      for (let k = 0; k < 10; k++) {
        const p = starXYRing();
        if (p) { x = p.x; y = p.y; break; }
      }
      if (x === undefined) continue;
      const a = 0.25 + rand() * 0.5;
      const r = 0.35 + rand() * 0.8;
      ctx.fillStyle = `rgba(220,225,240,${a.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }

    // (2) 밝은 별 — 소수, 글로우와 ✦ 스파이크
    const bright = Math.max(10, Math.floor((w * h) / (globe ? 45000 : 60000)));
    for (let i = 0; i < bright; i++) {
      let x, y;
      for (let k = 0; k < 10; k++) {
        const p = starXYRing();
        if (p) { x = p.x; y = p.y; break; }
      }
      if (x === undefined) continue;
      const sz = 1.2 + rand() * 1.6;
      const tint = rand();
      const r = tint < 0.5 ? 255 : (tint < 0.8 ? 220 : 200);
      const g = tint < 0.5 ? 250 : (tint < 0.8 ? 230 : 215);
      const b = tint < 0.5 ? 255 : (tint < 0.8 ? 255 : 220);
      // 헤일로
      const halo = ctx.createRadialGradient(x, y, 0, x, y, sz * 4);
      halo.addColorStop(0, `rgba(${r},${g},${b},0.85)`);
      halo.addColorStop(0.4, `rgba(${r},${g},${b},0.25)`);
      halo.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(x, y, sz * 4, 0, Math.PI * 2); ctx.fill();
      // 코어
      ctx.fillStyle = `rgba(${r},${g},${b},1)`;
      ctx.beginPath(); ctx.arc(x, y, sz, 0, Math.PI * 2); ctx.fill();
      // 회절 스파이크(가로·세로 가는 선)
      ctx.strokeStyle = `rgba(${r},${g},${b},0.55)`;
      ctx.lineWidth = 0.6;
      const spike = sz * 5;
      ctx.beginPath();
      ctx.moveTo(x - spike, y); ctx.lineTo(x + spike, y);
      ctx.moveTo(x, y - spike); ctx.lineTo(x, y + spike);
      ctx.stroke();
    }
  }

  _drawGlobeGraticule() {
    const ctx = this.ctx, vp = this.vp;
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    // 위도(가로) 15° 간격
    for (let latDeg = -75; latDeg <= 75; latDeg += 15) {
      const lat = latDeg * Math.PI / 180;
      ctx.beginPath();
      let started = false;
      for (let lonDeg = -180; lonDeg <= 180; lonDeg += 5) {
        const p = vp.projOrtho(lonDeg * Math.PI / 180, lat);
        if (!p.visible) { started = false; continue; }
        if (!started) { ctx.moveTo(p.x, p.y); started = true; }
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    // 경도(세로) 15° 간격
    for (let lonDeg = -180; lonDeg < 180; lonDeg += 15) {
      const lon = lonDeg * Math.PI / 180;
      ctx.beginPath();
      let started = false;
      for (let latDeg = -85; latDeg <= 85; latDeg += 5) {
        const p = vp.projOrtho(lon, latDeg * Math.PI / 180);
        if (!p.visible) { started = false; continue; }
        if (!started) { ctx.moveTo(p.x, p.y); started = true; }
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    // 적도·자오선 강조
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath();
    let started = false;
    for (let lonDeg = -180; lonDeg <= 180; lonDeg += 4) {
      const p = vp.projOrtho(lonDeg * Math.PI / 180, 0);
      if (!p.visible) { started = false; continue; }
      if (!started) { ctx.moveTo(p.x, p.y); started = true; }
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  _drawGlobeCells() {
    const ctx = this.ctx, vp = this.vp;
    ctx.lineWidth = 1.2;
    for (const cell of this.cells.values()) {
      const b = cell.bounds;
      if (!b || b.maxX === undefined) continue;
      const visible = cell.visible && cell.loaded;
      ctx.strokeStyle = visible ? "rgba(255,220,90,0.95)" : "rgba(255,255,255,0.35)";
      // 셀 외곽을 16분할해 경계가 곡선으로 보이도록
      const pts = [];
      const N = 4;
      // 아래변 (minY) 좌→우
      for (let i = 0; i <= N; i++) pts.push([b.minX + (b.maxX - b.minX) * i / N, b.minY]);
      // 우변 (maxX) 아→위
      for (let i = 1; i <= N; i++) pts.push([b.maxX, b.minY + (b.maxY - b.minY) * i / N]);
      // 위변 (maxY) 우→좌
      for (let i = 1; i <= N; i++) pts.push([b.maxX - (b.maxX - b.minX) * i / N, b.maxY]);
      // 좌변 (minX) 위→아
      for (let i = 1; i < N; i++) pts.push([b.minX, b.maxY - (b.maxY - b.minY) * i / N]);

      ctx.beginPath();
      let started = false, anyVisible = false, allVisible = true;
      for (const [lonDeg, latDeg] of pts) {
        const p = vp.projOrtho(lonDeg * Math.PI / 180, latDeg * Math.PI / 180);
        if (!p.visible) { started = false; allVisible = false; continue; }
        anyVisible = true;
        if (!started) { ctx.moveTo(p.x, p.y); started = true; }
        else ctx.lineTo(p.x, p.y);
      }
      if (!anyVisible) continue;
      // 전체가 앞면일 때만 closePath() — 부분 가시 셀은 마지막 점→첫 점 직선 폐쇄가 사선 잔상을 만들기 때문.
      if (allVisible) ctx.closePath();
      ctx.stroke();
    }
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
    // 포커스 셀: 강조 테두리. 그 외 표시 중 셀: 밴드색 얇은 윤곽(면 채움 없음)
    if (focused) {
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.lineWidth = 4;
      ctx.setLineDash([]);
      ctx.strokeRect(x, y, ww, hh);
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, ww, hh);
    } else if (on) {
      ctx.strokeStyle = col.replace(/[\d.]+\)$/, "0.55)");
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.strokeRect(x, y, ww, hh);
    }
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

  /**
   * 셀 경계 박스를 머케이터 좌표로 1회만 계산해 캐시(`[mxMin, mxMax, myMin, myMax]`).
   * 셀 컬링 + CSCL 인덱싱에 공통으로 쓰는 핫패스 함수라 호출이 잦다 — 캐시 필수.
   */
  _cellMercBbox(cell) {
    if (cell._mercBbox !== undefined) return cell._mercBbox;
    const b = cell.bounds;
    if (!b || b.maxX === undefined) return cell._mercBbox = null;
    return cell._mercBbox = [
      mercX(b.minX), mercX(b.maxX),
      mercY(b.minY), mercY(b.maxY),
    ];
  }

  /**
   * 화면 안에 들어오는 셀들의 (Mercator) 경계와 CSCL을 모아, 임의 위치 (mx, my)
   * 에서의 **가장 상세한(=가장 작은) CSCL** 을 즉시 돌려주는 클로저를 만든다.
   * 더 상세한 셀이 같은 위치를 덮으면 개략 셀의 점 심볼·사운딩을 생략하는
   * OpenCPN 거동을 구현하기 위한 인덱스.
   */
  _buildCsclLookup(denom, winMinX, winMaxX, winMinY, winMaxY) {
    const cells = [];
    for (const cell of this.cells.values()) {
      if (!cell.visible || !cell.loaded) continue;
      const b = cell.bounds;
      const cscl = b && b.cscl;
      if (!cscl || b.maxX === undefined) continue;
      if (this.scaleDisplay && denom > cscl * this.scaleOutFactor) continue;
      const cmb = this._cellMercBbox(cell);
      if (!cmb) continue;
      const mxMin = cmb[0], mxMax = cmb[1], myMin = cmb[2], myMax = cmb[3];
      if (mxMax < winMinX || mxMin > winMaxX || myMax < winMinY || myMin > winMaxY) continue;
      cells.push({ cscl, mxMin, mxMax, myMin, myMax });
    }
    return (mx, my) => {
      let best = Infinity;
      for (const c of cells) {
        if (mx < c.mxMin || mx > c.mxMax || my < c.myMin || my > c.myMax) continue;
        if (c.cscl < best) best = c.cscl;
      }
      return best;
    };
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
    if (this.declutter) {
      const sx = this.vp.sx(a[0]), sy = this.vp.sy(a[1]);
      // (1) 항행보조 시설: 다중 축척 셀이 같은 부이/등화를 중복 수록할 때 잔상 제거
      const navGroup = navaidGroupKey(feat);
      if (navGroup &&
          spatialDedup(this._pointSymbolGrid, navGroup, sx, sy, NAVAID_DEDUP_PX, NAVAID_DEDUP_PX)) {
        return;
      }
      // (2) TSS·항로·조류 등 방향 화살표: 줄지어 박힌 화살표를 듬성하게
      if (FLOW_ARROW_SYMBOL_RE.test(symName || "") &&
          spatialDedup(this._flowArrowGrid, "", sx, sy, FLOW_ARROW_MIN_DIST_PX, FLOW_ARROW_MIN_DIST_PX)) {
        return;
      }
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
    const fpx = this._soundingFontPx || 10;
    const charW = fpx * 0.6;
    ctx.fillStyle = this.s52.color("SNDG2");
    ctx.font = `${fpx}px sans-serif`;
    ctx.textAlign = "center";
    for (let i = 0; i < ps.length; i += 3) { // flat [x,y,depth,…]
      const x = vp.sx(ps[i]), y = vp.sy(ps[i + 1]);
      if (x < -20 || y < -20 || x > this.canvas.width + 20 || y > this.canvas.height + 20) continue;
      const label = soundingLabel(ps[i + 2], this.depthUnit); // metres
      const w = label.length * charW;
      if (!this._place(x - w / 2, y - fpx / 2, w, fpx + 1)) continue;
      ctx.fillText(label, x, y + fpx * 0.3);
    }
  }

  _text(feat, op) {
    const a = feat._pg && feat._pg.anchor;
    if (!a) return;
    const x = this.vp.sx(a[0]), y = this.vp.sy(a[1]);
    const fpx = this._labelFontPx || 11;
    const charW = fpx * 0.55;
    const w = op.text.length * charW + 4;
    if (!this._place(x + 4, y - fpx - 4, w, fpx + 2)) return;
    const ctx = this.ctx;
    ctx.fillStyle = op.color;
    ctx.font = `${fpx}px sans-serif`;
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
