const TASKS_KEY = 'notux.tasks';
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
let tasks = loadTasks();

function loadTasks() {
  try {
    const data = JSON.parse(localStorage.getItem(TASKS_KEY));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveTasks() {
  try {
    localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
  } catch {
    /* almacenamiento no disponible: la app sigue funcionando en memoria */
  }
}

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

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
function addTask(title, due) {
  tasks.push({ id: newId(), title, due: due || null, done: false, createdAt: new Date().toISOString(), completedAt: null });
  saveTasks();
  render();
}

function toggleTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  task.done = !task.done;
  task.completedAt = task.done ? new Date().toISOString() : null;
  saveTasks();
  render();
}

function removeTask(id) {
  tasks = tasks.filter((t) => t.id !== id);
  saveTasks();
  render();
}

/* ---------- Render ---------- */
function taskItem(t) {
  const overdue = !t.done && t.due && dayDiff(t.due) < 0;
  return h(
    'div',
    { class: `card task${t.done ? ' is-done' : ''}` },
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
      h('span', { class: `task-meta${overdue ? ' overdue' : ''}` }, relativeDate(t.due)),
    ),
    h(
      'button',
      { type: 'button', class: 'btn btn-ghost icon-btn', 'aria-label': 'Eliminar tarea', onclick: () => removeTask(t.id) },
      icon('trash'),
    ),
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
$('task-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const titleInput = $('task-title');
  const title = titleInput.value.trim();
  if (!title) {
    titleInput.focus();
    return;
  }
  addTask(title, $('task-due').value);
  e.target.reset();
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

renderToday();
renderNetwork();
render();
