# 타일 서버 별도 배포 (Vercel 앱 + 렌더 서버)

구조(레퍼런스 사이트와 동일): **정적 앱은 Vercel**, **타일 렌더는 별도 서버**.
같은 GitHub 저장소를 두 곳에 배포한다.

```
브라우저 ── index.html, js, 셀목록 ──▶  Vercel (정적, 기존)
   │
   └────── /tile/{z}/{x}/{y}.png ─────▶  타일 서버 (Docker, serve.js + node-canvas)
                                          ENC→PNG 렌더 + 디스크 캐시
```

타일이 안 잡히면(서버 미배포/다운) 앱은 자동으로 **벡터 렌더로 폴백**하므로 빈 화면이 안 된다.

---

## 0) 로컬 `serve.js`처럼 “동적 맵 서버” 한 방에 배포하려면

**동적 맵 서버**의 의미는 이 저장소 기준으로 다음과 같다.

- 브라우저가 **Web Mercator XYZ**로 `GET /tile/{z}/{x}/{y}.png?…` 를 요청할 때마다, 서버가 `000/` ENC를 읽어 **S-52와 동일 파이프라인**으로 PNG를 만들고(이미 있으면 디스크 `tiles/…` 캐시에서 즉시 반환) → 로컬에서 `node serve.js` 로 돌리는 것과 같은 방식이다.

**Render에서 그렇게 동작시키려면** 반드시 **이 저장소**를 빌드하는 **Docker Web Service**(`Dockerfile` → `node serve.js`)여야 한다. 같은 URL로 `index.html`·정적 자원과 **`/tile/…`** 이 같이 나와야 한다.

1. Render에 연결한 GitHub 저장소가 **`serve.js` + `Dockerfile` + `000/` ENC** 를 포함한 **이 프로젝트**인지 확인한다.  
2. **Runtime = Docker**, Dockerfile 경로·컨텍스트는 저장소 루트 기준으로 둔다.  
3. 배포 후 브라우저에서 **`https://<서비스>.onrender.com/`** 만 연다.  
4. `index.html` 의 **`enc-tile-base` meta는 비워 둔다**(`content=""`). 그래야 `js/tile-mercator.js`가 **동일 출처**로 `/tile/12/3516/1621.png` 를 프로브하고, 성공 시 로컬과 같이 **서버 타일 모드**로 붙는다.  
5. 동작 확인: `https://<서비스>.onrender.com/tile/12/3516/1621.png?p=day` 가 PNG로 열리면 맵 서버 타일 엔드포인트가 살아 있는 것이다.

**다른 저장소**(예: Python **Uvicorn** 기반 `s57viewer`)는 차트 뷰어로는 동작할 수 있지만, 위 **Node 전용 `/tile/{z}/{x}/{y}.png` API**를 제공하지 않으면 **이 S-52 viewer 프론트**와는 “맵 서버 한 벌”로 연결되지 않는다. S-52 ENC 타일을 쓰려면 타일용으로 **이 Dockerfile 서비스**를 따로 두거나, 기존 Web Service의 **Git 연결·Dockerfile을 이 저장소로 바꾼다**.

---

## 1) 타일 서버만 분리 배포 — Render (Vercel 정적 + 타일 전용)

1. 이 저장소를 GitHub에 push (새 파일 포함: `Dockerfile`, `.dockerignore`, 수정된 `serve.js` 등).
2. https://render.com → **New +** → **Web Service** → GitHub 저장소 연결.
3. Render가 `Dockerfile`을 자동 감지 → **Runtime: Docker**. (Build/Start 명령은 비워둠 — Dockerfile이 처리)
4. 설정:
   - **Instance Type**: Free(512MB, 15분 유휴 시 슬립 → 첫 요청 ~30~60s 콜드스타트) 또는 Starter($7/mo, 항상 켜짐).
   - **Runtime**: 반드시 **Docker** (`Dockerfile` 감지). **Node**로 만들면 Dockerfile·Noto CJK가 적용되지 않아 한글이 □로 나오고, 힙/캐시 기본도 컨테이너와 다를 수 있다.
   - **Health Check Path**: **`/health`** (또는 **`/healthz`** — `serve.js`가 둘 다 `ok`로 응답). Render에서 `/healthz`로 두어도 된다.
   - **Environment (512MB Free 권장)**:
     - `CELL_CACHE_MAX=12` — 셀 파싱이 메모리를 많이 쓰므로 낮게 두는 것이 OOM 방지에 가장 효과적이다. RAM 여유가 있으면 20~40까지 올려도 된다.
     - `NODE_OPTIONS=--max-old-space-size=384` — Node 힙이 컨테이너 RAM을 넘기면 OOM-kill된다. `node-canvas`(Cairo) 등 네이티브가 별도로 RAM을 쓰므로 Free 티어에서는 384 전후가 안전한 편이다.
   - (선택) 저장소 루트의 **`render.yaml`**을 쓰면 위 env·헬스 경로를 Blueprint로 한 번에 맞출 수 있다. 대시보드에서 **New Blueprint Instance** 또는 기존 서비스와 병합 시 Render 문서를 따른다.
5. **Create Web Service** → 빌드(몇 분, 000/ 셀 374MB 포함) 후 URL 발급: `https://<이름>.onrender.com`.
6. 확인:
   - `https://<이름>.onrender.com/health` → 본문 `ok`
   - `https://<이름>.onrender.com/tile/12/3516/1621.png?p=day` → 부산항 차트 PNG가 보이면 성공.

> Render는 컨테이너에 **`PORT`**(예: 10000)와 **`RENDER=true`**를 주입한다. `serve.js`는 `PORT`로 리슨한다. **기동 시 타일 엔진 예열**은 `RENDER=true`이면 기본 생략되어 Free 티어 OOM을 줄인다(첫 타일만 약간 느릴 수 있음). 예열을 켜려면 **`FORCE_TILE_WARMUP=1`**. node-canvas·Noto CJK는 Dockerfile이 설치한다.

## 2) Vercel 앱이 그 서버를 보도록 설정

`index.html`의 meta 한 줄만 바꾼다:

```html
<meta name="enc-tile-base" content="https://<이름>.onrender.com" />
```

(비워두면 동일 출처 = 로컬 `serve.js`용. 위 URL을 넣으면 Vercel 앱이 그 서버에서 타일을 가져온다.)

커밋 + push → Vercel 자동 재배포 → **확대 시 타일(렌더 서버) / 축소 시 지구본(벡터)**.

---

## 다른 플랫폼 (택1)

- **Fly.io** (항상 켜짐, 무료 할당): `fly launch`(Dockerfile 자동 감지 → fly.toml 생성) → `fly deploy` → `https://<앱>.fly.dev`.
- **Railway**: New Project → Deploy from Repo → Dockerfile 감지 → URL. (사용량 과금)
- **VPS**(DigitalOcean 등): `docker build -t s52-tiles . && docker run -e PORT=8080 -p 8080:8080 s52-tiles` → 리버스 프록시(HTTPS).

## 참고

- 디스크 타일 캐시(`tiles/`)는 컨테이너 재시작 시 사라짐(온디맨드 재렌더 → 다시 캐시). 영구화하려면 디스크 볼륨 연결 또는 이미지에 미리 구운 타일 COPY.
- 배포 후 **`502`** 이고 Logs에 앱 기동 로그가 없으면: **`package.json`의 `start`가 `node serve.js`인지**, Render **Docker Command**에 **`server.js`/`18000` 같은 오타·포트 인자**가 없는지 확인한다. (`server.js`는 저장소에 **호환 진입점**으로 두어 `node server.js`도 동일하게 기동되게 할 수 있다.)
- Dockerfile의 셀 인덱스 빌드 단계는 **`scripts/build-cell-index.mjs`** 가 맞다. **`build-sell-index`** 등 오타면 빌드/이미지가 꼬일 수 있다.
- RAM 부족(OOM: "used over 512MB" 등)이면 `CELL_CACHE_MAX`를 더 낮추고(예: 8~12), `NODE_OPTIONS` 힙 상한을 더 낮추거나(예: 320), **Standard(2GB)** 등 RAM 큰 인스턴스로 올린다.
- 헬스체크가 `connection refused`이면 프로세스가 포트에 바인드하기 전에 죽었거나(OOM 등) **Health Check Path**가 앱에 없는 경로인 경우가 있다. 이 저장소는 **`/health`** 와 **`/healthz`** 를 제공한다.
- 보안상 출처를 제한하려면 serve.js의 `Access-Control-Allow-Origin: *`을 Vercel 도메인으로 좁혀도 된다.
