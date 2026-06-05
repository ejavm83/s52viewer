// 일회성 도구: IHO S-52 Presentation Library 4.0 표준 색표를 추출한다.
// 출처는 CARIS Easy View가 번들한 colcalib XML(메타데이터상 source="S52Preslib4.0").
// 색 값 자체는 IHO 공개 표준(사실값)이며, 이를 우리 팔레트 이름에 맞춰 js/s52-preslib-colors.js로
// 내보낸다. s52.js가 chartsymbols.xml 로드 후 이 값으로 색을 덮어써 표준에 정렬한다.
import { DOMParser } from "linkedom";
import { readFileSync, writeFileSync } from "node:fs";

const CARIS = "C:/Program Files/CARIS/Easy View/6.0/system/S57Config/symbolization/colcalib/";
// 우리 color-table 이름 → CARIS colcalib 파일
const MAP = {
  DAY_BRIGHT: "day_bright.xml",
  DAY_BLACKBACK: "day_blackback.xml",
  DAY_WHITEBACK: "day_whiteback.xml",
  DUSK: "dusk_blackback.xml",
  NIGHT: "night.xml",
};

const out = {};
for (const [pal, file] of Object.entries(MAP)) {
  let txt;
  try { txt = readFileSync(CARIS + file, "utf8"); }
  catch { console.error("MISSING:", file); continue; }
  const doc = new DOMParser().parseFromString(txt, "text/xml");
  const m = {};
  for (const c of doc.querySelectorAll("Colour")) {
    if (c.getAttribute("Type") !== "RGB") continue; // RGB 항목만(HLS/CMYK 제외)
    const tok = c.getAttribute("Token");
    const r = +c.querySelector("R")?.textContent;
    const g = +c.querySelector("G")?.textContent;
    const b = +c.querySelector("B")?.textContent;
    if (tok && Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) m[tok] = [r, g, b];
  }
  out[pal] = m;
  console.error(pal.padEnd(14), Object.keys(m).length, "colors  (DEPDW=" + (m.DEPDW || "?") + ")");
}

let js = "// IHO S-52 Presentation Library 4.0 표준 색표(IHO 공개 표준 값).\n";
js += "// scripts/extract-preslib-colors.mjs가 PresLib 4.0(colcalib)에서 추출. s52.js가\n";
js += "// chartsymbols.xml 로드 후 이 값으로 색을 덮어써 표준(CARIS와 동일)에 정렬한다.\n";
js += "export const PRESLIB_COLORS = " + JSON.stringify(out) + ";\n";
writeFileSync("js/s52-preslib-colors.js", js);
console.error("→ wrote js/s52-preslib-colors.js (", (js.length / 1024).toFixed(1), "KB )");
