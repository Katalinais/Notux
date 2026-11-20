// Non-blocking notices that replace alert(). An optional action (e.g. "Deshacer")
// turns the toast into a button target; it stays a little longer so it can be reached.
const DEFAULT_MS = 4000;
const WITH_ACTION_MS = 7000;

let region = null;

function getRegion() {
  if (!region) {
    region = document.createElement('div');
    region.className = 'toasts';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    // As a popover the region renders in the top layer, above any open <dialog>.
    if ('popover' in HTMLElement.prototype) region.popover = 'manual';
    document.body.append(region);
    // 'close' doesn't bubble, but a capturing listener on the document sees it.
    document.addEventListener('close', () => queueMicrotask(syncRegion), true);
  }
  return region;
}

// A modal dialog makes everything outside it inert (top layer or not), so the
// region has to live inside the topmost modal for its buttons to be clickable.
function topmostModal() {
  return [...document.querySelectorAll('dialog[open]')].filter((d) => d.matches(':modal')).at(-1) ?? null;
}

function syncRegion() {
  if (!region) return;
  const parent = topmostModal() ?? document.body;
  const wasOpen = region.popover && region.matches(':popover-open');
  if (wasOpen) region.hidePopover();
  if (region.parentElement !== parent) parent.append(region);
  // Re-showing also moves it to the top of the top layer (above dialogs opened since).
  if (region.popover && region.childElementCount > 0) region.showPopover();
}

/**
 * @param {string} message
 * @param {{ type?: 'info' | 'error', action?: { label: string, onClick: () => void }, duration?: number }} [options]
 *   duration in ms; 0 keeps the toast until it's closed or its action is used.
 */
export function showToast(message, { type = 'info', action, duration } = {}) {
  const toast = document.createElement('div');
  toast.className = `toast${type === 'error' ? ' toast-error' : ''}`;

  const text = document.createElement('span');
  text.textContent = message;
  toast.append(text);

  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    toast.remove();
    syncRegion();
  };

  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      dismiss();
      action.onClick();
    });
    toast.append(btn);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Cerrar aviso');
  close.textContent = '×';
  close.addEventListener('click', dismiss);
  toast.append(close);

  getRegion().append(toast);
  syncRegion();
  const ms = duration ?? (action ? WITH_ACTION_MS : DEFAULT_MS);
  if (ms > 0) timer = setTimeout(dismiss, ms);
  return dismiss;
}
