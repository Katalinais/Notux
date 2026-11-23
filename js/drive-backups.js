// Backups in the user's Google Drive, through the Notux API (Ajustes → Respaldo).
// Only shown when signed in. The backup itself is the same JSON as the
// downloaded file (createBackup), and restoring goes through the same
// confirmation dialog as a local file (the caller's confirmRestore).
import { $, h, icon } from './dom.js';
import { showToast } from './toast.js';
import { LOCALE } from './dates.js';
import { ApiError, apiRequest } from './api.js';
import { getUser, isConfigured, onAuthChange, signInWithGoogle, updateUser } from './auth.js';
import { createBackup, describeCounts, parseBackup, InvalidBackupError } from './backup.js';

const TRANSFER_TIMEOUT_MS = 120_000; // up to 25 MB each way on a slow connection
const DELETE_CONFIRM_MS = 4000;

let options = null; // { getDb, confirmRestore, onBackupSaved }
let backups = null; // [{ id, name, createdTime, size }] once loaded
let loading = false;
let listError = null; // ApiError from the last load
let saving = false;
let busyId = null; // backup being restored or deleted
let busyAction = null; // 'restore' | 'delete'
let confirmDeleteId = null;
let confirmTimer = null;
let loadSeq = 0;

const isNotAuthorized = (err) => err?.code === 'DRIVE_NOT_AUTHORIZED';
const sessionGone = (err) => err?.code === 'SESSION_EXPIRED' || err?.code === 'NOT_SIGNED_IN';

function messageFor(err) {
  if (!(err instanceof ApiError)) return 'Algo salió mal con Google Drive.';
  switch (err.code) {
    case 'OFFLINE':
      return 'Sin conexión. Inténtalo cuando vuelvas a tener internet.';
    case 'NETWORK':
      return 'No se pudo conectar con el servidor de Notux.';
    case 'TIMEOUT':
      return 'El servidor tardó demasiado en responder. Inténtalo de nuevo.';
    case 'DRIVE_UNAVAILABLE':
      return 'Google Drive no responde ahora. Inténtalo en un rato.';
    case 'DRIVE_NOT_AUTHORIZED':
      return 'Notux ya no tiene permiso para usar tu Google Drive.';
    case 'SESSION_EXPIRED':
    case 'NOT_SIGNED_IN':
      return 'Tu sesión expiró. Vuelve a iniciar sesión.';
    case 'INVALID_BACKUP':
      return 'El servidor no aceptó el respaldo.';
  }
  if (err.status === 404) return 'Ese respaldo ya no está en tu Google Drive.';
  if (err.status === 413) return 'El respaldo es demasiado grande para guardarlo en Google Drive (máximo 25 MB).';
  return 'Algo salió mal con Google Drive.';
}

// Errors any action can hit: remember that Drive needs reconnecting.
function noteError(err) {
  if (isNotAuthorized(err) && getUser()?.driveConnected !== false) updateUser({ driveConnected: false });
  if (!(err instanceof ApiError)) console.error('Google Drive request failed:', err);
}

function report(err) {
  noteError(err);
  // These two already show in the section itself (or via the account's toast).
  if (isNotAuthorized(err) || sessionGone(err)) return;
  showToast(messageFor(err), { type: 'error' });
}

/* ---------- Formatting ---------- */
const dateFmt = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' });

function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  const [value, unit] = n >= 1_000_000 ? [n / 1_000_000, 'megabyte'] : [Math.max(n / 1000, 1), 'kilobyte'];
  return new Intl.NumberFormat(LOCALE, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: value < 10 ? 1 : 0,
  }).format(value);
}

function formatDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : dateFmt.format(d);
}

/* ---------- Rendering ---------- */
// Username/password accounts have no Google behind them, so no Drive.
function passwordAccountView() {
  return [
    h(
      'p',
      { class: 'muted small' },
      'Iniciaste sesión con usuario y contraseña. Para guardar respaldos en Google Drive, cierra sesión y entra con Google. Mientras tanto puedes descargar el respaldo como archivo.',
    ),
  ];
}

function reconnectView() {
  return [
    h(
      'p',
      { id: 'drive-hint', class: 'notice-warn small' },
      'Notux no tiene permiso para usar tu Google Drive (puede que lo hayas quitado en tu cuenta de Google). Vuelve a conectar tu cuenta para guardar respaldos allí.',
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-google btn-sm',
        disabled: !navigator.onLine,
        'aria-describedby': 'drive-hint',
        onclick: reconnect,
      },
      icon('google', 16),
      'Volver a conectar con Google',
    ),
  ];
}

function backupItem(b) {
  const busy = busyId === b.id;
  const disabled = !navigator.onLine || saving || busyId !== null;
  const meta = [formatDate(b.createdTime), formatSize(b.size)].filter(Boolean).join(' · ');
  const confirming = confirmDeleteId === b.id;
  return h(
    'li',
    { class: 'drive-item', 'aria-busy': busy ? 'true' : null },
    h(
      'div',
      { class: 'drive-item-text' },
      h('strong', {}, meta || b.name),
      h('span', { class: 'muted small' }, b.name),
    ),
    h(
      'div',
      { class: 'drive-item-actions' },
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-ghost btn-sm',
          disabled,
          'aria-label': `Restaurar el respaldo del ${meta || b.name}`,
          onclick: () => restore(b),
        },
        icon('upload', 16),
        busy && busyAction === 'restore' ? 'Abriendo…' : 'Restaurar',
      ),
      h(
        'button',
        {
          type: 'button',
          class: `btn btn-sm ${confirming ? 'btn-danger-solid' : 'btn-ghost'}`,
          disabled,
          'aria-label': confirming ? null : `Eliminar el respaldo del ${meta || b.name}`,
          onclick: () => remove(b),
        },
        icon('trash', 16),
        busy && busyAction === 'delete' ? 'Eliminando…' : confirming ? '¿Eliminar?' : 'Eliminar',
      ),
    ),
  );
}

function listView() {
  if (!navigator.onLine && !backups) {
    return [h('p', { class: 'muted small' }, 'Sin conexión: tus respaldos en Google Drive se ven con internet.')];
  }
  if (loading && !backups) {
    return [h('p', { class: 'muted small', role: 'status' }, 'Cargando respaldos de Google Drive…')];
  }
  const nodes = [];
  if (listError && !loading) {
    // A failed reload keeps showing the last list it got, under the warning.
    const message = backups ? `No se pudo actualizar la lista. ${messageFor(listError)}` : messageFor(listError);
    nodes.push(
      h(
        'div',
        { class: 'drive-error' },
        h('p', { class: 'notice-warn small', role: 'alert' }, message),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: loadList }, 'Reintentar'),
      ),
    );
  }
  if (!backups) return nodes;
  if (backups.length === 0) {
    nodes.push(h('p', { class: 'muted small' }, 'Aún no hay respaldos en tu Google Drive.'));
  } else {
    nodes.push(h('ul', { class: 'drive-list', 'aria-label': 'Respaldos en Google Drive' }, ...backups.map(backupItem)));
  }
  return nodes;
}

function render() {
  const section = $('drive-backups');
  const user = getUser();
  section.hidden = !isConfigured() || !user;
  if (section.hidden) return;

  const hadFocus = section.contains(document.activeElement);
  const focusedText = hadFocus ? document.activeElement.textContent : null;
  const title = h('h4', { class: 'drive-title' }, icon('cloud', 16), 'Google Drive');

  if (user.provider === 'password') {
    section.replaceChildren(title, ...passwordAccountView());
  } else if (user.driveConnected === false) {
    section.replaceChildren(title, ...reconnectView());
  } else {
    const online = navigator.onLine;
    const intro = h(
      'p',
      { class: online ? 'muted small' : 'notice-warn small' },
      online
        ? 'Guarda una copia en la carpeta «Notux» de tu Google Drive. Se conservan los 10 más recientes.'
        : 'Sin conexión: los respaldos en Google Drive se guardan y restauran con internet.',
    );
    const save = h(
      'button',
      {
        type: 'button',
        id: 'drive-save',
        class: 'btn btn-primary btn-sm',
        disabled: !online || saving || busyId !== null,
        'aria-busy': saving ? 'true' : null,
        onclick: save_,
      },
      icon('cloud', 16),
      saving ? 'Guardando…' : 'Guardar en Google Drive',
    );
    section.replaceChildren(title, intro, h('div', { class: 'settings-actions' }, save), ...listView());
  }

  // Re-rendering replaced the focused button: put focus back on its twin, or nearby.
  if (hadFocus) {
    const buttons = [...section.querySelectorAll('button:not(:disabled)')];
    (buttons.find((b) => b.textContent === focusedText) ?? buttons[0] ?? $('settings-close')).focus();
  }
}

/* ---------- Actions ---------- */
async function loadList() {
  const user = getUser();
  if (!user || user.provider === 'password' || user.driveConnected === false || !navigator.onLine) {
    render();
    return;
  }
  const seq = ++loadSeq;
  loading = true;
  listError = null;
  render();
  try {
    const list = await apiRequest('/drive/backups');
    if (seq !== loadSeq) return;
    backups = Array.isArray(list) ? list : [];
  } catch (err) {
    if (seq !== loadSeq) return;
    noteError(err);
    listError = err;
  } finally {
    if (seq === loadSeq) {
      loading = false;
      render();
    }
  }
}

async function save_() {
  if (saving) return;
  saving = true;
  render();
  try {
    const { blob, counts } = await createBackup(options.getDb());
    await apiRequest('/drive/backups', { method: 'POST', body: blob, timeout: TRANSFER_TIMEOUT_MS });
    showToast(`Respaldo guardado en Google Drive: ${describeCounts(counts)}.`);
    options.onBackupSaved?.();
    saving = false;
    await loadList(); // the server may also have dropped the oldest one
  } catch (err) {
    report(err);
  } finally {
    saving = false;
    render();
  }
}

async function restore(backup) {
  if (busyId) return;
  busyId = backup.id;
  busyAction = 'restore';
  render();
  let parsed;
  try {
    const text = await apiRequest(`/drive/backups/${encodeURIComponent(backup.id)}`, {
      as: 'text',
      timeout: TRANSFER_TIMEOUT_MS,
    });
    parsed = parseBackup(text);
  } catch (err) {
    if (err instanceof InvalidBackupError) showToast(err.message, { type: 'error' });
    else report(err);
    if (err?.status === 404) loadList();
    return;
  } finally {
    busyId = null;
    render();
  }
  options.confirmRestore(parsed, { source: 'drive' });
}

async function remove(backup) {
  if (busyId) return;
  if (confirmDeleteId !== backup.id) {
    // First press arms the button; a second one within a few seconds deletes.
    confirmDeleteId = backup.id;
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => {
      confirmDeleteId = null;
      render();
    }, DELETE_CONFIRM_MS);
    render();
    return;
  }
  clearTimeout(confirmTimer);
  confirmDeleteId = null;
  busyId = backup.id;
  busyAction = 'delete';
  render();
  try {
    await apiRequest(`/drive/backups/${encodeURIComponent(backup.id)}`, { method: 'DELETE' });
    backups = backups?.filter((b) => b.id !== backup.id) ?? null;
    showToast('Respaldo eliminado de Google Drive.');
  } catch (err) {
    if (err?.status === 404) {
      backups = backups?.filter((b) => b.id !== backup.id) ?? null; // already gone
    } else {
      report(err);
    }
  } finally {
    busyId = null;
    render();
  }
}

function reconnect() {
  try {
    signInWithGoogle(); // leaves for Google; comes back signed in with Drive access
  } catch (err) {
    report(err);
  }
}

/* ---------- Setup ---------- */
const settingsOpen = () => $('settings-dialog').open;

/** Reloads the list (call when Ajustes opens). */
export function refreshDriveBackups() {
  if (getUser()) loadList();
  else render();
}

/**
 * @param {{ getDb: () => IDBDatabase, confirmRestore: (parsed: object, info: { source: 'drive' }) => void,
 *           onBackupSaved?: () => void }} opts
 */
export function initDriveBackups(opts) {
  options = opts;
  onAuthChange((user, event) => {
    if (!user) {
      backups = null;
      listError = null;
      loadSeq++; // ignore answers for the previous account
    }
    if (event === 'SIGNED_IN') backups = null;
    render();
    if (user && user.driveConnected !== false && settingsOpen() && (event === 'SIGNED_IN' || !backups)) loadList();
  });
  window.addEventListener('online', () => (settingsOpen() && !backups ? loadList() : render()));
  window.addEventListener('offline', render);
  render();
}
