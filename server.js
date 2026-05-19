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
const { URL: WHATWG_URL } = require('url');

// ───────────────────────────────────────────
//  설정값 (환경변수 > 하드코딩 fallback)
// ───────────────────────────────────────────
const PORT         = process.env.PORT         || 3000;
const SGIS_KEY     = process.env.SGIS_KEY     || 'bf2a3156886f4639aab5';
const SGIS_SECRET  = process.env.SGIS_SECRET  || '859b0252556c4566b84a';
const SBI_KEY      = process.env.SBI_KEY      || '0192b883bc62868715471a636f6346a000db965d40d388c62a9c554bd225b4ae';
const KAKAO_REST_KEY = process.env.KAKAO_REST_KEY || '0f113d6fab4715e5ca6007660dfbc82b';
// 서울시 생활인구 API 키 (data.seoul.go.kr 무료 발급)
const SEOUL_DATA_KEY = process.env.SEOUL_DATA_KEY || '7565676557636a68313130645343727a';

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
/**
 * GET /api/sgis/population?x_crd=경도&y_crd=위도&year=2024
 * 카카오 좌표→행정구역 + 행정안전부 주민등록 인구 조회
 */
async function handleSgisPopulation(req, res) {
  try {
    const q = parseQuery(req.url);
    if (!q.x_crd || !q.y_crd) {
      return sendJson(res, 400, { ok: false, error: 'x_crd(경도), y_crd(위도) 파라미터 필요' });
    }

    const lng = q.x_crd; // 경도
    const lat = q.y_crd; // 위도

    // Step 1: 카카오 좌표→행정구역 코드 조회 (REST API 키 사용)
    const kakaoUrl =
      `https://dapi.kakao.com/v2/local/geo/coord2regioncode.json?x=${lng}&y=${lat}`;

    console.log('[POP] Step1 카카오 행정구역 조회:', kakaoUrl);
    const kakaoRes = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'dapi.kakao.com',
        path: `/v2/local/geo/coord2regioncode.json?x=${lng}&y=${lat}`,
        method: 'GET',
        headers: { 'Authorization': `KakaoAK ${KAKAO_REST_KEY}` }
      };
      const r = https.request(options, (res2) => {
        let body = '';
        res2.on('data', c => body += c);
        res2.on('end', () => {
          try { resolve({ status: res2.statusCode, json: JSON.parse(body) }); }
          catch { resolve({ status: res2.statusCode, json: null, raw: body }); }
        });
      });
      r.on('error', reject);
      r.setTimeout(8000, () => { r.destroy(); reject(new Error('timeout')); });
      r.end();
    });

    console.log('[POP] Step1 응답:', JSON.stringify(kakaoRes.json)?.substring(0, 200));

    let regionCode = null; // 10자리 법정동 코드 (admCd용)
    let regionCode5 = null; // 5자리 시군구 코드
    let regionName = null;
    if (kakaoRes.json?.documents?.length > 0) {
      const doc = kakaoRes.json.documents.find(d => d.region_type === 'B') || kakaoRes.json.documents[0];
      regionCode = doc.code;           // 10자리 전체 코드
      regionCode5 = doc.code?.substring(0, 5); // 5자리 시군구 코드
      regionName = doc.address_name;
      console.log('[POP] 행정구역:', regionName, '10자리코드:', regionCode);
    }

    if (!regionCode) {
      console.error('[POP] 행정구역 코드 조회 실패');
      return sendJson(res, 502, { ok: false, error: '행정구역 코드 조회 실패' });
    }

    // admmCd: 카카오 5자리 코드 → 행정기관코드 10자리 변환 (뒤에 00000 추가)
    const admmCd10 = regionCode5 + '00000';
    const yyyymm = '202412';
    const moiUrl =
      `https://apis.data.go.kr/1741000/admmPpltnHhStus/selectAdmmPpltnHhStus` +
      `?serviceKey=${encodeURIComponent(SBI_KEY)}` +
      `&admmCd=${admmCd10}` +
      `&srchFrYm=${yyyymm}&srchToYm=${yyyymm}` +
      `&lv=6&type=json&numOfRows=1&pageNo=1`;

    console.log('[POP] Step2 행안부 인구 조회:', moiUrl);
    const { status: s2, json: j2, raw: r2 } = await fetchJson(moiUrl);
    console.log('[POP] Step2 HTTP상태:', s2);
    console.log('[POP] Step2 JSON:', JSON.stringify(j2)?.substring(0, 500));
    console.log('[POP] Step2 RAW:', r2?.substring(0, 500));

    // 응답구조: Response.items.item (단일객체 또는 배열)
    const rawItem = j2?.Response?.items?.item || j2?.response?.body?.items?.item;
    const items2 = rawItem ? (Array.isArray(rawItem) ? rawItem : [rawItem]) : [];

    if (items2.length > 0) {
      let totPpltn=0, mPpltn=0, fPpltn=0, hhCnt=0;
      items2.forEach(item => {
        totPpltn += parseInt(item.totNmprCnt||0);
        mPpltn   += parseInt(item.maleNmprCnt||0);
        fPpltn   += parseInt(item.femlNmprCnt||0);
        hhCnt    += parseInt(item.hhCnt||0);
      });
      console.log('[POP] ✅ 인구 조회 성공 — 총인구:', totPpltn, '항목수:', items2.length);
      console.log('[POP] 첫 항목 필드:', JSON.stringify(Object.keys(items2[0])));
      return sendJson(res, 200, {
        ok: true,
        data: {
          admcode:      admmCd10,
          tot_ppltn:    totPpltn,
          male_ppltn:   mPpltn,
          female_ppltn: fPpltn,
          tot_family:   hhCnt,
          region_name:  regionName,
          region_code:  regionCode5,
        }
      });
    }

    console.warn('[POP] 인구 데이터 없음. admmCd:', regionCode5);
    console.warn('[POP] 응답 전체:', JSON.stringify(j2)?.substring(0, 500));
    return sendJson(res, 200, {
      ok: true,
      data: { region_name: regionName, region_code: regionCode5, admcode: admmCd10, tot_ppltn: null }
    });

  } catch (e) {
    console.error('[POP] 인구 조회 예외:', e.message);
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

/**
 * GET /api/sbi/sangkwon?cx=경도&cy=위도&radius=반경
 * 소상공인 상권분석 서비스 - 업종별 매출/유동인구 데이터
 * 공공데이터포털 소상공인시장진흥공단 상권분석 API 활용
 */
async function handleSbiSangkwon(req, res) {
  try {
    const q = parseQuery(req.url);
    if (!q.cx || !q.cy) {
      return sendJson(res, 400, { ok: false, error: 'cx, cy 파라미터 필요' });
    }
    const cx = parseFloat(q.cx).toFixed(6);
    const cy = parseFloat(q.cy).toFixed(6);
    const radius = parseInt(q.radius || 500);

    // baroApi: 소상공인 주변 상권 기준정보 (정상 작동 확인된 유일한 엔드포인트)
    const baroUrl =
      `https://apis.data.go.kr/B553077/api/open/sdsc2/baroApi` +
      `?serviceKey=${encodeURIComponent(SBI_KEY)}` +
      `&cx=${cx}&cy=${cy}&radius=${radius}&numOfRows=10&type=json`;

    console.log('[SANGKWON] baroApi 조회:', baroUrl.substring(0, 100));
    const { status: s1, json: j1 } = await fetchJson(baroUrl);
    console.log('[SANGKWON] baroApi 상태:', s1, JSON.stringify(j1)?.substring(0, 150));

    // 참고: floatingPpltn/agePopltn/trdarBssh 는 해당 serviceKey로 미제공(404)
    // 시간대/연령대 분포는 index.html의 상권유형 패턴으로 처리

    return sendJson(res, 200, {
      ok: true,
      baro: j1,
      statuses: { s1, s2: 'skipped', s3: 'skipped' },
      note: 'floatingPpltn/agePopltn API 미제공 - 상권유형 패턴 사용'
    });

  } catch (e) {
    console.error('[SANGKWON] 예외:', e.message);
    sendJson(res, 500, { ok: false, error: e.message });
  }
}


/**
 * GET /api/seoul/living?admcode=행정동코드&hour=HH
 * 서울시 실시간 생활인구 (서울시 열린데이터광장, 무료)
 * 발급: https://data.seoul.go.kr 회원가입 후 API 키 신청
 * 실행: SEOUL_DATA_KEY=발급키 node server.js
 */
async function handleSeoulLiving(req, res) {
  try {
    if (!SEOUL_DATA_KEY) {
      return sendJson(res, 200, { ok: false, reason: 'SEOUL_DATA_KEY 미설정', demo: true });
    }
    const q = parseQuery(req.url);
    const admcode = q.admcode || '1168010100';
    const now = new Date();
    const date = (q.date || now.toISOString().slice(0,10).replace(/-/g,''));
    const hour = String(q.hour || now.getHours()).padStart(2,'0');
    const seoulUrl = `http://openapi.seoul.go.kr:8088/${SEOUL_DATA_KEY}/json/RtmddpMobilityStats/1/100/${admcode}/${date}${hour}00`;
    console.log('[SEOUL] 생활인구 조회:', seoulUrl.substring(0,80));
    const { status, json: j, raw } = await fetchJson(seoulUrl);
    console.log('[SEOUL] 상태:', status, raw?.substring(0,100));
    if (status === 200 && j) return sendJson(res, 200, { ok: true, data: j });
    return sendJson(res, 200, { ok: false, reason: 'API 오류', status, demo: true });
  } catch (e) {
    sendJson(res, 200, { ok: false, reason: e.message, demo: true });
  }
}

// ═══════════════════════════════════════════
//  메인 HTTP 서버
// ═══════════════════════════════════════════
const server = http.createServer(async (req, res) => {
let pathname;
try {
  pathname = new WHATWG_URL(req.url, 'http://localhost').pathname;
} catch(e) { pathname = '/'; }

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

  if (pathname === '/api/sbi/sangkwon') {
    return handleSbiSangkwon(req, res);
  }

  if (pathname === '/api/seoul/living') {
    return handleSeoulLiving(req, res);
  }

  // 정적 파일 서빙 (index.html, CSS, JS 등)
  if (pathname === '/' || pathname === '/index.html') {
    const fs   = require('fs');
    const path = require('path');
    const file = path.join(__dirname, 'index.html');
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(content);
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
  console.log(`  브라우저에서 열기: http://localhost:${PORT}`);
  console.log('  종료: Ctrl+C');
  console.log('');

  // 브라우저 자동 열기 (Windows)
  const { exec } = require('child_process');
  setTimeout(() => {
    exec(`start http://localhost:${PORT}`, (err) => {
      if (err) console.log('  (브라우저 자동 열기 실패 - 수동으로 접속하세요)');
    });
  }, 500);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`❌ 포트 ${PORT}가 이미 사용 중입니다. PORT=3001 node server.js 로 변경하세요.`);
  } else {
    console.error('❌ 서버 오류:', e.message);
  }
  process.exit(1);
});
