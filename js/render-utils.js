// S-52 렌더러 순수 헬퍼 — 투영(mercX/mercY/projectFeature), 디클러터, S-52 분류,
// 사운딩/색 헬퍼. Renderer/Viewport 상태(`this`) 없음 → 공유·단위테스트 가능.
// render.js에서 동작 보존(verbatim) 추출.

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

export { DISP_ORDER, prioIndex, DISPLAY_CAT_RANK, DASH, DOTT, EMPTY_DASH, MIN_SEG2, MIN_SEG2_STROKE, CSCL_OVERLAP_TOL, MERCATOR_WORLD_OVERLAY_MIN_DENOM, GLOBE_MIN_DIAMETER_FRAC_OF_MIN_CANVAS_SIDE, FLOW_ARROW_SYMBOL_RE, FLOW_ARROW_MIN_DIST_PX, NAVAID_ACRONYM_RE, NAVAID_DEDUP_PX, TEXT_DEDUP_PX, ENC_BOUNDARY_WITH_GRID, BAND_COLORS, navaidGroupKey, spatialDedup, hazardSymbolDeclutterMinPx, navaidDedupPx, soundingDedupPx, isHazardDeclutterSym, depthContourStandardDisplay, isCoastlineLineForOverlap, isEncBoundaryFeat, computeEncBoundary, isMnsysFeat, parseRgbColor, mercX, mercY, soundingParts, bandOf, projectFeature };
