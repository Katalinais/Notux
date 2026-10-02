import {
  abrirBaseDeDatos,
  agregarTarea,
  actualizarTarea,
  eliminarTarea,
  obtenerTodasLasTareas,
  contarTareas,
  guardarConfig,
  obtenerConfig,
} from './db.js';
import { generarSal, derivarClaveDesdeContrasena, cifrarTexto, descifrarTexto } from './crypto.js';

const TASKS_KEY = 'notux.tasks';
const NOTES_CONFIG_ID = 'notasPrivadas';
const NOTES_CHECK_TEXT = 'notux-verificacion';
const PRIORIDAD_LABEL = { alta: 'Alta', media: 'Media', baja: 'Baja' };
const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('sw.js')
      .then((reg) => console.log('notux registrado:', reg.scope))
      .catch((err) => console.error('Error al registrar el sw:', err));
  });
}

/* ---------- Estado ---------- */
let db;
let tasks = [];
let notesKey = null; // CryptoKey en memoria; null = notas privadas bloqueadas
let revealedNoteId = null;
const decryptedNotes = new Map();

/* ---------- Migración desde localStorage (versión pre-IndexedDB) ---------- */
async function migrarDesdeLocalStorage() {
  const total = await contarTareas(db);
  if (total > 0) return;

  let antiguas;
  try {
    antiguas = JSON.parse(localStorage.getItem(TASKS_KEY));
  } catch {
    antiguas = null;
  }
  if (!Array.isArray(antiguas) || antiguas.length === 0) return;

  for (const t of antiguas) {
    await agregarTarea(db, {
      title: t.title,
      due: t.due ?? null,
      done: !!t.done,
      prioridad: 'media',
      createdAt: t.createdAt ?? new Date().toISOString(),
      completedAt: t.completedAt ?? null,
      notaCifrada: null,
      notaIv: null,
    });
  }
  localStorage.removeItem(TASKS_KEY);
  console.log(`notux: ${antiguas.length} tarea(s) migradas de localStorage a IndexedDB`);
}

/* ---------- Notas privadas: contraseña y clave ---------- */
async function candadoConfigurado() {
  return !!(await obtenerConfig(db, NOTES_CONFIG_ID));
}

async function crearContrasena(contrasena) {
  const sal = generarSal();
  const clave = await derivarClaveDesdeContrasena(contrasena, sal);
  const verificacion = await cifrarTexto(clave, NOTES_CHECK_TEXT);
  await guardarConfig(db, { id: NOTES_CONFIG_ID, sal, verificacion });
  notesKey = clave;
}

async function desbloquear(contrasena) {
  const cfg = await obtenerConfig(db, NOTES_CONFIG_ID);
  if (!cfg) throw new Error('No hay contraseña configurada');
  const clave = await derivarClaveDesdeContrasena(contrasena, cfg.sal);
  // Si la contraseña es incorrecta, decrypt() rechaza la promesa (AES-GCM detecta la clave equivocada).
  const texto = await descifrarTexto(clave, cfg.verificacion);
  if (texto !== NOTES_CHECK_TEXT) throw new Error('Contraseña incorrecta');
  notesKey = clave;
}

function bloquear() {
  notesKey = null;
  revealedNoteId = null;
  decryptedNotes.clear();
  actualizarEstadoCandado();
  actualizarEstadoNotaForm();
  render();
}

async function revelarNota(t) {
  if (decryptedNotes.has(t.id)) return;
  const texto = await descifrarTexto(notesKey, { cifrado: t.notaCifrada, iv: t.notaIv });
  decryptedNotes.set(t.id, texto);
}

function toggleNota(t) {
  return async () => {
    if (!notesKey) {
      abrirDialogoContrasena({
        modo: (await candadoConfigurado()) ? 'desbloquear' : 'crear',
        onExito: toggleNota(t),
      });
      return;
    }
    if (revealedNoteId === t.id) {
      revealedNoteId = null;
      render();
      return;
    }
    try {
      await revelarNota(t);
      revealedNoteId = t.id;
      render();
    } catch (err) {
      console.error('No se pudo descifrar la nota:', err);
      alert('No se pudo descifrar esta nota.');
    }
  };
}

/* ---------- Diálogo de contraseña ---------- */
function abrirDialogoContrasena({ modo, onExito }) {
  const dialog = $('pw-dialog');
  const form = $('pw-form');
  const input = $('pw-input');
  const error = $('pw-error');

  $('pw-title').textContent = modo === 'crear' ? 'Crea una contraseña' : 'Desbloquea tus notas privadas';
  $('pw-desc').textContent =
    modo === 'crear'
      ? 'Se usará para cifrar tus notas privadas. Si la olvidas, esas notas no se podrán recuperar.'
      : 'Ingresa la contraseña que usaste para cifrar tus notas privadas.';
  error.hidden = true;
  input.value = '';

  const onSubmit = async (e) => {
    e.preventDefault();
    const contrasena = input.value;
    if (!contrasena) return;
    try {
      if (modo === 'crear') await crearContrasena(contrasena);
      else await desbloquear(contrasena);

      form.removeEventListener('submit', onSubmit);
      dialog.close();
      actualizarEstadoCandado();
      actualizarEstadoNotaForm();
      await onExito?.();
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

function actualizarEstadoCandado() {
  const btn = $('notes-lock');
  if (notesKey) {
    btn.className = 'chip chip-ok';
    btn.replaceChildren(icon('unlock', 14), 'Notas privadas');
    return;
  }
  candadoConfigurado().then((configurado) => {
    btn.className = 'chip chip-warn';
    btn.replaceChildren(icon('lock', 14), configurado ? 'Notas privadas' : 'Configurar notas');
  });
}

function actualizarEstadoNotaForm() {
  $('task-note').disabled = !notesKey;
  $('task-note-hint').hidden = !!notesKey;
}

$('notes-lock').addEventListener('click', async () => {
  if (notesKey) {
    bloquear();
    return;
  }
  abrirDialogoContrasena({ modo: (await candadoConfigurado()) ? 'desbloquear' : 'crear' });
});

$('task-note-unlock').addEventListener('click', async () => {
  abrirDialogoContrasena({ modo: (await candadoConfigurado()) ? 'desbloquear' : 'crear' });
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

/* ---------- Fechas ---------- */
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

/* ---------- Acciones ---------- */
async function addTask(title, due, prioridad, notaTexto) {
  const tarea = {
    title,
    due: due || null,
    done: false,
    prioridad,
    createdAt: new Date().toISOString(),
    completedAt: null,
    notaCifrada: null,
    notaIv: null,
  };
  if (notaTexto) {
    if (!notesKey) throw new Error('Notas privadas bloqueadas');
    const { cifrado, iv } = await cifrarTexto(notesKey, notaTexto);
    tarea.notaCifrada = cifrado;
    tarea.notaIv = iv;
  }
  const id = await agregarTarea(db, tarea);
  tasks.push({ ...tarea, id });
  render();
}

async function toggleTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  const actualizada = { ...task, done: !task.done, completedAt: !task.done ? new Date().toISOString() : null };
  await actualizarTarea(db, actualizada);
  Object.assign(task, actualizada);
  render();
}

async function removeTask(id) {
  await eliminarTarea(db, id);
  tasks = tasks.filter((t) => t.id !== id);
  decryptedNotes.delete(id);
  render();
}

/* ---------- Render ---------- */
function taskItem(t) {
  const overdue = !t.done && t.due && dayDiff(t.due) < 0;
  const tieneNota = !!t.notaCifrada;
  const notaVisible = tieneNota && revealedNoteId === t.id && decryptedNotes.has(t.id);

  const fila = h(
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
        `${relativeDate(t.due)} · ${PRIORIDAD_LABEL[t.prioridad] ?? 'Media'}`,
      ),
    ),
    ...(tieneNota
      ? [
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-ghost icon-btn',
              'aria-label': notaVisible ? 'Ocultar nota privada' : 'Ver nota privada',
              onclick: toggleNota(t),
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
    fila,
    ...(notaVisible ? [h('p', { class: 'task-note' }, decryptedNotes.get(t.id))] : []),
  );
}

function emptyState() {
  return h('p', { class: 'card empty' }, icon('check-circle'), '¡Nada pendiente!');
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

  $('pending').replaceChildren(...(pending.length ? pending.map(taskItem) : [emptyState()]));
  $('done-section').hidden = done.length === 0;
  $('done').replaceChildren(...done.map(taskItem));
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

/* ---------- Inicio ---------- */
$('task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const titleInput = $('task-title');
  const title = titleInput.value.trim();
  if (!title) {
    titleInput.focus();
    return;
  }
  const due = $('task-due').value;
  const prioridad = $('task-priority').value;
  const nota = $('task-note').value.trim();

  try {
    await addTask(title, due, prioridad, nota || null);
  } catch (err) {
    console.error('No se pudo guardar la tarea:', err);
    alert('No se pudo guardar la tarea. Intenta de nuevo.');
    return;
  }
  e.target.reset();
  $('task-priority').value = 'media';
  titleInput.focus();
});

window.addEventListener('online', renderNetwork);
window.addEventListener('offline', renderNetwork);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    renderToday();
    render();
  }
});

async function iniciar() {
  db = await abrirBaseDeDatos();
  await migrarDesdeLocalStorage();
  tasks = await obtenerTodasLasTareas(db);

  renderToday();
  renderNetwork();
  actualizarEstadoCandado();
  actualizarEstadoNotaForm();
  render();
}

iniciar().catch((err) => console.error('No se pudo iniciar Notux:', err));
