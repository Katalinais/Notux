// Writes a Notux backup full of example data (subjects, weekly schedule, tasks
// and notes), with dates relative to today so it always looks current.
//
//   npm run demo-data               -> dev/notux-demo.json
//   node dev/demo-data.mjs out.json
//
// Load it in the app with Ajustes → Respaldo → Restaurar. It REPLACES whatever
// is in that browser, so use it on a fresh profile or after downloading a backup.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

const backup = {
  app: 'notux',
  format: 1,
  dbVersion: 7,
  exportedAt: now.toISOString(),
  tasks,
  notes,
  subjects,
  schedule,
  config: [],
};

writeFileSync(out, JSON.stringify(backup, null, 2) + '\n');
console.log(
  `Escrito ${out}: ${subjects.length} materias, ${schedule.length} horarios, ${tasks.length} tareas, ${notes.length} notas.`,
);
