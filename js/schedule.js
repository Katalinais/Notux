// Subjects and the weekly schedule. A subject (materia) has a name, a color and
// any number of sessions: recurring blocks with a day of the week, a start and
// end time and an optional place. Days use Date#getDay numbering (0 = Sunday …
// 6 = Saturday); times are 'HH:MM'.
import { $, h, icon, emptyState } from './dom.js';
import { getAllBlocks, getAllSubjects, saveSubject, deleteSubject, restoreSubject } from './db.js';
import { showToast } from './toast.js';
import { LOCALE } from './dates.js';
import { COLORS, DEFAULT_COLOR, suggestColor, cleanName, findByName, byName } from './subjects.js';

/* ---------- Pure helpers ---------- */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // timetables read Monday → Sunday
const ALWAYS_SHOWN = new Set([1, 2, 3, 4, 5]); // weekends only appear when they have blocks
const DEFAULT_START_HOUR = 7;
const DEFAULT_END_HOUR = 18;

export const toMinutes = (hhmm) => {
  const [hh, mm] = hhmm.split(':').map(Number);
  return hh * 60 + mm;
};
export const fromMinutes = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
export const formatTime = (hhmm) => hhmm.replace(/^0(\d)/, '$1'); // '07:30' → '7:30'
export const formatRange = (b) => `${formatTime(b.start)} – ${formatTime(b.end)}`;

const dayLongFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'long' });
const dayShortFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'short' });
// 2023-01-01 was a Sunday, so day n of the week is Jan 1 + n.
export const dayName = (day) => dayLongFmt.format(new Date(2023, 0, 1 + day));
export const dayShort = (day) => dayShortFmt.format(new Date(2023, 0, 1 + day)).replace('.', '');
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const byStart = (a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end);

const weekPos = (day) => WEEK_ORDER.indexOf(day);
export const byWeekTime = (a, b) => weekPos(a.day) - weekPos(b.day) || byStart(a, b);

// "Lun 7:00 – 9:00 · Mié 14:00 – 16:00"
export function sessionSummary(subjectBlocks) {
  return [...subjectBlocks]
    .sort(byWeekTime)
    .map((b) => `${capitalize(dayShort(b.day))} ${formatRange(b)}`)
    .join(' · ');
}

export function blocksOn(blocks, day) {
  return blocks.filter((b) => b.day === day).sort(byStart);
}

const overlaps = (a, b) => a.day === b.day && a.start < b.end && b.start < a.end;

// Existing blocks that would overlap `candidate` (ignoring itself when editing).
export function findConflicts(blocks, candidate) {
  return blocks.filter((b) => b.id !== candidate.id && overlaps(b, candidate)).sort(byStart);
}

// Side-by-side layout for overlapping blocks of one day: each block gets a lane
// and the lane count of its overlap cluster, so it can take 1/lanes of the width.
export function layoutLanes(dayBlocks) {
  const sorted = [...dayBlocks].sort(byStart);
  const result = new Map();
  let cluster = [];
  let clusterEnd = '';
  let laneEnds = [];

  const flush = () => {
    for (const item of cluster) result.set(item.block.id, { lane: item.lane, lanes: laneEnds.length });
    cluster = [];
    laneEnds = [];
  };

  for (const block of sorted) {
    if (cluster.length && block.start >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= block.start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = block.end;
    cluster.push({ block, lane });
    clusterEnd = cluster.length === 1 || block.end > clusterEnd ? block.end : clusterEnd;
  }
  flush();
  return result;
}

// Status of each of today's blocks relative to `nowMinutes`: 'past', 'now',
// 'next' (the first one still to come) or 'later'.
export function todayStatus(dayBlocks, nowMinutes) {
  let nextFound = false;
  return dayBlocks.map((b) => {
    const start = toMinutes(b.start);
    const end = toMinutes(b.end);
    if (end <= nowMinutes) return { block: b, status: 'past' };
    if (start <= nowMinutes) return { block: b, status: 'now', minutesLeft: end - nowMinutes };
    if (!nextFound) {
      nextFound = true;
      return { block: b, status: 'next', minutesUntil: start - nowMinutes };
    }
    return { block: b, status: 'later' };
  });
}

export function formatDuration(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return mm ? `${hh} h ${mm} min` : `${hh} h`;
}

const nowMinutes = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

/* ---------- View ---------- */
/**
 * @param {{
 *   onChange?: (event: { type: 'saved' | 'deleted' | 'restored', snapshot?: object }) => void,
 *   getCounts?: (subjectId: number) => { pending: number, notes: number },
 * }} options  onChange runs after a subject or its schedule is added, edited or removed.
 */
export function initSchedule({ onChange, getCounts } = {}) {
  let db = null;
  let subjects = [];
  let subjectMap = new Map();
  let blocks = [];
  let agendaDay = new Date().getDay(); // day shown in the phone agenda
  let editing = null; // subject being edited, or null when creating

  const subjectOf = (b) => subjectMap.get(b.subjectId) ?? { name: 'Sin nombre', color: DEFAULT_COLOR };
  const blocksOf = (subjectId) => blocks.filter((b) => b.subjectId === subjectId).sort(byWeekTime);

  async function reload() {
    [subjects, blocks] = await Promise.all([getAllSubjects(db), getAllBlocks(db)]);
    subjects.sort(byName);
    subjectMap = new Map(subjects.map((s) => [s.id, s]));
  }

  /* ----- Dialog ----- */
  const colorInputs = () => [...document.querySelectorAll('#subject-colors input')];
  const sessionRows = () => [...$('subject-sessions').querySelectorAll('.session')];

  $('subject-colors').replaceChildren(
    ...COLORS.map(([key, label]) =>
      h(
        'label',
        { class: `swatch blk-${key}`, title: label },
        h('input', { type: 'radio', name: 'subject-color', value: key, 'aria-label': label }),
      ),
    ),
  );

  let rowSeq = 0;
  function sessionRow({ id = null, day = 1, start = '07:00', end = '09:00', place = '' } = {}) {
    const n = ++rowSeq;
    const daySelect = h(
      'select',
      { class: 'input session-day', id: `session-day-${n}`, name: 'session-day' },
      ...WEEK_ORDER.map((d) => h('option', { value: String(d) }, capitalize(dayName(d)))),
    );
    daySelect.value = String(day);
    const row = h(
      'div',
      { class: 'session', 'data-block-id': id == null ? '' : String(id) },
      h('label', { class: 'sr-only', for: `session-day-${n}` }, 'Día'),
      daySelect,
      h('input', {
        class: 'input session-start',
        name: 'session-start',
        type: 'time',
        step: '300',
        value: start,
        'aria-label': 'Hora de inicio',
      }),
      h('input', {
        class: 'input session-end',
        name: 'session-end',
        type: 'time',
        step: '300',
        value: end,
        'aria-label': 'Hora de fin',
      }),
      h('button', {
        type: 'button',
        class: 'btn btn-ghost icon-btn session-remove',
        'aria-label': 'Quitar este horario',
        title: 'Quitar este horario',
        onclick: () => {
          const rows = sessionRows();
          const next = rows[rows.indexOf(row) + 1] ?? rows[rows.indexOf(row) - 1];
          row.remove();
          renumberRows();
          updateWarning();
          (next?.querySelector('.session-day') ?? $('subject-add-session')).focus();
        },
      }),
      h('input', {
        class: 'input session-place',
        name: 'session-place',
        type: 'text',
        maxlength: '60',
        value: place,
        placeholder: 'Lugar (opcional)',
        'aria-label': 'Lugar',
      }),
    );
    row.querySelector('.session-remove').append(icon('trash', 16));
    return row;
  }

  // Screen readers hear "Horario 2, Día" instead of five identical "Día" fields.
  function renumberRows() {
    const rows = sessionRows();
    rows.forEach((row, i) => {
      const n = `Horario ${i + 1}`;
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', n);
    });
    $('subject-sessions-empty').hidden = rows.length > 0;
  }

  function readRows() {
    return sessionRows().map((row) => ({
      row,
      id: row.dataset.blockId ? Number(row.dataset.blockId) : null,
      day: Number(row.querySelector('.session-day').value),
      start: row.querySelector('.session-start').value,
      end: row.querySelector('.session-end').value,
      place: row.querySelector('.session-place').value.trim(),
    }));
  }

  // "Add another" starts from the last row: same times, next weekday — the
  // usual case is the same class on another day.
  function addRow(values) {
    const last = readRows().at(-1);
    const fresh = values ?? {
      day: last ? WEEK_ORDER[(weekPos(last.day) + 1) % 7] : agendaDay,
      start: last?.start || '07:00',
      end: last?.end || '09:00',
      place: last?.place ?? '',
    };
    const row = sessionRow(fresh);
    $('subject-sessions').append(row);
    renumberRows();
    updateWarning();
    return row;
  }

  // Live warning while the user edits: overlaps are allowed (A/B weeks,
  // optional sessions) but worth pointing out before saving.
  function updateWarning() {
    const rows = readRows().filter((r) => r.start && r.end && r.start < r.end);
    const others = blocks.filter((b) => b.subjectId !== editing?.id);
    const messages = [];
    for (const r of rows) {
      for (const c of findConflicts(others, { id: null, ...r })) {
        messages.push(`${subjectOf(c).name} (${dayShort(c.day)} ${formatRange(c)})`);
      }
    }
    const ownClash = rows.some((a, i) => rows.slice(i + 1).some((b) => overlaps(a, b)));
    const warning = $('subject-warning');
    const parts = [];
    if (messages.length) parts.push(`Se cruza con: ${[...new Set(messages)].join(', ')}.`);
    if (ownClash) parts.push('Dos horarios de esta materia se cruzan entre sí.');
    warning.textContent = parts.join(' ');
    warning.hidden = parts.length === 0;
  }

  function fillPicker() {
    const pick = $('subject-pick');
    pick.replaceChildren(
      h('option', { value: '' }, 'Una materia nueva'),
      ...subjects.map((s) => h('option', { value: String(s.id) }, s.name)),
    );
    pick.value = '';
  }

  function fillDialog(subject, rows) {
    editing = subject;
    const isEdit = !!subject;
    $('subject-dialog-title').textContent = isEdit ? 'Editar materia' : 'Nueva materia';
    $('subject-pick-field').hidden = isEdit || subjects.length === 0;
    $('subject-delete').hidden = !isEdit;
    $('subject-error').hidden = true;
    $('subject-name').value = subject?.name ?? '';
    const color = subject?.color ?? suggestColor(subjects.length);
    for (const input of colorInputs()) input.checked = input.value === color;
    $('subject-sessions').replaceChildren(...rows.map(sessionRow));
    renumberRows();
    updateWarning();
  }

  /**
   * Opens the subject dialog.
   * - { subjectId }: edit that subject (and highlight `blockId` if given).
   * - { day, start }: new subject with one session at that slot (from the grid).
   * - {}: new subject with one session.
   */
  function openDialog({ subjectId = null, blockId = null, day = agendaDay, start = null } = {}) {
    const subject = subjectId != null ? subjectMap.get(subjectId) : null;
    fillPicker();
    if (subject) {
      fillDialog(subject, blocksOf(subject.id));
    } else {
      const startTime = start ?? '07:00';
      const end = fromMinutes(Math.min(toMinutes(startTime) + 120, 23 * 60 + 55));
      fillDialog(null, [{ day, start: startTime, end }]);
    }
    $('subject-dialog').showModal();
    const target = blockId != null && sessionRows().find((r) => r.dataset.blockId === String(blockId));
    if (target) {
      target.classList.add('is-focused');
      target.querySelector('.session-day').focus();
    } else if (!subject) {
      $('subject-name').focus();
    }
  }

  // Creating, but the sessions belong to a subject that already exists:
  // switch to editing it and keep the sessions typed so far as new ones.
  $('subject-pick').addEventListener('change', (e) => {
    const subject = subjectMap.get(Number(e.target.value));
    if (!subject) return;
    const typed = readRows().map(({ day, start, end, place }) => ({ day, start, end, place }));
    fillDialog(subject, [...blocksOf(subject.id), ...typed]);
    const rows = sessionRows();
    rows.slice(rows.length - typed.length).forEach((r) => r.classList.add('is-focused'));
    $('subject-name').focus();
  });

  $('subject-add-session').addEventListener('click', () => addRow().querySelector('.session-day').focus());
  $('subject-form').addEventListener('input', updateWarning);
  $('subject-form').addEventListener('change', updateWarning);
  $('subject-cancel').addEventListener('click', () => $('subject-dialog').close());
  $('subject-dialog').addEventListener('close', () => (editing = null));
  $('schedule-add').addEventListener('click', () => openDialog());
  $('subjects-add').addEventListener('click', () => openDialog());

  let saving = false;
  $('subject-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving) return;
    const error = $('subject-error');
    const fail = (message, focusEl) => {
      error.textContent = message;
      error.hidden = false;
      focusEl?.focus();
    };

    const name = cleanName($('subject-name').value);
    if (!name) return fail('Escribe el nombre de la materia o actividad.', $('subject-name'));
    const duplicate = findByName(subjects, name, editing?.id);
    if (duplicate) {
      return fail(
        `Ya tienes una materia llamada «${duplicate.name}». Elígela en «Agregar a» o usa otro nombre.`,
        $('subject-pick-field').hidden ? $('subject-name') : $('subject-pick'),
      );
    }
    const rows = readRows();
    for (const r of rows) {
      if (!r.start || !r.end)
        return fail('Indica la hora de inicio y de fin de cada horario.', r.row.querySelector('.session-start'));
      if (r.end <= r.start) {
        return fail('La hora de fin debe ser después de la de inicio.', r.row.querySelector('.session-end'));
      }
    }

    const now = new Date().toISOString();
    const color = colorInputs().find((i) => i.checked)?.value ?? DEFAULT_COLOR;
    const subject = editing ? { ...editing, name, color, updatedAt: now } : { name, color, createdAt: now };
    const previous = editing ? blocksOf(editing.id) : [];
    const sessions = rows.map(({ id, day, start, end, place }) => {
      const old = previous.find((b) => b.id === id);
      return old ? { ...old, day, start, end, place, updatedAt: now } : { day, start, end, place, createdAt: now };
    });
    const removed = previous.filter((b) => !rows.some((r) => r.id === b.id)).map((b) => b.id);

    saving = true;
    let result;
    try {
      result = await saveSubject(db, subject, sessions, removed);
      await reload();
    } catch (err) {
      console.error('Could not save the subject:', err);
      return fail('No se pudo guardar. Intenta de nuevo.');
    } finally {
      saving = false;
    }

    const wasEdit = !!editing;
    $('subject-dialog').close();
    if (!wasEdit && sessions.length && !sessions.some((b) => b.day === agendaDay)) agendaDay = sessions[0].day;
    changed({ type: 'saved', id: result.id });
    showToast(
      wasEdit
        ? 'Materia actualizada.'
        : sessions.length
          ? `«${name}» agregada con ${sessions.length} horario${sessions.length === 1 ? '' : 's'}.`
          : `«${name}» agregada.`,
    );
  });

  async function remove(subject) {
    let snapshot;
    try {
      snapshot = await deleteSubject(db, subject.id);
      await reload();
    } catch (err) {
      console.error('Could not delete the subject:', err);
      showToast('No se pudo eliminar la materia.', { type: 'error' });
      return false;
    }
    changed({ type: 'deleted', snapshot });
    const linked = snapshot.taskIds.length + snapshot.noteIds.length;
    showToast(`«${subject.name}» eliminada.${linked ? ' Sus tareas y notas quedaron sin materia.' : ''}`, {
      action: { label: 'Deshacer', onClick: () => restore(snapshot) },
      duration: 8000,
    });
    return true;
  }

  $('subject-delete').addEventListener('click', async () => {
    const subject = editing;
    if (!subject) return;
    if (await remove(subject)) $('subject-dialog').close();
  });

  async function restore(snapshot) {
    try {
      await restoreSubject(db, snapshot);
      await reload();
    } catch (err) {
      console.error('Could not restore the subject:', err);
      showToast('No se pudo restaurar la materia.', { type: 'error' });
      return;
    }
    changed({ type: 'restored', snapshot });
  }

  function changed(event) {
    render();
    onChange?.(event);
  }

  /* ----- Week grid (tablet/desktop) ----- */
  function visibleDays() {
    return WEEK_ORDER.filter((d) => ALWAYS_SHOWN.has(d) || blocks.some((b) => b.day === d));
  }

  function hourRange() {
    let first = DEFAULT_START_HOUR;
    let last = DEFAULT_END_HOUR;
    for (const b of blocks) {
      first = Math.min(first, Math.floor(toMinutes(b.start) / 60));
      last = Math.max(last, Math.ceil(toMinutes(b.end) / 60));
    }
    return [first, Math.min(last, 24)];
  }

  function blockCard(b, { lane = 0, lanes = 1, firstHour = 0 } = {}) {
    const s = subjectOf(b);
    const top = (toMinutes(b.start) - firstHour * 60) / 60;
    const len = (toMinutes(b.end) - toMinutes(b.start)) / 60;
    return h(
      'button',
      {
        type: 'button',
        class: `sch-block blk-${s.color}${len < 0.75 ? ' is-short' : ''}`,
        style: `--top: ${top}; --len: ${len}; --lane: ${lane}; --lanes: ${lanes};`,
        onclick: (e) => {
          e.stopPropagation();
          openDialog({ subjectId: b.subjectId, blockId: b.id });
        },
      },
      h('span', { class: 'sch-block-title' }, s.name),
      h('span', { class: 'sch-block-meta' }, formatRange(b) + (b.place ? ` · ${b.place}` : '')),
      h('span', { class: 'sr-only' }, `, ${dayName(b.day)}. Editar.`),
    );
  }

  function renderWeek() {
    const days = visibleDays();
    const [firstHour, lastHour] = hourRange();
    const hours = lastHour - firstHour;
    const today = new Date().getDay();
    const now = nowMinutes();

    const head = h(
      'div',
      { class: 'sch-head' },
      h('span'),
      ...days.map((d) => h('span', { class: d === today ? 'is-today' : '' }, capitalize(dayShort(d)))),
    );

    const times = h(
      'div',
      { class: 'sch-times', 'aria-hidden': 'true' },
      ...Array.from({ length: hours }, (_, i) => h('span', {}, `${firstHour + i}:00`)),
    );

    const columns = days.map((day) => {
      const dayBlocks = blocksOn(blocks, day);
      const lanes = layoutLanes(dayBlocks);
      const col = h(
        'div',
        {
          class: `sch-col${day === today ? ' is-today' : ''}`,
          'data-day': String(day),
          title: `Agregar clase el ${dayName(day)}`,
        },
        ...dayBlocks.map((b) => blockCard(b, { ...lanes.get(b.id), firstHour })),
      );
      if (day === today && now >= firstHour * 60 && now <= lastHour * 60) {
        col.append(
          h('span', { class: 'sch-now', style: `--top: ${(now - firstHour * 60) / 60};`, 'aria-hidden': 'true' }),
        );
      }
      // Clicking empty space opens "new class" at that hour.
      col.addEventListener('click', (e) => {
        if (e.target !== col) return;
        const rect = col.getBoundingClientRect();
        const hour = firstHour + Math.floor(((e.clientY - rect.top) / rect.height) * hours);
        openDialog({ day, start: fromMinutes(Math.min(hour, 23) * 60) });
      });
      return col;
    });

    const body = h('div', { class: 'sch-body' }, times, ...columns);
    const grid = h('div', { class: 'sch-week', style: `--days: ${days.length}; --hours: ${hours};` }, head, body);
    $('schedule-week').replaceChildren(grid);
  }

  /* ----- Agenda (phone) ----- */
  function renderAgenda() {
    const today = new Date().getDay();
    $('schedule-days').replaceChildren(
      ...WEEK_ORDER.map((day) =>
        h(
          'button',
          {
            type: 'button',
            class: `day-tab${day === agendaDay ? ' is-selected' : ''}${day === today ? ' is-today' : ''}`,
            'aria-pressed': day === agendaDay ? 'true' : 'false',
            'aria-label': `${capitalize(dayName(day))}${blocks.some((b) => b.day === day) ? '' : ', sin clases'}`,
            onclick: () => {
              agendaDay = day;
              renderAgenda();
            },
          },
          capitalize(dayShort(day)),
          h('span', {
            class: `day-tab-dot${blocks.some((b) => b.day === day) ? '' : ' is-empty'}`,
            'aria-hidden': 'true',
          }),
        ),
      ),
    );

    const dayBlocks = blocksOn(blocks, agendaDay);
    const statuses = agendaDay === today ? todayStatus(dayBlocks, nowMinutes()) : null;
    $('schedule-agenda').replaceChildren(
      ...(dayBlocks.length
        ? dayBlocks.map((b, i) => agendaItem(b, statuses?.[i]))
        : [emptyState(`No tienes clases el ${dayName(agendaDay)}.`, 'clock')]),
    );
  }

  function agendaItem(b, status) {
    const s = subjectOf(b);
    const badge =
      status?.status === 'now'
        ? 'Ahora'
        : status?.status === 'next'
          ? `En ${formatDuration(status.minutesUntil)}`
          : null;
    return h(
      'button',
      {
        type: 'button',
        class: `card agenda-item blk-${s.color}${status?.status === 'past' ? ' is-past' : ''}`,
        onclick: () => openDialog({ subjectId: b.subjectId, blockId: b.id }),
      },
      h('span', { class: 'agenda-time' }, formatTime(b.start), h('small', {}, formatTime(b.end))),
      h(
        'span',
        { class: 'agenda-body' },
        h('span', { class: 'task-title' }, s.name),
        ...(b.place ? [h('span', { class: 'task-meta' }, b.place)] : []),
      ),
      ...(badge ? [h('span', { class: `chip ${status.status === 'now' ? 'chip-ok' : 'chip-warn'}` }, badge)] : []),
      h('span', { class: 'sr-only' }, '. Editar.'),
      icon('edit', 16),
    );
  }

  /* ----- Subject list ----- */
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function renderSubjects() {
    $('subjects-list').replaceChildren(
      ...(subjects.length
        ? subjects.map((s) => {
            const own = blocksOf(s.id);
            const counts = getCounts?.(s.id) ?? { pending: 0, notes: 0 };
            return h(
              'a',
              { href: `#/materia/${s.id}`, class: `card subject-card blk-${s.color}` },
              h('span', { class: 'task-title' }, s.name),
              h('span', { class: 'task-meta' }, own.length ? sessionSummary(own) : 'Sin horario'),
              h(
                'span',
                { class: 'subject-card-counts' },
                plural(counts.pending, 'tarea pendiente', 'tareas pendientes'),
                ' · ',
                plural(counts.notes, 'nota', 'notas'),
              ),
            );
          })
        : [emptyState('Aún no tienes materias. Agrega una con su horario.', 'clock')]),
    );
  }

  function render() {
    renderWeek();
    renderAgenda();
    renderSubjects();
  }

  return {
    async load(database) {
      db = database;
      await reload();
      render();
    },
    render,
    renderSubjects,
    subjects: () => subjects,
    subject: (id) => subjectMap.get(id) ?? null,
    subjectOf,
    blocksOf,
    todayBlocks: () => blocksOn(blocks, new Date().getDay()),
    count: () => blocks.length,
    openDialog,
    remove,
  };
}
