// In-memory mock of the Notux API (the contract the real backend in backend/
// implements), for developing the frontend without Google credentials.
// Plain Node, no dependencies. Everything is lost when it stops.
//
//   npm run mock-api
//   # then set API_URL = 'http://localhost:3100' in js/config.js
//
// "Google" is fake: GET /auth/google redirects straight back to the app with a
// login code for a test user. Drive backups are kept in memory.
//
// Environment variables:
//   PORT              port to listen on (default 3100)
//   FRONTEND_ORIGINS  comma-separated allowed origins (default http://localhost:8080)
//   MOCK_ACCESS_TTL   access token lifetime in seconds (default 900; try 20 to see silent refreshes)
//   MOCK_DRIVE        ok | unauthorized | unavailable (default ok)
//   MOCK_AUTH_ERROR   make sign-in fail with ?auth_error=<value>, e.g. access_denied
//   MOCK_DELAY        extra latency in ms for every response (default 0)
//
// The same switches can be flipped while it runs (handy from the browser bar):
//   GET  /__mock                                  current state
//   GET  /__mock?drive=unauthorized               ok | unauthorized | unavailable
//   GET  /__mock?expire=1                         expire every access token now
//   GET  /__mock?access_ttl=20&delay=500&auth_error=access_denied  (auth_error= clears it)
// Signing in again resets drive=unauthorized to ok, like reconnecting Google would.
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.PORT) || 3100;
const ORIGINS = (process.env.FRONTEND_ORIGINS || 'http://localhost:8080')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const BODY_LIMIT = 25 * 1024 * 1024;
const LOGIN_CODE_TTL_MS = 60_000;
const REFRESH_TTL_MS = 30 * 24 * 3600_000;
const KEEP_BACKUPS = 10;
const LIST_MAX = 20;

const state = {
  drive: process.env.MOCK_DRIVE || 'ok',
  accessTtl: Number(process.env.MOCK_ACCESS_TTL) || 900,
  authError: process.env.MOCK_AUTH_ERROR || '',
  delay: Number(process.env.MOCK_DELAY) || 0,
};

const USER = { id: 'mock-user-1', email: 'estudiante@example.com', name: 'Estudiante de Prueba', picture: null };
const userView = () => ({ ...USER, driveConnected: state.drive !== 'unauthorized' });

const loginCodes = new Map(); // code -> expiresAt
const accessTokens = new Map(); // token -> expiresAt
const refreshTokens = new Map(); // token -> { family, revoked, expiresAt }
const backups = []; // newest first: { id, name, createdTime, size, body }

const token = (bytes = 24) => randomBytes(bytes).toString('base64url');

/* ---------- HTTP helpers ---------- */
class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const REASONS = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  413: 'Payload Too Large',
};

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !ORIGINS.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function send(req, res, status, body, headers = {}) {
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...corsHeaders(req),
    ...(payload ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new HttpError(413, 'request entity too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

/* ---------- Auth ---------- */
function issueTokens(family = token(8)) {
  const accessToken = `mock-access.${token()}`;
  const refreshToken = token(32);
  accessTokens.set(accessToken, Date.now() + state.accessTtl * 1000);
  refreshTokens.set(refreshToken, { family, revoked: false, expiresAt: Date.now() + REFRESH_TTL_MS });
  return { accessToken, refreshToken, expiresIn: state.accessTtl };
}

function requireUser(req) {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  const expiresAt = match && accessTokens.get(match[1]);
  if (!expiresAt || expiresAt < Date.now()) throw new HttpError(401, 'Unauthorized');
}

function requireDrive() {
  if (state.drive === 'unauthorized')
    throw new HttpError(403, 'Google Drive is not authorized', 'DRIVE_NOT_AUTHORIZED');
  if (state.drive === 'unavailable') throw new HttpError(502, 'Google Drive is unavailable', 'DRIVE_UNAVAILABLE');
}

function allowedRedirect(redirect) {
  try {
    const url = new URL(redirect);
    return ORIGINS.includes(url.origin) ? url : null;
  } catch {
    return null;
  }
}

/* ---------- Drive ---------- */
function backupName(date) {
  const p = (n) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  return `notux-respaldo-${day}-${p(date.getHours())}${p(date.getMinutes())}.json`;
}

const meta = ({ id, name, createdTime, size }) => ({ id, name, createdTime, size });

function findBackup(id) {
  const backup = backups.find((b) => b.id === id);
  if (!backup) throw new HttpError(404, 'Backup not found');
  return backup;
}

/* ---------- Routes ---------- */
async function route(req, res, url) {
  const { pathname } = url;
  const key = `${req.method} ${pathname}`;

  if (key === 'GET /health') return send(req, res, 200, { status: 'ok', info: { database: { status: 'up' } } });

  if (key === 'GET /__mock') {
    const q = url.searchParams;
    if (q.has('drive')) state.drive = q.get('drive');
    if (q.has('access_ttl')) state.accessTtl = Number(q.get('access_ttl')) || state.accessTtl;
    if (q.has('auth_error')) state.authError = q.get('auth_error');
    if (q.has('delay')) state.delay = Number(q.get('delay')) || 0;
    if (q.get('expire') === '1') for (const t of accessTokens.keys()) accessTokens.set(t, 0);
    return send(req, res, 200, { ...state, backups: backups.length, origins: ORIGINS });
  }

  if (key === 'GET /auth/google') {
    const redirect = allowedRedirect(url.searchParams.get('redirect') ?? '');
    if (!redirect) throw new HttpError(400, 'redirect must start with one of FRONTEND_ORIGINS');
    if (state.authError) {
      redirect.searchParams.set('auth_error', state.authError);
    } else {
      const code = token();
      loginCodes.set(code, Date.now() + LOGIN_CODE_TTL_MS);
      if (state.drive === 'unauthorized') state.drive = 'ok'; // consenting again restores Drive access
      redirect.searchParams.set('login_code', code);
    }
    return send(req, res, 302, undefined, { Location: redirect.href });
  }

  if (key === 'POST /auth/exchange') {
    const { code } = await readJson(req);
    const expiresAt = loginCodes.get(code);
    loginCodes.delete(code); // single use
    if (!expiresAt || expiresAt < Date.now()) throw new HttpError(401, 'Invalid login code', 'INVALID_LOGIN_CODE');
    return send(req, res, 200, { ...issueTokens(), user: userView() });
  }

  if (key === 'POST /auth/refresh') {
    const { refreshToken } = await readJson(req);
    const record = refreshTokens.get(refreshToken);
    if (!record || record.expiresAt < Date.now()) {
      throw new HttpError(401, 'Invalid refresh token', 'INVALID_REFRESH_TOKEN');
    }
    if (record.revoked) {
      // Reuse of a rotated token: assume it was stolen and end the whole session.
      for (const r of refreshTokens.values()) if (r.family === record.family) r.revoked = true;
      console.warn('  ! refresh token reused: session family revoked');
      throw new HttpError(401, 'Invalid refresh token', 'INVALID_REFRESH_TOKEN');
    }
    record.revoked = true;
    return send(req, res, 200, issueTokens(record.family));
  }

  if (key === 'POST /auth/logout') {
    const { refreshToken } = await readJson(req);
    const record = refreshTokens.get(refreshToken);
    if (record) for (const r of refreshTokens.values()) if (r.family === record.family) r.revoked = true;
    return send(req, res, 204);
  }

  if (key === 'GET /users/me') {
    requireUser(req);
    return send(req, res, 200, userView());
  }

  if (pathname === '/drive/backups' || pathname.startsWith('/drive/backups/')) {
    requireUser(req);
    const id = pathname === '/drive/backups' ? null : decodeURIComponent(pathname.slice('/drive/backups/'.length));

    if (req.method === 'GET' && id === null) {
      requireDrive();
      return send(req, res, 200, backups.slice(0, LIST_MAX).map(meta));
    }
    if (req.method === 'POST' && id === null) {
      const body = await readBody(req);
      requireDrive();
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new HttpError(400, 'Invalid backup', 'INVALID_BACKUP');
      }
      if (!parsed || typeof parsed !== 'object' || parsed.app !== 'notux' || parsed.format !== 1) {
        throw new HttpError(400, 'Invalid backup', 'INVALID_BACKUP');
      }
      const now = new Date();
      const backup = {
        id: `mock-file-${token(9)}`,
        name: backupName(now),
        createdTime: now.toISOString(),
        size: String(Buffer.byteLength(body)), // Drive reports sizes as strings
        body,
      };
      backups.unshift(backup);
      backups.splice(KEEP_BACKUPS);
      return send(req, res, 201, meta(backup));
    }
    if (req.method === 'GET' && id !== null) {
      requireDrive();
      return send(req, res, 200, findBackup(id).body);
    }
    if (req.method === 'DELETE' && id !== null) {
      requireDrive();
      backups.splice(backups.indexOf(findBackup(id)), 1);
      return send(req, res, 204);
    }
  }

  throw new HttpError(404, `Cannot ${req.method} ${pathname}`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const started = Date.now();
  res.on('finish', () => {
    if (req.method !== 'OPTIONS')
      console.log(`${req.method} ${url.pathname} → ${res.statusCode} (${Date.now() - started} ms)`);
  });

  if (req.method === 'OPTIONS') return send(req, res, 204);
  if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay));
  try {
    await route(req, res, url);
  } catch (caught) {
    let err = caught;
    if (!(err instanceof HttpError)) {
      console.error(err);
      err = new HttpError(500, 'Internal server error');
    }
    const body = { statusCode: err.status, message: err.message, error: REASONS[err.status] ?? 'Error' };
    if (err.code) body.code = err.code;
    if (!res.headersSent) send(req, res, err.status, body, err.status === 413 ? { Connection: 'close' } : {});
  }
});

server.listen(PORT, () => {
  console.log(`Notux mock API on http://localhost:${PORT}`);
  console.log(`  allowed origins: ${ORIGINS.join(', ')}`);
  console.log(
    `  drive=${state.drive} access_ttl=${state.accessTtl}s${state.authError ? ` auth_error=${state.authError}` : ''}`,
  );
  console.log(`  set API_URL = 'http://localhost:${PORT}' in js/config.js`);
});
