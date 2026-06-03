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

## 1) 타일 서버 배포 — Render (가장 쉬움, GitHub 연결)

1. 이 저장소를 GitHub에 push (새 파일 포함: `Dockerfile`, `.dockerignore`, 수정된 `serve.js` 등).
2. https://render.com → **New +** → **Web Service** → GitHub 저장소 연결.
3. Render가 `Dockerfile`을 자동 감지 → **Runtime: Docker**. (Build/Start 명령은 비워둠 — Dockerfile이 처리)
4. 설정:
   - **Instance Type**: Free(512MB, 15분 유휴 시 슬립 → 첫 요청 ~30~60s 콜드스타트) 또는 Starter($7/mo, 항상 켜짐).
   - **Environment**: `CELL_CACHE_MAX=60` (Free 512MB RAM 대비. 여유 있으면 140).
5. **Create Web Service** → 빌드(몇 분, 000/ 셀 374MB 포함) 후 URL 발급: `https://<이름>.onrender.com`.
6. 확인: 브라우저로 `https://<이름>.onrender.com/tile/12/3516/1621.png?p=day` → 부산항 차트 PNG가 보이면 성공.

> node-canvas 시스템 라이브러리·한글 폰트(Noto CJK)는 Dockerfile이 설치한다. PORT는 Render가 주입 → serve.js가 사용.

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
- **VPS**(DigitalOcean 등): `docker build -t s52-tiles . && docker run -p 8080:8080 s52-tiles` → 리버스 프록시(HTTPS).

## 참고

- 디스크 타일 캐시(`tiles/`)는 컨테이너 재시작 시 사라짐(온디맨드 재렌더 → 다시 캐시). 영구화하려면 디스크 볼륨 연결 또는 이미지에 미리 구운 타일 COPY.
- RAM 부족(슬립/OOM)이면 `CELL_CACHE_MAX`를 더 낮추거나 상위 플랜.
- 보안상 출처를 제한하려면 serve.js의 `Access-Control-Allow-Origin: *`을 Vercel 도메인으로 좁혀도 된다.
