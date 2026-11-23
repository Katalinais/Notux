// Small client for the Notux API (see js/config.js). JSON in and out, Bearer
// access token, one automatic refresh + retry on 401, timeouts, and errors that
// say what went wrong in a way the UI can act on (ApiError.status / .code).
//
// The tokens themselves live in auth.js, which plugs in through setAuthProvider()
// (this module can't import auth.js: auth.js uses this one to talk to the API).
import { API_URL } from './config.js';

const DEFAULT_TIMEOUT_MS = 15_000;

/** Base URL without a trailing slash; '' when accounts are disabled. */
export const API_BASE = API_URL.trim().replace(/\/+$/, '');

export const isApiConfigured = () => API_BASE !== '';

/**
 * Error from the API or from trying to reach it.
 * `status` is the HTTP status (0 when there was no response) and `code` is the
 * API's error code when it sent one (e.g. 'DRIVE_NOT_AUTHORIZED'), or one of:
 * 'OFFLINE' (no network), 'TIMEOUT', 'NETWORK' (server unreachable, CORS…),
 * 'NOT_CONFIGURED', 'NOT_SIGNED_IN', 'HTTP_<status>' (error without a code).
 */
export class ApiError extends Error {
  constructor(message, { status = 0, code = `HTTP_${status}`, cause } = {}) {
    super(message, { cause });
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /** True when the request never got an answer (offline, timeout, server down). */
  get isNetwork() {
    return this.status === 0 && ['OFFLINE', 'TIMEOUT', 'NETWORK'].includes(this.code);
  }
}

/* ---------- Auth hooks (filled in by auth.js) ---------- */
let authProvider = {
  getAccessToken: async () => null,
  refresh: async () => {
    throw new ApiError('Not signed in', { code: 'NOT_SIGNED_IN' });
  },
};

/**
 * @param {{ getAccessToken: () => Promise<string | null>, refresh: (rejectedToken?: string) => Promise<string> }} provider
 *   getAccessToken: a valid access token (refreshing first if it expired), or null when signed out.
 *   refresh: resolves with a new access token (single-flight), given the one the server refused.
 */
export function setAuthProvider(provider) {
  authProvider = provider;
}

/* ---------- Requests ---------- */
async function send(path, { method, body, headers, token, timeout }) {
  if (!isApiConfigured()) throw new ApiError('API_URL is not set', { code: 'NOT_CONFIGURED' });
  if (!navigator.onLine) throw new ApiError('No network connection', { code: 'OFFLINE' });

  const init = { method, headers: { Accept: 'application/json', ...headers }, mode: 'cors', credentials: 'omit' };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    const passThrough = body instanceof Blob || typeof body === 'string';
    init.body = passThrough ? body : JSON.stringify(body);
    init.headers['Content-Type'] ??= 'application/json';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  init.signal = controller.signal;
  try {
    return await fetch(API_BASE + path, init);
  } catch (err) {
    if (controller.signal.aborted)
      throw new ApiError('The server took too long to answer', { code: 'TIMEOUT', cause: err });
    // fetch() only rejects when there's no response at all.
    const code = navigator.onLine ? 'NETWORK' : 'OFFLINE';
    throw new ApiError('Could not reach the server', { code, cause: err });
  } finally {
    clearTimeout(timer);
  }
}

async function errorFrom(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // not JSON (proxy error page, empty body…)
  }
  const message = Array.isArray(payload?.message) ? payload.message.join('; ') : payload?.message;
  return new ApiError(message || `HTTP ${response.status}`, {
    status: response.status,
    code: typeof payload?.code === 'string' ? payload.code : `HTTP_${response.status}`,
  });
}

/**
 * Calls the API and resolves with the parsed JSON (null for 204), the text
 * when `as: 'text'`, or `{ status, headers, text }` when `as: 'raw'`. Rejects with ApiError.
 * @param {string} path  e.g. '/drive/backups'
 * @param {{ method?: string, body?: unknown, headers?: object, auth?: boolean, timeout?: number, as?: 'json' | 'text' | 'raw' }} [options]
 *   auth (default true) sends the access token and retries once after a refresh on 401.
 */
export async function apiRequest(path, { method = 'GET', body, headers = {}, auth = true, timeout, as = 'json' } = {}) {
  const opts = { method, body, headers, timeout: timeout ?? DEFAULT_TIMEOUT_MS };
  let token = null;
  if (auth) {
    token = await authProvider.getAccessToken();
    if (!token) throw new ApiError('Not signed in', { status: 401, code: 'NOT_SIGNED_IN' });
  }

  let response = await send(path, { ...opts, token });
  if (auth && response.status === 401) {
    // Expired or revoked access token: refresh once (shared with any other
    // request that hit the same 401) and retry. A failed refresh rejects here.
    token = await authProvider.refresh(token);
    response = await send(path, { ...opts, token });
  }
  if (!response.ok) throw await errorFrom(response);
  if (as === 'raw') return { status: response.status, headers: response.headers, text: await response.text() };
  if (response.status === 204) return null;
  if (as === 'text') return response.text();
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
