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

/**
 * S-52 display-cat 순위표 — `catAllowed`가 매 프레임 피처마다(수만 회) 조회하므로
 * 호출마다 객체를 새로 만들지 않도록 모듈 상수로 1회만 둔다(GC 압력 제거).
 */
const DISPLAY_CAT_RANK = { Displaybase: 0, Standard: 1, Other: 2, Mariners: 3 };

const DASH = [6, 4], DOTT = [1, 3], EMPTY_DASH = [];
/**
 * Min squared screen-space edge length (px²) for path decimation; see `_path()`.
 * 0.25 = 0.5 px 미만 정점만 제거 — 면 채움·클립 등 대용량 폴리곤용.
 */
const MIN_SEG2 = 0.25;
/**
 * LS(선) 스트로크 전용 — 면보다 촘촘히 두어 COALNE·등고선 등이 확대 시 덜 각져 보이게 함.
 * (0.01 → 인접 정점 간격 ~0.1 px 미만일 때만 생략)
 */
const MIN_SEG2_STROKE = 0.01;
/**
 * 겹치는 ENC 커버리지에서 컴파일 축척(CSCL)이 더 큰(숫자는 더 작음 = 더 상세한) 셀을 우선할 때
 * 허용 비율. IHO S-52 Presentation Library·ECDIS 관행(겹침 구간은 가용한 가장 큰 축척 데이터)과
 * 동일하게 점 심볼·사운딩·선(LS)에 공통 적용한다.
 */
const CSCL_OVERLAP_TOL = 1.5;

/**
 * Natural Earth 개략 육지/국경: 표시 분모(대략 1:N)가 이 값 **미만**이면 머케이터에서 끔.
 * 뷰포트와 겹치는 표시 중 ENC 셀이 있을 때도 끔 — ENC와 배타 표시 (`_shouldDrawNaturalEarthWorldLand`).
 * (`vp.scale > 30000`과 함께 적용.)
 */
const MERCATOR_WORLD_OVERLAY_MIN_DENOM = 2_800_000;

/**
 * 지구본 모드에서 더 이상 축소(scale 감소)하지 못하게 할 때,
 * 화면상 구 **직경**이 캔버스 **짧은 변** 길이의 이 비율보다 작아지지 않게 함.
 * (너무 작으면 별 배경만 크고 지도 디스크가 핀포인트처럼 보이는 문제가 생김.)
 */
const GLOBE_MIN_DIAMETER_FRAC_OF_MIN_CANVAS_SIDE = 0.94;

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

/**
 * 광역 축척(축소)에서 장애물·고립위험·난파선·암석 점심볼이 픽셀에 겹쳐 핑크/검정 덩어리로
 * 보이는 것을 줄인다. 표시 분모가 작을수록(확대) 0을 반환해 디클러터를 끈다.
 */
function hazardSymbolDeclutterMinPx(denom) {
  if (!Number.isFinite(denom) || denom < 45000) return 0;
  if (denom >= 900000) return 40;
  if (denom >= 350000) return 32;
  if (denom >= 150000) return 26;
  if (denom >= 80000) return 22;
  return 18;
}

/**
 * 항행보조(부이·등화·비컨) 점심볼을 소축척(축소)에서 더 듬성하게 솎는 거리(px).
 * 개략 셀(예: 1:200만 overview)이 촘촘히 담은 항로표지가 광역 뷰를 뒤덮는 것을 막는다.
 * 표시 분모가 작을수록(확대) 기존 NAVAID_DEDUP_PX(24)로 수렴해 상세를 그대로 유지한다.
 */
function navaidDedupPx(denom) {
  if (!Number.isFinite(denom) || denom < 150000) return NAVAID_DEDUP_PX; // ~1:15만↑(확대): 그대로
  if (denom >= 4000000) return 60;   // ~z6 이하
  if (denom >= 2000000) return 52;   // ~z7
  if (denom >= 1000000) return 44;   // ~z8
  if (denom >= 450000) return 36;    // ~z9–10
  return 30;                          // ~z11
}

/**
 * 수심 숫자(SOUNDG)를 소축척에서 듬성하게 솎는 최소 간격(px). 0이면 솎기 없음(상세 줌).
 * 라벨 박스(_place)와 **별개**의 공간 격자를 써서 지명 라벨엔 영향을 주지 않는다.
 */
function soundingDedupPx(denom) {
  if (!Number.isFinite(denom) || denom < 150000) return 0;
  if (denom >= 4000000) return 46;
  if (denom >= 2000000) return 40;
  if (denom >= 1000000) return 34;
  if (denom >= 450000) return 28;
  return 22;
}

function isHazardDeclutterSym(sym) {
  if (!sym || typeof sym !== "string") return false;
  const u = sym.toUpperCase();
  return u.startsWith("ISODGR") || u.startsWith("OBSTRN") || u.startsWith("WRECKS") || u.startsWith("UWTROC");
}

/** S-57 메타 경계(M_COVR·M_CSCL) — UI 격자와 함께 켜고 끔. 표시범주 Other라 Standard에서도 격자 ON이면 허용 */
const ENC_BOUNDARY_WITH_GRID = new Set(["M_COVR", "M_CSCL"]);
/**
 * ENC 셀 메타 경계(M_COVR·M_CSCL) — 카탈로그 미매칭(`OBJ302`/`OBJ301`),
 * OBJL 타입 불일치(문자열 "302"), 또는 약어만 비정상일 때도 식별해
 * DATCVR(CHBLK) 윤곽이 선 패스로 새는 것을 막는다.
 */
/**
 * 수심 등고선: chartsymbols.xml에서 display-cat이 Other로 잡혀 Standard 뷰에서
 * 전부 걸러지는 것을 막기 위해, 필터 단계에서만 Standard와 동일 취급한다.
 * 선형 DEPARE(경계가 DEPCNT02 CS로 그려지는 경우)도 동일.
 */
function depthContourStandardDisplay(feat) {
  if (!feat) return false;
  let v = feat._depthStd;
  if (v !== undefined) return v;
  const ac = String(feat.acronym || "").trim().toUpperCase();
  v = ac === "DEPCNT" || (ac === "DEPARE" && feat.prim === 2);
  return feat._depthStd = v;
}

/** 다중 축척 겹침에서 개략 셀 LS를 생략해도, 상세 셀에 COALNE가 없으면 해안이 뭉개져 보이므로 항상 그린다. */
function isCoastlineLineForOverlap(r) {
  if (!r || !r.feat) return false;
  if (String(r.feat.acronym || "").toUpperCase() !== "COALNE") return false;
  const pg = r.feat._pg;
  return !!(pg && pg.type === "Line");
}

// 메모이즈 래퍼 — feat.acronym/objl/attrs는 파싱 후 불변이라 결과를 피처에 1회 캐시한다.
// (매 프레임 피처마다 최대 4회 호출되며 문자열 toUpperCase + 정규식이 들어가 비쌌다.)
function isEncBoundaryFeat(feat) {
  if (!feat) return false;
  const c = feat._encB;
  if (c !== undefined) return c;
  return feat._encB = computeEncBoundary(feat);
}
function computeEncBoundary(feat) {
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
  let v = feat._mnsys;
  if (v !== undefined) return v;
  const ac = String(feat.acronym || "").trim().toUpperCase();
  if (ac === "M_NSYS" || /^OBJ306$/i.test(ac)) v = true;
  else {
    const o = feat.objl;
    const n = typeof o === "number" && Number.isFinite(o) ? o : parseInt(String(o), 10);
    v = n === 306;
  }
  return feat._mnsys = v;
}
// ratio is wrong, so X is longitude in radians — not degrees.
/**
 * S-52 색상 문자열 `rgb(r,g,b)` 또는 `#rrggbb` → `[r, g, b]` 숫자 배열.
 * 형식 인식 실패 시 null.
 */
function parseRgbColor(s) {
  if (!s || typeof s !== "string") return null;
  let m = s.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  if (m) return [+m[1], +m[2], +m[3]];
  m = s.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  return null;
}

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
  /**
   * 핀치·휠 등 사용자 축소(scale 감소) 입력의 scale 하한.
   * fit 직후 `zoomOutMinScale`이 지역 확대(=scale 큼)로 잡히면 그 값이
   * 3D 자동 전환 임계(`globeThresholdScale`)보다 크게 남아, 모바일에서 축소해도
   * 지구본으로 못 들어가는 경우가 있다. `auto3D` 머케이터에서는 하한을 `th×0.98`까지
   * 낮춰 진입 가능하게 한다. 지구본 모드에서는 `th×0.98`을 쓰면 scale이 th보다
   * 아래일 때 더 축소가 막히므로 `th×0.02`까지 허용해 지구본을 더 작게 볼 수 있게 한다.
   */
  minScaleForUserZoom() {
    if (this.zoomOutMinScale == null || !Number.isFinite(this.zoomOutMinScale)) return null;
    if (!this.auto3D) return this.zoomOutMinScale;
    if (typeof this.globeThresholdScale !== "function") return this.zoomOutMinScale;
    const th = this.globeThresholdScale();
    if (!(th > 0) || !Number.isFinite(th)) return this.zoomOutMinScale;
    // 머케이터: 지역 fit 한한이 th보다 크면 th 근처까지는 축소해 3D 진입 가능하게.
    // 지구본: th×0.98을 하한에 쓰면 scale < th 인 상태에서 더 줄일 수 없어 멈춤 → th보다 훨씬 작은 하한.
    if (this.isGlobeView()) return Math.min(this.zoomOutMinScale, th * 0.02);
    return Math.min(this.zoomOutMinScale, th * 0.98);
  }
  /** 사용자 줌 입력용: `minScaleForUserZoom` 미만으로 내려가지 않게 한다. */
  clampScaleForUserZoom(s) {
    let lo = this.minScaleForUserZoom();
    if (this.isGlobeView()) {
      const g = this.globeZoomOutMinScale();
      lo = lo == null ? g : Math.max(lo, g);
    }
    if (!Number.isFinite(s)) return s;
    if (lo != null) s = Math.max(s, lo);
    // 타일 모드 상한: OL 타일은 z18까지만 있어, vp가 그보다 더 확대되면 표시는 z18에 멈추고
    // vp만 깊어져 둘이 어긋난다 → 드래그해도 화면이 드래그량의 일부만 이동(="최대 확대 후 이동 안 됨").
    // tile-mercator가 z18에 해당하는 scale을 tileMaxScale로 세팅하면 그 위 확대를 막아 동기화한다.
    if (this.tileMaxScale > 0 && s > this.tileMaxScale) s = this.tileMaxScale;
    return s;
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
   * Globe ↔ Mercator 전환 임계 scale.
   * 사용자가 충분히 확대한 뒤에야 평면 머케이터로 전환되도록 `f·5`로 설정.
   * 이 시점에서 카메라 거리 D ≈ 1.2로 표면에 꽤 가까워 보이는 패치가 거의 평탄해지며,
   * 모드 전환 크로스페이드와 임계 스냅이 시각적 점프를 추가로 완화한다.
   *
   * - Globe(원근): 시야 폭 ≈ 2·acos(1/D), D = 1 + f/S
   * - Mercator: 시야 폭 ≈ canvas_width / S (라디안)
   * f·5에서: globe ≈ 67°, mercator ≈ 48° — 약간의 줌인 효과로 자연스러움.
   */
  globeThresholdScale() {
    return this.globeFocalLength() * 5;
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
    if (this.auto3D) {
      const t = this.globeThresholdScale();
      // 히스테리시스: 임계 하나로 양방향 전환하면 scale이 임계 근처에서 미세히 떨릴 때(또는 fit 한한이
      // 임계 아래라 매 프레임 syncAutoMode가 재평가될 때) globe↔mercator가 뒤집혀 전환 크로스페이드가
      // 반복 → 화면이 깜빡인다. 진입은 0.85t 아래, 이탈은 1.15t 위에서만 → 그 사이 밴드에선 현재 모드 유지.
      if (this.scale < t * 0.85 && this.mode !== "globe") this.enterGlobe();
      else if (this.scale > t * 1.15 && this.mode === "globe") this.exitGlobe();
    }
    if (this.mode === "globe") {
      const sm = this.globeZoomOutMinScale();
      if (this.scale < sm) this.scale = sm;
    }
  }
  enterGlobe() {
    if (this.mode === "globe") return;
    this._globeLat = this.centerLatRad();
    this._modeTransition = { from: "mercator", to: "globe", startTime: performance.now(), duration: 280 };
    this.mode = "globe";
  }
  exitGlobe() {
    if (this.mode !== "globe") return;
    // globe 중심 위·경도를 mercator 좌표로 되돌린다.
    this.cy = mercY(this._globeLat * 180 / Math.PI);
    this._modeTransition = { from: "globe", to: "mercator", startTime: performance.now(), duration: 280 };
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
   * 지구본을 더 멀리 보낼 때(scale 더 낮출 때) `globeRadius()`가
   * `min(w,h)·GLOBE_MIN_DIAMETER_FRAC_OF_MIN_CANVAS_SIDE/2` 미만이 되지 않게 하는 scale 하한.
   * r = f/√(D²−1), D = 1+f/s ⇒ s = f/(√(1+f²/r²)−1).
   */
  globeZoomOutMinScale() {
    const h = this.canvas.height;
    const w = this.canvas.width;
    if (!(h > 2 && w > 2)) return 1;
    const ref = Math.min(w, h);
    const dTar = ref * GLOBE_MIN_DIAMETER_FRAC_OF_MIN_CANVAS_SIDE;
    const rTar = dTar / 2;
    const f = this.globeFocalLength();
    if (!(f > 0) || !(rTar > 0)) return 1;
    const inner = Math.sqrt(1 + (f / rTar) * (f / rTar)) - 1;
    if (!(inner > 1e-10)) return 1;
    let s = Math.max(1, f / inner);
    const sSaved = this.scale;
    let guard = 0;
    while (guard < 10) {
      this.scale = s;
      const r = this.globeRadius();
      this.scale = sSaved;
      if (2 * r >= dTar * 0.998) break;
      s *= 1.04;
      guard++;
    }
    return Math.max(1, s);
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
    const s = this.scale, cy = this.cy;
    if (this._sdCacheScale === s && this._sdCacheCy === cy) return this._sdCacheVal;
    const R = 6378137; // earth radius (m)
    const phi = (this.centerLat() * Math.PI) / 180;
    const metresPerPixel = (R * Math.cos(phi)) / s;
    const v = metresPerPixel / (0.0254 / 96); // assume ~96 dpi
    this._sdCacheScale = s;
    this._sdCacheCy = cy;
    this._sdCacheVal = v;
    return v;
  }
  /** Mercator 캐시 좌표(mx,my) — `sx`/`sy`의 역변환(픽셀은 캔버스 좌상단 기준). */
  mercFromScreen(px, py) {
    const w = this.canvas.width, h = this.canvas.height;
    const mx = this.cx + (px - w / 2) / this.scale;
    const my = this.cy + (h / 2 - py) / this.scale;
    return [mx, my];
  }
  /**
   * Globe 원근 투영에서 화면 (px,py)이 가리키는 표면의 경·위도(라디안).
   * `projPerspective`와 동일한 카메라·초점 모델. 림 밖·시야 밖이면 null.
   */
  globePickLonLatFromScreen(px, py) {
    const f = this.globeFocalLength();
    const D = this.globeCameraDistance();
    const cx = this.canvas.width * 0.5;
    const cy = this.canvas.height * 0.5;
    const u = (px - cx) / f;
    const v = (cy - py) / f;
    const t = u * u + v * v;
    const a = t + 1;
    const b = -2 * D * t;
    const c = D * D * t - 1;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sqrtDisc = Math.sqrt(disc);
    const z1 = (-b - sqrtDisc) / (2 * a);
    const z2 = (-b + sqrtDisc) / (2 * a);
    const zMin = 1 / D + 1e-7;
    const roots = [z1, z2].filter((z) => z > zMin && z < 1 - 1e-9);
    if (!roots.length) return null;
    const zv = Math.max(...roots);
    const denom = D - zv;
    if (denom < 1e-9) return null;
    const xv = u * denom;
    const yv = v * denom;
    const cLat = this._globeLat;
    const cLon = this.cx;
    const sinCLat = Math.sin(cLat);
    const cosCLat = Math.cos(cLat);
    const Xg = -sinCLat * yv + cosCLat * zv;
    const Yg = xv;
    const Zg = cosCLat * yv + sinCLat * zv;
    const lat = Math.asin(Math.max(-1, Math.min(1, Zg)));
    const lon = cLon + Math.atan2(Yg, Xg);
    return { lon, lat };
  }
  /**
   * (lon,lat)가 (px,py)에 오도록 `cx`·`_globeLat`만 뉴턴으로 맞춤(scale은 그대로).
   */
  _alignGlobePivotToScreen(lon, lat, px, py) {
    for (let i = 0; i < 10; i++) {
      const pr = this.projPerspective(lon, lat);
      if (!pr.visible) break;
      const ex = px - pr.x;
      const ey = py - pr.y;
      if (ex * ex + ey * ey < 0.04) return;
      const eps = 1e-6;
      const ocx = this.cx;
      const oLat = this._globeLat;
      this.cx = ocx + eps;
      const pDx = this.projPerspective(lon, lat);
      this.cx = ocx;
      const j11 = (pDx.x - pr.x) / eps;
      const j21 = (pDx.y - pr.y) / eps;
      this._globeLat = oLat + eps;
      const pDy = this.projPerspective(lon, lat);
      this._globeLat = oLat;
      const j12 = (pDy.x - pr.x) / eps;
      const j22 = (pDy.y - pr.y) / eps;
      const det = j11 * j22 - j12 * j21;
      if (Math.abs(det) < 1e-14) break;
      this.cx += (j22 * ex - j12 * ey) / det;
      this._globeLat += (-j21 * ex + j11 * ey) / det;
      this._globeLat = Math.max(-Math.PI / 2 + 0.01,
        Math.min(Math.PI / 2 - 0.01, this._globeLat));
    }
  }
  /**
   * 지구본: 커서 아래 지점을 고정한 채 축척만 변경(구글 어스류 커서 줌).
   * 머케이터면 `zoomAtScreen`과 동일 동작.
   */
  zoomGlobeAtScreen(px, py, newScale) {
    newScale = this.clampScaleForUserZoom(newScale);
    if (!this.isGlobeView()) {
      this.zoomAtScreen(px, py, newScale);
      return;
    }
    const pick = this.globePickLonLatFromScreen(px, py);
    this.scale = newScale;
    if (pick) this._alignGlobePivotToScreen(pick.lon, pick.lat, px, py);
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
    this.ctx = canvas.getContext("2d", {
      alpha: true,
      // 낮은 지연·합성 비용 힌트(브라우저가 무시할 수 있음)
      desynchronized: true,
    });
    this.ctx.imageSmoothingEnabled = false;
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
    /** 버드뷰 기울기(도). 0 = 평면 정면. >0이면 캔버스를 CSS 3D 원근으로 기울여 오블리크 시점. */
    this._tiltDeg = 0;
    /** true면 ENC 겹침·줌과 무관하게 세계 육지(Natural Earth)를 항상 그림(UI 토글 없음, 기본 false). */
    this.forceWorldLand = false;
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

  /**
   * 그릴 피처용 행 객체를 풀에서 빌려 채워 반환(프레임당 새 객체 할당 제거).
   * `this._rowN`은 `_renderMercator` 시작에서 0으로 되감기므로 프레임마다 재사용된다.
   */
  _acquireRow(feat, ops, prio, cellCscl) {
    const pool = this._rowPool;
    let row = pool[this._rowN];
    if (!row) { row = { feat: null, ops: null, prio: 0, cellCscl: 0 }; pool[this._rowN] = row; }
    row.feat = feat; row.ops = ops; row.prio = prio; row.cellCscl = cellCscl;
    this._rowN++;
    return row;
  }

  /**
   * `_renderMercator` 동안만 설정: Mercator → 화면 선형변환을 vp 체인 없이 적용.
   * `_path`·해치·심볼·텍스트 등 핫패스에서 `sx`/`sy` 호출 비용을 줄인다.
   */
  _sx(mx) {
    const m = this._mercScreen;
    return m ? (mx - m.cx) * m.s + m.hw : this.vp.sx(mx);
  }
  _sy(my) {
    const m = this._mercScreen;
    return m ? m.hh - (my - m.cy) * m.s : this.vp.sy(my);
  }

  catAllowed(cat) {
    const lim = DISPLAY_CAT_RANK[this.minDisplayCat] ?? 2;
    return (DISPLAY_CAT_RANK[cat] ?? 1) <= lim;
  }

  /**
   * declutter ON이고, 이 resolved 항목이 속한 셀이 `cellCscl`로 표기된 개략도이며,
   * 기준점이 더 상세한 겹침 셀의 범위 안이면 true.
   * ECDIS에서 겹침 ENC에 대해 가용한 가장 큰 축척(가장 작은 CSCL) 데이터를 쓰는 처리와 동일한 취지.
   * @param {{ soundings?: boolean }} [opts] — `soundings: true`이면 앵커 대신 bbox 중심만 사용(사운딩 전용).
   */
  _shouldOmitForFinerOverlappingCell(r, opts) {
    if (!this.declutter || r.cellCscl === Infinity || !this._bestCsclAt) return false;
    let cx, cy;
    if (opts && opts.soundings) {
      if (!r.feat._bbox) return false;
      const b = r.feat._bbox;
      cx = (b[0] + b[2]) / 2;
      cy = (b[1] + b[3]) / 2;
    } else {
      const pg = r.feat._pg;
      if (pg && pg.anchor) {
        cx = pg.anchor[0];
        cy = pg.anchor[1];
      } else if (r.feat._bbox) {
        const b = r.feat._bbox;
        cx = (b[0] + b[2]) / 2;
        cy = (b[1] + b[3]) / 2;
      } else {
        return false;
      }
    }
    const best = this._bestCsclAt(cx, cy);
    return best !== Infinity && r.cellCscl > best * CSCL_OVERLAP_TOL;
  }

  /**
   * 겹침 ENC에서 개략 셀의 면·선을 생략할지.
   * bbox **중심만** 보면 큰 DEPARE 등이 상세 셀과 겹치는 구간 밖으로 크게 나갈 때,
   * 그 바깥쪽이 통째로 안 그려져 **셀(M_COVR) 경계에 맞춘 직사각형 구멍·조각**이 된다.
   * 모서리 4점 + 중심에서 모두 “이 셀보다 의미 있게 상세한 데이터가 있다”일 때만 생략한다.
   */
  _supersededByFinerForExtent(r) {
    if (!this.declutter || r.cellCscl === Infinity || !this._bestCsclAt) return false;
    const b = r.feat._bbox;
    if (!b) return false;
    const bestAt = this._bestCsclAt;
    const tol = CSCL_OVERLAP_TOL;
    const pts = [
      [b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]],
      [(b[0] + b[2]) * 0.5, (b[1] + b[3]) * 0.5],
    ];
    for (let i = 0; i < pts.length; i++) {
      const best = bestAt(pts[i][0], pts[i][1]);
      if (best === Infinity) return false;
      if (!(r.cellCscl > best * tol)) return false;
    }
    return true;
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
        if (!feat.geom && !feat.soundings && !feat._hasSoundings) continue;
        m.set(feat.acronym, (m.get(feat.acronym) || 0) + 1);
      }
    }
    return m;
  }

  /** 버드뷰 기울기 설정(도, 0~~70 권장). 즉시 CSS 변환에 반영. */
  setTilt(deg) {
    this._tiltDeg = Math.max(0, Math.min(70, +deg || 0));
    this._applyCanvasTilt();
  }

  /**
   * 버드뷰 — 캔버스 엘리먼트에 CSS 3D 원근 변환을 걸어 차트를 비스듬히 내려다보게 한다.
   * 픽셀 버퍼는 평면 top-down 렌더 그대로이고, GPU가 원근 왜곡만 입히므로 비용이 거의 없다.
   * - globe 모드에서는 항상 0(평면 차트일 때만 의미).
   * - transform-origin은 화면 중심 하단 쪽으로 둬 "앞쪽이 가깝고 위쪽(먼 곳)이 좁아지는" 자연스런 시점.
   * - 기울일수록 위(먼 쪽) 모서리에 빈 삼각형이 생기므로 scale로 살짝 키워 stage를 덮는다.
   */
  _applyCanvasTilt() {
    const c = this.canvas;
    if (!c || !c.style) return;
    const deg = this.vp.isGlobeView() ? 0 : (this._tiltDeg || 0);
    if (!deg) {
      if (c.style.transform) { c.style.transform = ""; c.style.transformOrigin = ""; }
      return;
    }
    const persp = Math.max(700, c.clientHeight * 1.4);
    // 기울기에 따라 빈 영역이 커지므로 scale 보정(최대 ~1.8배).
    const scale = 1 + (deg / 70) * 0.8;
    c.style.transformOrigin = "50% 60%";
    c.style.transform = `perspective(${persp}px) rotateX(${deg}deg) scale(${scale.toFixed(3)})`;
    this._updateBirdviewScenery(deg);
  }

  /**
   * 버드뷰 입체감 보조 레이어(하늘·거리 안개) 제어 — 구글 어스처럼 차트 위로 지평선·
   * 원경 흐림을 그려 "기울어진 종이"가 아니라 "펼쳐진 3D 장면"으로 보이게 한다.
   * 캔버스 자체는 CSS 원근으로 기울고, 하늘/안개는 stage 평면에 고정 오버레이로 둔다.
   */
  _updateBirdviewScenery(deg) {
    const stage = this.canvas && this.canvas.parentElement;
    if (!stage) return;
    const body = document.body;
    const sky = document.getElementById("sky");
    const haze = document.getElementById("haze");
    if (!deg) {
      body.classList.remove("birdview");
      if (sky) sky.style.height = "0px";
      if (haze) haze.style.opacity = "0";
      return;
    }
    body.classList.add("birdview");
    const h = stage.clientHeight || this.canvas.clientHeight || 0;
    // 기울수록 지평선이 내려오며 하늘이 넓어짐(최대 화면 높이의 ~42%).
    const skyH = Math.round(h * (deg / 60) * 0.42);
    if (sky) sky.style.height = `${skyH}px`;
    // 안개도 기울기에 비례해 진해짐.
    if (haze) haze.style.opacity = (0.35 + (deg / 60) * 0.65).toFixed(2);
  }

  render() {
    // 축척만 바뀌고 syncAutoMode가 빠지는 경로(초기 fit, 터치 핀치 등)에서도
    // 자동 지구본 전환이 되도록 매 프레임 동기화(비용은 비교·분기 수준).
    // auto3D가 꺼져 있어도 호출해야 함: globe 모드일 때 지구 디스크 최소 반지름 보정(§Viewport.syncAutoMode).
    this.vp.syncAutoMode();
    // 버드뷰 기울기를 캔버스 CSS 변환으로 적용(globe 모드면 자동으로 0 리셋).
    this._applyCanvasTilt();
    // ── 모드 전환 크로스페이드 ──
    // Globe ↔ Mercator 모드 전환 시 두 모드를 짧게 동시 렌더해 알파 교차로 부드럽게 연결.
    // 단순한 mode flip의 시각적 점프를 시간축에서 흩어 줘 자연스럽게 보이게 한다.
    const tr = this.vp._modeTransition;
    if (tr) {
      const now = performance.now();
      const elapsed = now - tr.startTime;
      if (elapsed >= tr.duration) {
        this.vp._modeTransition = null;
        // 정상 렌더 진행
      } else {
        const t = elapsed / tr.duration;
        const easedT = t * t * (3 - 2 * t); // smoothstep
        const ctx0 = this.ctx;
        const w0 = this.canvas.width, h0 = this.canvas.height;
        if (this.tileMode) {
          ctx0.clearRect(0, 0, w0, h0); // 타일 모드: 투명 비움 → globe가 아래 OL 타일로 디졸브
        } else {
          ctx0.fillStyle = "#000";
          ctx0.fillRect(0, 0, w0, h0);
        }
        // 나가는 모드(이전 mode 상태로 일시 복원)
        const curMode = this.vp.mode;
        ctx0.save();
        ctx0.globalAlpha = 1 - easedT;
        this.vp.mode = tr.from;
        if (tr.from === "globe") this._renderGlobe(); else this._renderMercator();
        ctx0.restore();
        // 들어오는 모드
        ctx0.save();
        ctx0.globalAlpha = easedT;
        this.vp.mode = tr.to;
        if (tr.to === "globe") this._renderGlobe(); else this._renderMercator();
        ctx0.restore();
        this.vp.mode = curMode;
        // 다음 프레임 예약
        if (typeof this.onTransitionFrame === "function") this.onTransitionFrame();
        return;
      }
    }
    // 3D 지구본 모드는 별도 경로로 그린다(머케이터 파이프라인을 우회).
    if (this.vp.isGlobeView()) { this._renderGlobe(); return; }
    this._renderMercator();
  }

  _renderMercator() {
    const ctx = this.ctx, vp = this.vp;
    const w = this.canvas.width, h = this.canvas.height;
    // 타일 모드: 평면 차트는 캔버스 아래의 OL 서버타일이 표시한다. 무거운 벡터 패스(면·선·
    // 심볼·텍스트)를 전부 건너뛰고 캔버스를 투명하게 비워 OL이 비쳐 보이게 한다. 전환 중에는
    // render()의 cross-fade가 이미 캔버스를 비웠으므로 다시 비우지 않는다(globe 알파를 지우지 않게).
    // 지구본(_renderGlobe)은 이 분기와 무관 — 기존대로 벡터로 그려진다.
    if (this.tileMode) {
      if (!vp._modeTransition) ctx.clearRect(0, 0, w, h);
      this.lastStats = { drawn: 0, culled: 0, denom: Math.round(vp.scaleDenominator()) };
      this._mercScreen = null;
      return;
    }
    this._mercScreen = { s: vp.scale, cx: vp.cx, cy: vp.cy, hw: w * 0.5, hh: h * 0.5 };
    ctx.fillStyle = this.s52.color("DEPDW");
    ctx.fillRect(0, 0, w, h);

    this._labelBoxes = [];
    /** 통항·조류 방향 화살표 디클러터: 버킷(28 px 격자) → 해당 버킷에 배치된 점들의 [x,y,...] */
    this._flowArrowGrid = new Map();
    this._pointSymbolGrid = new Map();
    this._hazardSymbolGrid = new Map();
    this._textDedupGrid = new Map();
    this._soundingGrid = new Map();
    const denom = vp.scaleDenominator();
    this._symbolDeclutterDenom = denom;
    // 소축척(축소)일수록 항행보조·수심 점표시를 더 듬성하게 솎는 간격(px). 상세 줌에선 기존값/0.
    this._navaidDedupPx = navaidDedupPx(denom);
    this._soundingDedupPx = this.declutter ? soundingDedupPx(denom) : 0;
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
    const PRIO_BUCKETS = 12;
    const buckets = new Array(PRIO_BUCKETS);
    for (let i = 0; i < PRIO_BUCKETS; i++) buckets[i] = [];
    // 그릴 피처마다 만들던 행 객체({feat,ops,prio,cellCscl})를 프레임 간 재사용하는 풀로
    // 대체한다(프레임당 수천 개 할당 → 0). 행은 같은 render() 안에서만 참조되고 다음
    // 프레임 시작에 인덱스를 0으로 되감아 재사용하므로 프레임 경계를 넘는 참조가 없다.
    if (!this._rowPool) this._rowPool = [];
    this._rowN = 0;
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
        // _hasSoundings: projectFeature가 feat.soundings를 null로 비운 뒤에도 사운딩
        // 보유 피처를 통과시키기 위한 영속 플래그(미투영 첫 프레임은 feat.soundings로 판정).
        if (!feat.geom && !feat.soundings && !feat._hasSoundings) continue;
        if (this.hiddenClasses.has(feat.acronym)) continue; // per-object-class toggle
        // 투영(캐시)한 뒤 화면 밖/서브픽셀 피처를 먼저 컬링한다. 줌인 시 대다수 피처가
        // 화면 밖이므로, 비싼 심볼 해석·SCAMIN·표시범주 판정을 그만큼 건너뛴다.
        // (워커가 적재 시 이미 투영해 두므로 _prep는 보통 no-op. 모든 필터는 AND라
        //  순서를 바꿔도 실제로 그려지는 피처 집합은 동일하다.)
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
        if (!this.showGrid && isEncBoundaryFeat(feat)) continue;
        if (this.respectScamin) {
          if (feat._scaminN === undefined) {
            const raw = feat.attrs && feat.attrs.SCAMIN;
            const sc = raw != null && raw !== "" ? parseFloat(raw) : NaN;
            feat._scaminN = Number.isNaN(sc) ? null : sc;
          }
          if (feat._scamaxN === undefined) {
            const rawX = feat.attrs && feat.attrs.SCAMAX;
            const sx = rawX != null && rawX !== "" ? parseFloat(rawX) : NaN;
            feat._scamaxN = Number.isNaN(sx) ? null : sx;
          }
          const scn = feat._scaminN;
          if (scn != null && denom > scn) continue;
          // S-57 SCAMAX: 표시 분모가 이 값보다 작으면(더 확대) 객체를 표시하지 않음.
          const scx = feat._scamaxN;
          if (scx != null && denom < scx) continue;
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
        // DEPCNT·선형 DEPARE는 PL상 display-cat이 Other인데, 실무·ECDIS 관행상
        // Standard 묶음에서도 수심 등고선을 기대하므로 표시 범주만 Standard로 본다.
        const displayCatForFilter = depthContourStandardDisplay(feat)
          ? "Standard"
          : res.displayCat;
        if (!feat.soundings && !feat._hasSoundings && !this.catAllowed(displayCatForFilter) && !encBoundaryWithGrid) continue;
        drawn++;
        const bucket = buckets[res.prio < PRIO_BUCKETS ? res.prio : PRIO_BUCKETS - 1];
        bucket.push(this._acquireRow(feat, res.ops, res.prio, cscl || Infinity));
      }
    }
    const resolved = [];
    for (let pi = 0; pi < PRIO_BUCKETS; pi++) {
      const b = buckets[pi];
      // 같은 표시우선순위 안에서는 개략 셀(큰 CSCL)을 먼저, 상세 셀(작은 CSCL)을 나중에 그려
      // 상세 셀의 정밀 해안선·면이 개략 셀의 단순화된 면 위에 얹히도록 한다(직선 가장자리 해소).
      // 안정 정렬이라 CSCL이 같으면 원래(셀 로드) 순서 유지.
      b.sort((p, q) => (p.cellCscl === q.cellCscl ? 0 : q.cellCscl - p.cellCscl));
      for (let j = 0; j < b.length; j++) resolved.push(b[j]);
    }

    // 점 심볼/사운딩/선(LS)용 셀 우선순위 인덱스 — 같은 위치를 여러 축척 셀이 덮을 때
    // 가장 상세한 셀을 기준으로 개략 셀의 중복 표시를 줄인다.
    this._bestCsclAt = this._buildCsclLookup(denom, winMinX, winMaxX, winMinY, winMaxY);

    // pass 1: area fills
    const drawAreaOps = (r) => {
      const pg = r.feat._pg;
      if (!pg || pg.type !== "Area") return;
      for (const op of r.ops) {
        if (op.op === "AC") {
          this._fillArea(pg.rings, op.color, 1);
        } else if (op.op === "AP") this._fillArea(pg.rings, op.color, 0.12);
        else if (op.op === "AP_ACHARE") this._fillAchareHatch(pg.rings);
      }
    };
    /** CSCL 미부여 셀은 정렬 시 가장 거친 것으로 취급(상세 셀 LNDARE가 위에 오도록). */
    const csclSortKey = (r) => (r.cellCscl === Infinity ? 1e18 : r.cellCscl);
    // pass 1: 면 채움 — 육지(LNDARE)와 바다(DEPARE 등)를 **한 목록에서 CSCL 거친→상세 순**으로
    // 통합해 칠한다. 이렇게 해야 상세 셀의 면(육지든 바다든)이 개략 셀의 단순화된 면 위에 얹혀,
    // 개략 셀 육지가 상세 셀 바다를 직선으로 덮던 "뭉툭한 해안선"이 사라진다.
    //  - supersededByFiner로 면을 생략하지 않는다(개략 면을 밑바탕으로 깔아 빈틈/구멍 방지).
    //    겹쳐 그리는 오버드로가 늘지만, 상세 데이터가 항상 위에 와 해안선이 정확해진다.
    //  - 같은 셀 안에서 육지·바다는 서로 겹치지 않으므로 순서 영향 없음.
    const areaRows = [];
    for (const r of resolved) {
      if (isEncBoundaryFeat(r.feat)) continue;
      const pg = r.feat._pg;
      if (!pg || pg.type !== "Area") continue;
      areaRows.push(r);
    }
    areaRows.sort((a, b) => csclSortKey(b) - csclSortKey(a));
    // 모든 면을 개략(큰 CSCL)→상세(작은 CSCL) 순으로 빠짐없이 칠한다. 상세 셀 면이 항상 위에
    // 얹혀 일관된다. (이전엔 "상세에 완전히 덮인 개략 바다 면 생략" 최적화를 넣었으나, 그 판정이
    // 폴리곤 단위라 셀 경계에서 수심 면이 보이다 말다 하는 격자 불일치를 만들어 제거함.)
    for (const r of areaRows) {
      drawAreaOps(r);
    }
    // pass 2: lines — batched by style so thousands of features stroke in a
    // handful of draw calls instead of one beginPath/stroke each.
    const lineGroups = new Map(); // "color|width|style" -> {op, rings:[...]}
    const chblkRgb = this.s52.color("CHBLK");
    for (const r of resolved) {
      if (isEncBoundaryFeat(r.feat)) continue; // M_COVR/M_CSCL: 검정 윤곽 제거
      // 개략 셀의 거친 선 생략 판정.
      //  - 일반 선: bbox 전 구간이 상세 셀에 덮일 때만 생략(보수적 — 빈틈 방지).
      //  - 해안선(COALNE/SLCONS 등): 한 점(앵커/중심) 기준으로도 더 상세한 셀이 그 위치를 덮으면
      //    생략. 상세 해안선이 있는 곳에 개략 셀의 직선 해안선이 겹쳐 그어지던 문제를 없앤다.
      const omit = isCoastlineLineForOverlap(r)
        ? this._shouldOmitForFinerOverlappingCell(r)
        : this._supersededByFinerForExtent(r);
      if (omit) continue;
      const pg = r.feat._pg;
      if (!pg || pg.type === "Point") continue;
      for (const op of r.ops) {
        if (op.op !== "LS") continue;
        if (isMnsysFeat(r.feat) && op.color === chblkRgb) continue;
        // 스타일 그룹 키는 op이 불변(해석 시 1회 생성·캐시)이라 op에 한 번만 만들어 둔다.
        let key = op._lsKey;
        if (key === undefined) key = op._lsKey = op.color + "|" + (op.width || 1) + "|" + (op.style || "");
        let grp = lineGroups.get(key);
        if (!grp) { grp = { op, rings: [] }; lineGroups.set(key, grp); }
        for (const ring of pg.rings) grp.rings.push(ring);
      }
    }
    for (const grp of lineGroups.values()) this._strokePolys(grp.rings, grp.op);
    // pass 3: point symbols, soundings, text
    // 점 심볼(SY)은 `_shouldOmitForFinerOverlappingCell`(앵커). LS는 패스 2에서 bbox 다점 기준 생략.
    // SOUNDG는 bbox 한 점 필터를 쓰지 않음 — 광역 셀 사운딩이 통째 사라지는 것을 방지.
    // 빠른 상호작용(줌·이동) 중에도 심볼·텍스트(지명·라벨)는 유지하고, 가장 수가 많아 비싼
    // 수심 숫자(SOUNDG)만 _fastMode일 때 잠깐 생략한다(멈추면 전체 디테일로 다시 그림).
    for (const r of resolved) {
      for (const op of r.ops) {
        if (op.op === "SY") {
          if (this._shouldOmitForFinerOverlappingCell(r)) continue;
          this._symbolFeature(r.feat, op.sym, op.rot);
        } else if (op.op === "SOUNDG" && this.showSoundings && !this._fastMode) {
          this._soundings(r.feat);
        } else if (op.op === "TX" && this.showText) {
          // 텍스트는 셀 우선순위 필터(CSCL)를 적용하지 않는다 — 셀마다 서로 다른 라벨
          // (개략도 "동해" vs 상세 "동해항 X부두")이 의도되며, 위치별 최상세 셀만
          // 그릴 경우 개략도 라벨이 잘려 정보가 거의 안 보이게 됨.
          // 진짜 중복은 텍스트 문자열+위치 spatial dedup이 제거.
          if (this.declutter) {
            const a = r.feat._pg && r.feat._pg.anchor;
            if (a && op.text) {
              const sx = this._sx(a[0]), sy = this._sy(a[1]);
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
    this._mercScreen = null;
  }

  // --- fast pan: snapshot the last full frame, then blit it translated while
  // the user drags, deferring the (expensive) full re-render until they stop.
  beginPan() { this.beginViewSnapshot(); }

  /** 현재 캔버스와 그 시점의 뷰(scale·cx·cy)를 스냅샷에 저장 — 팬/줌 프리뷰 블릿의 기준 프레임. */
  beginViewSnapshot() {
    if (!this._snap) this._snap = document.createElement("canvas");
    this._snap.width = this.canvas.width;
    this._snap.height = this.canvas.height;
    this._snap.getContext("2d").drawImage(this.canvas, 0, 0);
    const vp = this.vp;
    this._snapView = { scale: vp.scale, cx: vp.cx, cy: vp.cy };
  }
  /** 팬 캐시 여백 배율 — 뷰포트보다 이만큼 크게 풀 렌더해 두고, 이동은 블릿만(게임 미니맵 방식).
   * 2.0 = 각 변 50% 여백. 이 여백 안의 이동은 블릿만, 벗어나면 한 번 다시 굽는다(유휴 예열로 숨김). */
  _PAN_CACHE_MARGIN = 2.0;

  /**
   * 현재 줌의 차트를 **뷰포트보다 큰 오프스크린**에 풀 디테일로 한 번 렌더해 캐시한다.
   * 큰 면 폴리곤도 한 번만 그리므로(타일 분할은 폴리곤을 타일마다 재그려 더 느림) 이 방식이 유리.
   * 렌더 타깃을 잠시 오프스크린으로 바꿔 `_renderMercator`를 그대로 재사용한다(스왑 후 복원).
   */
  _buildPanCache() {
    const vp = this.vp;
    const w = this.canvas.width, h = this.canvas.height;
    if (w < 2 || h < 2) return;
    const M = this._PAN_CACHE_MARGIN;
    const OW = Math.round(w * M), OH = Math.round(h * M);
    if (!this._panCache) this._panCache = document.createElement("canvas");
    const oc = this._panCache;
    if (oc.width !== OW || oc.height !== OH) { oc.width = OW; oc.height = OH; }
    const octx = oc.getContext("2d");
    octx.imageSmoothingEnabled = false;
    const realCanvas = this.canvas, realCtx = this.ctx, realStats = this.lastStats;
    this.canvas = oc; this.ctx = octx; vp.canvas = oc;
    try { this._renderMercator(); }
    finally { this.canvas = realCanvas; this.ctx = realCtx; vp.canvas = realCanvas; this.lastStats = realStats; }
    this._panCacheView = { cx: vp.cx, cy: vp.cy, scale: vp.scale, ow: OW, oh: OH };
  }

  /** 현재 뷰가 팬 캐시로 덮이는지(같은 줌 + 여백 안). 아니면 다시 구워야 함. */
  _panCacheCovers() {
    const v = this._panCacheView, vp = this.vp;
    if (!v || !this._panCache) return false;
    if (Math.abs(v.scale - vp.scale) > vp.scale * 1e-4) return false;
    const w = this.canvas.width, h = this.canvas.height;
    if (v.ow !== Math.round(w * this._PAN_CACHE_MARGIN)) return false;
    if (Math.abs((v.cx - vp.cx) * vp.scale) > (v.ow - w) / 2 - 1) return false;
    if (Math.abs((vp.cy - v.cy) * vp.scale) > (v.oh - h) / 2 - 1) return false;
    return true;
  }

  previewPan() {
    if (this.vp.isGlobeView()) { this.render(); return; }
    // 타일 모드: 평면 팬은 아래 OL 타일이 처리 → 캔버스는 투명 유지(불투명 배경으로 OL 가리지 않게)
    if (this.tileMode) { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); return; }
    if (!this._panCacheCovers()) this._buildPanCache();
    const ctx = this.ctx, vp = this.vp, v = this._panCacheView;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.fillStyle = this.s52.color("DEPDW");
    ctx.fillRect(0, 0, w, h);
    if (!v) return;
    const dx = Math.round((w - v.ow) / 2 + (v.cx - vp.cx) * vp.scale);
    const dy = Math.round((h - v.oh) / 2 + (vp.cy - v.cy) * vp.scale);
    ctx.drawImage(this._panCache, dx, dy);
  }

  /** 현재 뷰가 팬 캐시 여백의 절반 이상을 남기고 덮이는지 — 그러면 재빌드 불필요(freeze 회피). */
  _panCacheComfortable() {
    const v = this._panCacheView, vp = this.vp;
    if (!v || !this._panCache) return false;
    if (Math.abs(v.scale - vp.scale) > vp.scale * 1e-4) return false;
    const w = this.canvas.width, h = this.canvas.height;
    if (v.ow !== Math.round(w * this._PAN_CACHE_MARGIN)) return false;
    const driftX = Math.abs((v.cx - vp.cx) * vp.scale);
    const driftY = Math.abs((vp.cy - v.cy) * vp.scale);
    const maxX = (v.ow - w) / 2, maxY = (v.oh - h) / 2;
    return driftX < maxX * 0.5 && driftY < maxY * 0.5;
  }

  /** 정착 직후 유휴 시 — 다음 이동이 즉시 매끄럽도록 현재 뷰 기준 팬 캐시를 미리 구워 둔다.
   * 단, 여백이 절반 이상 남아 있으면(대부분의 짧은 이동) 재빌드를 건너뛰어 release 직후 freeze를 없앤다.
   * 캐시가 여백 가장자리에 가까워졌을 때만 한 번 다시 굽는다(드물게). */
  warmPanCache() {
    if (this.vp.isGlobeView()) return;
    if (this._panCacheComfortable()) return;
    this._buildPanCache();
  }

  /**
   * 패닝 프리뷰용 저비용 배경: 개략 셀(큰 CSCL)의 **면 채움(AC)만** 현재 뷰포트에 그린다.
   * 드래그로 드러난 영역이 빈(바다색) 채로 남지 않게 개략 바다·육지로 채우는 용도라, 선·심볼·
   * 사운딩·텍스트는 생략한다. (호출 측에서 `_mercScreen`을 설정해 둔다.)
   */
  _drawCoarseAreaBackdrop(winMinX, winMaxX, winMinY, winMaxY) {
    const table = this.s52.currentTable;
    const COARSE = 400000; // 1:400k 이상(개략 밴드)만 — 적고 넓어 저비용
    for (const cell of this.cells.values()) {
      if (!cell.visible || !cell.loaded || !cell.features) continue;
      const cscl = cell.bounds && cell.bounds.cscl;
      if (!cscl || cscl < COARSE) continue; // 상세 셀은 스냅샷이 덮으므로 제외
      const cmb = this._cellMercBbox(cell);
      if (cmb && (cmb[1] < winMinX || cmb[0] > winMaxX || cmb[3] < winMinY || cmb[2] > winMaxY)) continue;
      for (const feat of cell.features) {
        if (!feat.geom || isEncBoundaryFeat(feat)) continue;
        this._prep(feat);
        const pg = feat._pg;
        if (!pg || pg.type !== "Area") continue;
        const b = feat._bbox;
        if (b && (b[2] < winMinX || b[0] > winMaxX || b[3] < winMinY || b[1] > winMaxY)) continue;
        if (feat._resTable !== table) {
          const r = this.s52.resolve(feat, "Simplified");
          feat._res = { ops: r.ops, displayCat: r.displayCat, prio: prioIndex(r.dispPrio) };
          feat._resTable = table;
        }
        const ops = feat._res.ops;
        for (let i = 0; i < ops.length; i++) {
          if (ops[i].op === "AC") this._fillArea(pg.rings, ops[i].color, 1);
        }
      }
    }
  }

  /**
   * 줌(또는 팬+줌) 프리뷰: 스냅샷을 찍은 시점의 뷰와 현재 뷰의 차이를 균일 확대(k)+평행이동(tx,ty)
   * affine으로 계산해 스냅샷을 현재 뷰포트에 맞춰 한 번만 블릿한다. 매 프레임 벡터를 다시 그리지
   * 않아 슬리피맵처럼 줌이 즉각 매끄럽고, 멈추면 호출 측이 풀 렌더로 선명하게 마무리한다.
   * 머케이터 전용(globe·모드 전환 중에는 호출 측이 풀 렌더로 우회). 포커스 픽셀은 `zoomAtScreen`과
   * 동일하게 고정된다(유도: current = k·snap + [w/2·(1-k) + (snapCx-cx)·scale]).
   */
  previewFromSnapshot() {
    const sv = this._snapView;
    if (!sv || !this._snap) return false;
    const vp = this.vp;
    const w = this.canvas.width, h = this.canvas.height;
    // 타일 모드: 평면 줌은 아래 OL 타일이 처리 → 캔버스 투명 유지(true 반환해 풀렌더 폴백 방지)
    if (this.tileMode) { this.ctx.clearRect(0, 0, w, h); return true; }
    const k = vp.scale / sv.scale;
    const tx = w * 0.5 * (1 - k) + (sv.cx - vp.cx) * vp.scale;
    const ty = h * 0.5 * (1 - k) - (sv.cy - vp.cy) * vp.scale;
    const ctx = this.ctx;
    ctx.fillStyle = this.s52.color("DEPDW");
    ctx.fillRect(0, 0, w, h);
    // 축소(k<1)는 스냅샷이 캔버스를 못 덮어 가장자리에 여백이 생긴다 — 풀 렌더(느림) 대신
    // 개략 면 채움(+세계 육지)을 저비용으로 깔아 채운다. 확대(k≥1)는 스냅샷이 캔버스를 덮어 불필요.
    if (k < 1) {
      this._mercScreen = { s: vp.scale, cx: vp.cx, cy: vp.cy, hw: w * 0.5, hh: h * 0.5 };
      const halfW = (w / 2) / vp.scale * 1.05, halfH = (h / 2) / vp.scale * 1.05;
      this._drawMercatorWorldOverlay(vp.cx - halfW, vp.cx + halfW, vp.cy - halfH, vp.cy + halfH);
      this._drawCoarseAreaBackdrop(vp.cx - halfW, vp.cx + halfW, vp.cy - halfH, vp.cy + halfH);
      this._mercScreen = null;
    }
    const prevSmooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true; // 줌 스케일 블릿은 부드럽게(최종 풀 렌더에서 선명 복원)
    ctx.drawImage(this._snap, 0, 0, w, h, tx, ty, w * k, h * k);
    ctx.imageSmoothingEnabled = prevSmooth;
    return true;
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

    // 대기 글로우 — 구체 림 바깥쪽에 부드러운 푸른 빛(2D 머케이터의 DEPDW 색조에 맞춤)
    const oceanColor = this.s52.color("DEPDW");
    const oceanRgb = parseRgbColor(oceanColor) || [115, 182, 239];
    const [or, og, ob] = oceanRgb;
    const glow = ctx.createRadialGradient(cx, cy, R * 0.98, cx, cy, R * 1.18);
    glow.addColorStop(0, `rgba(${or},${og},${ob},0.55)`);
    glow.addColorStop(0.5, `rgba(${or},${og},${ob},0.22)`);
    glow.addColorStop(1, `rgba(${or},${og},${ob},0)`);
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.18, 0, Math.PI * 2); ctx.fill();

    // 구체 디스크 — **2D 머케이터와 동일한 S-52 DEPDW 색**으로 두 모드 간 색 이질감 제거.
    // 단색 채움(방사 그라데이션은 정지점 띠가 보이기 쉬워 피함). 림 부근 푸른 톤은 위 글로우가 담당.
    ctx.fillStyle = oceanColor;
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
   * 현재 머케이터 뷰 창과 겹치는 **표시 중 ENC 셀**이 있는지(메인 루프와 동일한 셀 필터).
   * 있으면 Natural Earth와 ENC를 동시에 쓰지 않기 위해 개략 육지를 끈다.
   */
  _mercViewportIntersectsDisplayedEncCell(winMinX, winMaxX, winMinY, winMaxY) {
    const denom = this.vp.scaleDenominator();
    for (const cell of this.cells.values()) {
      if (!cell.visible || !cell.loaded || !cell.features) continue;
      const cscl = cell.bounds && cell.bounds.cscl;
      if (this.scaleDisplay && cscl && denom > cscl * this.scaleOutFactor) continue;
      const cmb = this._cellMercBbox(cell);
      if (!cmb) continue;
      if (cmb[1] < winMinX || cmb[0] > winMaxX || cmb[3] < winMinY || cmb[2] > winMaxY) continue;
      return true;
    }
    return false;
  }

  /**
   * Natural Earth 110m 개략 육지/국경을 **ENC 아래 배경**으로 그릴지.
   * 축소 뷰에서는 항상 그린다 — ENC가 적재 안 됐거나 커버하지 않는 영역이 빈(잘린) 채로
   * 남지 않도록 세계 육지가 빈틈을 채운다. ENC 면(DEPARE 바다·LNDARE 육지)이 그 위에 덮이므로
   * ENC가 있는 곳에서는 세계 육지가 보이지 않는다.
   * (이전엔 'ENC가 뷰와 겹치면 끔(배타)' + 'denom 임계 미만이면 끔'이라, 일부만 적재된 광역
   *  뷰에서 미커버 영역이 통째 비어 보이는 문제가 있었다.)
   * 충분히 확대(scale>30000)되면 ENC가 화면을 채우므로 끈다.
   */
  _shouldDrawNaturalEarthWorldLand(winMinX, winMaxX, winMinY, winMaxY) {
    if (this.forceWorldLand) return true;
    return this.vp.scale <= 30000;
  }

  /**
   * 머케이터에서 세계 대륙(채움) + 국경(라인)을 그린다.
   * - 폴리곤별 mercator bbox는 한 번만 계산해 캐시되어, 매 프레임 컬링은 단순 비교 4번.
   * - 매우 축소·확대된 경우 화면 밖 폴리곤은 통째 스킵 → 한국 줌에서 아프리카·남미 등 무관 폴리곤 제거.
   * - `_shouldDrawNaturalEarthWorldLand` false면 생략 — 뷰에 ENC가 있으면 개략 지도와 배타.
   */
  _drawMercatorWorldOverlay(winMinX, winMaxX, winMinY, winMaxY) {
    if (!this._shouldDrawNaturalEarthWorldLand(winMinX, winMaxX, winMinY, winMaxY)) return;
    this._ensureWorldLand();
    this._prepWorldLandMerc();
    this._prepWorldCountriesMerc();
    const ctx = this.ctx;
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
          ctx.moveTo(this._sx(flat[0]), this._sy(flat[1]));
          for (let i = 2; i < n; i += 2) ctx.lineTo(this._sx(flat[i]), this._sy(flat[i + 1]));
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
          ctx.moveTo(this._sx(flat[0]), this._sy(flat[1]));
          for (let i = 2; i < n; i += 2) ctx.lineTo(this._sx(flat[i]), this._sy(flat[i + 1]));
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
    // 보간점에는 onLimb=true 플래그를 명시 — 정규화 후 z가 limbCos에서 미세하게 어긋나도
    // 다운스트림 `_appendGlobeFillRing`이 림 호로 연결할지 직선으로 연결할지 정확히 판정 가능.
    const inter = (A, B) => {
      const dz = B.z - A.z;
      if (Math.abs(dz) < 1e-11) return null;
      const t = (limbCos - A.z) / dz;
      if (t < -1e-7 || t > 1 + 1e-7) return null;
      const x = A.x + t * (B.x - A.x);
      const y = A.y + t * (B.y - A.y);
      const z = A.z + t * (B.z - A.z);
      const L = Math.hypot(x, y, z) || 1e-9;
      return { x: x / L, y: y / L, z: z / L, onLimb: true };
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
   * globe **면 채움**: 반구 클립 후 화면 폴리곤.
   * 림 위에 놓인 두 인접 정점(폴리곤이 지평선을 가로지를 때 클립이 만든 점)은
   * 화면 직선(chord)이 아니라 **림 원호(arc)** 로 연결해 채움이 디스크 안쪽으로
   * 부풀어 바다 영역까지 노란색으로 덮는 잔상을 막는다.
   */
  _appendGlobeFillRing(ctx, ring) {
    const vp = this.vp;
    const raw = this._ringLonLatToViewVerts(vp, ring);
    if (!raw) return;
    const clipped = this._clipViewRingToGlobeFront(vp, raw);
    if (!clipped) return;
    // 림 정점 판정: 클립 단계에서 보간으로 만들어진 점에만 onLimb=true 플래그가 있음.
    // (z를 비교하면 단위구면 재정규화로 인한 미세 오차로 검출이 빠진다.)
    const onLimb = (v) => v.onLimb === true;
    const cx = vp.canvas.width / 2, cy = vp.canvas.height / 2;
    const limbR = vp.globeRadius();
    const angleOf = (v) => {
      const p = this._viewUnitToGlobeScreen(vp, v);
      return Math.atan2(p.y - cy, p.x - cx);
    };
    /** prev → cur 한 구간을 패스에 추가: 둘 다 림 점이면 림 호, 아니면 직선. */
    const stepTo = (prev, cur) => {
      if (onLimb(prev) && onLimb(cur)) {
        const a1 = angleOf(prev);
        const a2 = angleOf(cur);
        let dA = a2 - a1;
        while (dA > Math.PI) dA -= 2 * Math.PI;
        while (dA < -Math.PI) dA += 2 * Math.PI;
        ctx.arc(cx, cy, limbR, a1, a1 + dA, dA < 0);
      } else {
        const p = this._viewUnitToGlobeScreen(vp, cur);
        ctx.lineTo(p.x, p.y);
      }
    };
    const p0 = this._viewUnitToGlobeScreen(vp, clipped[0]);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < clipped.length; i++) {
      stepTo(clipped[i - 1], clipped[i]);
    }
    // ── 닫힘 간선도 같은 규칙 적용 ──
    // closePath()는 항상 직선으로 마지막→첫 정점을 연결한다. 폴리곤이 림 위에서 시작·끝나면
    // 그 직선이 디스크를 가로질러 노란색 사선이 된다. 직접 stepTo로 연결한 뒤 closePath.
    stepTo(clipped[clipped.length - 1], clipped[0]);
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
    const focus = this.gridFocusName;
    /** 머케이터 셀 격자(`_drawGridCell`)와 동일한 축척 밴드색 — 3D에서도 셀 구분이 되도록 */
    const strokeCellLayers = (cell, layers) => {
      const b = cell.bounds;
      if (!b || b.maxX === undefined) return;
      const pts = [];
      const N = 4;
      for (let i = 0; i <= N; i++) pts.push([b.minX + (b.maxX - b.minX) * i / N, b.minY]);
      for (let i = 1; i <= N; i++) pts.push([b.maxX, b.minY + (b.maxY - b.minY) * i / N]);
      for (let i = 1; i <= N; i++) pts.push([b.maxX - (b.maxX - b.minX) * i / N, b.maxY]);
      for (let i = 1; i < N; i++) pts.push([b.minX, b.maxY - (b.maxY - b.minY) * i / N]);

      const projs = [];
      let allVisible = true;
      for (const [lonDeg, latDeg] of pts) {
        const p = vp.projOrtho(lonDeg * Math.PI / 180, latDeg * Math.PI / 180);
        if (!p.visible) { allVisible = false; break; }
        projs.push(p);
      }
      if (!allVisible) return;
      for (const { strokeStyle, lineWidth } of layers) {
        ctx.beginPath();
        ctx.moveTo(projs[0].x, projs[0].y);
        for (let i = 1; i < projs.length; i++) ctx.lineTo(projs[i].x, projs[i].y);
        ctx.closePath();
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = lineWidth;
        ctx.setLineDash(EMPTY_DASH);
        ctx.stroke();
      }
    };

    for (const cell of this.cells.values()) {
      if (focus && cell.name === focus) continue;
      const name = cell.name || "";
      const col = BAND_COLORS[bandOf(name)] || "rgba(140,148,168,0.88)";
      const visible = cell.visible && cell.loaded;
      const dim = col.replace(/[\d.]+\)$/, "0.34)");
      strokeCellLayers(cell, [{
        strokeStyle: visible ? col : dim,
        lineWidth: visible ? 1.65 : 1.05,
      }]);
    }
    if (focus) {
      const cell = this.cells.get(focus);
      if (cell) {
        const col = BAND_COLORS[bandOf(focus)] || "rgba(140,148,168,0.88)";
        strokeCellLayers(cell, [
          { strokeStyle: "rgba(255,255,255,0.92)", lineWidth: 3.2 },
          { strokeStyle: col, lineWidth: 2.05 },
        ]);
      }
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
    const ctx = this.ctx;
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
      const x = this._sx(mercX(L));
      const y0 = this._sy(winMinY), y1 = this._sy(winMaxY);
      this._strokeGraticuleSegment(ctx, x, y0, x, y1);
      if (i % lonLabelEvery === 0) {
        const lab = this._formatLonLabel(L, lonStep);
        this._drawGraticuleLabel(ctx, lab, x, h - 2, "bottom");
      }
    }

    for (let i = 0; i < latVisible.length; i++) {
      const La = latVisible[i];
      const y = this._sy(mercY(La));
      const x0 = this._sx(winMinX), x1 = this._sx(winMaxX);
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
    let sx0 = Infinity;
    let sy0 = Infinity;
    let sx1 = -Infinity;
    let sy1 = -Infinity;
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i += 2) {
        const px = this._sx(ring[i]);
        const py = this._sy(ring[i + 1]);
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
   * 더 상세한 셀이 같은 위치를 덮으면 개략 셀의 점 심볼·사운딩·**선(LS)** 을 생략하는
   * 겹침 ENC 처리(IHO S-52/ECDIS: 해당 구간의 가장 큰 축척 데이터 우선)에 쓴다.
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
    for (const ring of rings) this._path(ring, MIN_SEG2_STROKE);
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

  // Build a path, decimating vertices that land within sqrt(minSeg2) px of the
  // previous one (invisible detail). The final vertex is always emitted so
  // rings stay closed. `minSeg2` defaults to MIN_SEG2 (면용); LS는 `_strokePolys`에서 더 촘촘히.
  // arr: flat Float64Array [x0,y0,x1,y1,…] in Mercator units.
  _path(arr, minSeg2 = MIN_SEG2) {
    const ctx = this.ctx;
    const n = arr.length;
    const m = this._mercScreen;
    // 핫패스: Mercator→화면 선형변환을 정점 루프 안에 인라인(메서드 호출/속성 조회 제거).
    // `_sx`/`_sy`의 빠른 경로와 동일한 수식이라 결과 픽셀은 비트 단위로 같다.
    if (m) {
      const s = m.s, mcx = m.cx, mcy = m.cy, hw = m.hw, hh = m.hh;
      let lx = (arr[0] - mcx) * s + hw, ly = hh - (arr[1] - mcy) * s;
      ctx.moveTo(lx, ly);
      for (let i = 2; i < n; i += 2) {
        const x = (arr[i] - mcx) * s + hw, y = hh - (arr[i + 1] - mcy) * s;
        const dx = x - lx, dy = y - ly;
        if (i === n - 2 || dx * dx + dy * dy >= minSeg2) {
          ctx.lineTo(x, y);
          lx = x; ly = y;
        }
      }
      return;
    }
    let lx = this._sx(arr[0]), ly = this._sy(arr[1]);
    ctx.moveTo(lx, ly);
    for (let i = 2; i < n; i += 2) {
      const x = this._sx(arr[i]), y = this._sy(arr[i + 1]);
      const dx = x - lx, dy = y - ly;
      if (i === n - 2 || dx * dx + dy * dy >= minSeg2) {
        ctx.lineTo(x, y);
        lx = x; ly = y;
      }
    }
  }

  _symbolFeature(feat, symName, rot) {
    const a = feat._pg && feat._pg.anchor;
    if (!a) return;
    if (this.declutter) {
      const sx = this._sx(a[0]), sy = this._sy(a[1]);
      // (1) 항행보조 시설: 다중 축척 셀이 같은 부이/등화를 중복 수록할 때 잔상 제거
      const navGroup = navaidGroupKey(feat);
      if (navGroup &&
          spatialDedup(this._pointSymbolGrid, navGroup, sx, sy, this._navaidDedupPx, this._navaidDedupPx)) {
        return;
      }
      // (2) TSS·항로·조류 등 방향 화살표: 줄지어 박힌 화살표를 듬성하게
      if (FLOW_ARROW_SYMBOL_RE.test(symName || "") &&
          spatialDedup(this._flowArrowGrid, "", sx, sy, FLOW_ARROW_MIN_DIST_PX, FLOW_ARROW_MIN_DIST_PX)) {
        return;
      }
      // (3) 장애·난파·암석: 광역 뷰에서만 픽셀 거리로 띄엄 표시(확대 시 전부 유지).
      const hzMin = hazardSymbolDeclutterMinPx(this._symbolDeclutterDenom || 0);
      if (hzMin > 0 && isHazardDeclutterSym(symName) &&
          spatialDedup(this._hazardSymbolGrid, "", sx, sy, hzMin, hzMin)) {
        return;
      }
    }
    this._blit(symName, a[0], a[1], rot);
  }

  // rot: degrees clockwise from north (S-57 ORIENT). Screen is north-up so the
  // canvas rotation equals the bearing directly.
  _blit(symName, mx, my, rot) {
    const s = this.s52.symbols.get(symName);
    const x = this._sx(mx), y = this._sy(my);
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
    const ctx = this.ctx;
    const fpx = this._soundingFontPx || 10;
    const decPx = Math.max(7, fpx * 0.72);  // 데시미터(소수 한 자리) 아래첨자 크기
    const decDrop = fpx * 0.22;             // 아래첨자 내림량
    ctx.fillStyle = this.s52.color("SNDG2");
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    const W = this.canvas.width, H = this.canvas.height;
    const sgMin = this._soundingDedupPx || 0; // 소축척 솎기 최소간격(px), 0=비활성(상세 줌)
    for (let i = 0; i < ps.length; i += 3) { // flat [x,y,depth,…]
      const x = this._sx(ps[i]), y = this._sy(ps[i + 1]);
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
      // 소축척: 라벨 박스와 별개의 공간 격자로 수심을 듬성하게 솎는다(데이터는 유지).
      if (sgMin > 0 && spatialDedup(this._soundingGrid, "", x, y, sgMin, sgMin)) continue;
      const s = soundingParts(ps[i + 2], this.depthUnit); // metres
      ctx.font = `${fpx}px sans-serif`;
      const wWhole = ctx.measureText(s.whole).width;
      let wDec = 0;
      if (s.dec != null) { ctx.font = `${decPx}px sans-serif`; wDec = ctx.measureText(s.dec).width; }
      const totalW = wWhole + wDec;
      if (!this._place(x - totalW / 2, y - fpx / 2, totalW, fpx + 3)) continue;
      const sx = x - totalW / 2, by = y + fpx * 0.3;
      ctx.font = `${fpx}px sans-serif`;
      ctx.fillText(s.whole, sx, by);                          // 정수부(미터): 정상 크기
      if (s.dec != null) {
        ctx.font = `${decPx}px sans-serif`;
        ctx.fillText(s.dec, sx + wWhole, by + decDrop);       // 데시미터: 작게+내려서(아래첨자)
      }
      if (s.drying) {                                          // 건출높이: 숫자 아래 밑줄(음수 부호 대신)
        ctx.fillRect(sx, by + Math.max(1.5, fpx * 0.12), totalW, Math.max(1, fpx * 0.09));
      }
    }
  }

  _text(feat, op) {
    const a = feat._pg && feat._pg.anchor;
    if (!a) return;
    const x = this._sx(a[0]), y = this._sy(a[1]);
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

// S-52 SOUNDG 표기 분해: 미터(정수부)와 데시미터(첫 소수, 아래첨자로 그림)로 나눈다.
// 31m 미만만 데시미터 표기(이상은 정수). 음수=차트 데이텀 위(간조 시 노출)=「건출높이」이므로
// 음수 부호를 쓰지 않고 양수 절대값 + 밑줄(drying)로 표시한다(S-52 표준).
function soundingParts(metres, unit) {
  const drying = metres < 0;
  let v = Math.abs(metres);
  if (unit === "ft") v *= 3.280839895;
  else if (unit === "fathom") v *= 0.5468066492;
  const showDec = unit === "ft" ? false : unit === "fathom" ? v < 11 : v < 31;
  if (showDec) {
    const d = Math.round(v * 10); // 데시미터 단위로 반올림
    return { whole: Math.floor(d / 10).toString(), dec: (d % 10).toString(), drying };
  }
  return { whole: Math.round(v).toString(), dec: null, drying };
}

function bandOf(name) {
  if (!name || typeof name !== "string") return 0;
  const base = name.replace(/\\/g, "/");
  const i = base.lastIndexOf("/");
  const leaf = i >= 0 ? base.slice(i + 1) : base;
  const m = leaf.match(/^[A-Z]{2}(\d)/i);
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
  // 사운딩 보유 여부를 영속 플래그로 남긴다. 아래에서 feat.soundings를 null로 비우면
  // 렌더 루프의 "사운딩은 표시범주 필터 면제" 검사가 두 번째 프레임부터 깨져
  // 사운딩이 팬/줌 후 사라지기 때문(원래 버그).
  feat._hasSoundings = !!ps;
  // keep a tiny truthy geom marker so the "has content" checks still pass
  if (feat.geom) feat.geom = { type: feat.geom.type };
  else if (ps) feat.geom = { type: "Sounding" };
  feat.soundings = null;
}

export { Renderer, Viewport, projectFeature, mercX, mercY };
