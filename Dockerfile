# S-52 ENC 타일 서버 — serve.js를 node-canvas와 함께 실행해 ENC를 PNG 타일로 렌더링한다.
# 별도 서버(Render/Fly.io/Railway 등)에 배포하고, Vercel 정적 앱은 이 서버 주소로 타일을 요청.
#
# node-canvas는 Cairo/Pango 등 시스템 라이브러리가 필요하고, 한글 라벨(부산남항 등) 렌더링을
# 위해 Noto CJK 폰트를 설치한다(없으면 한글이 □□로 나옴).
FROM node:22-bookworm-slim

# node-canvas 런타임/빌드 의존성 + 한글 폰트
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config python3 \
      libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev libpixman-1-dev \
      fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 의존성 먼저 설치(레이어 캐시 — package.json 바뀔 때만 재설치). canvas는 리눅스 prebuilt 사용.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# 앱 소스 전체(serve.js, lib/, js/, assets/, 000/ ENC 셀, cell-index.json 등)
# node_modules·tiles는 .dockerignore로 제외 → 위에서 설치한 리눅스 바이너리 유지
COPY . .

# 셀 인덱스 미리 빌드(이미 있으면 그대로 사용)
RUN node scripts/build-cell-index.mjs || true

# PORT는 호스트가 주입(Render/Fly 등). 로컬: docker run -e PORT=8080 -p 8080:8080 ...
# 헬스체크 경로: GET /health (Render 대시보드 Health Check Path에 /health 권장)
# 512MB 컨테이너: Node 힙 + node-canvas(Cairo) 네이티브가 같이 쓰므로 힙을 ~320MB로 제한
# 힙이 크면 node-canvas(Cairo)와 겹쳐 컨테이너 512MB를 넘기기 쉬움 — Render Free/Starter(512MB) 권장
ENV NODE_OPTIONS=--max-old-space-size=320
EXPOSE 10000
CMD ["node", "serve.js"]
