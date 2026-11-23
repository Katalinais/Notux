// "Generar quiz" in Notas: sends the notes on the board (respecting the subject
// filter) to the Notux API, which asks Claude for a multiple-choice quiz, and
// runs it here one question at a time. Needs an account and a connection; the
// notes leave the device only when the user presses "Generar".
import { $, h, icon } from './dom.js';
import { ApiError, apiRequest, isApiConfigured } from './api.js';
import { getUser, onAuthChange } from './auth.js';
import { openLogin } from './login.js';
import { showToast } from './toast.js';

const MAX_NOTES = 40;
const MAX_NOTE_CHARS = 6000;
const MAX_TOTAL_CHARS = 60_000;
const TIMEOUT_MS = 120_000; // generation plus a possible cold start of the server

const ERRORS = {
  AI_NOT_CONFIGURED: 'La IA no está activada en el servidor de Notux.',
  AI_REFUSED: 'No se pudo armar un quiz con estas notas. Prueba con notas que tengan más contenido.',
  AI_UNAVAILABLE: 'La IA no está disponible en este momento. Inténtalo de nuevo en un rato.',
  AI_TOO_MUCH_TEXT: 'Hay demasiado texto. Filtra por una materia para usar menos notas.',
  HTTP_429: 'Generaste varios quizzes seguidos. Espera un minuto y vuelve a intentarlo.',
  OFFLINE: 'Sin conexión: necesitas internet para generar un quiz.',
  NETWORK: 'No se pudo conectar con el servidor de Notux.',
  TIMEOUT: 'La IA tardó demasiado en responder. Inténtalo de nuevo.',
};

let getSource = null; // () => { notes: { title, text }[], label: string }
let quiz = null; // { title, questions }
let index = 0;
let answers = []; // chosen option per question (null = not answered yet)
let generating = null; // AbortController-less guard: ignore an answer for a closed dialog

const dialog = () => $('quiz-dialog');
const body = () => $('quiz-body');

/* ---------- Views ---------- */
function setupView(errorMessage = null) {
  const { notes, label } = getSource();
  const usable = notes.filter((n) => n.text.trim());
  const total = usable.reduce((sum, n) => sum + n.title.length + n.text.length, 0);
  const tooLong = usable.find((n) => n.text.length > MAX_NOTE_CHARS);
  let problem = null;
  if (!usable.length) problem = 'No hay notas con texto para hacer preguntas. Escribe alguna nota primero.';
  else if (usable.length > MAX_NOTES || total > MAX_TOTAL_CHARS)
    problem = 'Hay demasiado texto para un solo quiz. Filtra por una materia para usar menos notas.';
  else if (tooLong)
    problem = `La nota «${tooLong.title}» es muy larga para el quiz (máximo ${MAX_NOTE_CHARS} caracteres).`;

  const count = h(
    'select',
    { id: 'quiz-count', class: 'input', disabled: !!problem },
    ...[5, 8, 10, 15].map((n) => h('option', { value: String(n), selected: n === 8 }, `${n} preguntas`)),
  );
  const generate = h(
    'button',
    { type: 'submit', class: 'btn btn-primary', disabled: !!problem || !navigator.onLine },
    icon('check-circle', 18),
    'Generar',
  );
  const form = h(
    'form',
    {
      class: 'form',
      onsubmit: (e) => {
        e.preventDefault();
        generate_(usable, Number(count.value));
      },
    },
    h(
      'p',
      { class: 'muted small' },
      problem
        ? ''
        : `Se enviarán ${usable.length} nota${usable.length === 1 ? '' : 's'} (${label}) a Claude, la IA de Anthropic, para crear preguntas de opción múltiple. Las fotos y los audios no se envían.`,
    ),
    problem ? h('p', { class: 'notice-warn small' }, problem) : '',
    errorMessage ? h('p', { class: 'task-meta overdue', role: 'alert' }, errorMessage) : '',
    h('div', {}, h('label', { class: 'label', for: 'quiz-count' }, 'Cantidad'), count),
    h(
      'div',
      { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Cancelar'),
      generate,
    ),
  );
  $('quiz-title').textContent = 'Quiz con IA';
  body().replaceChildren(form);
  (problem ? form.querySelector('.btn-ghost') : count).focus();
}

function loadingView() {
  body().replaceChildren(
    h('p', { class: 'quiz-loading', role: 'status' }, 'Generando tu quiz… puede tardar hasta un minuto.'),
    h(
      'div',
      { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Cancelar'),
    ),
  );
}

function questionView() {
  const q = quiz.questions[index];
  const chosen = answers[index];
  const answered = chosen !== null;
  const last = index === quiz.questions.length - 1;
  $('quiz-title').textContent = quiz.title;

  const options = q.options.map((text, i) => {
    let state = '';
    if (answered && i === q.correctIndex) state = ' is-correct';
    else if (answered && i === chosen) state = ' is-wrong';
    return h(
      'button',
      {
        type: 'button',
        class: `quiz-option${state}`,
        disabled: answered,
        'aria-pressed': i === chosen ? 'true' : 'false',
        onclick: () => choose(i),
      },
      h('span', { class: 'quiz-letter', 'aria-hidden': 'true' }, 'ABCD'[i]),
      h('span', {}, text),
    );
  });

  const feedback = answered
    ? h(
        'div',
        { class: `quiz-feedback ${chosen === q.correctIndex ? 'is-correct' : 'is-wrong'}`, role: 'status' },
        h('strong', {}, chosen === q.correctIndex ? '¡Correcto!' : `Era la ${'ABCD'[q.correctIndex]}.`),
        ' ',
        q.explanation,
        q.sourceNote ? h('span', { class: 'muted small quiz-source' }, `De la nota «${q.sourceNote}»`) : '',
      )
    : '';

  const next = h(
    'button',
    { type: 'button', class: 'btn btn-primary', disabled: !answered, onclick: last ? resultView : () => go(index + 1) },
    last ? 'Ver resultado' : 'Siguiente',
  );

  body().replaceChildren(
    h('p', { class: 'muted small quiz-progress' }, `Pregunta ${index + 1} de ${quiz.questions.length}`),
    h('p', { class: 'quiz-question', id: 'quiz-question' }, q.question),
    h('div', { class: 'quiz-options', role: 'group', 'aria-labelledby': 'quiz-question' }, ...options),
    feedback,
    h(
      'div',
      { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Salir'),
      next,
    ),
  );
  (answered ? next : body().querySelector('.quiz-option')).focus();
}

function resultView() {
  const right = answers.filter((a, i) => a === quiz.questions[i].correctIndex).length;
  const total = quiz.questions.length;
  const ratio = right / total;
  const message =
    ratio === 1
      ? '¡Perfecto! Dominas estas notas.'
      : ratio >= 0.7
        ? '¡Muy bien! Repasa las que fallaste.'
        : 'Vale la pena repasar estas notas otra vez.';
  const missed = quiz.questions
    .map((q, i) => ({ q, i }))
    .filter(({ q, i }) => answers[i] !== q.correctIndex)
    .map(({ q }) =>
      h(
        'li',
        {},
        h('strong', {}, q.question),
        h('span', { class: 'muted small' }, ` Respuesta: ${q.options[q.correctIndex]}`),
      ),
    );
  const again = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => start(quiz) }, 'Repetir');
  body().replaceChildren(
    h('p', { class: 'quiz-score', role: 'status' }, h('strong', {}, `${right} de ${total}`), ` · ${message}`),
    missed.length ? h('p', { class: 'label' }, 'Para repasar') : '',
    missed.length ? h('ul', { class: 'quiz-missed' }, ...missed) : '',
    h(
      'div',
      { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Cerrar'),
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => setupView() }, 'Nuevo quiz'),
      again,
    ),
  );
  again.focus();
}

/* ---------- Actions ---------- */
function start(newQuiz) {
  quiz = newQuiz;
  index = 0;
  answers = quiz.questions.map(() => null);
  questionView();
}

function go(i) {
  index = i;
  questionView();
}

function choose(i) {
  if (answers[index] !== null) return;
  answers[index] = i;
  questionView();
}

async function generate_(notes, count) {
  const token = {};
  generating = token;
  loadingView();
  try {
    const result = await apiRequest('/ai/quiz', {
      method: 'POST',
      body: { notes: notes.map(({ title, text }) => ({ title: title.slice(0, 200), text })), count },
      timeout: TIMEOUT_MS,
    });
    if (generating !== token || !dialog().open) return; // closed meanwhile
    start(result);
  } catch (err) {
    if (generating !== token || !dialog().open) return;
    if (!(err instanceof ApiError) || !(err.code in ERRORS))
      console.error('Quiz generation failed:', err?.code ?? err?.name);
    if (err instanceof ApiError && ['SESSION_EXPIRED', 'NOT_SIGNED_IN'].includes(err.code)) {
      close();
      return;
    }
    setupView(ERRORS[err?.code] ?? 'No se pudo generar el quiz. Inténtalo de nuevo.');
  } finally {
    if (generating === token) generating = null;
  }
}

function close() {
  generating = null;
  if (dialog().open) dialog().close();
}

function open() {
  if (!getUser()) {
    showToast('Inicia sesión para generar quizzes con IA.');
    openLogin();
    return;
  }
  quiz = null;
  setupView();
  dialog().showModal();
}

function renderButton() {
  $('notes-quiz').hidden = !isApiConfigured();
}

/**
 * @param {{ getSource: () => { notes: { title: string, text: string }[], label: string } }} options
 *   the notes currently on the board (after the subject filter) and a label for them
 */
export function initQuiz(options) {
  getSource = options.getSource;
  $('notes-quiz').addEventListener('click', open);
  dialog().addEventListener('close', () => (generating = null));
  onAuthChange(renderButton);
  renderButton();
}
