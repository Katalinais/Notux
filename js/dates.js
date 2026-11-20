// Date helpers. Days are handled as local 'YYYY-MM-DD' strings (the value of an
// <input type="date">), never as UTC timestamps, so a task due "today" doesn't
// shift a day depending on the time zone.
export const LOCALE = 'es-CO';
const MS_PER_DAY = 86400000;

export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export function parseDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function toISODay(d) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export const todayISO = () => toISODay(new Date());

// Whole days from today to s (negative = past). Rounded so DST changes don't skew it.
export const dayDiff = (s) => Math.round((parseDay(s) - startOfDay(new Date())) / MS_PER_DAY);

export function addDays(s, n) {
  const d = parseDay(s);
  d.setDate(d.getDate() + n);
  return toISODay(d);
}

// Same day number in another month, clamped (Jan 31 + 1 month → Feb 28/29).
export function addMonths(s, n) {
  const d = parseDay(s);
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), lastDay));
  return toISODay(target);
}

export const sameMonth = (a, b) => a.slice(0, 7) === b.slice(0, 7);

// 0 = Sunday … 6 = Saturday, from the locale's week info (es-CO starts on Sunday).
export function firstDayOfWeek(locale = LOCALE) {
  try {
    const loc = new Intl.Locale(locale);
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info?.firstDay) return info.firstDay % 7;
  } catch {
    // older browsers: fall through
  }
  return 0;
}

// Every day shown in a month view: whole weeks from the one containing the 1st
// to the one containing the last day (4–6 rows), as 'YYYY-MM-DD' strings.
export function monthGrid(s, weekStart = firstDayOfWeek()) {
  const d = parseDay(s);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const lead = (first.getDay() - weekStart + 7) % 7;
  const trail = (weekStart + 6 - last.getDay() + 7) % 7;
  const total = lead + last.getDate() + trail;
  const start = toISODay(new Date(first.getFullYear(), first.getMonth(), 1 - lead));
  return Array.from({ length: total }, (_, i) => addDays(start, i));
}

// Short weekday names in display order, e.g. ['dom', 'lun', …].
export function weekdayNames(weekStart = firstDayOfWeek(), locale = LOCALE) {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2023, 0, 1 + ((weekStart + i) % 7))).replace('.', ''));
}

const weekdayFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'long' });
const shortDateFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' });

export function relativeDate(s) {
  if (!s) return 'Sin fecha';
  const n = dayDiff(s);
  if (n === 0) return 'Hoy';
  if (n === 1) return 'Mañana';
  if (n === -1) return 'Ayer';
  if (n > 1 && n < 7) return weekdayFmt.format(parseDay(s));
  return shortDateFmt.format(parseDay(s));
}
