// Calendar view: a month grid with tasks placed on their due date, plus a panel
// with the selected day's tasks and a quick-add form for that day.
//
// The only state is the selected day; the month shown is always the month of
// that day, so prev/next, "Hoy", clicking a spill-over day and keyboard
// navigation are all just "select another day".
import { $, h, emptyState } from './dom.js';
import {
  LOCALE,
  todayISO,
  parseDay,
  addDays,
  addMonths,
  sameMonth,
  dayDiff,
  monthGrid,
  weekdayNames,
  firstDayOfWeek,
} from './dates.js';

const MAX_PILLS = 3; // titles shown per day on wide screens; the rest become "+N"
const MAX_DOTS = 3; // dots shown per day on phones
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

const monthFmt = new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' });
const dayLongFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
const monthYearFmt = new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' });
const weekdayFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'long' });
const dayContext = (d) => `de ${monthYearFmt.format(d)}, ${weekdayFmt.format(d)}`;

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const byDoneThenPriority = (a, b) =>
  Number(a.done) - Number(b.done) ||
  (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1) ||
  a.createdAt.localeCompare(b.createdAt);

function groupByDay(tasks) {
  const map = new Map();
  for (const t of tasks) {
    if (!t.due) continue;
    if (!map.has(t.due)) map.set(t.due, []);
    map.get(t.due).push(t);
  }
  for (const list of map.values()) list.sort(byDoneThenPriority);
  return map;
}

function countLabel(dayTasks) {
  const pending = dayTasks.filter((t) => !t.done).length;
  const done = dayTasks.length - pending;
  const parts = [];
  if (pending) parts.push(`${pending} pendiente${pending === 1 ? '' : 's'}`);
  if (done) parts.push(`${done} hecha${done === 1 ? '' : 's'}`);
  return parts.length ? parts.join(', ') : 'sin tareas';
}

/**
 * @param {{
 *   getTasks: () => object[],
 *   renderTask: (task: object) => HTMLElement,
 *   onAddTask: (title: string, due: string, priority: string) => Promise<void>,
 * }} deps
 */
export function initCalendar({ getTasks, renderTask, onAddTask }) {
  const weekStart = firstDayOfWeek();
  let selectedDay = todayISO();

  $('cal-weekdays').replaceChildren(...weekdayNames(weekStart).map((name) => h('span', {}, name)));

  function select(day, { focus = false } = {}) {
    selectedDay = day;
    render({ focus });
  }

  $('cal-prev').addEventListener('click', () => select(addMonths(selectedDay, -1)));
  $('cal-next').addEventListener('click', () => select(addMonths(selectedDay, 1)));
  $('cal-today').addEventListener('click', () => select(todayISO()));

  // Arrow keys move by day/week, PageUp/PageDown by month, Home/End to the
  // week's edges — the usual date-grid keyboard model.
  const KEY_MOVES = {
    ArrowLeft: (d) => addDays(d, -1),
    ArrowRight: (d) => addDays(d, 1),
    ArrowUp: (d) => addDays(d, -7),
    ArrowDown: (d) => addDays(d, 7),
    PageUp: (d) => addMonths(d, -1),
    PageDown: (d) => addMonths(d, 1),
    Home: (d) => addDays(d, -((parseDay(d).getDay() - weekStart + 7) % 7)),
    End: (d) => addDays(d, 6 - ((parseDay(d).getDay() - weekStart + 7) % 7)),
  };

  $('cal-grid').addEventListener('keydown', (e) => {
    const move = KEY_MOVES[e.key];
    if (!move || !e.target.closest('.cal-cell')) return;
    e.preventDefault();
    select(move(selectedDay), { focus: true });
  });

  $('cal-grid').addEventListener('click', (e) => {
    const cell = e.target.closest('.cal-cell');
    if (cell) select(cell.dataset.day);
  });

  $('cal-add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('cal-add-title');
    const title = input.value.trim();
    if (!title) {
      input.focus();
      return;
    }
    try {
      await onAddTask(title, selectedDay, $('cal-add-priority').value);
    } catch {
      return; // onAddTask already told the user what went wrong
    }
    input.value = '';
    input.focus();
  });

  function cell(day, dayTasks, today) {
    const pending = dayTasks.filter((t) => !t.done);
    const overdue = day < today && pending.length > 0;
    const classes = ['cal-cell'];
    if (!sameMonth(day, selectedDay)) classes.push('is-outside');
    if (day === today) classes.push('is-today');
    if (day === selectedDay) classes.push('is-selected');
    if (overdue) classes.push('has-overdue');

    const pills = dayTasks.slice(0, MAX_PILLS).map((t) =>
      h(
        'span',
        {
          class: `cal-pill prio-${t.priority ?? 'medium'}${t.done ? ' is-done' : ''}${!t.done && day < today ? ' is-overdue' : ''}`,
        },
        t.title,
      ),
    );
    if (dayTasks.length > MAX_PILLS)
      pills.push(h('span', { class: 'cal-more' }, `+${dayTasks.length - MAX_PILLS} más`));

    const dots = dayTasks
      .slice(0, MAX_DOTS)
      .map((t) => h('span', { class: `cal-dot prio-${t.priority ?? 'medium'}${t.done ? ' is-done' : ''}` }));

    return h(
      'button',
      {
        type: 'button',
        class: classes.join(' '),
        'data-day': day,
        tabindex: day === selectedDay ? '0' : '-1', // roving tabindex: one tab stop for the grid
        'aria-pressed': day === selectedDay ? 'true' : 'false',
        'aria-current': day === today ? 'date' : undefined,
      },
      h('span', { class: 'cal-num' }, String(parseDay(day).getDate())),
      // Name = visible text + this context ("20 de noviembre de 2026, viernes: 2
      // pendientes. Parcial…"), so screen readers say what's on screen and more.
      h('span', { class: 'sr-only' }, ` ${dayContext(parseDay(day))}: ${countLabel(dayTasks)}.`),
      h('span', { class: 'cal-pills' }, ...pills),
      h('span', { class: 'cal-dots', 'aria-hidden': 'true' }, ...dots),
    );
  }

  function render({ focus = false } = {}) {
    const today = todayISO();
    const byDay = groupByDay(getTasks());

    $('cal-title').textContent = capitalize(monthFmt.format(parseDay(selectedDay)));
    $('cal-grid').replaceChildren(
      ...monthGrid(selectedDay, weekStart).map((day) => cell(day, byDay.get(day) ?? [], today)),
    );

    const n = dayDiff(selectedDay);
    const relative = n === 0 ? 'Hoy' : n === 1 ? 'Mañana' : n === -1 ? 'Ayer' : null;
    $('cal-day-title').replaceChildren(
      capitalize(dayLongFmt.format(parseDay(selectedDay))),
      ...(relative ? [h('span', { class: 'chip chip-ok cal-day-chip' }, relative)] : []),
    );

    const dayTasks = byDay.get(selectedDay) ?? [];
    $('cal-day-list').replaceChildren(
      ...(dayTasks.length ? dayTasks.map(renderTask) : [emptyState('No hay tareas para este día.', 'calendar')]),
    );

    if (focus) $('cal-grid').querySelector('.is-selected')?.focus();
  }

  return { render, select };
}
