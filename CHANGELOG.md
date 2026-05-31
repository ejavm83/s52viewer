# 변경 기록

## v0.2.3 (2026-05-31)

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
