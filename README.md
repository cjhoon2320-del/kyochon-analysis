# 교촌에프앤비 상권분석 툴 — API 프록시 서버

## 구조

```
📁 프로젝트 폴더/
├── index.html       ← 상권분석 툴 (브라우저에서 열기)
├── server/
│   ├── server.js    ← Node.js 프록시 서버
│   ├── package.json
│   └── README.md
```

## 설치 및 실행

### 1단계 — Node.js 설치 확인
```bash
node -v   # v16 이상 권장
```

### 2단계 — 서버 실행 (외부 패키지 없음, 내장 모듈만 사용)
```bash
node server/server.js
```

콘솔에 아래가 표시되면 정상:
```
╔══════════════════════════════════════════╗
║   교촌에프앤비 상권분석 프록시 서버       ║
║   http://localhost:3000                   ║
╚══════════════════════════════════════════╝
```

### 3단계 — 브라우저에서 index.html 열기
- `index.html`을 **더블클릭**하거나
- VS Code Live Server 등으로 열기
- 네비바 상단에 `SGIS: ✅`, `유동: ✅` 배지가 표시되면 성공

---

## 포트 변경
기본 포트는 **3000**입니다. 충돌 시:
```bash
PORT=4000 node server/server.js
```
그리고 `index.html` 상단의 `PROXY_BASE` 값도 변경:
```js
const PROXY_BASE = 'http://localhost:4000';
```

---

## API 엔드포인트

| 경로 | 설명 | 파라미터 |
|------|------|----------|
| `GET /health` | 서버 상태 확인 | — |
| `GET /api/sgis/token` | SGIS 토큰 발급 (1시간 캐시) | — |
| `GET /api/sgis/population` | 거주인구 조회 | `x_crd`, `y_crd`, `year` |
| `GET /api/sbi/floating` | 유동인구 조회 | `cx`(경도), `cy`(위도), `radius` |

---

## 환경변수로 API 키 변경
```bash
SGIS_KEY=xxx SGIS_SECRET=yyy SBI_KEY=zzz node server/server.js
```
