// Backup to / restore from a single JSON file.
//
// IndexedDB stores binary values JSON can't hold: photos and audio (Blob), and
// the private-notes crypto material (ArrayBuffer ciphertexts, Uint8Array IVs
// and salt). Each one is written as { $type, data: base64 } and turned back
// into exactly the same type on import, so encrypted notes still decrypt.
import { exportAll, replaceAll, DATA_STORES, DB_VERSION } from './db.js';
import { subjectsFromLegacyBlocks } from './subjects.js';

const APP_ID = 'notux';
const FORMAT = 1;

/* ---------- base64 ---------- */
function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000; // String.fromCharCode(...hugeArray) overflows the stack
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* ---------- encode / decode ---------- */
async function encode(value) {
  if (value instanceof Blob) {
    return { $type: 'blob', mime: value.type, data: bytesToBase64(new Uint8Array(await value.arrayBuffer())) };
  }
  if (value instanceof ArrayBuffer) return { $type: 'arraybuffer', data: bytesToBase64(new Uint8Array(value)) };
  if (value instanceof Uint8Array) return { $type: 'uint8array', data: bytesToBase64(value) };
  if (Array.isArray(value)) return Promise.all(value.map(encode));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = await encode(v);
    return out;
  }
  return value;
}

function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') {
    switch (value.$type) {
      case 'blob':
        return new Blob([base64ToBytes(value.data)], { type: value.mime ?? '' });
      case 'arraybuffer':
        return base64ToBytes(value.data).buffer;
      case 'uint8array':
        return base64ToBytes(value.data);
      default: {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = decode(v);
        return out;
      }
    }
  }
  return value;
}

/* ---------- export ---------- */
export async function createBackup(db) {
  const data = await exportAll(db);
  const payload = { app: APP_ID, format: FORMAT, dbVersion: DB_VERSION, exportedAt: new Date().toISOString() };
  for (const name of DATA_STORES) payload[name] = await encode(data[name]);
  const counts = summarize(data);
  return { blob: new Blob([JSON.stringify(payload)], { type: 'application/json' }), counts };
}

export function backupFileName(date = new Date()) {
  const day = date.toLocaleDateString('sv-SE'); // YYYY-MM-DD in local time
  return `notux-respaldo-${day}.json`;
}

/* ---------- import ---------- */
export class InvalidBackupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidBackupError';
  }
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Parses and validates a backup file's text. Throws InvalidBackupError with a
// message meant for the user when the file isn't a usable Notux backup.
export function parseBackup(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new InvalidBackupError('El archivo no es un JSON válido.');
  }
  if (!isObj(raw) || raw.app !== APP_ID) throw new InvalidBackupError('Este archivo no es un respaldo de Notux.');
  if (raw.format !== FORMAT) {
    throw new InvalidBackupError('Este respaldo es de una versión de Notux que esta app no reconoce.');
  }
  if (raw.dbVersion > DB_VERSION) {
    throw new InvalidBackupError('Este respaldo viene de una versión más nueva de Notux. Actualiza la app primero.');
  }

  const data = {};
  for (const name of DATA_STORES) {
    const list = raw[name] ?? [];
    if (!Array.isArray(list) || !list.every(isObj))
      throw new InvalidBackupError('El respaldo está incompleto o dañado.');
    data[name] = decode(list);
  }

  // Backups from before subjects (dbVersion ≤ 5) have blocks with their own
  // name and color: convert them exactly like the database upgrade does.
  if (data.schedule.some((b) => b.subjectId == null)) {
    const migrated = subjectsFromLegacyBlocks(data.schedule, data.subjects);
    data.subjects = [...data.subjects, ...migrated.subjects];
    data.schedule = migrated.blocks;
  }

  const bad = (msg) => {
    throw new InvalidBackupError(`El respaldo está dañado: ${msg}`);
  };
  for (const t of data.tasks)
    if (typeof t.title !== 'string' || !Number.isInteger(t.id)) bad('hay una tarea inválida.');
  const titles = new Set(data.tasks.map((t) => t.title));
  if (titles.size !== data.tasks.length) bad('hay tareas con el mismo título.');
  for (const n of data.notes) if (typeof n.title !== 'string' || !Number.isInteger(n.id)) bad('hay una nota inválida.');
  for (const s of data.subjects) {
    if (typeof s.name !== 'string' || !Number.isInteger(s.id)) bad('hay una materia inválida.');
  }
  const subjectIds = new Set(data.subjects.map((s) => s.id));
  if (subjectIds.size !== data.subjects.length) bad('hay materias repetidas.');
  const linked = (r) => r.subjectId == null || subjectIds.has(r.subjectId);
  if (!data.tasks.every(linked) || !data.notes.every(linked)) bad('hay tareas o notas de una materia que no existe.');
  for (const b of data.schedule) {
    const ok =
      Number.isInteger(b.id) && Number.isInteger(b.day) && b.day >= 0 && b.day <= 6 && subjectIds.has(b.subjectId);
    if (!ok || !/^\d\d:\d\d$/.test(b.start) || !/^\d\d:\d\d$/.test(b.end)) bad('hay una clase inválida.');
  }
  for (const c of data.config) if (typeof c.id !== 'string') bad('la configuración es inválida.');

  return { data, exportedAt: raw.exportedAt ?? null, counts: summarize(data) };
}

export function restoreBackup(db, data) {
  return replaceAll(db, data);
}

/* ---------- summary ---------- */
export function summarize(data) {
  return {
    tasks: data.tasks?.length ?? 0,
    privateNotes: data.tasks?.filter((t) => t.encryptedNote).length ?? 0,
    notes: data.notes?.length ?? 0,
    media: data.notes?.filter((n) => n.photo || n.audio).length ?? 0,
    subjects: data.subjects?.length ?? 0,
    schedule: data.schedule?.length ?? 0,
    hasPassword: data.config?.some((c) => c.id === 'privateNotes') ?? false,
  };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function describeCounts(c) {
  return [
    plural(c.tasks, 'tarea', 'tareas'),
    plural(c.notes, 'nota', 'notas'),
    plural(c.subjects ?? 0, 'materia', 'materias'),
    plural(c.schedule, 'horario', 'horarios'),
  ].join(', ');
}
