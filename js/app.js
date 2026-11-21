import {
  openDatabase,
  createTask,
  updateTask,
  deleteTask,
  getAllTasks,
  countTasks,
  markTasksDoneByPriority,
  createNote,
  updateNote,
  putNotes,
  deleteNote,
  getAllNotes,
} from './db.js';
import {
  isPasswordConfigured,
  createPassword,
  unlockWithPassword,
  changePassword,
  encryptNote,
  decryptNote,
  WrongPasswordError,
} from './vault.js';
import {
  isCameraSupported,
  openCamera,
  stopCamera,
  capturePhoto,
  processGalleryPhoto,
  isMicrophoneSupported,
  startAudioRecording,
} from './device.js';
import { showToast } from './toast.js';
import { $, h, icon, iconButton, emptyState } from './dom.js';
import { LOCALE, dayDiff, relativeDate, todayISO } from './dates.js';
import { initCalendar } from './calendar.js';
import { initNoteBoard } from './note-board.js';
import { initSchedule, todayStatus, formatRange, formatDuration, sessionSummary } from './schedule.js';
import {
  createBackup,
  backupFileName,
  parseBackup,
  restoreBackup,
  describeCounts,
  InvalidBackupError,
} from './backup.js';
import * as reminders from './reminders.js';

const TASKS_KEY = 'notux.tasks';
const PRIORITY_LABEL = { high: 'Alta', medium: 'Media', low: 'Baja' };
const IDLE_LOCK_MS = 5 * 60 * 1000; // no taps or keys for this long → lock private notes
const HIDDEN_LOCK_MS = 60 * 1000; // app in the background for this long → lock private notes

/* ---------- Service worker and updates ---------- */
// A new version installs in the background and waits; the user chooses when to
// switch with "Actualizar", then the page reloads once onto the new code.
let updateRequested = false;

function offerUpdate(worker) {
  showToast('Hay una versión nueva de Notux.', {
    duration: 0,
    action: {
      label: 'Actualizar',
      onClick: () => {
        updateRequested = true;
        worker.postMessage({ type: 'SKIP_WAITING' });
      },
    },
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    let reg;
    try {
      reg = await navigator.serviceWorker.register('sw.js');
    } catch (err) {
      console.error('Error registering the service worker:', err);
      return;
    }
    // Only an *update* is worth announcing: on the very first install there's
    // no controller yet and nothing old to replace.
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker);
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) reg.update().catch(() => {}); // offline is fine
    });
  });

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // clients.claim() on first install also fires this; reload only on request.
    if (!updateRequested || reloading) return;
    reloading = true;
    location.reload();
  });
}

/* ---------- Install prompt ---------- */
let deferredInstallPrompt = null;

// Offered in the sidebar (desktop) and in Ajustes (everywhere) only while the
// browser says the app can be installed.
function showInstall(available) {
  $('btn-install').hidden = !available;
  $('install-section').hidden = !available;
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstall(true);
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  showInstall(false);
});

async function promptInstall() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  console.log('Install prompt outcome:', outcome);
  deferredInstallPrompt = null;
  showInstall(false);
}
$('btn-install').addEventListener('click', promptInstall);
$('btn-install-settings').addEventListener('click', promptInstall);

/* ---------- State ---------- */
let db;
let tasks = [];
let notes = [];
let notesKey = null; // CryptoKey held in memory; null = private notes locked
let revealedNoteId = null;
const decryptedNotes = new Map(); // task.id -> plaintext, cleared on lock

let editingTask = null; // { id, noteLoaded } while the edit dialog is open
let editingNoteId = null; // id of the free-form note loaded in the note form, or null
let notesFilter = 'all'; // 'all' | 'none' | subject id — which notes the Notas board shows

let cameraStream = null;
let capturedPhoto = null; // Blob | null, for the note currently being composed
let capturedPhotoUrl = null; // object URL for its preview, revoked on change/reset
const noteThumbUrls = new Map(); // note.id -> object URL, revoked when the note is removed or changed

let activeRecording = null; // controller from startAudioRecording(), null when not recording
let recordingTimerId = null;
let recordingStartedAt = null;
let capturedAudio = null; // Blob | null, for the note currently being composed
let capturedAudioUrl = null;
const noteAudioUrls = new Map(); // note.id -> object URL, same lifecycle as noteThumbUrls

/* ---------- Sidebar (tablet/desktop) ---------- */
// Collapses to an icon rail; the choice is remembered per browser.
const SIDEBAR_KEY = 'notux.sidebar';

function setSidebarCollapsed(collapsed) {
  document.querySelector('.app').classList.toggle('is-sidebar-collapsed', collapsed);
  const toggle = $('sidebar-toggle');
  const label = collapsed ? 'Expandir menú' : 'Contraer menú';
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.querySelector('.nav-label').textContent = label;
  toggle.title = label;
  // With the labels hidden, a tooltip names each icon.
  for (const link of document.querySelectorAll('#sidebar-nav a, .sidebar-footer .side-btn:not(#sidebar-toggle)')) {
    if (collapsed) link.title = link.querySelector('.nav-label').textContent;
    else link.removeAttribute('title');
  }
}

{
  let stored = null;
  try {
    stored = localStorage.getItem(SIDEBAR_KEY);
  } catch {
    // storage blocked: start expanded
  }
  // Apply the saved state without animating it on load.
  document.documentElement.classList.add('no-transition');
  setSidebarCollapsed(stored === 'collapsed');
  requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('no-transition')));
}

$('sidebar-toggle').addEventListener('click', () => {
  const collapsed = !document.querySelector('.app').classList.contains('is-sidebar-collapsed');
  setSidebarCollapsed(collapsed);
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? 'collapsed' : 'expanded');
  } catch {
    // ignore
  }
});

/* ---------- Routes ---------- */
const VIEWS = ['inicio', 'tareas', 'calendario', 'horario', 'notas', 'materia'];
const NAV_FOR = { materia: 'horario' }; // views without a tab of their own highlight their parent

// '#/notas' → { view: 'notas' }, '#/materia/3' → { view: 'materia', id: 3 }
function currentRoute() {
  const [view, param] = location.hash.replace(/^#\/?/, '').split('/');
  if (view === 'materia' && /^\d+$/.test(param ?? '')) return { view, id: Number(param) };
  return { view: VIEWS.includes(view) && view !== 'materia' ? view : 'inicio' };
}

let previousView = null;

function navigate() {
  const { view } = currentRoute();
  for (const v of VIEWS) {
    $(`view-${v}`).hidden = v !== view;
  }
  const nav = NAV_FOR[view] ?? view;
  document.querySelectorAll('[data-route]').forEach((a) => {
    if (a.dataset.route === nav) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (view === 'materia') renderSubjectPage();
  else document.title = 'Notux';
  // Leaving Notas with the form open and nothing typed just closes it.
  if (previousView === 'notas' && view !== 'notas' && !noteFormDirty()) closeNoteForm();
  if (previousView !== view) window.scrollTo(0, 0);
  previousView = view;
}

window.addEventListener('hashchange', navigate);

/* ---------- Migration from localStorage (pre-IndexedDB version) ---------- */
async function migrateFromLocalStorage() {
  const total = await countTasks(db);
  if (total > 0) return;

  let oldTasks;
  try {
    oldTasks = JSON.parse(localStorage.getItem(TASKS_KEY));
  } catch {
    oldTasks = null;
  }
  if (!Array.isArray(oldTasks) || oldTasks.length === 0) return;

  for (const t of oldTasks) {
    await createTask(db, {
      title: t.title,
      due: t.due ?? null,
      done: !!t.done,
      priority: 'medium',
      createdAt: t.createdAt ?? new Date().toISOString(),
      completedAt: t.completedAt ?? null,
      encryptedNote: null,
      noteIv: null,
    });
  }
  localStorage.removeItem(TASKS_KEY);
  console.log(`notux: migrated ${oldTasks.length} task(s) from localStorage to IndexedDB`);
}

/* ---------- Private notes: lock state ---------- */
async function passwordMode() {
  return (await isPasswordConfigured(db)) ? 'unlock' : 'create';
}

async function requestUnlock(onSuccess) {
  openPasswordDialog({ mode: await passwordMode(), onSuccess });
}

// Everything that shows or edits plaintext follows the lock state from here.
function refreshLockedUi() {
  updateLockState();
  updateNoteFormState();
  loadEditorNote();
  render();
}

function lock({ notice } = {}) {
  if (!notesKey) return;
  notesKey = null;
  revealedNoteId = null;
  decryptedNotes.clear();
  $('task-note').value = ''; // a half-typed private note shouldn't outlive the lock
  refreshLockedUi();
  if (notice) showToast(notice);
}

async function revealNote(t) {
  if (decryptedNotes.has(t.id)) return;
  decryptedNotes.set(t.id, await decryptNote(notesKey, t));
}

function toggleNote(t) {
  return async () => {
    if (!notesKey) {
      requestUnlock(toggleNote(t));
      return;
    }
    if (revealedNoteId === t.id) {
      revealedNoteId = null;
      render();
      return;
    }
    try {
      await revealNote(t);
      revealedNoteId = t.id;
      render();
    } catch (err) {
      console.error('Could not decrypt the note:', err);
      showToast('No se pudo descifrar esta nota.', { type: 'error' });
    }
  };
}

async function updateLockState() {
  const configured = notesKey ? true : await isPasswordConfigured(db);
  const btn = $('notes-lock');
  btn.className = `chip chip-icon ${notesKey ? 'chip-ok' : 'chip-warn'}`;
  btn.replaceChildren(icon(notesKey ? 'unlock' : 'lock', 16));
  const label = notesKey
    ? 'Notas privadas desbloqueadas. Bloquear'
    : configured
      ? 'Notas privadas bloqueadas. Desbloquear'
      : 'Notas privadas: crear una contraseña';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  $('btn-change-password').hidden = !configured;
  $('privacy-hint').textContent = configured
    ? 'Se cifran con tu contraseña antes de guardarse. Si la olvidas, no se pueden recuperar.'
    : 'Aún no tienes contraseña. Créala con el candado de la barra superior.';
}

function updateNoteFormState() {
  $('task-note').disabled = !notesKey;
  $('task-note-hint').hidden = !!notesKey;
}

$('notes-lock').addEventListener('click', () => {
  if (notesKey) lock();
  else requestUnlock();
});

$('task-note-unlock').addEventListener('click', () => requestUnlock());

/* ---------- Private notes: auto-lock ---------- */
let lastActivity = Date.now();
let hiddenLockTimer = null;
let hiddenAt = null;

const markActivity = () => (lastActivity = Date.now());
for (const type of ['pointerdown', 'keydown', 'input']) {
  document.addEventListener(type, markActivity, { capture: true, passive: true });
}

setInterval(() => {
  if (notesKey && !document.hidden && Date.now() - lastActivity > IDLE_LOCK_MS) {
    lock({ notice: 'Notas privadas bloqueadas por inactividad.' });
  }
}, 15_000);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = Date.now();
    hiddenLockTimer = setTimeout(() => lock(), HIDDEN_LOCK_MS);
    return;
  }
  clearTimeout(hiddenLockTimer);
  // Background timers can be throttled, so check the elapsed time on return too.
  if (notesKey && hiddenAt && Date.now() - hiddenAt > HIDDEN_LOCK_MS) lock();
  hiddenAt = null;
  renderToday();
  render();
  schedule.render();
});

/* ---------- Password dialog ---------- */
// One submit listener for the dialog's whole lifetime. Each open only swaps the
// request below; a per-open listener would pile up whenever the dialog was
// cancelled, and in 'create' mode two stacked handlers derived two different
// keys, so notes could end up encrypted with a key that no longer matched the
// stored salt.
let pwRequest = null; // { mode, onSuccess } while the dialog is open
let pwBusy = false; // PBKDF2 takes a moment; ignore repeated submits meanwhile

function openPasswordDialog({ mode, onSuccess }) {
  const dialog = $('pw-dialog');
  if (dialog.open) return;
  pwRequest = { mode, onSuccess };

  $('pw-title').textContent = mode === 'create' ? 'Crea una contraseña' : 'Desbloquea tus notas privadas';
  $('pw-desc').textContent =
    mode === 'create'
      ? 'Se usará para cifrar tus notas privadas. Si la olvidas, esas notas no se podrán recuperar.'
      : 'Ingresa la contraseña que usaste para cifrar tus notas privadas.';
  $('pw-error').hidden = true;
  $('pw-input').value = '';
  dialog.showModal();
}

$('pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('pw-input');
  const error = $('pw-error');
  const password = input.value;
  if (!password || !pwRequest || pwBusy) return;

  const { mode, onSuccess } = pwRequest;
  pwBusy = true;
  try {
    // Re-check: another tab may have created the password since the dialog opened.
    notesKey =
      mode === 'create' && !(await isPasswordConfigured(db))
        ? await createPassword(db, password)
        : await unlockWithPassword(db, password);
  } catch (err) {
    if (!(err instanceof WrongPasswordError)) console.error(err);
    error.textContent = 'Contraseña incorrecta.';
    error.hidden = false;
    input.focus();
    input.select();
    return;
  } finally {
    pwBusy = false;
  }

  pwRequest = null;
  $('pw-dialog').close();
  markActivity();
  refreshLockedUi();
  await onSuccess?.();
});

$('pw-dialog').addEventListener('close', () => {
  pwRequest = null;
  $('pw-input').value = ''; // don't leave the password sitting in the DOM
});

$('pw-cancel').addEventListener('click', () => $('pw-dialog').close());

/* ---------- Change password dialog ---------- */
let pwChangeBusy = false;

$('btn-change-password').addEventListener('click', () => {
  $('pwchange-form').reset();
  $('pwchange-error').hidden = true;
  $('pwchange-dialog').showModal();
});

$('pwchange-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (pwChangeBusy) return;
  const current = $('pwchange-current').value;
  const next = $('pwchange-new').value;
  const error = $('pwchange-error');

  if (next !== $('pwchange-confirm').value) {
    error.textContent = 'Las contraseñas nuevas no coinciden.';
    error.hidden = false;
    $('pwchange-confirm').focus();
    return;
  }

  pwChangeBusy = true;
  const submit = $('pwchange-submit');
  submit.disabled = true;
  submit.textContent = 'Cifrando…';
  try {
    notesKey = await changePassword(db, current, next);
    tasks = await getAllTasks(db); // new ciphertexts and IVs
  } catch (err) {
    if (err instanceof WrongPasswordError) {
      error.textContent = 'La contraseña actual no es correcta.';
      $('pwchange-current').select();
    } else {
      console.error('Could not change the password:', err);
      error.textContent = 'No se pudo cambiar la contraseña. Tus notas siguen con la contraseña anterior.';
    }
    error.hidden = false;
    return;
  } finally {
    pwChangeBusy = false;
    submit.disabled = false;
    submit.textContent = 'Cambiar';
  }

  $('pwchange-dialog').close();
  markActivity();
  refreshLockedUi();
  showToast('Contraseña cambiada. Tus notas privadas se volvieron a cifrar.');
});

$('pwchange-dialog').addEventListener('close', () => $('pwchange-form').reset());
$('pwchange-cancel').addEventListener('click', () => $('pwchange-dialog').close());

/* ---------- Tasks: actions ---------- */
async function addTask({ title, due, priority = 'medium', noteText = null, subjectId = null }) {
  const task = {
    title,
    due: due || null,
    done: false,
    priority,
    subjectId,
    createdAt: new Date().toISOString(),
    completedAt: null,
    encryptedNote: null,
    noteIv: null,
  };
  if (noteText) {
    if (!notesKey) throw new Error('Private notes are locked');
    Object.assign(task, await encryptNote(notesKey, noteText));
  }
  const id = await createTask(db, task);
  tasks.push({ ...task, id });
  render();
}

async function toggleTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  const updated = { ...task, done: !task.done, completedAt: !task.done ? new Date().toISOString() : null };
  try {
    await updateTask(db, updated);
  } catch (err) {
    console.error('Could not update the task:', err);
    showToast('No se pudo actualizar la tarea.', { type: 'error' });
    return;
  }
  Object.assign(task, updated);
  render();
}

async function removeTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  try {
    await deleteTask(db, id);
  } catch (err) {
    console.error('Could not delete the task:', err);
    showToast('No se pudo eliminar la tarea.', { type: 'error' });
    return;
  }
  tasks = tasks.filter((t) => t.id !== id);
  decryptedNotes.delete(id);
  if (revealedNoteId === id) revealedNoteId = null;
  render();
  showToast(`Tarea «${task.title}» eliminada.`, { action: { label: 'Deshacer', onClick: () => restoreTask(task) } });
}

async function restoreTask(task) {
  try {
    await createTask(db, task); // same id: it comes back exactly where it was
  } catch (err) {
    console.error('Could not restore the task:', err);
    showToast(
      err.name === 'ConstraintError'
        ? 'No se pudo restaurar: ya existe otra tarea con ese título.'
        : 'No se pudo restaurar la tarea.',
      { type: 'error' },
    );
    return;
  }
  tasks.push(task);
  render();
}

/* ---------- Tasks: edit dialog ---------- */
async function openTaskEditor(id) {
  const t = tasks.find((x) => x.id === id);
  if (!t || $('task-dialog').open) return;
  editingTask = { id, noteLoaded: false };
  $('task-edit-title').value = t.title;
  $('task-edit-due').value = t.due ?? '';
  $('task-edit-priority').value = t.priority ?? 'medium';
  $('task-edit-subject').value = subjectValue(t.subjectId);
  $('task-edit-error').hidden = true;
  await loadEditorNote();
  $('task-dialog').showModal();
}

// Fills the editor's private-note field according to the lock state. While
// locked the field stays empty and disabled, and saving keeps the existing
// ciphertext untouched instead of treating the empty field as "remove note".
async function loadEditorNote() {
  if (!editingTask) return;
  const t = tasks.find((x) => x.id === editingTask.id);
  const hasNote = !!t?.encryptedNote;
  const textarea = $('task-edit-note');
  editingTask.noteLoaded = false;
  textarea.value = '';

  let failed = false;
  if (t && notesKey) {
    try {
      if (hasNote) {
        await revealNote(t);
        textarea.value = decryptedNotes.get(t.id);
      }
      editingTask.noteLoaded = true;
    } catch (err) {
      console.error('Could not decrypt the note:', err);
      failed = true;
    }
  }

  textarea.disabled = !editingTask.noteLoaded;
  textarea.placeholder = editingTask.noteLoaded ? 'Se cifra antes de guardarse. Déjala vacía para quitarla.' : '';
  $('task-edit-note-hint').hidden = editingTask.noteLoaded;
  $('task-edit-note-unlock').hidden = !!notesKey;
  $('task-edit-note-hint-text').textContent = failed
    ? 'No se pudo descifrar la nota; se conservará tal cual.'
    : hasNote
      ? 'Esta tarea tiene una nota privada. Desbloquea para verla o editarla.'
      : 'Desbloquea las notas privadas para agregar una.';
}

let savingTask = false;

$('task-edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!editingTask || savingTask) return;
  const t = tasks.find((x) => x.id === editingTask.id);
  if (!t) {
    $('task-dialog').close();
    return;
  }
  const titleInput = $('task-edit-title');
  const title = titleInput.value.trim();
  if (!title) {
    titleInput.focus();
    return;
  }

  const updated = {
    ...t,
    title,
    due: $('task-edit-due').value || null,
    priority: $('task-edit-priority').value,
    subjectId: readSubjectSelect($('task-edit-subject')),
  };
  let noteText = null; // null = note not touched
  savingTask = true;
  try {
    if (editingTask.noteLoaded && notesKey) {
      const text = $('task-edit-note').value.trim();
      const previous = t.encryptedNote ? decryptedNotes.get(t.id) : '';
      if (text !== previous) {
        noteText = text;
        Object.assign(updated, text ? await encryptNote(notesKey, text) : { encryptedNote: null, noteIv: null });
      }
    }
    await updateTask(db, updated);
  } catch (err) {
    console.error('Could not save the task:', err);
    const error = $('task-edit-error');
    error.textContent =
      err.name === 'ConstraintError' ? 'Ya existe otra tarea con ese título.' : 'No se pudo guardar. Intenta de nuevo.';
    error.hidden = false;
    if (err.name === 'ConstraintError') titleInput.focus();
    return;
  } finally {
    savingTask = false;
  }

  Object.assign(t, updated);
  if (noteText) decryptedNotes.set(t.id, noteText);
  else if (noteText === '') {
    decryptedNotes.delete(t.id);
    if (revealedNoteId === t.id) revealedNoteId = null;
  }
  $('task-dialog').close();
  render();
  showToast('Tarea actualizada.');
});

$('task-dialog').addEventListener('close', () => {
  editingTask = null;
  $('task-edit-note').value = '';
});
$('task-edit-cancel').addEventListener('click', () => $('task-dialog').close());
$('task-edit-note-unlock').addEventListener('click', () => requestUnlock());

/* ---------- Free-form notes: camera, gallery, CRUD ---------- */
// These notes are separate from the encrypted private note on tasks — they're
// plain (unencrypted) and can carry a photo, so they don't belong behind the password lock.
if (!isCameraSupported()) {
  $('note-camera-btn').hidden = true;
}
if (!isMicrophoneSupported()) {
  $('note-audio-btn').hidden = true;
}

function setNotePhoto(blob) {
  capturedPhoto = blob;
  if (capturedPhotoUrl) URL.revokeObjectURL(capturedPhotoUrl);
  capturedPhotoUrl = URL.createObjectURL(blob);
  const img = $('note-photo-preview');
  img.src = capturedPhotoUrl;
  img.hidden = false;
  $('note-photo-remove').hidden = false;
}

function resetNotePhoto() {
  capturedPhoto = null;
  if (capturedPhotoUrl) URL.revokeObjectURL(capturedPhotoUrl);
  capturedPhotoUrl = null;
  const img = $('note-photo-preview');
  img.hidden = true;
  img.removeAttribute('src');
  $('note-photo-remove').hidden = true;
}

$('note-photo-remove').addEventListener('click', resetNotePhoto);

$('note-camera-btn').addEventListener('click', async () => {
  try {
    cameraStream = await openCamera('environment');
    $('camera-video').srcObject = cameraStream;
    $('camera-dialog').showModal();
  } catch (err) {
    console.error('Could not open the camera:', err);
    showToast('No se pudo abrir la cámara. Revisa los permisos en el candado de la barra de direcciones.', {
      type: 'error',
    });
  }
});

$('camera-capture').addEventListener('click', async () => {
  const video = $('camera-video');
  if (!video.videoWidth) return; // stream not ready yet: the frame would be empty
  const blob = await capturePhoto(video);
  if (blob) setNotePhoto(blob);
  $('camera-dialog').close();
});

$('camera-cancel').addEventListener('click', () => $('camera-dialog').close());

// 'close' fires for every way out (buttons and Escape), so the camera is
// always released here instead of staying on after Escape.
$('camera-dialog').addEventListener('close', () => {
  stopCamera(cameraStream);
  cameraStream = null;
  $('camera-video').srcObject = null;
});

$('note-gallery-btn').addEventListener('click', () => $('note-gallery-input').click());

$('note-gallery-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    setNotePhoto(await processGalleryPhoto(file));
  } catch (err) {
    console.error('Could not read the image:', err);
    showToast('No se pudo leer esa imagen.', { type: 'error' });
  }
  e.target.value = ''; // allow picking the same file again later
});

function setNoteAudio(blob) {
  capturedAudio = blob;
  if (capturedAudioUrl) URL.revokeObjectURL(capturedAudioUrl);
  capturedAudioUrl = URL.createObjectURL(blob);
  const audioEl = $('note-audio-preview');
  audioEl.src = capturedAudioUrl;
  audioEl.hidden = false;
  $('note-audio-remove').hidden = false;
}

function resetNoteAudio() {
  capturedAudio = null;
  if (capturedAudioUrl) URL.revokeObjectURL(capturedAudioUrl);
  capturedAudioUrl = null;
  const audioEl = $('note-audio-preview');
  audioEl.hidden = true;
  audioEl.removeAttribute('src');
  $('note-audio-remove').hidden = true;
}

function updateRecordButton(recording) {
  const btn = $('note-audio-btn');
  btn.classList.toggle('btn-recording', recording);
  if (!recording) {
    btn.replaceChildren(icon('mic', 18), ' Grabar audio');
    return;
  }
  const seconds = Math.floor((Date.now() - recordingStartedAt) / 1000);
  const mm = String(Math.floor(seconds / 60));
  const ss = String(seconds % 60).padStart(2, '0');
  btn.replaceChildren(icon('mic', 18), ` Detener (${mm}:${ss})`);
}

function discardRecording() {
  if (!activeRecording) return;
  clearInterval(recordingTimerId);
  activeRecording.cancel();
  activeRecording = null;
  updateRecordButton(false);
}

$('note-audio-btn').addEventListener('click', async () => {
  if (activeRecording) {
    clearInterval(recordingTimerId);
    const recording = activeRecording;
    activeRecording = null;
    const blob = await recording.stop();
    setNoteAudio(blob);
    updateRecordButton(false);
    return;
  }
  try {
    activeRecording = await startAudioRecording();
    recordingStartedAt = Date.now();
    updateRecordButton(true);
    recordingTimerId = setInterval(() => updateRecordButton(true), 500);
  } catch (err) {
    console.error('Could not start recording:', err);
    showToast('No se pudo grabar audio. Revisa los permisos del micrófono.', { type: 'error' });
  }
});

$('note-audio-remove').addEventListener('click', resetNoteAudio);

function forgetNoteMedia(id) {
  for (const urls of [noteThumbUrls, noteAudioUrls]) {
    const url = urls.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      urls.delete(id);
    }
  }
}

function resetNoteForm() {
  discardRecording();
  editingNoteId = null;
  $('note-form').reset();
  resetNotePhoto();
  resetNoteAudio();
  $('note-form-title').textContent = 'Nueva nota';
  $('note-submit').textContent = 'Guardar nota';
}

// The form lives folded away behind "Nueva nota" so the board shows every note;
// it unfolds for a new note or to edit one.
function openNoteForm({ subjectId = null } = {}) {
  const form = $('note-form');
  if (form.hidden) {
    form.hidden = false;
    $('note-new').setAttribute('aria-expanded', 'true');
  }
  if (editingNoteId === null && subjectId !== null) $('note-subject').value = subjectValue(subjectId);
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('note-title').focus({ preventScroll: true });
}

function closeNoteForm({ focus = false } = {}) {
  const hadEdit = editingNoteId !== null;
  resetNoteForm();
  $('note-form').hidden = true;
  $('note-new').setAttribute('aria-expanded', 'false');
  if (hadEdit) renderNotesView();
  if (focus) $('note-new').focus();
}

// Anything typed or attached that closing would throw away.
function noteFormDirty() {
  if ($('note-form').hidden) return false;
  return !!(
    activeRecording ||
    capturedPhoto ||
    capturedAudio ||
    $('note-title').value.trim() ||
    $('note-text').value.trim()
  );
}

$('note-new').addEventListener('click', () => {
  if (editingNoteId !== null) resetNoteForm(); // switch from editing to a fresh note
  const subjectId = typeof notesFilter === 'number' ? notesFilter : null; // filtering by a subject → preselect it
  openNoteForm({ subjectId });
  renderNotesView();
});
$('note-cancel').addEventListener('click', () => closeNoteForm({ focus: true }));
$('note-form-close').addEventListener('click', () => closeNoteForm({ focus: true }));
$('note-form').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !noteFormDirty()) closeNoteForm({ focus: true });
});

// Editing reuses the creation form, so camera, gallery and recording work the same.
function startNoteEdit(id) {
  const n = notes.find((x) => x.id === id);
  if (!n) return;
  if (currentRoute().view !== 'notas') location.hash = '#/notas';
  discardRecording();
  editingNoteId = id;
  $('note-title').value = n.title;
  $('note-text').value = n.text ?? '';
  $('note-subject').value = subjectValue(n.subjectId);
  if (n.photo) setNotePhoto(n.photo);
  else resetNotePhoto();
  if (n.audio) setNoteAudio(n.audio);
  else resetNoteAudio();
  $('note-form-title').textContent = 'Editar nota';
  $('note-submit').textContent = 'Guardar cambios';
  renderNotesView();
  openNoteForm();
}

let savingNote = false;

$('note-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (savingNote) return;
  if (activeRecording) {
    showToast('Detén la grabación antes de guardar la nota.');
    return;
  }
  const titleInput = $('note-title');
  const title = titleInput.value.trim();
  if (!title) {
    titleInput.focus();
    return;
  }
  const fields = {
    title,
    text: $('note-text').value.trim(),
    subjectId: readSubjectSelect($('note-subject')),
    photo: capturedPhoto,
    audio: capturedAudio,
  };
  const existing = editingNoteId !== null ? notes.find((n) => n.id === editingNoteId) : null;

  let savedId = null;
  savingNote = true;
  try {
    if (existing) {
      const updated = { ...existing, ...fields, updatedAt: new Date().toISOString() };
      await updateNote(db, updated);
      notes = notes.map((n) => (n.id === updated.id ? updated : n));
      forgetNoteMedia(updated.id); // photo/audio may have changed
    } else {
      const note = { ...fields, createdAt: new Date().toISOString() };
      const id = await createNote(db, note);
      notes.push({ ...note, id });
      savedId = id;
    }
  } catch (err) {
    console.error('Could not save the note:', err);
    showToast('No se pudo guardar la nota. Intenta de nuevo.', { type: 'error' });
    return;
  } finally {
    savingNote = false;
  }
  closeNoteForm();
  // A new note filed under another subject than the one being filtered would
  // seem to vanish; show everything instead.
  if (!noteMatchesFilter(fields)) notesFilter = 'all';
  renderNotesView();
  renderSubjectViews();
  noteBoard.reveal(savedId ?? existing.id); // it may have landed below the visible part of the board
  showToast(existing ? 'Nota actualizada.' : 'Nota guardada.');
});

async function removeNote(id) {
  const note = notes.find((n) => n.id === id);
  if (!note) return;
  try {
    await deleteNote(db, id);
  } catch (err) {
    console.error('Could not delete the note:', err);
    showToast('No se pudo eliminar la nota.', { type: 'error' });
    return;
  }
  notes = notes.filter((n) => n.id !== id);
  forgetNoteMedia(id);
  if (editingNoteId === id) closeNoteForm();
  renderNotesView();
  renderSubjectViews();
  showToast(`Nota «${note.title}» eliminada.`, { action: { label: 'Deshacer', onClick: () => restoreNote(note) } });
}

async function restoreNote(note) {
  try {
    await createNote(db, note); // same id, same photo/audio blobs
  } catch (err) {
    console.error('Could not restore the note:', err);
    showToast('No se pudo restaurar la nota.', { type: 'error' });
    return;
  }
  notes.push(note);
  renderNotesView();
  renderSubjectViews();
}

// Deterministic per note.id so cards don't re-shuffle their look on every re-render.
function noteCardStyle(id) {
  const angle = ((id * 53) % 9) - 4; // -4..4deg
  const delay = ((id * 37) % 40) / 10; // 0..3.9s
  const hue = (id * 67) % 360;
  return `--note-angle: ${angle}deg; --note-delay: ${delay}s; --note-hue: ${hue};`;
}

/* ---------- Render ---------- */
// Small colored label with the subject's name; links to its page.
function subjectTag(subjectId) {
  const s = subjectId != null ? schedule.subject(subjectId) : null;
  if (!s) return null;
  return h('a', { class: `subject-tag blk-${s.color}`, href: `#/materia/${s.id}` }, s.name);
}

function taskItem(t, { showSubject = true } = {}) {
  const overdue = !t.done && t.due && dayDiff(t.due) < 0;
  const tag = showSubject ? subjectTag(t.subjectId) : null;
  const hasNote = !!t.encryptedNote;
  const noteVisible = hasNote && revealedNoteId === t.id && decryptedNotes.has(t.id);

  const row = h(
    'div',
    { class: 'task' },
    h(
      'button',
      {
        type: 'button',
        class: `check${t.done ? ' checked' : ''}`,
        'aria-label': t.done ? 'Marcar como pendiente' : 'Marcar como hecha',
        onclick: () => toggleTask(t.id),
      },
      ...(t.done ? [icon('check', 14)] : []),
    ),
    h(
      'div',
      { class: 'task-body' },
      h('span', { class: 'task-title' }, t.title),
      h(
        'span',
        { class: 'task-meta-row' },
        h(
          'span',
          { class: `task-meta${overdue ? ' overdue' : ''}` },
          `${relativeDate(t.due)} · ${PRIORITY_LABEL[t.priority] ?? 'Media'}`,
        ),
        ...(tag ? [tag] : []),
      ),
    ),
    h(
      'div',
      { class: 'task-actions' },
      ...(hasNote
        ? [iconButton('note', noteVisible ? 'Ocultar nota privada' : 'Ver nota privada', toggleNote(t))]
        : []),
      iconButton('edit', `Editar tarea «${t.title}»`, () => openTaskEditor(t.id)),
      iconButton('trash', `Eliminar tarea «${t.title}»`, () => removeTask(t.id), 20),
    ),
  );

  return h(
    'div',
    { class: `card task-card${t.done ? ' is-done' : ''}` },
    row,
    ...(noteVisible ? [h('p', { class: 'task-note' }, decryptedNotes.get(t.id))] : []),
  );
}

function render() {
  const pending = tasks
    .filter((t) => !t.done)
    .sort((a, b) => (a.due ?? '9').localeCompare(b.due ?? '9') || a.createdAt.localeCompare(b.createdAt));
  const done = tasks.filter((t) => t.done).sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));

  const overdue = pending.filter((t) => t.due && dayDiff(t.due) < 0).length;
  const soon = pending.filter((t) => t.due && dayDiff(t.due) >= 0 && dayDiff(t.due) <= 7).length;

  $('stat-overdue').textContent = overdue;
  $('stat-overdue').classList.toggle('danger', overdue > 0);
  $('stat-soon').textContent = soon;
  $('stat-done').textContent = done.length;

  $('pending').replaceChildren(...(pending.length ? pending.map(taskItem) : [emptyState('¡Nada pendiente!')]));
  $('done-section').hidden = done.length === 0;
  $('done').replaceChildren(...done.map(taskItem));

  renderTasksView();
  calendar.render();
  renderTodayPanel();
  renderSubjectViews();
}

function renderTasksView() {
  const search = $('tasks-search').value.trim().toLowerCase();
  const priorityFilter = $('tasks-filter').value;
  const subjectFilter = $('tasks-subject').value; // 'all' | 'none' | id

  const filtered = tasks
    .filter((t) => priorityFilter === 'all' || t.priority === priorityFilter)
    .filter((t) =>
      subjectFilter === 'all'
        ? true
        : subjectFilter === 'none'
          ? t.subjectId == null
          : t.subjectId === Number(subjectFilter),
    )
    .filter((t) => t.title.toLowerCase().includes(search))
    .sort(
      (a, b) =>
        Number(a.done) - Number(b.done) ||
        (a.due ?? '9').localeCompare(b.due ?? '9') ||
        a.createdAt.localeCompare(b.createdAt),
    );

  $('tasks-list').replaceChildren(
    ...(filtered.length ? filtered.map(taskItem) : [emptyState('No se encontraron tareas.')]),
  );
}

function noteItem(n, { showSubject = true, movable = false } = {}) {
  const tag = showSubject ? subjectTag(n.subjectId) : null;
  let thumbUrl = noteThumbUrls.get(n.id);
  if (n.photo && !thumbUrl) {
    thumbUrl = URL.createObjectURL(n.photo);
    noteThumbUrls.set(n.id, thumbUrl);
  }
  let audioUrl = noteAudioUrls.get(n.id);
  if (n.audio && !audioUrl) {
    audioUrl = URL.createObjectURL(n.audio);
    noteAudioUrls.set(n.id, audioUrl);
  }

  return h(
    'div',
    {
      class: `card note-card${editingNoteId === n.id ? ' is-editing' : ''}`,
      style: noteCardStyle(n.id),
      'data-note-id': String(n.id),
    },
    h(
      'div',
      { class: 'task' },
      ...(movable
        ? [
            h(
              'button',
              {
                type: 'button',
                class: 'note-grip',
                'aria-label': `Mover nota «${n.title}»`,
                'aria-describedby': 'notes-board-help',
              },
              icon('grip', 18),
            ),
          ]
        : []),
      h(
        'div',
        { class: 'task-body' },
        h('span', { class: 'task-title' }, n.title),
        h(
          'span',
          { class: 'task-meta-row' },
          h('span', { class: 'task-meta' }, new Date(n.createdAt).toLocaleDateString(LOCALE)),
          ...(tag ? [tag] : []),
        ),
      ),
      h(
        'div',
        { class: 'task-actions' },
        iconButton('edit', `Editar nota «${n.title}»`, () => startNoteEdit(n.id)),
        iconButton('trash', `Eliminar nota «${n.title}»`, () => removeNote(n.id), 20),
      ),
    ),
    ...(n.text ? [h('p', { class: 'task-note' }, n.text)] : []),
    ...(thumbUrl ? [h('img', { class: 'note-photo', src: thumbUrl, alt: '' })] : []),
    ...(audioUrl ? [h('audio', { class: 'note-audio', src: audioUrl, controls: 'true' })] : []),
  );
}

const newestFirst = (a, b) => b.createdAt.localeCompare(a.createdAt);

function noteMatchesFilter(n, filter = notesFilter) {
  if (filter === 'all') return true;
  if (filter === 'none') return n.subjectId == null;
  return n.subjectId === filter;
}

function renderNotesFilter() {
  const subjects = schedule.subjects();
  // A subject filter that no longer exists (deleted, or after a restore) falls back to all.
  if (typeof notesFilter === 'number' && !schedule.subject(notesFilter)) notesFilter = 'all';
  const container = $('notes-filter');
  container.hidden = subjects.length === 0;
  if (container.hidden) {
    notesFilter = 'all';
    return;
  }
  const chip = (value, label, count, color) =>
    h(
      'button',
      {
        type: 'button',
        class: `filter-chip${color ? ` blk-${color}` : ''}`,
        'aria-pressed': notesFilter === value ? 'true' : 'false',
        onclick: () => {
          notesFilter = value;
          renderNotesView();
        },
      },
      ...(color ? [h('span', { class: 'filter-dot', 'aria-hidden': 'true' })] : []),
      label,
      h('span', { class: 'filter-count' }, String(count)),
    );
  const unfiled = notes.filter((n) => n.subjectId == null).length;
  container.replaceChildren(
    chip('all', 'Todas', notes.length),
    ...subjects.map((s) => chip(s.id, s.name, notes.filter((n) => n.subjectId === s.id).length, s.color)),
    ...(unfiled && unfiled < notes.length ? [chip('none', 'Sin materia', unfiled)] : []),
  );
}

function renderNotesView() {
  renderNotesFilter();
  // Newest first, whatever order they were loaded, created or restored in.
  const shown = notes.filter((n) => noteMatchesFilter(n)).sort(newestFirst);
  const total = notes.length;
  $('notes-count').textContent =
    total === 0
      ? ''
      : shown.length === total
        ? `${total} nota${total === 1 ? '' : 's'}`
        : `${shown.length} de ${total} notas`;
  $('notes-empty').replaceChildren(
    ...(shown.length
      ? []
      : [
          emptyState(
            total ? 'No hay notas de esta materia.' : 'Aún no tienes notas. Crea una con «Nueva nota».',
            'note',
          ),
        ]),
  );
  $('notes-board-help').hidden = shown.length === 0;
  $('notes-arrange').hidden = !notes.some((n) => n.board);
  noteBoard.render(shown.map((n) => ({ note: n, el: noteItem(n, { movable: true }) })));
}

/* ---------- Notes canvas ---------- */
const noteBoard = initNoteBoard($('notes-list'), { onMove: saveNotePositions });

async function saveNotePositions(changes) {
  const boards = new Map(changes.map((c) => [c.id, c.board]));
  const updated = notes.filter((n) => boards.has(n.id)).map((n) => ({ ...n, board: boards.get(n.id) }));
  try {
    await putNotes(db, updated);
  } catch (err) {
    console.error('Could not save the note positions:', err);
    showToast('No se pudo guardar dónde dejaste la nota.', { type: 'error' });
    renderNotesView(); // put everything back where the database says
    return;
  }
  // Replace in place (not re-render): the cards are already where they were dropped.
  const byId = new Map(updated.map((n) => [n.id, n]));
  notes = notes.map((n) => byId.get(n.id) ?? n);
  $('notes-arrange').hidden = false;
}

// "Ordenar": forget every position and go back to the automatic columns.
$('notes-arrange').addEventListener('click', async () => {
  const previous = notes.filter((n) => n.board);
  if (!previous.length) return;
  const cleared = previous.map(({ board: _board, ...rest }) => rest);
  try {
    await putNotes(db, cleared);
  } catch (err) {
    console.error('Could not reset the board:', err);
    showToast('No se pudieron ordenar las notas.', { type: 'error' });
    return;
  }
  const byId = new Map(cleared.map((n) => [n.id, n]));
  notes = notes.map((n) => byId.get(n.id) ?? n);
  renderNotesView();
  showToast('Notas ordenadas.', {
    action: {
      label: 'Deshacer',
      onClick: async () => {
        // Only the positions come back; anything edited since stays as it is now.
        const back = new Map(previous.map((n) => [n.id, n.board]));
        const restored = notes.filter((n) => back.has(n.id)).map((n) => ({ ...n, board: back.get(n.id) }));
        try {
          await putNotes(db, restored);
        } catch (err) {
          console.error('Could not restore the board:', err);
          showToast('No se pudo deshacer.', { type: 'error' });
          return;
        }
        const byId = new Map(restored.map((n) => [n.id, n]));
        notes = notes.map((n) => byId.get(n.id) ?? n);
        renderNotesView();
      },
    },
  });
});

/* ---------- Subjects: selects and subject page ---------- */
const subjectValue = (id) => (id != null && schedule.subject(id) ? String(id) : '');
const readSubjectSelect = (select) => (select.value ? Number(select.value) : null);

// Every <select data-subject-select> lists the subjects: "none" ones start with
// "Sin materia" (for picking), "filter" ones with "Todas" + "Sin materia".
function fillSubjectSelects() {
  const subjects = schedule.subjects();
  for (const select of document.querySelectorAll('[data-subject-select]')) {
    const previous = select.value;
    const isFilter = select.dataset.subjectSelect === 'filter';
    select.replaceChildren(
      ...(isFilter
        ? [h('option', { value: 'all' }, 'Todas'), h('option', { value: 'none' }, 'Sin materia')]
        : [h('option', { value: '' }, 'Sin materia')]),
      ...subjects.map((s) => h('option', { value: String(s.id) }, s.name)),
    );
    const stillThere = [...select.options].some((o) => o.value === previous);
    select.value = stillThere ? previous : isFilter ? 'all' : '';
    // Nothing to choose from yet: the field is just noise.
    select.closest('div').hidden = subjects.length === 0;
  }
}

function subjectCounts(subjectId) {
  return {
    pending: tasks.filter((t) => t.subjectId === subjectId && !t.done).length,
    notes: notes.filter((n) => n.subjectId === subjectId).length,
  };
}

const byPendingThenDue = (a, b) =>
  Number(a.done) - Number(b.done) ||
  (a.due ?? '9').localeCompare(b.due ?? '9') ||
  a.createdAt.localeCompare(b.createdAt);

function renderSubjectPage() {
  const route = currentRoute();
  if (route.view !== 'materia' || !db) return;
  const subject = schedule.subject(route.id);
  $('subject-page').hidden = !subject;
  $('subject-missing').hidden = !!subject;
  if (!subject) return;

  const title = $('subject-page-title');
  title.className = `subject-heading blk-${subject.color}`;
  title.textContent = subject.name;
  document.title = `${subject.name} · Notux`;
  const own = schedule.blocksOf(subject.id);
  $('subject-page-sessions').textContent = own.length
    ? sessionSummary(own) +
      (own.some((b) => b.place) ? ` · ${[...new Set(own.map((b) => b.place).filter(Boolean))].join(', ')}` : '')
    : 'Sin horario';

  const subjectTasks = tasks.filter((t) => t.subjectId === subject.id).sort(byPendingThenDue);
  $('subject-tasks').replaceChildren(
    ...(subjectTasks.length
      ? subjectTasks.map((t) => taskItem(t, { showSubject: false }))
      : [emptyState('Sin tareas de esta materia.')]),
  );
  const subjectNotes = notes.filter((n) => n.subjectId === subject.id).sort(newestFirst);
  $('subject-notes').replaceChildren(
    ...(subjectNotes.length
      ? subjectNotes.map((n) => noteItem(n, { showSubject: false }))
      : [emptyState('Sin notas de esta materia.', 'note')]),
  );
}

// Anything that changes tasks, notes or subjects refreshes the places that
// cross-reference them.
function renderSubjectViews() {
  schedule.renderSubjects();
  renderSubjectPage();
}

$('subject-page-edit').addEventListener('click', () => schedule.openDialog({ subjectId: currentRoute().id }));

$('subject-task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('subject-task-title');
  const title = input.value.trim();
  if (!title) {
    input.focus();
    return;
  }
  try {
    await addTask({ title, due: $('subject-task-due').value, subjectId: currentRoute().id });
  } catch (err) {
    notifyTaskSaveError(err);
    return;
  }
  e.target.reset();
  input.focus();
});

$('subject-note-add').addEventListener('click', () => {
  const subjectId = currentRoute().id;
  location.hash = '#/notas';
  if (editingNoteId !== null) resetNoteForm();
  notesFilter = subjectId;
  renderNotesView();
  openNoteForm({ subjectId });
});

// Mirrors a subject delete/undo on the tasks and notes held in memory (the
// database already changed in the same transaction).
function applySubjectChange({ type, snapshot }) {
  if (type === 'deleted' || type === 'restored') {
    const subjectId = type === 'restored' ? snapshot.subject.id : null;
    const taskIds = new Set(snapshot.taskIds);
    const noteIds = new Set(snapshot.noteIds);
    for (const t of tasks)
      if (taskIds.has(t.id) && (type === 'deleted' || t.subjectId == null)) t.subjectId = subjectId;
    for (const n of notes)
      if (noteIds.has(n.id) && (type === 'deleted' || n.subjectId == null)) n.subjectId = subjectId;
  }
  fillSubjectSelects();
  render();
  renderNotesView();
  const route = currentRoute();
  if (type === 'deleted' && route.view === 'materia' && route.id === snapshot.subject?.id) location.hash = '#/horario';
}

const schedule = initSchedule({ onChange: applySubjectChange, getCounts: subjectCounts });

// Inicio's "Hoy" strip: today's classes (with what's on now / next) and how
// many tasks are due today.
function renderTodayPanel() {
  const statuses = todayStatus(schedule.todayBlocks(), new Date().getHours() * 60 + new Date().getMinutes());
  $('today-classes').replaceChildren(
    ...(statuses.length
      ? statuses.map(({ block: b, status, minutesUntil, minutesLeft }) => {
          const subject = schedule.subjectOf(b);
          const badge =
            status === 'now'
              ? h('span', { class: 'chip chip-ok' }, `Ahora · quedan ${formatDuration(minutesLeft)}`)
              : status === 'next'
                ? h('span', { class: 'chip chip-warn' }, `En ${formatDuration(minutesUntil)}`)
                : null;
          return h(
            'a',
            {
              href: `#/materia/${b.subjectId}`,
              class: `card today-class blk-${subject.color}${status === 'past' ? ' is-past' : ''}`,
            },
            h('span', { class: 'today-class-time' }, formatRange(b)),
            h('span', { class: 'task-title' }, subject.name),
            ...(b.place ? [h('span', { class: 'task-meta' }, b.place)] : []),
            ...(badge ? [badge] : []),
          );
        })
      : [emptyState('Hoy no tienes clases.', 'clock')]),
  );

  const today = todayISO();
  const due = tasks.filter((t) => !t.done && t.due === today).length;
  $('today-due-link').textContent = due
    ? `${due} tarea${due === 1 ? '' : 's'} vence${due === 1 ? '' : 'n'} hoy →`
    : 'Nada vence hoy →';
}

$('today-due-link').addEventListener('click', () => calendar.select(todayISO()));

// "Ahora / En 20 min", the red now-line and the date roll over by themselves.
setInterval(() => {
  renderToday();
  renderTodayPanel();
  schedule.render();
}, 60_000);

const todayFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });

function renderToday() {
  $('today').textContent = todayFmt.format(new Date()).replace(',', '');
}

function renderNetwork() {
  const online = navigator.onLine;
  const chip = $('net');
  chip.className = `chip ${online ? 'chip-ok' : 'chip-warn'}`;
  chip.replaceChildren(
    icon(online ? 'wifi' : 'wifi-off', 14),
    h('span', { class: 'chip-label' }, online ? 'En línea' : 'Sin conexión'),
  );
}

/* ---------- Settings: backup, reminders ---------- */
const LAST_BACKUP_KEY = 'notux.lastBackupAt';
const STALE_BACKUP_DAYS = 14;

function readLastBackup() {
  try {
    return localStorage.getItem(LAST_BACKUP_KEY);
  } catch {
    return null; // storage blocked: just don't show it
  }
}

function renderBackupInfo() {
  const el = $('backup-last');
  const last = readLastBackup();
  const hasData = tasks.length + notes.length + schedule.subjects().length > 0;
  const days = last ? Math.floor((Date.now() - new Date(last)) / 86400000) : null;
  el.classList.toggle('is-stale', hasData && (days === null || days >= STALE_BACKUP_DAYS));
  el.textContent =
    days === null
      ? hasData
        ? 'Aún no has descargado ningún respaldo desde este navegador.'
        : ''
      : `Último respaldo: ${days === 0 ? 'hoy' : days === 1 ? 'ayer' : `hace ${days} días`}.`;
  el.hidden = !el.textContent;
}

async function downloadBackup() {
  const { blob, counts } = await createBackup(db);
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: backupFileName() });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  try {
    localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString());
  } catch {
    // ignore
  }
  renderBackupInfo();
  return counts;
}

async function renderReminders() {
  const toggle = $('reminders-toggle');
  const info = await reminders.status(db);
  toggle.checked = info.level === 'ok' || info.level === 'limited';
  toggle.disabled = info.level === 'unsupported';
  const el = $('reminders-status');
  el.textContent = info.message;
  el.hidden = !info.message;
  el.className = `small ${info.level === 'ok' ? 'is-ok' : 'is-warn'}`;
  $('reminders-test').hidden = !toggle.checked;
}

function openSettings() {
  renderBackupInfo();
  renderReminders();
  updateLockState();
  $('settings-dialog').showModal();
}
$('btn-settings').addEventListener('click', openSettings); // sidebar
$('btn-settings-mobile').addEventListener('click', openSettings); // top bar on phones
$('settings-close').addEventListener('click', () => $('settings-dialog').close());

$('backup-export').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const counts = await downloadBackup();
    showToast(`Respaldo descargado: ${describeCounts(counts)}.`);
  } catch (err) {
    console.error('Could not create the backup:', err);
    showToast('No se pudo crear el respaldo.', { type: 'error' });
  } finally {
    btn.disabled = false;
  }
});

let pendingRestore = null; // parsed backup waiting for confirmation

$('backup-import').addEventListener('click', () => $('backup-file').click());

$('backup-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = ''; // picking the same file again should still fire 'change'
  if (!file) return;
  try {
    pendingRestore = parseBackup(await file.text());
  } catch (err) {
    if (!(err instanceof InvalidBackupError)) console.error('Could not read the backup:', err);
    showToast(err instanceof InvalidBackupError ? err.message : 'No se pudo leer el archivo.', { type: 'error' });
    return;
  }
  const { counts, exportedAt } = pendingRestore;
  const when = exportedAt
    ? new Date(exportedAt).toLocaleString(LOCALE, { dateStyle: 'long', timeStyle: 'short' })
    : 'fecha desconocida';
  $('restore-backup').textContent = `${describeCounts(counts)} · descargado el ${when}`;
  $('restore-current').textContent = describeCounts({
    tasks: tasks.length,
    notes: notes.length,
    subjects: schedule.subjects().length,
    schedule: schedule.count(),
  });
  $('restore-error').hidden = true;
  $('restore-dialog').showModal();
});

$('restore-save-current').addEventListener('click', async () => {
  try {
    await downloadBackup();
  } catch (err) {
    console.error('Could not create the backup:', err);
    showToast('No se pudo descargar el respaldo actual.', { type: 'error' });
  }
});

$('restore-cancel').addEventListener('click', () => $('restore-dialog').close());
$('restore-dialog').addEventListener('close', () => (pendingRestore = null));

$('restore-confirm').addEventListener('click', async (e) => {
  if (!pendingRestore) return;
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await restoreBackup(db, pendingRestore.data);
  } catch (err) {
    console.error('Could not restore the backup:', err);
    $('restore-error').textContent = 'No se pudo restaurar. Tus datos actuales no se modificaron.';
    $('restore-error').hidden = false;
    return;
  } finally {
    btn.disabled = false;
  }
  const { counts } = pendingRestore;
  $('restore-dialog').close();
  $('settings-dialog').close();
  await reloadAllData();
  showToast(`Respaldo restaurado: ${describeCounts(counts)}.`);
});

// After a restore everything in memory is stale, including the notes key: the
// restored notes may use another password, so they start locked.
async function reloadAllData() {
  notesKey = null;
  revealedNoteId = null;
  decryptedNotes.clear();
  closeNoteForm();
  notesFilter = 'all';
  for (const id of [...noteThumbUrls.keys(), ...noteAudioUrls.keys()]) forgetNoteMedia(id);
  tasks = await getAllTasks(db);
  notes = await getAllNotes(db);
  await schedule.load(db);
  fillSubjectSelects();
  $('task-note').value = '';
  updateLockState();
  updateNoteFormState();
  render();
  renderNotesView();
  reminders.refresh(db);
}

$('reminders-toggle').addEventListener('change', async (e) => {
  const toggle = e.currentTarget;
  toggle.disabled = true;
  try {
    if (toggle.checked) {
      const ok = await reminders.enable(db);
      if (!ok) showToast('Sin permiso para notificaciones no se pueden enviar recordatorios.', { type: 'error' });
    } else {
      await reminders.disable(db);
    }
  } catch (err) {
    console.error('Could not change the reminder setting:', err);
    showToast('No se pudo cambiar el recordatorio.', { type: 'error' });
  } finally {
    toggle.disabled = false;
    renderReminders();
  }
});

$('reminders-test').addEventListener('click', () => reminders.sendTest());

/* ---------- Startup ---------- */
function notifyTaskSaveError(err) {
  console.error('Could not save the task:', err);
  showToast(
    err.name === 'ConstraintError'
      ? 'Ya existe una tarea con ese título.'
      : 'No se pudo guardar la tarea. Intenta de nuevo.',
    { type: 'error' },
  );
}

const calendar = initCalendar({
  getTasks: () => tasks,
  renderTask: taskItem,
  onAddTask: async (title, due, priority) => {
    try {
      await addTask({ title, due, priority });
    } catch (err) {
      notifyTaskSaveError(err);
      throw err;
    }
  },
});

$('task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const titleInput = $('task-title');
  const title = titleInput.value.trim();
  if (!title) {
    titleInput.focus();
    return;
  }
  const due = $('task-due').value;
  const priority = $('task-priority').value;
  const note = $('task-note').value.trim();
  const subjectId = readSubjectSelect($('task-subject'));

  try {
    await addTask({ title, due, priority, noteText: note || null, subjectId });
  } catch (err) {
    notifyTaskSaveError(err);
    return;
  }
  e.target.reset();
  $('task-priority').value = 'medium';
  titleInput.focus();
});

function updateBulkDoneButtonState() {
  $('tasks-bulk-done').disabled = $('tasks-filter').value === 'all';
}

$('tasks-search').addEventListener('input', renderTasksView);
$('tasks-subject').addEventListener('change', renderTasksView);
$('tasks-filter').addEventListener('change', () => {
  renderTasksView();
  updateBulkDoneButtonState();
});

$('tasks-bulk-done').addEventListener('click', async () => {
  const priority = $('tasks-filter').value;
  if (priority === 'all') return;
  try {
    const updated = await markTasksDoneByPriority(db, priority);
    if (updated > 0) {
      tasks = await getAllTasks(db);
      render();
    }
    showToast(
      updated > 0
        ? `${updated} tarea${updated === 1 ? '' : 's'} marcada${updated === 1 ? '' : 's'} como hecha${updated === 1 ? '' : 's'}.`
        : 'No había tareas pendientes con esa prioridad.',
    );
  } catch (err) {
    console.error('Could not bulk-update tasks:', err);
    showToast('No se pudieron marcar las tareas.', { type: 'error' });
  }
});

window.addEventListener('online', renderNetwork);
window.addEventListener('offline', renderNetwork);

async function init() {
  db = await openDatabase({
    onBlocked: () =>
      showToast('Cierra las otras pestañas de Notux para terminar de actualizar la app.', { duration: 15000 }),
    onVersionChange: () =>
      showToast('Notux se actualizó en otra pestaña.', {
        type: 'error',
        duration: 60000,
        action: { label: 'Recargar', onClick: () => location.reload() },
      }),
  });
  await migrateFromLocalStorage();
  tasks = await getAllTasks(db);
  notes = await getAllNotes(db);
  await schedule.load(db);
  fillSubjectSelects();

  renderToday();
  renderNetwork();
  updateLockState();
  updateNoteFormState();
  updateBulkDoneButtonState();
  render();
  renderNotesView();
  reminders.refresh(db).catch(() => {});
}

navigate();
init().catch((err) => {
  console.error('Could not start Notux:', err);
  showToast('No se pudo abrir la base de datos de Notux. Recarga la página.', { type: 'error', duration: 15000 });
});
