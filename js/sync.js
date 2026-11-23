// Sync across devices for signed-in users. Without an account nothing here runs:
// the data lives only in this browser, as always.
//
// Model: the account holds one snapshot of all the data (the same JSON as a
// backup) with a version number. This browser remembers which version it last
// synced and whether it changed anything since ("dirty"):
//   - local changes        -> upload, saying which version they're based on
//   - newer version online -> download and replace the local data
//   - both changed         -> ask which ones to keep (never merges silently)
// The first time an account is used in a browser that already has data, and
// the account has data too, it also asks.
//
// Storage: localStorage 'notux.sync' = { userId, version, dirty, seq, syncedAt }.
// Shared by every tab; network work is serialized with a Web Lock, and a tab
// that replaces the data tells the others (BroadcastChannel) to reload theirs.
import { $, h } from './dom.js';
import { LOCALE } from './dates.js';
import { showToast } from './toast.js';
import { ApiError, apiRequest, isApiConfigured } from './api.js';
import { getUser, onAuthChange } from './auth.js';
import { exportAll, onDataChange, withoutChangeNotifications } from './db.js';
import { backupFileName, createBackup, describeCounts, parseBackup, restoreBackup, summarize } from './backup.js';

const STATE_KEY = 'notux.sync';
const LOCK_NAME = 'notux-sync';
const PUSH_DELAY_MS = 2000; // gather a burst of edits into one upload
const POLL_MS = 60_000; // look for changes from other devices while visible
const BUSY_RETRY_MS = 15_000;
const TIMEOUT_MS = 70_000; // the free Render instance can take ~1 min to wake up

let options = null; // { getDb, onRemoteApplied }
let status = 'off'; // off | syncing | synced | pending | offline | conflict | error
let pushTimer = null;
let pollTimer = null;
let running = null;
let conflict = null; // { kind, remote: { version, updatedAt, parsed }, localCounts }
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('notux-sync') : null;

/* ---------- State ---------- */
function readState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY));
    return s && typeof s.userId === 'string' && Number.isInteger(s.version) ? s : null;
  } catch {
    return null;
  }
}

function writeState(state) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // storage blocked: it re-checks with the server next time
  }
}

function stateFor(user) {
  const s = readState();
  return s?.userId === user.id ? s : null;
}

function setStatus(next) {
  status = next;
  renderStatus();
}

/* ---------- Helpers ---------- */
const db = () => options.getDb();
const active = () => !!options && isApiConfigured() && !!getUser();

async function localSnapshot() {
  const data = await exportAll(db());
  return { counts: summarize(data), empty: ['tasks', 'notes', 'subjects', 'schedule'].every((s) => !data[s].length) };
}

// The user is in the middle of something: replacing the data now would close it.
function userIsBusy() {
  if (document.querySelector('dialog[open]')) return true;
  const el = document.activeElement;
  return !!el && ['INPUT', 'TEXTAREA'].includes(el.tagName) && el.value.trim() !== '' && el.type !== 'search';
}

const withLock = (fn) => (navigator.locks ? navigator.locks.request(LOCK_NAME, fn) : fn());

// An account with nothing synced yet, shown as the "account" side of a choice.
const EMPTY_DATA = { tasks: [], notes: [], subjects: [], schedule: [], config: [] };
const EMPTY_REMOTE = { version: 0, parsed: { data: EMPTY_DATA, counts: summarize(EMPTY_DATA), exportedAt: null } };

/* ---------- Network ---------- */
const getRemoteState = () => apiRequest('/sync', { timeout: TIMEOUT_MS });

async function getRemoteData() {
  const res = await apiRequest('/sync/data', { as: 'raw', timeout: TIMEOUT_MS });
  if (res.status === 204) return null;
  return { version: Number(res.headers.get('X-Sync-Version')), parsed: parseBackup(res.text) };
}

async function upload(user, baseVersion) {
  const seqAtExport = stateFor(user)?.seq ?? 0;
  const { blob } = await createBackup(db());
  const result = await apiRequest('/sync/data', {
    method: 'PUT',
    body: await blob.text(),
    headers: { 'Content-Type': 'application/json', 'X-Base-Version': String(baseVersion) },
    timeout: TIMEOUT_MS,
  });
  // Edits made while uploading aren't in this version: stay dirty for another round.
  const now = stateFor(user) ?? { seq: 0 };
  const dirty = (now.seq ?? 0) !== seqAtExport;
  writeState({ userId: user.id, version: result.version, dirty, seq: now.seq ?? 0, syncedAt: Date.now() });
  if (dirty) schedulePush();
}

async function apply(user, remote) {
  await withoutChangeNotifications(() => restoreBackup(db(), remote.parsed.data));
  writeState({ userId: user.id, version: remote.version, dirty: false, seq: 0, syncedAt: Date.now() });
  await options.onRemoteApplied();
  channel?.postMessage('applied');
}

/* ---------- Reconcile ---------- */
async function reconcileOnce() {
  const user = getUser();
  if (!user || conflict) return;
  if (!navigator.onLine) {
    setStatus(stateFor(user)?.dirty ? 'pending' : 'offline');
    return;
  }
  setStatus('syncing');
  const remote = await getRemoteState();
  const state = stateFor(user);

  if (!state) {
    // First sync of this account in this browser.
    const local = await localSnapshot();
    const otherAccount = readState() !== null; // this browser's data was synced with someone else
    if (remote.version === 0 && local.empty) {
      writeState({ userId: user.id, version: 0, dirty: false, seq: 0, syncedAt: Date.now() });
    } else if (remote.version === 0 && !otherAccount) {
      await upload(user, 0);
    } else if (remote.version > 0 && local.empty) {
      const data = await getRemoteData();
      if (data && !(await applyWhenIdle(user, data))) return;
    } else {
      // Both have data, or the data here belongs to another account: never mix them silently.
      await askWhichToKeep(
        otherAccount ? 'other' : 'first',
        user,
        local,
        remote.version === 0 ? EMPTY_REMOTE : undefined,
      );
      return;
    }
  } else if (remote.version === state.version) {
    if (state.dirty) await upload(user, state.version);
  } else if (remote.version > state.version) {
    const data = await getRemoteData();
    if (!data) return;
    if (state.dirty) {
      await askWhichToKeep('both', user, await localSnapshot(), data);
      return;
    }
    if (!(await applyWhenIdle(user, data))) return;
  } else {
    // The account has an older version than we remember (e.g. its data was reset): ours wins.
    await upload(user, remote.version);
  }
  setStatus('synced');
}

// Returns false when it had to wait because the user is in the middle of something.
async function applyWhenIdle(user, data) {
  if (userIsBusy()) {
    setStatus('pending');
    setTimeout(() => reconcile(), BUSY_RETRY_MS);
    return false;
  }
  await apply(user, data);
  showToast('Se cargaron los datos de tu cuenta.');
  return true;
}

/** Checks the account and uploads or downloads as needed. One at a time, across tabs. */
export function reconcile() {
  if (!active()) return Promise.resolve();
  running ??= withLock(async () => {
    try {
      await reconcileOnce();
    } catch (err) {
      handleError(err);
    }
  }).finally(() => (running = null));
  return running;
}

function handleError(err) {
  if (err instanceof ApiError && err.code === 'SYNC_CONFLICT') {
    setTimeout(() => reconcile(), 0); // someone uploaded first: look again
    return;
  }
  if (err instanceof ApiError && err.isNetwork) {
    setStatus(stateFor(getUser() ?? { id: '' })?.dirty ? 'pending' : 'offline');
    return;
  }
  if (err instanceof ApiError && ['SESSION_EXPIRED', 'NOT_SIGNED_IN'].includes(err.code)) return;
  console.error('Sync failed:', err?.code ?? err?.name ?? 'Error');
  setStatus('error');
}

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => reconcile(), PUSH_DELAY_MS);
}

/* ---------- Conflicts ---------- */
async function askWhichToKeep(kind, user, local, data) {
  const remote = data ?? (await getRemoteData());
  if (!remote) return reconcileOnce();
  conflict = { kind, remote, localCounts: local.counts, userId: user.id };
  setStatus('conflict');
  openConflictDialog();
}

function openConflictDialog() {
  if (!conflict) return;
  const { kind, remote, localCounts } = conflict;
  $('sync-desc').textContent = {
    first: 'Tu cuenta ya tiene datos guardados, y este navegador también. ¿Cuáles quieres usar?',
    other: 'Los datos de este navegador se sincronizaron antes con otra cuenta. ¿Cuáles quieres usar en esta?',
    both: 'Hiciste cambios en este navegador y, mientras tanto, también en otro dispositivo. ¿Cuáles quieres conservar?',
  }[kind];
  const when = remote.parsed.exportedAt
    ? new Date(remote.parsed.exportedAt).toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' })
    : '';
  $('sync-remote').textContent = describeCounts(remote.parsed.counts) + (when ? ` · guardado el ${when}` : '');
  $('sync-local').textContent = describeCounts(localCounts);
  $('sync-error').hidden = true;
  if (!$('sync-dialog').open) $('sync-dialog').showModal();
}

async function resolveConflict(choice) {
  const user = getUser();
  if (!conflict || !user || conflict.userId !== user.id) return;
  const buttons = $('sync-dialog').querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    await withLock(async () => {
      if (choice === 'remote') {
        await apply(user, conflict.remote);
      } else {
        // Keep this browser's data: upload it over the account's current version.
        writeState({
          ...(stateFor(user) ?? { seq: 0 }),
          userId: user.id,
          version: conflict.remote.version,
          dirty: true,
        });
        await upload(user, conflict.remote.version);
      }
    });
    conflict = null;
    $('sync-dialog').close();
    setStatus('synced');
    showToast(
      choice === 'remote'
        ? 'Listo: usas los datos de tu cuenta.'
        : 'Listo: tu cuenta tiene ahora los datos de este navegador.',
    );
  } catch (err) {
    if (err instanceof ApiError && err.code === 'SYNC_CONFLICT') {
      // Yet another change elsewhere: show the newest version and ask again.
      conflict = null;
      $('sync-dialog').close();
      reconcile();
      return;
    }
    console.error('Could not resolve the sync conflict:', err?.code ?? err?.name ?? 'Error');
    $('sync-error').textContent =
      err instanceof ApiError && err.isNetwork
        ? 'No se pudo conectar con el servidor. Inténtalo de nuevo.'
        : 'No se pudo completar. Tus datos no cambiaron; inténtalo de nuevo.';
    $('sync-error').hidden = false;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

async function downloadLocalCopy() {
  try {
    const { blob } = await createBackup(db());
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: backupFileName() });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (err) {
    console.error('Could not create the backup:', err);
    showToast('No se pudo descargar la copia.', { type: 'error' });
  }
}

/* ---------- Status in Ajustes → Cuenta ---------- */
function ago(ms) {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'hace un momento';
  if (minutes < 60) return `hace ${minutes} min`;
  return new Date(ms).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' });
}

function renderStatus() {
  const el = $('sync-status');
  const user = getUser();
  el.hidden = !options || !isApiConfigured() || !user;
  if (el.hidden) return;
  const syncedAt = stateFor(user)?.syncedAt;
  const texts = {
    syncing: 'Sincronizando…',
    synced: `Sincronizado con tu cuenta${syncedAt ? ` · ${ago(syncedAt)}` : ''}.`,
    pending: 'Hay cambios por sincronizar; se envían cuando haya conexión.',
    offline: 'Sin conexión: se sincroniza cuando vuelva internet.',
    conflict: 'Sincronización en pausa: elige qué datos conservar.',
    error: 'No se pudo sincronizar. Se reintentará en un momento.',
    off: '',
  };
  const children = [h('span', {}, texts[status] ?? '')];
  if (status === 'conflict') {
    children.push(
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: openConflictDialog }, 'Elegir'),
    );
  } else if (status === 'error' || status === 'synced') {
    children.push(
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => reconcile() }, 'Sincronizar ahora'),
    );
  }
  el.className = `sync-status small ${status === 'conflict' || status === 'error' ? 'notice-warn' : 'muted'}`;
  el.replaceChildren(...children);
}

/* ---------- Wiring ---------- */
/**
 * Starts syncing (call once, after the database is open).
 * @param {{ getDb: () => IDBDatabase, onRemoteApplied: () => Promise<void> }} opts
 *   onRemoteApplied reloads everything the app keeps in memory.
 */
export function initSync(opts) {
  options = opts;

  // Tracked even while signed out: when that account signs in again, these edits
  // count as changes made here (uploaded, or a conflict if the account changed too).
  onDataChange(() => {
    const state = readState();
    if (!state) return; // never synced here: the first sync decides what to do with this data
    writeState({ ...state, dirty: true, seq: (state.seq ?? 0) + 1 });
    if (!active()) return;
    if (status !== 'conflict') setStatus(navigator.onLine ? 'syncing' : 'pending');
    schedulePush();
  });

  onAuthChange((user, event) => {
    if (!user) {
      conflict = null;
      if ($('sync-dialog').open) $('sync-dialog').close();
      setStatus('off');
      return;
    }
    if (event === 'SIGNED_IN') reconcile();
    else renderStatus();
  });

  channel?.addEventListener('message', (e) => {
    if (e.data === 'applied') options.onRemoteApplied();
  });
  window.addEventListener('online', () => reconcile());
  window.addEventListener('offline', () => active() && setStatus(stateFor(getUser())?.dirty ? 'pending' : 'offline'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reconcile();
  });
  pollTimer = setInterval(() => document.visibilityState === 'visible' && reconcile(), POLL_MS);

  $('sync-use-remote').addEventListener('click', () => resolveConflict('remote'));
  $('sync-use-local').addEventListener('click', () => resolveConflict('local'));
  $('sync-download').addEventListener('click', downloadLocalCopy);
  $('sync-later').addEventListener('click', () => $('sync-dialog').close());

  renderStatus();
  reconcile();
}

/** For tests and debugging. */
export function stopSync() {
  clearInterval(pollTimer);
  clearTimeout(pushTimer);
}
