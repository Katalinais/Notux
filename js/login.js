// Sign-in screen: Google, or username and password. The account is optional:
// "Continuar sin cuenta" (or Escape) closes it and Notux works as always.
// It opens by itself on startup while signed out, until the user skips it once;
// signing in clears that, so after signing out it shows up again next time.
import { $ } from './dom.js';
import { showToast } from './toast.js';
import { isConfigured, getUser, signInWithGoogle, signInWithPassword, profileOf } from './auth.js';

const SKIP_KEY = 'notux.login.skipped';

const dialog = $('login-dialog');
const form = $('login-form');
const errorEl = $('login-error');
let busy = null; // 'google' | 'password' | null
let fromStartup = false; // opened by itself: closing it means "not now"

const ERRORS = {
  INVALID_CREDENTIALS: 'Usuario o contraseña incorrectos.',
  HTTP_429: 'Demasiados intentos. Espera un minuto y vuelve a intentarlo.',
  OFFLINE: 'Sin conexión: necesitas internet para iniciar sesión.',
  NETWORK: 'No se pudo conectar con el servidor de Notux. Inténtalo de nuevo en un momento.',
  TIMEOUT: 'El servidor tardó demasiado en responder. Inténtalo de nuevo.',
};

function skipped() {
  try {
    return localStorage.getItem(SKIP_KEY) === '1';
  } catch {
    return false;
  }
}

function setSkipped(value) {
  try {
    if (value) localStorage.setItem(SKIP_KEY, '1');
    else localStorage.removeItem(SKIP_KEY);
  } catch {
    // storage blocked: it just asks again next time
  }
}

function showError(message) {
  errorEl.textContent = message ?? '';
  errorEl.hidden = !message;
}

function render() {
  const online = navigator.onLine;
  $('login-offline').hidden = online;
  const google = $('login-google');
  google.disabled = !online || busy !== null;
  google.setAttribute('aria-busy', busy === 'google' ? 'true' : 'false');
  google.lastElementChild.textContent = busy === 'google' ? 'Abriendo Google…' : 'Continuar con Google';
  const submit = $('login-submit');
  submit.disabled = !online || busy !== null;
  submit.setAttribute('aria-busy', busy === 'password' ? 'true' : 'false');
  submit.textContent = busy === 'password' ? 'Entrando…' : 'Entrar';
  for (const input of form.querySelectorAll('input')) input.readOnly = busy === 'password';
}

/** Opens the sign-in screen (from the sidebar button or Ajustes → Cuenta). */
export function openLogin({ startup = false } = {}) {
  if (!isConfigured() || getUser() || dialog.open) return;
  fromStartup = startup;
  showError(null);
  render();
  dialog.showModal();
  $('login-username').focus();
}

function close() {
  if (dialog.open) dialog.close();
}

async function submitPassword(e) {
  e.preventDefault();
  if (busy) return;
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  if (!username || !password) {
    showError('Escribe tu usuario y tu contraseña.');
    (username ? $('login-password') : $('login-username')).focus();
    return;
  }
  busy = 'password';
  showError(null);
  render();
  try {
    const user = await signInWithPassword(username, password);
    setSkipped(false);
    form.reset();
    close();
    showToast(`Sesión iniciada como ${profileOf(user).name}.`);
  } catch (err) {
    if (err?.code !== 'INVALID_CREDENTIALS') console.error('Password sign-in failed:', err?.code ?? err?.name);
    showError(ERRORS[err?.code] ?? 'No se pudo iniciar sesión. Inténtalo de nuevo.');
    $('login-password').select();
  } finally {
    busy = null;
    render();
    if (dialog.open && !errorEl.hidden) $('login-password').focus();
  }
}

function startGoogle() {
  if (busy) return;
  busy = 'google';
  render();
  try {
    setSkipped(false);
    signInWithGoogle(); // leaves for Google; comes back signed in (account.js reports it)
  } catch (err) {
    console.error('Could not start Google sign-in:', err?.code ?? err?.name ?? 'Error');
    showError(ERRORS[err?.code] ?? 'No se pudo abrir el inicio de sesión con Google. Inténtalo de nuevo.');
    busy = null;
    render();
  }
}

/** Wires the screen. Call once; then maybeOpenOnStartup() once the session is known. */
export function initLogin() {
  form.addEventListener('submit', submitPassword);
  $('login-google').addEventListener('click', startGoogle);
  $('login-skip').addEventListener('click', close);
  dialog.addEventListener('cancel', (e) => {
    if (busy === 'password') e.preventDefault(); // let the request finish
  });
  dialog.addEventListener('close', () => {
    if (fromStartup && !getUser()) setSkipped(true);
    fromStartup = false;
    form.reset();
    showError(null);
  });
  window.addEventListener('online', render);
  window.addEventListener('offline', render);
  // Back from Google with the browser's back button (page restored from bfcache).
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && busy === 'google') {
      busy = null;
      render();
    }
  });
}

/** Shows the screen on startup when signed out, unless the user already chose to go without an account. */
export function maybeOpenOnStartup() {
  if (!skipped()) openLogin({ startup: true });
}
