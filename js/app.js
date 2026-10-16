import {
  openDatabase,
  createTask,
  updateTask,
  deleteTask,
  getAllTasks,
  countTasks,
  markTasksDoneByPriority,
  saveConfig,
  getConfig,
  createNote,
  deleteNote,
  getAllNotes,
} from './db.js';
import { generateSalt, deriveKeyFromPassword, encryptText, decryptText } from './crypto.js';
import { isCameraSupported, openCamera, stopCamera, capturePhoto, processGalleryPhoto } from './device.js';

const TASKS_KEY = 'notux.tasks';
const NOTES_CONFIG_ID = 'privateNotes';
const NOTES_CHECK_TEXT = 'notux-verificacion'; // internal sentinel only, never shown — keep stable across renames
const PRIORITY_LABEL = { high: 'Alta', medium: 'Media', low: 'Baja' };
const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

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
const decryptedNotes = new Map();

let cameraStream = null;
let capturedPhoto = null; // Blob | null, for the note currently being composed
let capturedPhotoUrl = null; // object URL for its preview, revoked on change/reset
const noteThumbUrls = new Map(); // note.id -> object URL, revoked when the note is removed or re-rendered

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

/* ---------- Private notes: password and key ---------- */
async function isPasswordConfigured() {
  return !!(await getConfig(db, NOTES_CONFIG_ID));
}

async function createPassword(password) {
  const salt = generateSalt();
  const key = await deriveKeyFromPassword(password, salt);
  const verification = await encryptText(key, NOTES_CHECK_TEXT);
  await saveConfig(db, { id: NOTES_CONFIG_ID, salt, verification });
  notesKey = key;
}

async function unlock(password) {
  const config = await getConfig(db, NOTES_CONFIG_ID);
  if (!config) throw new Error('No password configured');
  const key = await deriveKeyFromPassword(password, config.salt);
  // If the password is wrong, decrypt() rejects the promise (AES-GCM detects the wrong key).
  const text = await decryptText(key, config.verification);
  if (text !== NOTES_CHECK_TEXT) throw new Error('Incorrect password');
  notesKey = key;
}

function lock() {
  notesKey = null;
  revealedNoteId = null;
  decryptedNotes.clear();
  updateLockState();
  updateNoteFormState();
  render();
}

async function revealNote(t) {
  if (decryptedNotes.has(t.id)) return;
  const text = await decryptText(notesKey, { ciphertext: t.encryptedNote, iv: t.noteIv });
  decryptedNotes.set(t.id, text);
}

function toggleNote(t) {
  return async () => {
    if (!notesKey) {
      openPasswordDialog({
        mode: (await isPasswordConfigured()) ? 'unlock' : 'create',
        onSuccess: toggleNote(t),
      });
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
      alert('No se pudo descifrar esta nota.');
    }
  };
}

/* ---------- Password dialog ---------- */
function openPasswordDialog({ mode, onSuccess }) {
  const dialog = $('pw-dialog');
  const form = $('pw-form');
  const input = $('pw-input');
  const error = $('pw-error');

  $('pw-title').textContent = mode === 'create' ? 'Crea una contraseña' : 'Desbloquea tus notas privadas';
  $('pw-desc').textContent =
    mode === 'create'
      ? 'Se usará para cifrar tus notas privadas. Si la olvidas, esas notas no se podrán recuperar.'
      : 'Ingresa la contraseña que usaste para cifrar tus notas privadas.';
  error.hidden = true;
  input.value = '';

  const onSubmit = async (e) => {
    e.preventDefault();
    const password = input.value;
    if (!password) return;
    try {
      if (mode === 'create') await createPassword(password);
      else await unlock(password);

      form.removeEventListener('submit', onSubmit);
      dialog.close();
      updateLockState();
      updateNoteFormState();
      await onSuccess?.();
    } catch (err) {
      console.error(err);
      error.textContent = 'Contraseña incorrecta.';
      error.hidden = false;
      input.focus();
      input.select();
    }
  };

  form.addEventListener('submit', onSubmit);
  dialog.showModal();
}

$('pw-cancel').addEventListener('click', () => $('pw-dialog').close());

function updateLockState() {
  const btn = $('notes-lock');
  if (notesKey) {
    btn.className = 'chip chip-ok';
    btn.replaceChildren(icon('unlock', 14), 'Notas privadas');
    return;
  }
  isPasswordConfigured().then((configured) => {
    btn.className = 'chip chip-warn';
    btn.replaceChildren(icon('lock', 14), configured ? 'Notas privadas' : 'Configurar notas');
  });
}

function updateNoteFormState() {
  $('task-note').disabled = !notesKey;
  $('task-note-hint').hidden = !!notesKey;
}

$('notes-lock').addEventListener('click', async () => {
  if (notesKey) {
    lock();
    return;
  }
  openPasswordDialog({ mode: (await isPasswordConfigured()) ? 'unlock' : 'create' });
});

$('task-note-unlock').addEventListener('click', async () => {
  openPasswordDialog({ mode: (await isPasswordConfigured()) ? 'unlock' : 'create' });
});

/* ---------- DOM ---------- */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function icon(name, size = 20) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/* ---------- Dates ---------- */
const weekdayFmt = new Intl.DateTimeFormat('es-CO', { weekday: 'long' });
const shortDateFmt = new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short' });
const todayFmt = new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const parseDay = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const dayDiff = (s) => Math.round((parseDay(s) - startOfDay(new Date())) / 86400000);

function relativeDate(s) {
  if (!s) return 'Sin fecha';
  const n = dayDiff(s);
  if (n === 0) return 'Hoy';
  if (n === 1) return 'Mañana';
  if (n === -1) return 'Ayer';
  if (n > 1 && n < 7) return weekdayFmt.format(parseDay(s));
  return shortDateFmt.format(parseDay(s));
}

/* ---------- Actions ---------- */
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
    const { ciphertext, iv } = await encryptText(notesKey, noteText);
    task.encryptedNote = ciphertext;
    task.noteIv = iv;
  }
  const id = await createTask(db, task);
  tasks.push({ ...task, id });
  render();
}

async function toggleTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  const updated = { ...task, done: !task.done, completedAt: !task.done ? new Date().toISOString() : null };
  await updateTask(db, updated);
  Object.assign(task, updated);
  render();
}

async function removeTask(id) {
  await deleteTask(db, id);
  tasks = tasks.filter((t) => t.id !== id);
  decryptedNotes.delete(id);
  render();
}

/* ---------- Free-form notes: camera, gallery, CRUD ---------- */
// These notes are separate from the encrypted notaPrivada field on tasks — they're
// plain (unencrypted) and can carry a photo, so they don't belong behind the password lock.
if (!isCameraSupported()) {
  $('note-camera-btn').hidden = true;
}

function setNotePhoto(blob) {
  capturedPhoto = blob;
  if (capturedPhotoUrl) URL.revokeObjectURL(capturedPhotoUrl);
  capturedPhotoUrl = URL.createObjectURL(blob);
  const img = $('note-photo-preview');
  img.src = capturedPhotoUrl;
  img.hidden = false;
}

function resetNotePhoto() {
  capturedPhoto = null;
  if (capturedPhotoUrl) URL.revokeObjectURL(capturedPhotoUrl);
  capturedPhotoUrl = null;
  $('note-photo-preview').hidden = true;
}

$('note-camera-btn').addEventListener('click', async () => {
  try {
    cameraStream = await openCamera('environment');
    $('camera-video').srcObject = cameraStream;
    $('camera-dialog').showModal();
  } catch (err) {
    console.error('Could not open the camera:', err);
    alert('No se pudo abrir la cámara. Revisa los permisos en el candado de la barra de direcciones.');
  }
});

$('camera-capture').addEventListener('click', async () => {
  const blob = await capturePhoto($('camera-video'));
  setNotePhoto(blob);
  stopCamera(cameraStream);
  cameraStream = null;
  $('camera-dialog').close();
});

$('camera-cancel').addEventListener('click', () => {
  stopCamera(cameraStream);
  cameraStream = null;
  $('camera-dialog').close();
});

$('note-gallery-btn').addEventListener('click', () => $('note-gallery-input').click());

$('note-gallery-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const blob = await processGalleryPhoto(file);
  setNotePhoto(blob);
  e.target.value = ''; // allow picking the same file again later
});

$('note-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const titleInput = $('note-title');
  const title = titleInput.value.trim();
  if (!title) {
    titleInput.focus();
    return;
  }
  const text = $('note-text').value.trim();
  const note = { title, text, photo: capturedPhoto, createdAt: new Date().toISOString() };

  try {
    const id = await createNote(db, note);
    notes.unshift({ ...note, id });
  } catch (err) {
    console.error('Could not save the note:', err);
    alert('No se pudo guardar la nota. Intenta de nuevo.');
    return;
  }
  e.target.reset();
  resetNotePhoto();
  renderNotesView();
});

async function removeNote(id) {
  await deleteNote(db, id);
  notes = notes.filter((n) => n.id !== id);
  const url = noteThumbUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    noteThumbUrls.delete(id);
  }
  renderNotesView();
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
    ...(hasNote
      ? [
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-ghost icon-btn',
              'aria-label': noteVisible ? 'Ocultar nota privada' : 'Ver nota privada',
              onclick: toggleNote(t),
            },
            icon('note', 18),
          ),
        ]
      : []),
    h(
      'button',
      { type: 'button', class: 'btn btn-ghost icon-btn', 'aria-label': 'Eliminar tarea', onclick: () => removeTask(t.id) },
      icon('trash'),
    ),
  );

  return h(
    'div',
    { class: `card task-card${t.done ? ' is-done' : ''}` },
    row,
    ...(noteVisible ? [h('p', { class: 'task-note' }, decryptedNotes.get(t.id))] : []),
  );
}

function emptyState(message, iconName = 'check-circle') {
  return h('p', { class: 'card empty' }, icon(iconName), message);
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

  return h(
    'div',
    { class: 'card note-card' },
    h(
      'div',
      { class: 'task' },
      h(
        'div',
        { class: 'task-body' },
        h('span', { class: 'task-title' }, n.title),
        h('span', { class: 'task-meta' }, new Date(n.createdAt).toLocaleDateString('es-CO')),
      ),
      h(
        'button',
        { type: 'button', class: 'btn btn-ghost icon-btn', 'aria-label': 'Eliminar nota', onclick: () => removeNote(n.id) },
        icon('trash'),
      ),
    ),
    ...(n.text ? [h('p', { class: 'task-note' }, n.text)] : []),
    ...(thumbUrl ? [h('img', { class: 'note-photo', src: thumbUrl, alt: '' })] : []),
  );
}

function renderNotesView() {
  $('notes-list').replaceChildren(...(notes.length ? notes.map(noteItem) : [emptyState('Aún no tienes notas.', 'note')]));
}

function renderToday() {
  $('today').textContent = todayFmt.format(new Date()).replace(',', '');
}

function renderNetwork() {
  const online = navigator.onLine;
  const chip = $('net');
  chip.className = `chip ${online ? 'chip-ok' : 'chip-warn'}`;
  chip.replaceChildren(icon(online ? 'wifi' : 'wifi-off', 14), online ? 'En línea' : 'Sin conexión');
}

/* ---------- Startup ---------- */
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
    console.error('Could not save the task:', err);
    alert(err.name === 'ConstraintError' ? 'Ya existe una tarea con ese título.' : 'No se pudo guardar la tarea. Intenta de nuevo.');
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
  } catch (err) {
    console.error('Could not bulk-update tasks:', err);
    alert('No se pudieron marcar las tareas.');
  }
});

window.addEventListener('online', renderNetwork);
window.addEventListener('offline', renderNetwork);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    renderToday();
    render();
  }
});

async function init() {
  db = await openDatabase();
  await migrateFromLocalStorage();
  tasks = await getAllTasks(db);
  notes = await getAllNotes(db);

  renderToday();
  renderNetwork();
  updateLockState();
  updateNoteFormState();
  updateBulkDoneButtonState();
  render();
  renderNotesView();
}

navigate();
init().catch((err) => console.error('Could not start Notux:', err));
