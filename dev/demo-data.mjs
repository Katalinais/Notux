// Writes a Notux backup full of example data (subjects, weekly schedule, tasks
// and notes), with dates relative to today so it always looks current. It also
// covers what a backup has to carry byte for byte: private notes encrypted with
// the password below (salt, IVs, ciphertexts), a photo and an audio recording.
//
//   npm run demo-data               -> dev/notux-demo.json
//   node dev/demo-data.mjs out.json
//
// Load it in the app with Ajustes → Respaldo → Restaurar. It REPLACES whatever
// is in that browser, so use it on a fresh profile or after downloading a backup.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { deriveKeyFromPassword, encryptText, generateSalt } from '../js/crypto.js';

// Password of the private notes in the demo data (Tareas → editar → Nota privada).
const PRIVATE_NOTES_PASSWORD = 'notux1234';

const out = process.argv[2] ?? fileURLToPath(new URL('./notux-demo.json', import.meta.url));
const now = new Date();

// YYYY-MM-DD in local time, `offset` days from today.
function day(offset) {
  const d = new Date(now);
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('sv-SE');
}
// ISO timestamp `offset` days from now (negative = in the past).
function at(offset, hour = 10) {
  const d = new Date(now);
  d.setDate(d.getDate() + offset);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

const subjects = [
  { id: 1, name: 'Cálculo Integral', color: 'indigo' },
  { id: 2, name: 'Física II', color: 'sky' },
  { id: 3, name: 'Programación Web', color: 'emerald' },
  { id: 4, name: 'Bases de Datos', color: 'amber' },
  { id: 5, name: 'Inglés IV', color: 'rose' },
  { id: 6, name: 'Gimnasio', color: 'slate' },
].map((s) => ({ ...s, createdAt: at(-60) }));

// day: 0 = domingo … 6 = sábado
const schedule = [
  [1, 1, '07:00', '09:00', 'C-204'],
  [1, 3, '07:00', '09:00', 'C-204'],
  [2, 2, '09:00', '11:00', 'Laboratorio de Física'],
  [2, 4, '09:00', '11:00', 'B-101'],
  [3, 1, '14:00', '16:00', 'Sala de cómputo 3'],
  [3, 4, '14:00', '16:00', 'Sala de cómputo 3'],
  [4, 2, '14:00', '16:00', 'A-302'],
  [4, 5, '10:00', '12:00', 'A-302'],
  [5, 3, '11:00', '13:00', 'Idiomas 12'],
  [5, 5, '07:00', '09:00', 'Idiomas 12'],
  [6, 2, '18:00', '19:30', 'Coliseo'],
  [6, 4, '18:00', '19:30', 'Coliseo'],
].map(([subjectId, d, start, end, place], i) => ({
  id: i + 1,
  subjectId,
  day: d,
  start,
  end,
  place,
  createdAt: at(-60),
}));

// [title, due offset (null = no date), priority, subjectId, done]
const taskRows = [
  ['Taller 4: integrales por partes', -2, 'high', 1, false],
  ['Informe de laboratorio: ley de Ohm', -1, 'high', 2, false],
  ['Leer capítulo 7 (fracciones parciales)', 0, 'medium', 1, false],
  ['Subir avance del proyecto a GitHub', 0, 'high', 3, false],
  ['Quiz de vocabulario unidad 5', 1, 'medium', 5, false],
  ['Modelo entidad-relación de la biblioteca', 2, 'high', 4, false],
  ['Ejercicios de circuitos RC', 3, 'medium', 2, false],
  ['Maquetar la página de contacto', 4, 'low', 3, false],
  ['Parcial 2 de Cálculo', 6, 'high', 1, false],
  ['Consultas SQL: JOIN y GROUP BY', 8, 'medium', 4, false],
  ['Presentación oral: "My hometown"', 10, 'medium', 5, false],
  ['Entrega final del proyecto web', 20, 'high', 3, false],
  ['Taller 1 de Física (repaso)', null, 'low', 2, false],
  ['Comprar cuaderno cuadriculado', null, 'low', null, false],
  ['Renovar el carné estudiantil', 5, 'medium', null, false],
  ['Taller 3: sustitución trigonométrica', -9, 'high', 1, true],
  ['Normalización hasta 3FN', -6, 'medium', 4, true],
  ['Formulario con validación en JS', -4, 'medium', 3, true],
  ['Listening practice 4', -3, 'low', 5, true],
  ['Rutina de piernas', -1, 'low', 6, true],
];
// Same JSON shapes as js/backup.js writes for binary values.
const b64 = (bytes) => Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).toString('base64');
const u8 = (bytes) => ({ $type: 'uint8array', data: b64(bytes) });
const buf = (bytes) => ({ $type: 'arraybuffer', data: b64(bytes) });
const blob = (mime, bytes) => ({ $type: 'blob', mime, data: b64(bytes) });

// Private notes: the same config js/vault.js creates, and notes encrypted with its key.
const salt = generateSalt();
const key = await deriveKeyFromPassword(PRIVATE_NOTES_PASSWORD, salt);
const verification = await encryptText(key, 'notux-verificacion');
const config = [
  {
    id: 'privateNotes',
    salt: u8(salt),
    verification: { ciphertext: buf(verification.ciphertext), iv: u8(verification.iv) },
  },
];
const privateNotes = {
  2: 'El profe dijo que el informe vale 30 %. Clave del laboratorio: 4512.',
  6: 'Preguntarle a Luis si ya tiene las tablas de préstamos.',
  9: 'Temas: partes, sustitución trigonométrica y fracciones parciales. Me cuesta la 3.',
};

const tasks = taskRows.map(([title, due, priority, subjectId, done], i) => ({
  id: i + 1,
  title,
  due: due === null ? null : day(due),
  done,
  priority,
  subjectId,
  createdAt: at(Math.min(due ?? -5, 0) - 7, 8 + (i % 10)),
  completedAt: done ? at(due - 1, 20) : null,
  encryptedNote: null,
  noteIv: null,
}));
for (const task of tasks) {
  const text = privateNotes[task.id];
  if (!text) continue;
  const { ciphertext, iv } = await encryptText(key, text);
  task.encryptedNote = buf(ciphertext);
  task.noteIv = u8(iv);
}

// A small PNG: graph paper with a curve, like a photo of the board.
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), row + 1 + x * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const photo = png(320, 220, (x, y) => {
  const curve = 110 - 80 * Math.sin((x / 320) * Math.PI * 2);
  if (Math.abs(y - curve) < 2.5) return [79, 70, 229];
  if (y === 110 || x === 20) return [51, 65, 85];
  if (x % 20 === 0 || y % 20 === 0) return [199, 210, 254];
  return [248, 250, 252];
});

// A short WAV: three rising notes, like a voice memo placeholder.
function wav(seconds = 1.8, rate = 22050) {
  const samples = Math.floor(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  const notes = [440, 554.37, 659.25];
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const n = Math.min(notes.length - 1, Math.floor((t / seconds) * notes.length));
    const local = t - (n * seconds) / notes.length;
    const envelope = Math.min(1, local * 40) * Math.exp(-local * 3);
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * notes[n] * t) * envelope * 12000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const noteRows = [
  ['Fórmulas de integración', '∫ u dv = uv − ∫ v du\n∫ sec²x dx = tan x + C\nRevisar tabla de la página 412.', 1, -3],
  [
    'Preguntas para el profe de Física',
    '¿Entra la ley de Kirchhoff en el parcial?\n¿Se puede llevar calculadora graficadora?',
    2,
    -2,
  ],
  ['Ideas para el proyecto web', '- Modo oscuro\n- Notificaciones de tareas\n- Exportar a PDF', 3, -5],
  ['Comandos de Git que siempre olvido', 'git switch -c rama\ngit stash pop\ngit log --oneline --graph', 3, -12],
  ['Tipos de JOIN', 'INNER: solo coincidencias\nLEFT: todo lo de la izquierda\nFULL: todo de ambos lados', 4, -4],
  ['Phrasal verbs unidad 5', 'look forward to · give up · run out of · get along with', 5, -1],
  ['Rutina del gimnasio', 'Lunes y jueves: tren superior\nMartes: piernas\nViernes: cardio 30 min', 6, -20],
  ['Pendientes de la semana', 'Pagar la matrícula, sacar fotocopias del taller, llamar a la abuela 💛', null, 0],
];
const notes = noteRows.map(([title, text, subjectId, created], i) => ({
  id: i + 1,
  title,
  text,
  subjectId,
  photo: null,
  audio: null,
  createdAt: at(created, 9 + i),
}));
notes.push(
  {
    id: notes.length + 1,
    title: 'Foto del tablero: gráfica de sen(x)',
    text: 'La tomé al final de la clase. Ojo con los cortes en el eje x.',
    subjectId: 1,
    photo: blob('image/png', photo),
    audio: null,
    createdAt: at(-1, 9),
  },
  {
    id: notes.length + 2,
    title: 'Audio: pronunciación unidad 5',
    text: 'Grabación para repasar antes del quiz.',
    subjectId: 5,
    photo: null,
    audio: blob('audio/wav', wav()),
    createdAt: at(0, 8),
  },
);

const backup = {
  app: 'notux',
  format: 1,
  dbVersion: 7,
  exportedAt: now.toISOString(),
  tasks,
  notes,
  subjects,
  schedule,
  config,
};

writeFileSync(out, JSON.stringify(backup, null, 2) + '\n');
console.log(
  `Escrito ${out}: ${subjects.length} materias, ${schedule.length} horarios, ${tasks.length} tareas ` +
    `(${Object.keys(privateNotes).length} con nota privada), ${notes.length} notas (1 con foto, 1 con audio).`,
);
console.log(`Contraseña de las notas privadas: ${PRIVATE_NOTES_PASSWORD}`);
