// Daily reminder settings. The notification itself is built and shown by the
// service worker (sw.js → notifyToday), from a Periodic Background Sync event.
//
// Periodic Background Sync only exists in Chromium browsers and only fires for
// an installed app; the browser decides how often (at most ~every 12 h) based
// on how much the app is used. There is no reliable way to schedule an exact
// time without a push server, so the UI says so instead of over-promising.
import { getConfig, saveConfig } from './db.js';

const CONFIG_ID = 'reminders';
const SYNC_TAG = 'notux-reminders';
const MIN_INTERVAL = 12 * 60 * 60 * 1000;

export const notificationsSupported = () => 'Notification' in window && 'serviceWorker' in navigator;
const periodicSyncSupported = () =>
  'serviceWorker' in navigator && 'periodicSync' in ServiceWorkerRegistration.prototype;

async function settings(db) {
  return (await getConfig(db, CONFIG_ID)) ?? { id: CONFIG_ID, enabled: false };
}

export async function isEnabled(db) {
  return (await settings(db)).enabled && Notification.permission === 'granted';
}

/**
 * Describes what the reminder can actually do on this device.
 * @returns {Promise<{ level: 'ok' | 'limited' | 'off' | 'unsupported' | 'blocked', message: string }>}
 */
export async function status(db) {
  if (!notificationsSupported()) {
    return { level: 'unsupported', message: 'Este navegador no permite notificaciones.' };
  }
  if (Notification.permission === 'denied') {
    return {
      level: 'blocked',
      message: 'Bloqueaste las notificaciones de Notux. Actívalas en el candado de la barra de direcciones.',
    };
  }
  if (!(await isEnabled(db))) return { level: 'off', message: '' };
  if (!periodicSyncSupported()) {
    return {
      level: 'limited',
      message: 'Este navegador no permite revisar en segundo plano: el recordatorio no llegará con la app cerrada.',
    };
  }
  const reg = await navigator.serviceWorker.ready;
  const tags = await reg.periodicSync.getTags().catch(() => []);
  if (!tags.includes(SYNC_TAG)) {
    return {
      level: 'limited',
      message: 'Instala Notux como app para que el recordatorio llegue aunque esté cerrada.',
    };
  }
  return {
    level: 'ok',
    message:
      'Activo. Llega una vez al día, por la mañana; el navegador decide la hora exacta según cuánto uses la app.',
  };
}

// Registers the periodic sync if the browser lets us; failing is expected when
// the app isn't installed, so it's not an error.
async function registerSync() {
  if (!periodicSyncSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const perm = await navigator.permissions.query({ name: 'periodic-background-sync' }).catch(() => null);
    if (perm && perm.state === 'denied') return false;
    await reg.periodicSync.register(SYNC_TAG, { minInterval: MIN_INTERVAL });
    return true;
  } catch {
    return false;
  }
}

// Asks for notification permission (must run from a user gesture) and turns
// the reminder on. Returns false if the user didn't allow notifications.
export async function enable(db) {
  if (!notificationsSupported()) return false;
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') return false;
  await saveConfig(db, { ...(await settings(db)), enabled: true });
  await registerSync();
  return true;
}

export async function disable(db) {
  await saveConfig(db, { ...(await settings(db)), enabled: false });
  if (periodicSyncSupported()) {
    const reg = await navigator.serviceWorker.ready;
    await reg.periodicSync.unregister(SYNC_TAG).catch(() => {});
  }
}

// Re-registers on startup: after installing the app, the sync becomes possible
// without the user having to toggle the setting again.
export async function refresh(db) {
  if (await isEnabled(db)) await registerSync();
}

// Shows today's reminder right away (the service worker builds it from the data).
export async function sendTest() {
  const reg = await navigator.serviceWorker.ready;
  reg.active?.postMessage({ type: 'TEST_REMINDER' });
}
