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
import { initSchedule, todayStatus, formatRange, formatDuration } from './schedule.js';

const TASKS_KEY = 'notux.tasks';
const PRIORITY_LABEL = { high: 'Alta', medium: 'Media', low: 'Baja' };
const IDLE_LOCK_MS = 5 * 60 * 1000; // no taps or keys for this long → lock private notes
const HIDDEN_LOCK_MS = 60 * 1000; // app in the background for this long → lock private notes

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('sw.js')
      .then((reg) => console.log('notux registered:', reg.scope))
      .catch((err) => console.error('Error registering the service worker:', err));
  });
}

/* ---------- Install prompt ---------- */
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  $('btn-install').hidden = false;
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  $('btn-install').hidden = true;
});

$('btn-install').addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  console.log('Install prompt outcome:', outcome);
  deferredInstallPrompt = null;
  $('btn-install').hidden = true;
});

/* ---------- State ---------- */
let db;
let tasks = [];
let notes = [];
let notesKey = null; // CryptoKey held in memory; null = private notes locked
let revealedNoteId = null;
const decryptedNotes = new Map(); // task.id -> plaintext, cleared on lock

let editingTask = null; // { id, noteLoaded } while the edit dialog is open
let editingNoteId = null; // id of the free-form note loaded in the note form, or null

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

/* ---------- Routes ---------- */
const VIEWS = ['inicio', 'tareas', 'calendario', 'horario', 'notas'];

function currentRoute() {
  const route = location.hash.replace(/^#\/?/, '');
  return VIEWS.includes(route) ? route : 'inicio';
}

function navigate() {
  const route = currentRoute();
  for (const v of VIEWS) {
    $(`view-${v}`).hidden = v !== route;
  }
  document.querySelectorAll('[data-route]').forEach((a) => {
    if (a.dataset.route === route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
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
  btn.className = `chip ${notesKey ? 'chip-ok' : 'chip-warn'}`;
  btn.replaceChildren(icon(notesKey ? 'unlock' : 'lock', 14), configured ? 'Notas privadas' : 'Configurar notas');
  btn.title = notesKey ? 'Bloquear notas privadas' : configured ? 'Desbloquear notas privadas' : 'Crear una contraseña';
  $('btn-change-password').hidden = !configured;
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
async function addTask(title, due, priority, noteText) {
  const task = {
    title,
    due: due || null,
    done: false,
    priority,
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

  const updated = { ...t, title, due: $('task-edit-due').value || null, priority: $('task-edit-priority').value };
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
  $('note-edit-banner').hidden = true;
  $('note-submit').textContent = 'Guardar nota';
}

// Editing reuses the creation form, so camera, gallery and recording work the same.
function startNoteEdit(id) {
  const n = notes.find((x) => x.id === id);
  if (!n) return;
  discardRecording();
  editingNoteId = id;
  $('note-title').value = n.title;
  $('note-text').value = n.text ?? '';
  if (n.photo) setNotePhoto(n.photo);
  else resetNotePhoto();
  if (n.audio) setNoteAudio(n.audio);
  else resetNoteAudio();
  $('note-edit-banner').hidden = false;
  $('note-submit').textContent = 'Guardar cambios';
  renderNotesView();
  $('note-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('note-title').focus({ preventScroll: true });
}

$('note-edit-cancel').addEventListener('click', () => {
  resetNoteForm();
  renderNotesView();
});

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
  const fields = { title, text: $('note-text').value.trim(), photo: capturedPhoto, audio: capturedAudio };
  const existing = editingNoteId !== null ? notes.find((n) => n.id === editingNoteId) : null;

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
    }
  } catch (err) {
    console.error('Could not save the note:', err);
    showToast('No se pudo guardar la nota. Intenta de nuevo.', { type: 'error' });
    return;
  } finally {
    savingNote = false;
  }
  resetNoteForm();
  renderNotesView();
  if (existing) showToast('Nota actualizada.');
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
  if (editingNoteId === id) resetNoteForm();
  renderNotesView();
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
}

// Deterministic per note.id so cards don't re-shuffle their look on every re-render.
function noteCardStyle(id) {
  const angle = ((id * 53) % 9) - 4; // -4..4deg
  const delay = ((id * 37) % 40) / 10; // 0..3.9s
  const hue = (id * 67) % 360;
  return `--note-angle: ${angle}deg; --note-delay: ${delay}s; --note-hue: ${hue};`;
}

/* ---------- Render ---------- */
function taskItem(t) {
  const overdue = !t.done && t.due && dayDiff(t.due) < 0;
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
        { class: `task-meta${overdue ? ' overdue' : ''}` },
        `${relativeDate(t.due)} · ${PRIORITY_LABEL[t.priority] ?? 'Media'}`,
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
}

function renderTasksView() {
  const search = $('tasks-search').value.trim().toLowerCase();
  const priorityFilter = $('tasks-filter').value;

  const filtered = tasks
    .filter((t) => priorityFilter === 'all' || t.priority === priorityFilter)
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

function noteItem(n) {
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
    { class: `card note-card${editingNoteId === n.id ? ' is-editing' : ''}`, style: noteCardStyle(n.id) },
    h(
      'div',
      { class: 'task' },
      h(
        'div',
        { class: 'task-body' },
        h('span', { class: 'task-title' }, n.title),
        h('span', { class: 'task-meta' }, new Date(n.createdAt).toLocaleDateString(LOCALE)),
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

function renderNotesView() {
  // Newest first, whatever order they were loaded, created or restored in.
  const sorted = [...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $('notes-list').replaceChildren(
    ...(sorted.length ? sorted.map(noteItem) : [emptyState('Aún no tienes notas.', 'note')]),
  );
}

const schedule = initSchedule({ onChange: () => renderTodayPanel() });

// Inicio's "Hoy" strip: today's classes (with what's on now / next) and how
// many tasks are due today.
function renderTodayPanel() {
  const statuses = todayStatus(schedule.todayBlocks(), new Date().getHours() * 60 + new Date().getMinutes());
  $('today-classes').replaceChildren(
    ...(statuses.length
      ? statuses.map(({ block: b, status, minutesUntil, minutesLeft }) => {
          const badge =
            status === 'now'
              ? h('span', { class: 'chip chip-ok' }, `Ahora · quedan ${formatDuration(minutesLeft)}`)
              : status === 'next'
                ? h('span', { class: 'chip chip-warn' }, `En ${formatDuration(minutesUntil)}`)
                : null;
          return h(
            'a',
            {
              href: '#/horario',
              class: `card today-class blk-${b.color ?? 'indigo'}${status === 'past' ? ' is-past' : ''}`,
            },
            h('span', { class: 'today-class-time' }, formatRange(b)),
            h('span', { class: 'task-title' }, b.subject),
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
      await addTask(title, due, priority, null);
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

  try {
    await addTask(title, due, priority, note || null);
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

  renderToday();
  renderNetwork();
  updateLockState();
  updateNoteFormState();
  updateBulkDoneButtonState();
  render();
  renderNotesView();
}

navigate();
init().catch((err) => {
  console.error('Could not start Notux:', err);
  showToast('No se pudo abrir la base de datos de Notux. Recarga la página.', { type: 'error', duration: 15000 });
});
