// 타일 캐시 설정 ↔ 캐시 키 (서버·예열 공용).
// serve.js(요청 파싱)와 scripts/prerender-coverage.mjs(예열 경로)가 같은 규칙을 쓰도록
// 한곳에 둔다 — 키가 어긋나면 예열해 둔 타일을 서버가 못 찾아 매번 다시 렌더하게 된다.

/**
 * 쿼리스트링 → S-52 타일 설정.
 * 기본값은 예열된 'day' 타일과 일치(palette day · 표시 standard · 등고선 2/30/50 · SCAMIN on)
 * 하도록 잡아, 기본 요청이 디스크 캐시를 그대로 쓰게 한다.
 */
export function tileSettings(q) {
  const g = (re) => { const m = q.match(re); return m ? m[1] : null; };
  const num = (re, d) => { const v = g(re); return v != null ? +v : d; };
  return {
    palette: g(/(?:^|&)p=(day|dusk|night)/) || g(/(?:^|&)t=(day|dusk|night)/) || "day",
    display: g(/(?:^|&)disp=(base|standard|other)/) || "standard",
    shallow: num(/(?:^|&)shallow=(\d+(?:\.\d+)?)/, 2),
    safety: num(/(?:^|&)safety=(\d+(?:\.\d+)?)/, 30),
    deep: num(/(?:^|&)deep=(\d+(?:\.\d+)?)/, 50),
    scamin: !/(?:^|&)scamin=0/.test(q),
  };
}

/**
 * 설정 → 디스크 캐시 하위 폴더 키. 기본값이면 팔레트명만(예: "day"),
 * 비기본이면 접미사가 붙는다(예: "day__other", "day__c2-10-20", "day__nsc").
 */
export function settingsKey(s) {
  const x = [];
  if (s.display !== "standard") x.push(s.display);
  if (!(s.shallow === 2 && s.safety === 30 && s.deep === 50)) x.push(`c${s.shallow}-${s.safety}-${s.deep}`);
  if (!s.scamin) x.push("nsc");
  return x.length ? `${s.palette}__${x.join("_")}` : s.palette;
}
