# 변경 기록

## v0.2.6 (2026-05-31)

- **다중 축척 면(DEPARE·LNDARE 등)**: 개략·상세 셀 면을 한 목록에서 CSCL 큰 순→작은 순으로 통합 칠하고, `supersededByFiner`로 개략 면을 빼지 않아 셀 경계에서 수심면이 들쭉날쭉 보이던 격자 불일치를 줄였습니다 (`render.js`).
- **같은 표시우선순위 내 정렬**: 버킷 안에서 개략 셀을 먼저·상세 셀을 나중에 그려 상세 면·선이 개략 데이터 위에 일관되게 올라가게 했습니다 (`render.js`).
- **해안선(COALNE) LS**: 겹침 생략을 COALNE **선**은 앵커 기준(`_shouldOmitForFinerOverlappingCell`), 그 외 선은 bbox 다점 기준(`_supersededByFinerForExtent`)으로 구분했습니다. LS 스트로크는 `MIN_SEG2_STROKE`로 면보다 촘촘한 픽셀 데시메이션을 적용했습니다 (`render.js`).
- **부드러운 줌**: 애니메이션 중 `Renderer._fastMode`로 사운딩(SOUNDG)만 잠시 생략하고, 멈추면 전체 디테일로 마지막 한 프레임을 그려 저사양에서도 줌이 덜 끊기게 했습니다 (`main.js`, `render.js`).
- **표기**: 앱 하단 크레딧·패키지 v0.2.6, 모듈 캐시 버스트(`index.html`, `main.js`).

## v0.2.5 (2026-05-31)

- **도구줄**: 수심단위(미터/피트/패덤 순환)·경위도선·3D 지구본 체크박스를 제거했습니다. 수심은 기본 미터(`depthUnit`), 경위도선은 기본 끔(`showGraticule`), 축소 시 지구본 자동 전환은 기본 유지(`Viewport.auto3D`)입니다. 필요 시 개발자 콘솔에서 `state.renderer`·`state.renderer.vp`로 조정할 수 있습니다 (`index.html`, `main.js`).
- **문서**: `docs/코드-설명.md`의 UI·§5.1 설명을 위 변경에 맞게 정리했습니다.
- **표기**: 앱 하단 크레딧·패키지 v0.2.5, `main.js` 캐시 버스트(`index.html`).

## v0.2.4 (2026-05-31)

- **다중 축척 면·선**: 겹침에서 개략 셀 피처를 bbox **중심**만 보고 생략하면 큰 DEPARE 등이 셀(M_COVR) 경계에 맞춘 직사각형 구멍·조각으로 깨져 보이던 문제를, 모서리+중심 샘플로 생략 판정하고(LNDARE와 같이) LNDARE가 아닌 면도 CSCL 거친→상세 순으로 칠해 상세가 위에 오게 수정 (`render.js`).
- **SCAMAX(축척)**: S-57과 동일하게 `SCAMIN`만이 아니라 `SCAMAX`도 적용해, 과도하게 확대했을 때(표시 분모가 SCAMAX보다 작을 때) 숨겨야 할 지물이 남지 않도록 함 (`render.js`, 문서).
- **장애물 점심볼(광역)**: 표시 분모가 약 1:4.5만 이상(축소 뷰)일 때만 `ISODGR`·`OBSTRN`·`WRECKS`·`UWTROC` 심볼을 화면 픽셀 거리로 띄엄 그려 연안 핑크·검정 과밀을 완화; 확대 시에는 기존처럼 전부 표시 (`render.js`).
- **장애물 심볼(OBSTRN/UDWHAZ)**: `VALSOU`가 없을 때마다 `ISODGR01`(자홍 고립 위험)로 그리던 것을, 수심이 안전수심 이하로 **확정**된 경우와 `WRECKS`·`UWTROC`만 고립 위험으로 두고 그 외는 `OBSTRN01`로 표시해 연안 핑크 과밀을 완화 (`s52.js`).
- **휠 줌(구글 어스 UX)**: 스크롤량에 비례해 log-스케일로 확대·축소(`deltaMode`·Ctrl 휠 보정); 부드러운 줌 애니메이션은 유지. **3D 지구본**에서도 커서 아래 지점을 고정한 채 축척만 바뀌도록 역투영·정렬(`globePickLonLatFromScreen`, `zoomGlobeAtScreen`). 핀치 줌도 지구본에서 동일하게 커서(두 손 중심) 기준(`main.js`, `render.js`).
- **지도 클릭**: 셀 격자 표시 중에도 지도 클릭으로 셀 on/off를 바꾸지 않음 — 표시 여부는 좌측 셀 목록 체크박스에서만 변경; 격자 모드에서는 클릭한 셀 포커스·목록 동기화만 유지 (`main.js`).
- **3D 지구본·셀 격자**: ENC 축척 밴드별 색(`BAND_COLORS`)으로 셀 경계를 그려 한반도 등 겹침 구역에서도 셀을 구분하기 쉽게 함; 포커스 셀은 흰 외곽 후 밴드색 이중선. 경로형 셀 키는 파일명만으로 밴드 판별(`bandOf`, `render.js`).
- **LNDARE(육지면)**: 다중 축척 겹침에서 `supersededByFiner`로 개략 셀 LNDARE까지 빠지면 상세 셀에 육지 폴리곤이 없는 구간에 Natural Earth·바다색만 남던 문제를, LNDARE는 겹침 생략하지 않고 CSCL이 거친 순→상세 순으로 칠해 상세 ENC 육지가 위에 오게 수정 (`render.js`, `main.js` 캐시 버스트).
- **Natural Earth 개략 육지**: 표시 분모가 약 1:280만 미만·`vp.scale>30000`·또는 **뷰포트와 겹치는 표시 중 ENC 셀이 있으면** Natural Earth를 끔 — 개략 지도와 ENC를 배타적으로만 표시; 위성 클립도 동일 (`_mercViewportIntersectsDisplayedEncCell`, `render.js`).
- **오브젝트 패널**: S-52 `display-cat`(chartsymbols.xml) 기준으로 Display Base / Standard / Other 구간 헤더로 목록을 나눔;「표시범주에 맞춰 목록 축소」로 상단 Base·Standard·All/Other 선택과 동일하게 그려질 수 있는 클래스만 남김 (`s52.js`, `main.js`, `index.html`).
- **좌측 목록**: 셀·객체 행을 `<div>`로 두어 행만 클릭할 때는 체크박스가 바뀌지 않고, 체크박스를 직접 눌렀을 때만 on/off 되도록 수정 (`main.js`).
- **셀 목록**: 지도 뷰와 겹치는 항목을 각 폴더 안에서 위쪽으로 정렬 (`reorderCellListByViewport`, `main.js`).
- **도구줄**: 색상표·표시범주·수심단위를 `<select>` 대신 클릭 시 옵션 순환(↻ 아이콘 회전 애니메이션)으로 전환 (`index.html`, `main.js`).
- **표기**: 앱 하단 크레딧·패키지 v0.2.4, `main.js` 캐시 버스트(`index.html`).

## v0.2.3 (2026-05-31)

- **셀 목록**: 뷰포트 밖 셀도 목록에 남기고 흐리게 표시해, 지도에 보이는 영역과 겹치는 항목을 구분 (`main.js`, `index.html`).
- **표기**: 앱 하단 크레딧 및 패키지 버전을 v0.2.3 (2026.05.31)으로 갱신, 모듈 캐시 버스트(`index.html`, `main.js`).
- **다중 축척**: 면·선에도 위치별 최상세 CSCL 기준 생략(`supersededByFiner`)으로 해안선 이중 그리기·면 누적 완화; SOUNDG는 bbox 한 점 필터를 제거해 광역 셀 사운딩 소실 방지 (`render.js`).
- **사운딩**: `projectFeature`가 `feat.soundings`를 비운 뒤에도 `_hasSoundings`로 렌더 통과·표시범주 면제가 유지되게 해 팬/줌 후 사운딩이 사라지던 문제 수정 (`render.js`).
- **해안선 디테일**: `_path()` decimation 임계 `MIN_SEG2`를 0.25로 낮춰 미세 굴곡 보존 (`render.js`).
- **등심선**: DEPCNT 기본 선 굵기 상향, `VALDCO`가 안전 수심과 같으면 더 굵게 강조 (`s52.js`).

## v0.2.2 (2026-05-27)

- **모바일 자동 3D**: 지역 초기 `fit`으로 `zoomOutMinScale`이 3D 전환 임계보다 크게 잡혀 핀치 축소만으로는 지구본에 못 들어가던 문제를, `auto3D`일 때 사용자 줌 하한을 `min(zoomOutMinScale, globeThreshold×0.98)`으로 완화해 해결 (`Viewport.minScaleForUserZoom`, `render.js`, `main.js`).

## v0.2.1 (2026-05-28)

- **줌 축소 한계**: `fit`으로 맞춘 축척보다 휠·키·핀치로 더 축소되지 않도록 하한을 두고, 전역 맞춤 등으로 다시 맞출 때만 그만큼까지 축소 허용. 부드러운 줌·즐겨찾기 복원에도 동일 적용 (`render.js`, `main.js`).
- **휠 줌**: 한 노치당 배율을 2.0으로 키우고, `deltaY` 부호만 써서 마우스·트랙패드별 스크롤량 차이를 무시 (`main.js`).
- **3D 지구본 바다**: 방사 그라데이션 대신 단색 채움으로 캔버스 사선·띠 아티팩트 제거 (`render.js`).
- **지구본 우주·별**: 심우주(전 화면 밀도, 디스크 안만 비움) + 천구 고리(반지름을 캔버스 모서리까지), 밝은 별 레이어 정리 (`render.js`).
- **지구본 관성**: 마우스·터치로 빠르게 돌린 뒤 손을 떼면 잠시 미끄러지며 감속 (`main.js`).
- **지구본 터치**: 한 손가락 팬을 구면 회전으로 통일, 두 손가락 핀치 시 `zoomAtScreen` 대신 축척만 조절해 중심·회전 깨짐 방지 (`main.js`).
- **자동 3D 전환**: `render()`마다 `syncAutoMode()`를 호출해 축척만 바뀌는 경로에서도 자동 지구본 전환이 빠지지 않게 함 (`render.js`).
- **머케이터 세계 배경**: 대륙·국경을 폴리곤별 merc bbox 캐시로 컬링, 항만 상세 줌(`scale > 30000`)에서는 생략 (`render.js`).
- **셀 뷰포트 컬링**: 화면 밖 셀은 피처 루프 자체를 스킵 (`render.js`).
- **텍스트 디클러터**: 다중 축척 셀에서 동일 위치는 최상세 CSCL 라벨만, 가까운 위치의 동일 문자열 라벨은 하나만 (`render.js`).
- **globe 대륙·국경**: 반구 클립 면 채움·앞면 구간만의 국경선으로 뒷면 정점으로 인한 잘못된 채움/잡선 완화 (`render.js`).
- **문서**: 지구본 배경 설명 갱신 (`docs/코드-설명.md`).

## v0.2.0 (2026-05-28)

- **3D 지구본**: 원근 투영·임계 축척 전환, 휠·핀치 줌과 연동, 툴바「3D 지구본」으로 자동 전환 끄기 (`render.js`, `main.js`, `index.html`).
- **부드러운 휠 줌**: `smoothZoomTo()`로 포커스 유지 보간 줌 (`main.js`).
- **세계 윤곽**: Natural Earth 110m `ne_110m_land.geojson`·`ne_110m_countries.geojson` 번들, globe/머케이터 공통 배경 (`assets/`, `render.js`).
- **머케이터 배경**: 평면 모드에서도 대륙·국경 레이어로 ENC 밖 영역 위치 감각 유지 (`render.js`).
- **GitHub Actions**: `npm test` 및 `cell-index` 빌드 CI (`.github/workflows/ci.yml`).
- **개발 편의**: `set-git-author-ejavm83.bat` — 이 저장소에 `ejavm83` 로컬 git 사용자 설정.

## v0.1.1 (2026-05-27)

- **ENC 셀 경계(M_COVR·M_CSCL)**: 약어·OBJL·`CATCOV` 등으로 메타 경계를 안정적으로 식별하고, `DATCVR` 단계에서는 CHBLK `LS`를 내지 않음(`render.js`, `s52.js`).
- **M_NSYS CHBLK**: `LC(MARSYS51)` 근사 CHBLK 실선이 다중 ENC에서 격자처럼 보이지 않도록 선 패스에서 생략 (`render.js`).
- **초기 UI**: 기본으로 좌측 셀 목록을 접고, 포커스 셀 배지는 비어 있을 때 숨김 (`index.html`).
- **초기화**: 격자·경위도선 체크 상태를 렌더러와 맞춤 (`main.js`).
- **휠 줌**: 한 스텝당 배율을 키보드 줌(1.15)과 구분해 1.35로 조정 (`main.js`).

## v0.1.0

- 최초 공개 버전 기준(이전 기록 없음).
