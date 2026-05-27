# 변경 기록

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
