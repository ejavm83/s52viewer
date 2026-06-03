// Tile-based map rendering for index.html — replaces the vector renderer (main.js).
// ONLY the map rendering method changes: client-side vector canvas → OpenLayers
// server tiles (/tile/{z}/{x}/{y}.png). The existing UI (toolbar cycles, cell-list
// sidebar, status bar, scale bar, zoom buttons) is kept and wired to the OL map.
(function () {
  "use strict";
  const BUSAN = [129.04, 35.08];
  const KOREA = [124, 32, 132.5, 39];

  // ── S-52 설정 → 타일 URL (툴바 순환이 구동) ──
  const PAL = { DAY_BRIGHT: "day", DUSK: "dusk", NIGHT: "night" };
  const DISP = { Displaybase: "base", Standard: "standard", Other: "other" };
  const settings = { p: "day", disp: "standard" };
  document.body.dataset.p = settings.p;
  const tileUrl = () => {
    let u = `/tile/{z}/{x}/{y}.png?p=${settings.p}`;
    if (settings.disp !== "standard") u += `&disp=${settings.disp}`;
    return u;
  };

  // ── #stage 안에 OL 지도 삽입(기존 벡터 캔버스는 숨김) ──
  const stage = document.getElementById("stage");
  const chart = document.getElementById("chart"); if (chart) chart.style.display = "none";
  ["sky", "haze"].forEach((id) => { const e = document.getElementById(id); if (e) e.style.display = "none"; });
  const olDiv = document.createElement("div"); olDiv.id = "olmap";
  stage.insertBefore(olDiv, stage.firstChild);

  const encTiles = new ol.source.XYZ({ url: tileUrl(), maxZoom: 18, minZoom: 4, transition: 150 });
  const refresh = () => encTiles.setUrl(tileUrl());

  // 셀 경계 격자 오버레이(셀 격자 토글용)
  const gridSource = new ol.source.Vector();
  const gridLayer = new ol.layer.Vector({ source: gridSource, visible: false,
    style: new ol.style.Style({ stroke: new ol.style.Stroke({ color: "rgba(41,128,185,.75)", width: 1 }) }) });

  const map = new ol.Map({
    target: olDiv,
    layers: [new ol.layer.Tile({ source: encTiles, preload: 2 }), gridLayer],
    controls: [], // 기존 #zoom-ctrl·#scale-bar 사용
    view: new ol.View({ center: ol.proj.fromLonLat(BUSAN), zoom: 12, minZoom: 5, maxZoom: 18, enableRotation: false }),
  });
  window.encMap = map;

  // ── 툴바 순환(색상표·표시범주) — 기존 .toolbar-cycle 패턴 ──
  function wireCycle(id, options, onPick) {
    const btn = document.getElementById(id);
    if (!btn) return;
    const textEl = btn.querySelector(".cycle-text"), icon = btn.querySelector(".cycle-icon");
    let idx = Math.max(0, options.findIndex((o) => o.value === btn.value));
    const apply = () => { btn.value = options[idx].value; if (textEl) textEl.textContent = options[idx].label; };
    apply();
    btn.addEventListener("click", () => {
      idx = (idx + 1) % options.length; apply();
      if (icon) { icon.classList.remove("spinning"); void icon.offsetWidth; icon.classList.add("spinning"); }
      onPick(options[idx].value);
    });
  }
  wireCycle("palette", [{ value: "DAY_BRIGHT", label: "Day" }, { value: "DUSK", label: "Dusk" }, { value: "NIGHT", label: "Night" }],
    (v) => { settings.p = PAL[v]; document.body.dataset.p = settings.p; refresh(); });
  wireCycle("dispcat", [{ value: "Displaybase", label: "Base" }, { value: "Standard", label: "Standard" }, { value: "Other", label: "All / Other" }],
    (v) => { settings.disp = DISP[v]; refresh(); });

  // ── 셀 격자 / 사이드바 토글 / 줌 버튼 / 로고 ──
  document.getElementById("grid")?.addEventListener("change", (e) => gridLayer.setVisible(e.target.checked));
  document.getElementById("sidebarVisible")?.addEventListener("change", (e) => {
    document.body.classList.toggle("sidebar-collapsed", !e.target.checked);
    setTimeout(() => map.updateSize(), 0);
  });
  const zoomBy = (d) => map.getView().animate({ zoom: map.getView().getZoom() + d, duration: 200 });
  document.getElementById("zoom-in")?.addEventListener("click", () => zoomBy(1));
  document.getElementById("zoom-out")?.addEventListener("click", () => zoomBy(-1));
  document.querySelectorAll(".app-logo").forEach((el) =>
    el.addEventListener("click", () => map.getView().animate({ center: ol.proj.fromLonLat(BUSAN), zoom: 13, duration: 600 })));

  // ── 서버 타일 방식에 적용 안 되는 컨트롤 정리 ──
  const hide = (id) => { const e = document.getElementById(id); if (e) e.style.display = "none"; };
  hide("open-enc");                                   // 서버에 셀이 이미 있음
  const bm = document.getElementById("basemap")?.closest("label"); if (bm) bm.style.display = "none"; // 위성 배경(불투명 타일이라 N/A)
  hide("tabObjs"); hide("showVisible"); hide("hideAll"); // 오브젝트탭·표시/숨김(벡터 전용)

  // ── 셀 목록(사이드바): /cell-index.json, 검색, 클릭 fly-to, 화면 겹침 강조 ──
  const bandColor = (name) => { const m = name.match(/^[A-Z]{2}(\d)/i); const b = m ? +m[1] : 0;
    return ({ 1: "#e74c3c", 2: "#e67e22", 3: "#f1c40f", 4: "#2ecc71", 5: "#3498db", 6: "#9b59b6" })[b] || "#888"; };
  const csclLabel = (c) => ({ 5000: "항만", 25000: "접근", 75000: "연안", 250000: "일반", 330000: "일반", 500000: "광역", 2000000: "총도" })[c] || ("1:" + (c || "?"));
  const listEl = document.getElementById("celllist");
  const focusedCell = document.getElementById("focused-cell");
  let cells = [], rows = [];

  function flyTo(c, el) {
    map.getView().fit(ol.proj.transformExtent([c.minX, c.minY, c.maxX, c.maxY], "EPSG:4326", "EPSG:3857"),
      { duration: 600, padding: [40, 40, 40, 40], maxZoom: 15 });
    if (focusedCell) focusedCell.textContent = c.name.replace(/\.000$/, "");
    rows.forEach((r) => r.el.classList.toggle("focus", r.el === el));
  }
  function markVisible() {
    const size = map.getSize(); if (!size) return;
    const ll = ol.proj.transformExtent(map.getView().calculateExtent(size), "EPSG:3857", "EPSG:4326");
    for (const r of rows) {
      const c = r.c, out = c.maxX < ll[0] || c.minX > ll[2] || c.maxY < ll[1] || c.minY > ll[3];
      r.el.classList.toggle("out-of-viewport", out);
    }
  }
  function renderList(q = "") {
    if (!listEl) return;
    listEl.innerHTML = ""; rows = [];
    const needle = q.trim().toUpperCase();
    for (const c of cells) {
      if (needle && !c.name.toUpperCase().includes(needle)) continue;
      const row = document.createElement("div"); row.className = "cellrow";
      const dot = document.createElement("span"); dot.className = "dot"; dot.style.background = bandColor(c.name);
      const nm = document.createElement("span"); nm.className = "cellname"; nm.textContent = c.name.replace(/\.000$/, "");
      const sc = document.createElement("span"); sc.textContent = csclLabel(c.cscl);
      sc.style.cssText = "margin-left:auto;color:#7fa8bd;font-size:11px;";
      row.append(dot, nm, sc);
      row.addEventListener("click", () => flyTo(c, row));
      listEl.appendChild(row); rows.push({ c, el: row });
    }
    const cc = document.getElementById("cellcount"); if (cc) cc.textContent = `${rows.length} / ${cells.length}`;
    markVisible();
  }
  fetch("/cell-index.json").then((r) => r.json()).then((idx) => {
    cells = idx.filter((c) => Number.isFinite(c.minX)).sort((a, b) => (a.cscl - b.cscl) || a.name.localeCompare(b.name));
    for (const c of cells) {
      gridSource.addFeature(new ol.Feature(new ol.geom.Polygon([[
        ol.proj.fromLonLat([c.minX, c.minY]), ol.proj.fromLonLat([c.maxX, c.minY]),
        ol.proj.fromLonLat([c.maxX, c.maxY]), ol.proj.fromLonLat([c.minX, c.maxY]), ol.proj.fromLonLat([c.minX, c.minY]),
      ]])));
    }
    renderList();
  });
  document.getElementById("filter")?.addEventListener("input", (e) => renderList(e.target.value));
  document.getElementById("fitAll")?.addEventListener("click", () => {
    map.getView().fit(ol.proj.transformExtent(KOREA, "EPSG:4326", "EPSG:3857"), { duration: 600 });
    if (focusedCell) focusedCell.textContent = "";
  });

  // ── 상태바 + 기존 #scale-bar 갱신(OL view 기준) ──
  const statusEl = document.getElementById("status");
  const sbLabel = document.getElementById("scale-bar-label"), sbTrack = document.getElementById("scale-bar-track");
  function update() {
    const v = map.getView(), c = v.getCenter(); if (!c) return;
    const ll = ol.proj.toLonLat(c), latf = Math.cos(ll[1] * Math.PI / 180);
    if (statusEl) statusEl.textContent = `위도 ${ll[1].toFixed(4)}°  경도 ${ll[0].toFixed(4)}°   ·   축척 1:${Math.round(v.getResolution() / 0.00028 * latf).toLocaleString()}`;
    const mpp = v.getResolution() * latf; let len = mpp * 110;
    const pow = Math.pow(10, Math.floor(Math.log10(len))); let n = len / pow; n = n >= 5 ? 5 : n >= 2 ? 2 : 1;
    const nice = n * pow;
    if (sbLabel) sbLabel.textContent = nice >= 1000 ? `${nice / 1000} km` : `${Math.round(nice)} m`;
    if (sbTrack) sbTrack.style.width = `${Math.round(nice / mpp)}px`;
  }
  map.on("moveend", () => { update(); markVisible(); });
  map.once("postrender", update);
  update();

  // 상태바 초기 안내 → 첫 view 정보로 대체
  const ml = document.getElementById("map-loading"); if (ml) ml.hidden = true;
})();
