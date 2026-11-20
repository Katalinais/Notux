// Weekly schedule: recurring blocks (classes, activities) with a day of the
// week, a start and end time, a subject, an optional place and a color.
// Days use Date#getDay numbering (0 = Sunday … 6 = Saturday); times are 'HH:MM'.
import { $, h, icon, emptyState } from './dom.js';
import { createBlocks, updateBlock, deleteBlock, createBlock, getAllBlocks } from './db.js';
import { showToast } from './toast.js';
import { LOCALE } from './dates.js';

/* ---------- Pure helpers ---------- */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // timetables read Monday → Sunday
const ALWAYS_SHOWN = new Set([1, 2, 3, 4, 5]); // weekends only appear when they have blocks
const DEFAULT_START_HOUR = 7;
const DEFAULT_END_HOUR = 18;

export const COLORS = [
  ['indigo', 'Índigo'],
  ['sky', 'Celeste'],
  ['emerald', 'Verde'],
  ['amber', 'Ámbar'],
  ['orange', 'Naranja'],
  ['rose', 'Rosa'],
  ['violet', 'Violeta'],
  ['slate', 'Gris'],
];

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
const dayShort = (day) => dayShortFmt.format(new Date(2023, 0, 1 + day)).replace('.', '');
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const byStart = (a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end);

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
 * @param {{ onChange?: () => void }} options  onChange runs after any block is added, edited or removed.
 */
export function initSchedule({ onChange } = {}) {
  let db = null;
  let blocks = [];
  let agendaDay = new Date().getDay(); // day shown in the phone agenda
  let editing = null; // block being edited, or null when creating

  /* ----- Dialog ----- */
  const dayInputs = () => [...document.querySelectorAll('#block-days input')];
  const colorInputs = () => [...document.querySelectorAll('#block-colors input')];

  $('block-days').replaceChildren(
    ...WEEK_ORDER.map((day) =>
      h(
        'label',
        { class: 'toggle-chip' },
        h('input', { type: 'checkbox', name: 'block-day', value: String(day) }),
        h('span', { title: capitalize(dayName(day)) }, capitalize(dayShort(day))),
      ),
    ),
  );
  $('block-colors').replaceChildren(
    ...COLORS.map(([key, label]) =>
      h(
        'label',
        { class: `swatch blk-${key}`, title: label },
        h('input', { type: 'radio', name: 'block-color', value: key, 'aria-label': label }),
      ),
    ),
  );

  function selectedDays() {
    return dayInputs()
      .filter((i) => i.checked)
      .map((i) => Number(i.value));
  }

  function readForm() {
    return {
      subject: $('block-subject').value.trim(),
      days: selectedDays(),
      start: $('block-start').value,
      end: $('block-end').value,
      place: $('block-place').value.trim(),
      color: colorInputs().find((i) => i.checked)?.value ?? 'indigo',
    };
  }

  // Live warning while the user edits: overlapping classes are allowed (A/B
  // weeks, optional sessions) but worth pointing out before saving.
  function updateWarning() {
    const { days, start, end } = readForm();
    const warning = $('block-warning');
    if (!start || !end || start >= end || !days.length) {
      warning.hidden = true;
      return;
    }
    const conflicts = days.flatMap((day) => findConflicts(blocks, { id: editing?.id, day, start, end }));
    warning.hidden = conflicts.length === 0;
    if (conflicts.length) {
      const list = conflicts.map((c) => `${c.subject} (${dayShort(c.day)} ${formatRange(c)})`).join(', ');
      warning.textContent = `Se cruza con: ${list}.`;
    }
  }

  function openDialog({ block = null, day = agendaDay, start = null } = {}) {
    editing = block;
    const isEdit = !!block;
    $('block-dialog-title').textContent = isEdit ? 'Editar clase' : 'Nueva clase';
    $('block-days-legend').textContent = isEdit ? 'Día' : 'Días (puedes elegir varios)';
    $('block-delete').hidden = !isEdit;
    $('block-error').hidden = true;

    // Editing moves one block to another day; creating can repeat it on several.
    // Switch every input's type first: a radio that's still checked from last
    // time would otherwise uncheck the one just selected in the same group.
    const inputs = dayInputs();
    for (const input of inputs) {
      input.checked = false;
      input.type = isEdit ? 'radio' : 'checkbox';
    }
    for (const input of inputs) input.checked = Number(input.value) === (isEdit ? block.day : day);

    const startTime = block?.start ?? start ?? '07:00';
    $('block-subject').value = block?.subject ?? '';
    $('block-place').value = block?.place ?? '';
    $('block-start').value = startTime;
    $('block-end').value = block?.end ?? fromMinutes(Math.min(toMinutes(startTime) + 120, 23 * 60 + 55));
    const color = block?.color ?? COLORS[blocks.length % COLORS.length][0];
    for (const input of colorInputs()) input.checked = input.value === color;

    updateWarning();
    $('block-dialog').showModal();
  }

  $('block-form').addEventListener('input', updateWarning);
  $('block-form').addEventListener('change', updateWarning);
  $('block-cancel').addEventListener('click', () => $('block-dialog').close());
  $('block-dialog').addEventListener('close', () => (editing = null));
  $('schedule-add').addEventListener('click', () => openDialog());

  let saving = false;
  $('block-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving) return;
    const data = readForm();
    const error = $('block-error');
    const fail = (message, focusId) => {
      error.textContent = message;
      error.hidden = false;
      if (focusId) $(focusId).focus();
    };

    if (!data.subject) return fail('Escribe el nombre de la clase o actividad.', 'block-subject');
    if (!data.days.length) return fail('Elige al menos un día.');
    if (!data.start || !data.end) return fail('Indica la hora de inicio y de fin.', 'block-start');
    if (data.end <= data.start) return fail('La hora de fin debe ser después de la de inicio.', 'block-end');

    const { days, ...fields } = data;
    saving = true;
    try {
      if (editing) {
        const updated = { ...editing, ...fields, day: days[0], updatedAt: new Date().toISOString() };
        await updateBlock(db, updated);
        blocks = blocks.map((b) => (b.id === updated.id ? updated : b));
      } else {
        const createdAt = new Date().toISOString();
        const fresh = days.map((day) => ({ ...fields, day, createdAt }));
        const ids = await createBlocks(db, fresh);
        blocks.push(...fresh.map((b, i) => ({ ...b, id: ids[i] })));
      }
    } catch (err) {
      console.error('Could not save the block:', err);
      return fail('No se pudo guardar. Intenta de nuevo.');
    } finally {
      saving = false;
    }

    const wasEdit = !!editing;
    $('block-dialog').close();
    if (!wasEdit && !days.includes(agendaDay)) agendaDay = days[0];
    changed();
    showToast(
      wasEdit
        ? 'Clase actualizada.'
        : days.length > 1
          ? `«${fields.subject}» agregada a ${days.length} días.`
          : `«${fields.subject}» agregada.`,
    );
  });

  $('block-delete').addEventListener('click', async () => {
    const block = editing;
    if (!block) return;
    try {
      await deleteBlock(db, block.id);
    } catch (err) {
      console.error('Could not delete the block:', err);
      $('block-error').textContent = 'No se pudo eliminar.';
      $('block-error').hidden = false;
      return;
    }
    blocks = blocks.filter((b) => b.id !== block.id);
    $('block-dialog').close();
    changed();
    showToast(`«${block.subject}» eliminada del ${dayName(block.day)}.`, {
      action: { label: 'Deshacer', onClick: () => restore(block) },
    });
  });

  async function restore(block) {
    try {
      await createBlock(db, block); // same id
    } catch (err) {
      console.error('Could not restore the block:', err);
      showToast('No se pudo restaurar la clase.', { type: 'error' });
      return;
    }
    blocks.push(block);
    changed();
  }

  function changed() {
    render();
    onChange?.();
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
    const top = (toMinutes(b.start) - firstHour * 60) / 60;
    const len = (toMinutes(b.end) - toMinutes(b.start)) / 60;
    return h(
      'button',
      {
        type: 'button',
        class: `sch-block blk-${b.color ?? 'indigo'}${len < 0.75 ? ' is-short' : ''}`,
        style: `--top: ${top}; --len: ${len}; --lane: ${lane}; --lanes: ${lanes};`,
        onclick: (e) => {
          e.stopPropagation();
          openDialog({ block: b });
        },
      },
      h('span', { class: 'sch-block-title' }, b.subject),
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
        class: `card agenda-item blk-${b.color ?? 'indigo'}${status?.status === 'past' ? ' is-past' : ''}`,
        onclick: () => openDialog({ block: b }),
      },
      h('span', { class: 'agenda-time' }, formatTime(b.start), h('small', {}, formatTime(b.end))),
      h(
        'span',
        { class: 'agenda-body' },
        h('span', { class: 'task-title' }, b.subject),
        ...(b.place ? [h('span', { class: 'task-meta' }, b.place)] : []),
      ),
      ...(badge ? [h('span', { class: `chip ${status.status === 'now' ? 'chip-ok' : 'chip-warn'}` }, badge)] : []),
      h('span', { class: 'sr-only' }, '. Editar.'),
      icon('edit', 16),
    );
  }

  function render() {
    renderWeek();
    renderAgenda();
  }

  return {
    async load(database) {
      db = database;
      blocks = await getAllBlocks(db);
      render();
    },
    render,
    todayBlocks: () => blocksOn(blocks, new Date().getDay()),
    count: () => blocks.length,
    openDialog,
  };
}
