// Account UI: the "Cuenta" section in Ajustes and the account button in the
// sidebar. All auth logic lives in auth.js; this only renders its state.
import { $, h, icon } from './dom.js';
import { showToast } from './toast.js';
import { LOCALE } from './dates.js';
import { isConfigured, getUser, onAuthChange, initAuth, signInWithGoogle, signOut, profileOf } from './auth.js';

let signingIn = false; // between pressing the button and leaving for Google

function initialOf(name) {
  return [...name.trim()][0]?.toLocaleUpperCase(LOCALE) ?? '?';
}

// Photo when there is one, the initial otherwise (and when the photo can't load,
// e.g. offline: it comes from Google, outside the service worker's cache).
function avatar(profile, size) {
  const el = h('span', { class: `account-avatar account-avatar-${size}`, 'aria-hidden': 'true' });
  if (!profile) {
    el.append(icon('user', 20));
    return el;
  }
  const initial = h('span', { class: 'account-initial' }, initialOf(profile.name));
  if (profile.avatarUrl) {
    const img = h('img', { src: profile.avatarUrl, alt: '', referrerpolicy: 'no-referrer', decoding: 'async' });
    img.addEventListener('error', () => img.replaceWith(initial));
    el.append(img);
  } else {
    el.append(initial);
  }
  return el;
}

/* ---------- Sidebar button ---------- */
function renderSidebarButton(profile) {
  const btn = $('btn-account');
  btn.hidden = !isConfigured(); // no account features at all: keep the sidebar as it was
  const label = profile ? profile.name : 'Iniciar sesión';
  btn.replaceChildren(avatar(profile, 'sm'), h('span', { class: 'nav-label' }, label));
  if (profile) btn.setAttribute('aria-label', `Cuenta: ${profile.name}`);
  else btn.removeAttribute('aria-label');
  // Collapsed sidebar: the label is visually hidden, so a tooltip names the button.
  if (document.querySelector('.app').classList.contains('is-sidebar-collapsed')) btn.title = label;
}

/* ---------- Ajustes → Cuenta ---------- */
function notConfiguredView() {
  return [
    h(
      'p',
      { class: 'muted small' },
      'Las cuentas no están activadas en esta copia de Notux. Todo funciona igual: tus datos se guardan solo en este navegador.',
    ),
  ];
}

function signedOutView() {
  const online = navigator.onLine;
  const hint = h(
    'p',
    { id: 'account-hint', class: online ? 'muted small' : 'notice-warn small' },
    online
      ? 'Inicia sesión con Google para guardar respaldos en tu Google Drive. Es opcional: sin cuenta todo sigue funcionando.'
      : 'Sin conexión: necesitas internet para iniciar sesión. Sin cuenta todo sigue funcionando.',
  );
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-google',
      disabled: !online || signingIn,
      'aria-busy': signingIn ? 'true' : null,
      'aria-describedby': 'account-hint',
      onclick: startSignIn,
    },
    icon('google', 18),
    signingIn ? 'Abriendo Google…' : 'Continuar con Google',
  );
  return [hint, btn];
}

function signedInView(profile) {
  return [
    h(
      'div',
      { class: 'account-user' },
      avatar(profile, 'lg'),
      h(
        'div',
        { class: 'account-user-text' },
        h('strong', {}, profile.name),
        profile.email ? h('span', { class: 'muted small' }, profile.email) : '',
      ),
    ),
    h(
      'p',
      { class: 'muted small' },
      navigator.onLine
        ? 'Puedes guardar respaldos en tu Google Drive (abajo, en Respaldo). Tus datos siguen guardados en este navegador.'
        : 'Sin conexión: tu sesión sigue guardada en este dispositivo.',
    ),
    h(
      'button',
      { type: 'button', class: 'btn btn-ghost btn-sm', onclick: endSession },
      icon('logout', 16),
      'Cerrar sesión',
    ),
  ];
}

function render() {
  const user = getUser();
  const profile = user ? profileOf(user) : null;
  renderSidebarButton(profile);

  const body = $('account-body');
  const hadFocus = body.contains(document.activeElement);
  body.replaceChildren(...(!isConfigured() ? notConfiguredView() : profile ? signedInView(profile) : signedOutView()));
  // Re-rendering replaced the focused button: keep focus in the section.
  if (hadFocus) (body.querySelector('button:not(:disabled)') ?? $('settings-close')).focus();
}

/* ---------- Actions ---------- */
function startSignIn() {
  if (signingIn) return;
  signingIn = true;
  render();
  try {
    signInWithGoogle(); // the page navigates away to Google
  } catch (err) {
    console.error('Could not start Google sign-in:', err?.code ?? err?.name ?? 'Error');
    showToast('No se pudo abrir el inicio de sesión con Google. Inténtalo de nuevo.', { type: 'error' });
    signingIn = false;
    render();
  }
}

async function endSession() {
  await signOut();
  showToast('Sesión cerrada.');
}

const REDIRECT_ERRORS = {
  access_denied: 'Se canceló el inicio de sesión con Google.',
  INVALID_LOGIN_CODE: 'El inicio de sesión expiró antes de terminar. Inténtalo de nuevo.',
  OFFLINE: 'Sin conexión: no se pudo terminar de iniciar sesión.',
  NETWORK: 'No se pudo conectar con el servidor de Notux para iniciar sesión.',
  TIMEOUT: 'El servidor de Notux tardó demasiado. Inténtalo de nuevo.',
};

function reportRedirect({ redirected, user, error }) {
  if (!redirected) return;
  if (user) {
    showToast(`Sesión iniciada como ${profileOf(user).name}.`);
    return;
  }
  if (error !== 'access_denied') console.error('Google sign-in failed:', error); // cancelling isn't an error
  showToast(REDIRECT_ERRORS[error] ?? 'No se pudo iniciar sesión con Google. Inténtalo de nuevo.', { type: 'error' });
}

/**
 * Wires the account UI. Call once on startup.
 * @param {{ openSettings: () => void }} options  the sidebar button opens Ajustes
 */
export function initAccount({ openSettings }) {
  $('btn-account').addEventListener('click', openSettings);
  onAuthChange((_user, event) => {
    render();
    if (event === 'SESSION_EXPIRED') {
      showToast('Tu sesión expiró. Vuelve a iniciar sesión para usar Google Drive.', { type: 'error' });
    }
  });
  window.addEventListener('online', render);
  window.addEventListener('offline', render);
  // A tab restored from the back/forward cache after leaving for Google.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && signingIn) {
      signingIn = false;
      render();
    }
  });
  render();
  initAuth()
    .then(reportRedirect)
    .catch((err) => console.error('Account startup failed:', err?.name ?? 'Error'));
}
