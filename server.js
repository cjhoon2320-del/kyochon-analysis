'use strict';

/**
 * 교촌에프앤비 상권분석 툴 — API 프록시 서버
 * ─────────────────────────────────────────────
 * 역할: 브라우저 CORS 차단을 우회하여 SGIS / 소상공인 API를 서버에서 직접 호출
 *
 * 포트: 3000 (기본값, PORT 환경변수로 변경 가능)
 * 실행: node server.js
 *
 * 엔드포인트:
 *   GET /api/sgis/token          → SGIS accessToken 발급
 *   GET /api/sgis/population     → SGIS 거주인구 조회
 *   GET /api/sbi/floating        → 소상공인 유동인구 조회
 *   GET /health                  → 서버 상태 확인
 */

const http    = require('http');
const https   = require('https');
const url_mod = require('url');

// ───────────────────────────────────────────
//  설정값 (환경변수 > 하드코딩 fallback)
// ───────────────────────────────────────────
const PORT         = process.env.PORT         || 3000;
const SGIS_KEY     = process.env.SGIS_KEY     || 'bf2a3156886f4639aab5';
const SGIS_SECRET  = process.env.SGIS_SECRET  || '859b0252556c4566b84a';
const SBI_KEY      = process.env.SBI_KEY      || '0192b883bc62868715471a636f6346a000db965d40d388c62a9c554bd225b4ae';

// ───────────────────────────────────────────
//  허용 오리진 (index.html을 여는 브라우저)
//  로컬 파일(file://)도 허용
// ───────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5500',   // VS Code Live Server
  'http://127.0.0.1:5500',
  'null',                    // file:// 로 열었을 때 Origin: null
];

// ───────────────────────────────────────────
//  SGIS 토큰 캐시 (1시간 유효)
// ───────────────────────────────────────────
let tokenCache = { value: null, expires: 0 };

// ─────────────────────────────────────────────────────
//  헬퍼: 외부 HTTPS URL 가져오기 (리다이렉트 추종)
// ─────────────────────────────────────────────────────
function fetchJson(targetUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      return reject(new Error('Too many redirects'));
    }

    const parsed = url_mod.parse(targetUrl);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const req    = lib.get(targetUrl, (res) => {
      // 리다이렉트 처리
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log(`[REDIRECT] ${res.statusCode} → ${res.headers.location}`);
        return fetchJson(res.headers.location, redirectCount + 1)
          .then(resolve)
          .catch(reject);
      }

      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, json: null, raw: body }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ───────────────────────────────────────────
//  헬퍼: CORS 헤더 설정
// ───────────────────────────────────────────
function setCors(req, res) {
  const origin = req.headers['origin'] || 'null';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

// ───────────────────────────────────────────
//  헬퍼: JSON 응답 전송
// ───────────────────────────────────────────
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ───────────────────────────────────────────
//  헬퍼: 쿼리스트링 파싱
// ───────────────────────────────────────────
function parseQuery(reqUrl) {
  return Object.fromEntries(new url_mod.URL(reqUrl, 'http://localhost').searchParams);
}

// ═══════════════════════════════════════════
//  라우트 핸들러
// ═══════════════════════════════════════════

/** GET /health */
async function handleHealth(req, res) {
  sendJson(res, 200, {
    status : 'ok',
    server : '교촌 상권분석 프록시 서버',
    time   : new Date().toISOString(),
    apis   : { sgis: '✅ ready', sbi: '✅ ready' },
  });
}

/** GET /api/sgis/token — SGIS accessToken 발급 (1시간 캐시) */
async function handleSgisToken(req, res) {
  try {
    // 캐시 유효하면 즉시 반환
    if (tokenCache.value && Date.now() < tokenCache.expires) {
      return sendJson(res, 200, { ok: true, accessToken: tokenCache.value, cached: true });
    }

    const apiUrl =
      `https://sgisapi.kostat.go.kr/OpenAPI3/auth/authentication.json` +
      `?consumer_key=${SGIS_KEY}&consumer_secret=${SGIS_SECRET}`;

    console.log('[SGIS] 토큰 요청 URL:', apiUrl);
    const { status, json } = await fetchJson(apiUrl);

    console.log('[SGIS] 응답 상태:', status);
    console.log('[SGIS] 응답 내용:', JSON.stringify(json, null, 2));

    if (json && (json.errCd === 0 || json.errCd === '0') && json.result?.accessToken) {
      tokenCache.value   = json.result.accessToken;
      tokenCache.expires = Date.now() + 55 * 60 * 1000;
      console.log('[SGIS] ✅ 토큰 발급 완료:', tokenCache.value.substring(0, 20) + '...');
      return sendJson(res, 200, { ok: true, accessToken: tokenCache.value, cached: false });
    }

    // SGIS 오류 응답
    console.error('[SGIS] 토큰 발급 실패. 응답:', json);
    sendJson(res, 502, { ok: false, error: json?.errMsg || '토큰 발급 실패', raw: json });
  } catch (e) {
    console.error('[SGIS] 토큰 요청 예외:', e.message);
    sendJson(res, 500, { ok: false, error: e.message });
  }
}

/**
 * GET /api/sgis/population?x_crd=&y_crd=&year=2024
 * SGIS 거주인구 조회 (UTM-K 좌표)
 */
async function handleSgisPopulation(req, res) {
  try {
    const q = parseQuery(req.url);

    if (!q.x_crd || !q.y_crd) {
      return sendJson(res, 400, { ok: false, error: 'x_crd, y_crd 파라미터 필요' });
    }

    // 토큰 확보
    if (!tokenCache.value || Date.now() >= tokenCache.expires) {
      const tokenRes = await fetchJson(
        `https://sgisapi.kostat.go.kr/OpenAPI3/auth/authentication.json` +
        `?consumer_key=${SGIS_KEY}&consumer_secret=${SGIS_SECRET}`
      );
      if (tokenRes.json?.errCd === 0 && tokenRes.json?.result?.accessToken) {
        tokenCache.value   = tokenRes.json.result.accessToken;
        tokenCache.expires = Date.now() + 55 * 60 * 1000;
      } else {
        return sendJson(res, 502, { ok: false, error: 'SGIS 토큰 발급 실패' });
      }
    }

    const year   = q.year || '2024';
    const apiUrl =
      `https://sgisapi.kostat.go.kr/OpenAPI3/stats/population.json` +
      `?accessToken=${tokenCache.value}` +
      `&year=${year}&adm_cd=00&low_search=1` +
      `&x_crd=${q.x_crd}&y_crd=${q.y_crd}`;

    const { status, json } = await fetchJson(apiUrl);

    if (json && json.errCd === 0) {
      console.log('[SGIS] 거주인구 조회 성공');
      return sendJson(res, 200, { ok: true, data: json.result });
    }

    // 토큰 만료 가능성 → 캐시 초기화
    if (json?.errCd === -401 || json?.errCd === -402) {
      tokenCache.value = null;
    }
    sendJson(res, 502, { ok: false, error: json?.errMsg || '인구 조회 실패', raw: json });
  } catch (e) {
    console.error('[SGIS] 인구 조회 예외:', e.message);
    sendJson(res, 500, { ok: false, error: e.message });
  }
}

/**
 * GET /api/sbi/floating?cx=&cy=&radius=
 * 소상공인 유동인구 조회 (WGS84 좌표)
 */
async function handleSbiFloating(req, res) {
  try {
    const q = parseQuery(req.url);

    if (!q.cx || !q.cy) {
      return sendJson(res, 400, { ok: false, error: 'cx(경도), cy(위도) 파라미터 필요' });
    }

    const radius  = q.radius  || 300;
    const numOfRows = q.numOfRows || 1;

    const apiUrl =
      `https://apis.data.go.kr/B553077/api/open/sdsc2/baroApi` +
      `?serviceKey=${encodeURIComponent(SBI_KEY)}` +
      `&cx=${q.cx}&cy=${q.cy}` +
      `&radius=${radius}&numOfRows=${numOfRows}&type=json`;

    const { status, json } = await fetchJson(apiUrl);

    if (status === 200 && json) {
      console.log('[SBI] 유동인구 조회 성공');
      return sendJson(res, 200, { ok: true, data: json });
    }

    sendJson(res, 502, { ok: false, error: '소상공인 API 응답 오류', status });
  } catch (e) {
    console.error('[SBI] 유동인구 예외:', e.message);
    sendJson(res, 500, { ok: false, error: e.message });
  }
}

// ═══════════════════════════════════════════
//  메인 HTTP 서버
// ═══════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  const parsedUrl = url_mod.parse(req.url);
  const pathname  = parsedUrl.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    setCors(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  setCors(req, res);

  // GET만 허용
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method Not Allowed' });
  }

  console.log(`[${new Date().toLocaleTimeString('ko-KR')}] ${req.method} ${pathname}`);

  // 라우팅
  if (pathname === '/health') {
    return handleHealth(req, res);
  }
  if (pathname === '/api/sgis/token') {
    return handleSgisToken(req, res);
  }
  if (pathname === '/api/sgis/population') {
    return handleSgisPopulation(req, res);
  }
  if (pathname === '/api/sbi/floating') {
    return handleSbiFloating(req, res);
  }

  // 정적 파일 서빙 (index.html) — 선택적
  if (pathname === '/' || pathname === '/index.html') {
    const fs   = require('fs');
    const path = require('path');
    const file = path.join(__dirname, 'index.html');
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(file).pipe(res);
    }
  }

  sendJson(res, 404, { error: 'Not Found', path: pathname });
});

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   교촌에프앤비 상권분석 프록시 서버       ║');
  console.log(`║   http://localhost:${PORT}                   ║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  GET /health              서버 상태 확인 ║');
  console.log('║  GET /api/sgis/token      SGIS 토큰 발급 ║');
  console.log('║  GET /api/sgis/population 거주인구 조회  ║');
  console.log('║  GET /api/sbi/floating    유동인구 조회  ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  SGIS KEY  : ${SGIS_KEY}         ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`❌ 포트 ${PORT}가 이미 사용 중입니다. PORT=3001 node server.js 로 변경하세요.`);
  } else {
    console.error('❌ 서버 오류:', e.message);
  }
  process.exit(1);
});
