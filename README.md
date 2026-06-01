# S-52 ENC Viewer

브라우저에서 **IHO S-57 ENC**(`.000`)를 읽고, **S-52 표현 규칙**에 가깝게 **2D 캔버스**에 그리는 정적 웹 뷰어입니다. 파싱·표현·렌더링은 클라이언트 **JavaScript(ES 모듈)**에서 수행하고, Node 서버는 정적 파일과 셀 인덱스 API만 제공합니다.

## 특징

- S-57 피처를 S-52 룩업에 맞춰 해석 후 면·선·심볼·텍스트 등으로 렌더링
- `000/`에 두거나 **파일·폴더 선택**·드래그 앤 드롭으로 로컬 ENC 열기
- 색상표(Day / Dusk / Night), 표시범주(Base / Standard / All), 셀 격자, 선택적 **육지 위성 오버레이**(Esri World Imagery)
- 3D 지구본·머케이터 전환, 팬·줌·터치·키보드 단축키, 뷰포트 즐겨찾기(1–9)
- 툴바 제목(로고) 클릭 시 **캡처용 프레이밍**(부산항·가덕도 일대)으로 뷰 이동

## 요구 사항

- **Node.js** 18+ 권장(로컬 서버·셀 인덱스 빌드·테스트용)
- 최신 **Chromium / Firefox / Safari** 등 ES 모듈·`OffscreenCanvas`/Worker를 지원하는 브라우저

## 빠른 시작

```bash
git clone https://github.com/ejavm83/s52viewer.git
cd s52viewer
npm install          # 선택: 루트에 package-lock이 있으면
npm run build        # 선택: cell-index.json 미리 생성(없어도 serve 시 /api/index로 생성 가능)
npm run serve        # 기본 http://localhost:8000/
```

브라우저에서 `http://localhost:8000/`을 엽니다. **`file://`로 `index.html`만 열면** 모듈·fetch 제한으로 동작하지 않을 수 있으므로 반드시 위처럼 HTTP로 서빙하세요.

## npm 스크립트

| 스크립트 | 설명 |
|----------|------|
| `npm run serve` | `serve.js`로 정적 서버 기동(포트: 인자·`PORT`·기본 8000) |
| `npm run build` | `000/` 기준으로 `cell-index.json` 생성 |
| `npm test` | 파서 등 단위 테스트(`test/parse-test.mjs`) |

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
