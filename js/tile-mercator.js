// Hybrid map rendering for index.html — vector globe (zoomed out) + OL server
// tiles (zoomed in, flat). Bolts onto the EXISTING vector app (window.s52app)
// without modifying main.js:
//   • renderer.tileMode = true  → render.js skips the heavy vector flat-chart
//     pass and leaves the #chart canvas transparent (globe path is untouched).
//   • an OpenLayers tile map is inserted *under* the transparent canvas, so the
//     flat chart is shown by fast cached server tiles (/tile/).
//   • each frame we MIRROR the app's viewport (vp) onto the OL view, and show OL
//     only in flat/mercator (+ transition) — in full globe mode OL is hidden so
//     the vector 3D globe shows. The existing toolbar/cell-list/zoom/pan all keep
//     driving vp; OL just follows.
(function () {
  "use strict";
  const R = 6378137; // web-mercator earth radius (vp.scale: screen px per mercator-radian → m/px = R/scale)
  const PAL = { DAY_BRIGHT: "day", DUSK: "dusk", NIGHT: "night" };
  const DISP = { Displaybase: "base", Standard: "standard", Other: "other" };
  // 타일 서버 베이스 URL(meta). 비우면 동일 출처(로컬 serve.js); 별도 서버면 그 절대 URL.
  const TILE_BASE = (document.querySelector('meta[name="enc-tile-base"]')?.content || "").trim().replace(/\/+$/, "");

  function enableTiles(app) {
    if (typeof ol === "undefined") { console.warn("tile-mercator: OpenLayers(ol) 미로드"); return; }
    const renderer = app.state.renderer, vp = renderer.vp;
    renderer.tileMode = true; // 평면 차트는 OL이 표시 → 벡터 플랫 렌더 생략

    // 설정(팔레트·표시범주)은 기존 툴바가 renderer에 반영하므로, 그 상태를 관찰해 타일 URL 생성
    const tileUrl = () => {
      const p = PAL[renderer.s52.currentTable] || "day";
      const d = DISP[renderer.minDisplayCat] || "standard";
      return `${TILE_BASE}/tile/{z}/{x}/{y}.png?p=${p}` + (d !== "standard" ? `&disp=${d}` : "");
    };
    // crossOrigin: 외부 타일 서버 텍스처를 OL 캔버스/WebGL이 쓸 수 있게(서버는 ACAO:* 응답)
    // transition:0 — 줌 중 타일이 매번 페이드-인하면 깜빡임처럼 보이므로 페이드 끔(즉시 표시).
    const encTiles = new ol.source.XYZ({ url: tileUrl(), maxZoom: 18, minZoom: 2, transition: 0, crossOrigin: "anonymous" });

    // #chart 캔버스 바로 아래에 OL 지도 삽입(상호작용·컨트롤 없음 — #chart/main.js가 처리)
    const stage = document.getElementById("stage");
    const chart = document.getElementById("chart");
    const olDiv = document.createElement("div"); olDiv.id = "olmap";
    stage.insertBefore(olDiv, chart);
    const view = new ol.View({ center: [0, 0], zoom: 2, enableRotation: false, constrainResolution: false, multiWorld: false });
    // preload: 줌 시 새 레벨 타일이 로드되기 전까지 하위 줌 타일을 계속 그려 빈 프레임(깜빡임) 방지.
    const map = new ol.Map({ target: olDiv, layers: [new ol.layer.Tile({ source: encTiles, preload: 6 })], controls: [], interactions: [], view });
    window.encMap = map;
    const onResize = () => map.updateSize();
    window.addEventListener("resize", onResize);
    setTimeout(onResize, 0);

    // OL z18 타일 해상도(이보다 더 확대하면 타일이 없음) — 동기화 시 이 아래로 안 내려가게 클램프
    const MIN_RES = (2 * Math.PI * R) / (256 * Math.pow(2, 18));
    let lastTable = null, lastDisp = null, lastKey = "", lastShow = null;
    function frame() {
      try {
        // 1) 팔레트/표시범주 변경 → 타일 URL 갱신(+ 미로드 타일 배경색용 data-p)
        if (renderer.s52.currentTable !== lastTable || renderer.minDisplayCat !== lastDisp) {
          lastTable = renderer.s52.currentTable; lastDisp = renderer.minDisplayCat;
          document.body.dataset.p = PAL[lastTable] || "day";
          encTiles.setUrl(tileUrl());
        }
        // 2) 모드: 전체 지구본이면 OL 숨김(벡터 지구본 표시), 평면·전환이면 OL 표시
        const show = !!vp._modeTransition || !vp.isGlobeView();
        if (show !== lastShow) { lastShow = show; olDiv.style.display = show ? "" : "none"; if (show) map.updateSize(); }
        // 3) 평면일 때 vp(머케이터 라디안) → OL(EPSG:3857) 미러링
        if (show && Number.isFinite(vp.scale) && vp.scale > 0) {
          const lat = Math.max(-89.9, Math.min(89.9, vp.centerLat()));
          const center = ol.proj.fromLonLat([vp.cx * 180 / Math.PI, lat]);
          const res = Math.max(MIN_RES, R / vp.scale);
          const key = `${center[0].toFixed(1)},${center[1].toFixed(1)},${res.toExponential(4)}`;
          if (key !== lastKey) { lastKey = key; view.setCenter(center); view.setResolution(res); }
        }
      } catch (e) { /* 한 프레임 실패해도 루프는 계속 */ }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    console.log("tile-mercator: 하이브리드 활성(평면=OL 타일, 축소=벡터 지구본)");
  }

  // 타일 서버 가용성 프로브 → 가용할 때만 타일 모드 활성. 정적 호스트(Vercel 등)엔 /tile
  // 서버가 없어 404가 나므로, 그 경우 tileMode를 켜지 않아 기존 벡터 렌더가 그대로 동작한다.
  function start(app) {
    if (typeof ol === "undefined") { console.warn("tile-mercator: OpenLayers(ol) 미로드 → 벡터 유지"); return; }
    let done = false;
    const decide = (ok, why) => {
      if (done) return; done = true;
      if (ok) enableTiles(app);
      else console.warn("tile-mercator: /tile 미가용(" + why + ") → 벡터 렌더 유지(정적 호스트?)");
    };
    const probe = new Image();
    probe.crossOrigin = "anonymous";
    probe.onload = () => decide(probe.naturalWidth > 0, "empty");
    probe.onerror = () => decide(false, "404/error");
    probe.src = `${TILE_BASE}/tile/12/3516/1621.png?p=day&probe=1`;
    // Render 등 무료 호스트는 슬립 해제·첫 타일(node-canvas) 예열까지 6초를 넘기기 쉬움
    setTimeout(() => decide(false, "timeout"), 22_000);
  }

  // main.js의 비동기 init 완료 대기(window.s52app.state.renderer)
  (function wait(n) {
    const app = window.s52app;
    if (app && app.state && app.state.renderer) start(app);
    else if ((n || 0) < 200) setTimeout(() => wait((n || 0) + 1), 60);
    else console.warn("tile-mercator: s52app 대기 시간 초과");
  })(0);
})();
