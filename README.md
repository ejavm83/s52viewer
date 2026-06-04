# S-52 ENC Viewer

**기본 화면(`index.html`)**은 브라우저에서 **OpenLayers**로 **Web Mercator XYZ 타일**을 붙이고, 각 타일 PNG는 **Node 서버**가 `000/`의 **IHO S-57 ENC**를 읽어 **동일한 S-52 파이프라인**(`js/s52.js`·`js/render.js`)으로 **node-canvas**에 그린 뒤 디스크(`tiles/…`)에 캐시합니다. 즉 “지도 그리기”의 무게는 서버 쪽에 있고, 클라이언트는 타일 합성·UI만 담당합니다.

별도로 저장소에는 **클라이언트에서만** `.000`을 fetch·파싱해 **2D 캔버스**에 직접 그리던 **`js/main.js` 벡터 뷰** 코드가 남아 있으나, **현재 기본 진입점에서는 로드하지 않습니다**(타일 방식과 병행 유지·참고용).

## 특징

- **서버 타일**: `GET /tile/{z}/{x}/{y}.png` — 팔레트·표시범주 등은 쿼리로 구분, 결과는 `tiles/<설정키>/…`에 장기 캐시
- **OpenLayers** 팬·줌(우하단 ±, 휠 등), 셀 인덱스 기반 **사이드바 목록·검색·행 클릭 fly-to**, **셀 경계 격자** 오버레이
- 색상표(Day / Dusk / Night), 표시범주(Base / Standard / All) — 툴바 순환 버튼과 타일 URL이 연동
- 툴바 제목(로고) 클릭 시 **부산항 일대**로 뷰 이동(`tile-app.js`)
- (참고) **`tiles.html` / `viewer.html`**: 타일 전용·경량 UI 페이지
- (참고) **`js/main.js` 벡터 뷰**가 지원하던 항목: 로컬 ENC 열기, 위성 오버레이, 3D 지구본, 오브젝트 패널 등 — 기본 `index.html` 타일 모드에서는 비활성·미적용 UI가 숨겨짐

## 요구 사항

- **Node.js** 18+ 권장. **`npm run serve`** 시 타일 렌더를 위해 **`canvas`(node-canvas)** 네이티브 빌드가 필요합니다(플랫폼별 빌드 도구).
- 브라우저: **OpenLayers**가 동작하는 최신 **Chromium / Firefox / Safari** 등

## 빠른 시작

```bash
git clone https://github.com/ejavm83/s52viewer.git
cd s52viewer
npm install          # 선택: 루트에 package-lock이 있으면
npm run build        # 선택: cell-index.json 미리 생성(없어도 serve 시 /api/index로 생성 가능)
npm run serve        # 기본 http://localhost:8000/
```

브라우저에서 `http://localhost:8000/`을 엽니다. **`file://`로 `index.html`만 열면** 모듈·fetch 제한으로 동작하지 않을 수 있으므로 반드시 위처럼 HTTP로 서빙하세요.

## Render에 새로 배포

| 방법 | 할 일 |
|------|--------|
| **한 번에 (Blueprint)** | Render Dashboard → **New** → **Blueprint** → 이 저장소 선택 → `render.yaml` 적용. (서비스 이름·플랜은 마법사에서 바꿀 수 있음) |
| **수동 (Web Service)** | **New** → **Web Service** → 같은 저장소 연결 → **Runtime: Docker**, Health **`/healthz`**, Environment에 `CELL_CACHE_MAX`·`NODE_OPTIONS`는 [`render.yaml`](render.yaml)과 동일하게. |

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ejavm83/s52viewer)

- 마법사에서 **Docker**로 빌드되는지 확인하고, **Docker Command는 비움** · **`PORT` 환경 변수는 수동 추가하지 않음**.
- 배포 후: `/healthz` → `ok`, `/tile/12/3516/1621.png?p=day` → PNG, 루트 `/` → 뷰어. **`enc-tile-base`는 비움**이면 동일 호스트에서 타일 사용.
- **512MB(Starter/Free)** 에서 Events에 **OOM**이 뜨면: **`CELL_CACHE_MAX=8`**, **`NODE_OPTIONS=--max-old-space-size=256`**, **`TILE_RENDER_MAX=2`**(타일 동시 렌더 제한)을 시도하거나 **Scaling**에서 **RAM 2GB(Standard)** 로 올린다. (`RENDER=true`일 때 코드 기본 셀 캐시는 12.)
- 슬립 없이 쓰려면 인스턴스를 **Starter** 등으로 올리면 됩니다.
- 상세·분리 배포(Vercel+Render): [`DEPLOY-TILE-SERVER.md`](DEPLOY-TILE-SERVER.md)

## npm 스크립트

| 스크립트 | 설명 |
|----------|------|
| `npm run serve` | `serve.js`로 정적 서버 + **`/tile/{z}/{x}/{y}.png`** ENC 래스터 타일(캐시·node-canvas) |
| `npm run build` | `000/` 기준으로 `cell-index.json` 생성 |
| `npm test` | 파서 등 단위 테스트(`test/parse-test.mjs`) |

타일 예열·배치 생성은 패키지 스크립트에 없고, 필요 시 예: `node scripts/prerender-tiles.mjs …`, `node scripts/prerender-coverage.mjs` 등을 직접 실행합니다(`docs/코드-설명.md` 참고).

## 문서

- **프로그램 설명(웹)**: 서버로 연 뒤 [`about.html`](about.html) — `docs/코드-설명.md`를 렌더합니다.
- **상세 아키텍처**: [`docs/코드-설명.md`](docs/코드-설명.md)
- **변경 기록**: [`CHANGELOG.md`](CHANGELOG.md)

## CI

GitHub Actions에서 `npm test` 및 셀 인덱스 빌드 등을 실행합니다([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## 주의

- **완전한 ECDIS S-52 구현은 아닙니다.** 조건부 기호·룩업·패턴 등은 일부 근사·생략됩니다.
- **ENC 데이터**는 IHO·국가 규제에 따른 사용·배포 조건을 따르세요. 이 저장소는 샘플 데이터 유무와 무관하게 뷰어 코드만 제공합니다.

## 제작·버전

앱 하단 크레딧 및 `package.json`의 버전 필드를 참고하세요.
