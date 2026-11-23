// Optional account: sign-in with Google through the Notux API (backend/).
// Notux never requires an account: with an empty API_URL (js/config.js)
// everything here is a no-op and isConfigured() is false.
//
// Flow: signInWithGoogle() leaves for `${API}/auth/google`, which comes back to
// this page with ?login_code=… (or ?auth_error=…). initAuth() trades the code for
// tokens (POST /auth/exchange) and cleans the URL.
//
// Storage:
// - localStorage 'notux.auth': { refreshToken, user }. The cached user is what
//   keeps the account visible offline and after a reload.
// - access token + expiry: in memory, mirrored to sessionStorage so a reload
//   doesn't need a refresh right away.
// Refresh tokens rotate (each use revokes the previous one and reusing a revoked
// one kills the whole session), so refreshes are serialized across tabs with a
// Web Lock and always use the newest token in localStorage.
//
// Privacy: nothing in this module logs the user's email, name or tokens.
import { API_BASE, ApiError, apiRequest, isApiConfigured, setAuthProvider } from './api.js';

const STORAGE_KEY = 'notux.auth';
const ACCESS_KEY = 'notux.auth.access';
const LOCK_NAME = 'notux-auth-refresh';
const CALLBACK_PARAMS = ['login_code', 'auth_error'];
const EXPIRY_MARGIN_MS = 30_000; // refresh up to this long before the token actually expires
const LOGOUT_TIMEOUT_MS = 3000;

export const isConfigured = isApiConfigured;

/* ---------- Storage ---------- */
function readStored() {
  if (!isConfigured()) return null;
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return stored?.refreshToken && stored.user ? stored : null;
  } catch {
    return null; // storage blocked or not JSON: treat as signed out
  }
}

function writeStored(value) {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage blocked: the session lasts until the tab closes
  }
}

let access = null; // { token, expiresAt }

function readAccess() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(ACCESS_KEY));
    return typeof saved?.token === 'string' && typeof saved.expiresAt === 'number' ? saved : null;
  } catch {
    return null;
  }
}

function setAccess(token, expiresIn) {
  // Treated as expired a bit early, so a request doesn't leave with a token about to die.
  const lifetime = expiresIn * 1000;
  access = token ? { token, expiresAt: Date.now() + lifetime - Math.min(EXPIRY_MARGIN_MS, lifetime / 4) } : null;
  try {
    if (access) sessionStorage.setItem(ACCESS_KEY, JSON.stringify(access));
    else sessionStorage.removeItem(ACCESS_KEY);
  } catch {
    // ignore
  }
}

/* ---------- State and listeners ---------- */
let currentUser = readStored()?.user ?? null;
if (currentUser) access = readAccess();
const listeners = new Set();

function setUser(user, event) {
  currentUser = user;
  for (const callback of listeners) {
    try {
      callback(user, event);
    } catch (err) {
      console.error('Auth listener failed:', err?.name ?? 'Error');
    }
  }
}

/** The signed-in user ({ id, email, name, picture, driveConnected }) or null. Known synchronously, even offline. */
export function getUser() {
  return currentUser;
}

/**
 * Calls back with (user | null, event) whenever the account changes. Events:
 * 'SIGNED_IN', 'SIGNED_OUT', 'SESSION_EXPIRED', 'USER_UPDATED'.
 * @returns {() => void} unsubscribe
 */
export function onAuthChange(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function saveSession({ accessToken, refreshToken, expiresIn, user }) {
  writeStored({ refreshToken, user });
  setAccess(accessToken, expiresIn);
}

function clearSession() {
  writeStored(null);
  setAccess(null);
}

/** Merges fields into the cached user (e.g. driveConnected: false after Drive says so). */
export function updateUser(patch) {
  const stored = readStored();
  if (!stored) return;
  const user = { ...stored.user, ...patch };
  writeStored({ ...stored, user });
  setUser(user, 'USER_UPDATED');
}

/* ---------- Tokens ---------- */
const withLock = (fn) => (navigator.locks ? navigator.locks.request(LOCK_NAME, fn) : fn());

let refreshing = null;

async function doRefresh() {
  return withLock(async () => {
    // Read inside the lock: another tab may have rotated the token meanwhile.
    const stored = readStored();
    if (!stored) {
      if (currentUser) setUser(null, 'SIGNED_OUT');
      throw new ApiError('Not signed in', { status: 401, code: 'NOT_SIGNED_IN' });
    }
    let result;
    try {
      result = await apiRequest('/auth/refresh', {
        method: 'POST',
        body: { refreshToken: stored.refreshToken },
        auth: false,
      });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.code === 'INVALID_REFRESH_TOKEN')) {
        // The session is over (expired, revoked, or signed out elsewhere).
        clearSession();
        setUser(null, 'SESSION_EXPIRED');
        throw new ApiError('The session expired', { status: 401, code: 'SESSION_EXPIRED', cause: err });
      }
      throw err; // offline / server down: keep the session for later
    }
    if (readStored()?.refreshToken !== stored.refreshToken) {
      // Signed out while the refresh was in flight: drop the new token too.
      sendLogout(result.refreshToken);
      throw new ApiError('Not signed in', { status: 401, code: 'NOT_SIGNED_IN' });
    }
    saveSession({ ...result, user: stored.user });
    return result.accessToken;
  });
}

/**
 * Gets a new access token (one refresh at a time per tab, serialized across tabs).
 * @param {string} [rejectedToken]  the token the server just refused: when a newer one
 *   already replaced it (a request that started before another one refreshed), that
 *   one is returned instead of refreshing again.
 */
export function refreshSession(rejectedToken) {
  if (!refreshing && rejectedToken && access && access.token !== rejectedToken && access.expiresAt > Date.now()) {
    return Promise.resolve(access.token);
  }
  refreshing ??= doRefresh().finally(() => (refreshing = null));
  return refreshing;
}

/** A valid access token (refreshing first when it's missing or about to expire), or null when signed out. */
export async function getAccessToken() {
  if (!readStored()) return null;
  if (access && access.expiresAt > Date.now()) return access.token;
  return refreshSession();
}

setAuthProvider({ getAccessToken, refresh: refreshSession });

/* ---------- Sign-in redirect ---------- */
// Drop ?login_code / ?auth_error and land on the home route. replaceState
// doesn't fire 'hashchange', so the router is told explicitly.
function cleanCallbackUrl() {
  const url = new URL(location.href);
  for (const p of CALLBACK_PARAMS) url.searchParams.delete(p);
  url.hash = '#/';
  history.replaceState(history.state, '', url);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

async function refreshUser() {
  const user = await apiRequest('/users/me');
  const stored = readStored();
  if (!stored) return;
  writeStored({ ...stored, user });
  if (JSON.stringify(user) !== JSON.stringify(currentUser)) setUser(user, 'USER_UPDATED');
}

/**
 * Call once on startup. Finishes a sign-in coming back from the API (exchanging
 * the one-time code), or refreshes the cached user in the background.
 * @returns {Promise<{ redirected: boolean, user?: object, error?: string }>}
 *   error: the API's auth_error ('access_denied', …) or an ApiError code.
 */
export async function initAuth() {
  if (!isConfigured()) return { redirected: false };
  const params = new URL(location.href).searchParams;
  const code = params.get('login_code');
  const authError = params.get('auth_error');
  if (!code && authError === null) {
    if (currentUser && navigator.onLine) {
      refreshUser().catch((err) => {
        if (!(err instanceof ApiError)) console.error('Could not load the account:', err?.name ?? 'Error');
      });
    }
    return { redirected: false };
  }

  // Clean first: the code is single use, a reload must not try it again.
  cleanCallbackUrl();
  if (authError !== null) return { redirected: true, error: authError || 'server_error' };

  const previous = readStored();
  try {
    const result = await apiRequest('/auth/exchange', { method: 'POST', body: { code }, auth: false });
    saveSession(result);
    // Signing in again (e.g. to reconnect Drive) replaces the previous session.
    if (previous && previous.refreshToken !== result.refreshToken) sendLogout(previous.refreshToken);
    setUser(result.user, 'SIGNED_IN');
    return { redirected: true, user: result.user };
  } catch (err) {
    return { redirected: true, error: err instanceof ApiError ? err.code : 'server_error' };
  }
}

/** Leaves the page for Google; the API sends the user back to this same page. */
export function signInWithGoogle() {
  if (!isConfigured()) throw new ApiError('API_URL is not set', { code: 'NOT_CONFIGURED' });
  if (!navigator.onLine) throw new ApiError('No network connection', { code: 'OFFLINE' });
  // Current page without query or hash: works at the domain root and under a
  // subpath (GitHub Pages /notux/). Its origin must be in the API's FRONTEND_ORIGINS.
  const redirect = location.origin + location.pathname;
  location.assign(`${API_BASE}/auth/google?redirect=${encodeURIComponent(redirect)}`);
}

function sendLogout(refreshToken) {
  if (!refreshToken || !navigator.onLine) return Promise.resolve();
  return apiRequest('/auth/logout', {
    method: 'POST',
    body: { refreshToken },
    auth: false,
    timeout: LOGOUT_TIMEOUT_MS,
  }).catch(() => {}); // best effort: the token expires on its own anyway
}

/** Signs out on this device. Local state is cleared right away, even offline. */
export async function signOut() {
  const stored = readStored();
  clearSession();
  if (currentUser) setUser(null, 'SIGNED_OUT');
  await sendLogout(stored?.refreshToken);
}

// Another tab signed in, out, or refreshed the user.
window.addEventListener('storage', (e) => {
  if (e.key !== STORAGE_KEY && e.key !== null) return;
  const stored = readStored();
  if (!stored) {
    access = null;
    if (currentUser) setUser(null, 'SIGNED_OUT');
  } else if (!currentUser || currentUser.id !== stored.user.id) {
    access = null; // another account's token
    setUser(stored.user, 'SIGNED_IN');
  } else if (JSON.stringify(currentUser) !== JSON.stringify(stored.user)) {
    setUser(stored.user, 'USER_UPDATED');
  }
});

/** Display fields for the UI. */
export function profileOf(user) {
  const email = user?.email ?? '';
  const name = user?.name?.trim() || email.split('@')[0] || 'Tu cuenta';
  return { name, email, avatarUrl: user?.picture || null };
}
