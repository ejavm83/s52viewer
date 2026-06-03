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

# 플랫폼이 PORT 환경변수를 주입하면 serve.js가 그걸 사용(없으면 8080)
ENV PORT=8080
EXPOSE 8080
CMD ["node", "serve.js"]
