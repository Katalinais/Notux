const CACHE_NAME = 'notux-v9';
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/crypto.js',
  './js/device.js',
  './js/vault.js',
  './js/toast.js',
  './js/dom.js',
  './js/dates.js',
  './js/calendar.js',
  './js/schedule.js',
  './js/backup.js',
  './js/reminders.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
];

// Paths are resolved against the SW scope, not the domain root, so the app
// keeps working when it's served from a subfolder (e.g. GitHub Pages).
const SCOPE = new URL(self.registration.scope);
const ICONS_PATH = new URL('icons/', SCOPE).pathname;
const API_PATH = new URL('api/', SCOPE).pathname;
const APP_SHELL = new URL('index.html', SCOPE).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)),
    // No skipWaiting() here: a new version waits until the page offers
    // "Actualizar" and the user accepts, instead of swapping code under an open
    // tab (which could mix old HTML with new JS mid-session).
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'TEST_REMINDER') event.waitUntil(notifyToday({ force: true }));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Only full, successful same-origin responses are worth keeping: caching a 404
// or a 500 would serve that error forever under cache-first.
function isCacheable(response) {
  return response && response.ok && response.type === 'basic';
}

async function putInCache(request, response) {
  if (!isCacheable(response)) return;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response);
}

async function cacheFirst(event) {
  const cached = await caches.match(event.request);
  if (cached) return cached;
  const response = await fetch(event.request);
  event.waitUntil(putInCache(event.request, response.clone()));
  return response;
}

async function networkFirst(event) {
  try {
    const response = await fetch(event.request);
    event.waitUntil(putInCache(event.request, response.clone()));
    return response;
  } catch (err) {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(event) {
  const cached = await caches.match(event.request);
  const update = fetch(event.request).then((response) => {
    event.waitUntil(putInCache(event.request, response.clone()));
    return response;
  });

  if (cached) {
    // Revalidate in the background; being offline here is expected, not an error.
    event.waitUntil(update.catch(() => {}));
    return cached;
  }
  return update;
}

// Navigations (opening the app, reloading, a link with ?query) fall back to the
// cached app shell when the network is down, instead of the browser's offline page.
async function handleNavigation(event) {
  try {
    return await staleWhileRevalidate(event);
  } catch {
    const shell = await caches.match(APP_SHELL);
    if (shell) return shell;
    return new Response('Notux no está disponible sin conexión todavía.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Leave anything we can't or shouldn't cache to the browser: non-GET requests
  // (Cache API rejects them) and other origins (extensions, CDNs, etc.).
  if (request.method !== 'GET' || url.origin !== SCOPE.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
  } else if (url.pathname.startsWith(ICONS_PATH)) {
    event.respondWith(cacheFirst(event));
  } else if (url.pathname.startsWith(API_PATH)) {
    event.respondWith(networkFirst(event));
  } else {
    event.respondWith(staleWhileRevalidate(event));
  }
});

/* ---------- Daily reminder ---------- */
// Runs from Periodic Background Sync (installed app, Chromium) or on demand for
// the "test" button. Reads IndexedDB directly; the page isn't open.
const REMINDER_TAG = 'notux-reminders';
const EARLIEST_HOUR = 6; // don't notify in the middle of the night

self.addEventListener('periodicsync', (event) => {
  if (event.tag === REMINDER_TAG) event.waitUntil(notifyToday());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? SCOPE.href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => w.url.startsWith(SCOPE.href));
      if (open) return open.focus().then((w) => w?.navigate?.(url) ?? w);
      return self.clients.openWindow(url);
    }),
  );
});

function openNotuxDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('notux-db'); // no version: whatever the page created
    // If the page never ran, don't create an empty database from here.
    req.onupgradeneeded = () => req.transaction.abort();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getAll(db, store) {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(store)) return resolve([]);
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function putConfig(db, record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('config', 'readwrite');
    tx.objectStore('config').put(record);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}

const localDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shortTime = (hhmm) => hhmm.replace(/^0(\d)/, '$1');
const listOf = (items, max = 3) =>
  items.length > max ? `${items.slice(0, max).join(', ')} y ${items.length - max} más` : items.join(', ');

async function notifyToday({ force = false } = {}) {
  let db;
  try {
    db = await openNotuxDb();
  } catch {
    return;
  }
  try {
    const config = await getAll(db, 'config');
    const settings = config.find((c) => c.id === 'reminders') ?? { id: 'reminders', enabled: false };
    const now = new Date();
    const today = localDay(now);
    if (!force && (!settings.enabled || settings.lastNotifiedDay === today || now.getHours() < EARLIEST_HOUR)) return;

    const tasks = (await getAll(db, 'tasks')).filter((t) => !t.done && t.due);
    const dueToday = tasks.filter((t) => t.due === today).map((t) => t.title);
    const overdue = tasks.filter((t) => t.due < today).length;
    const classes = (await getAll(db, 'schedule'))
      .filter((b) => b.day === now.getDay())
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((b) => `${b.subject} ${shortTime(b.start)}`);

    const lines = [];
    if (dueToday.length) lines.push(`Vencen hoy: ${listOf(dueToday)}`);
    if (overdue) lines.push(`${overdue} tarea${overdue === 1 ? '' : 's'} vencida${overdue === 1 ? '' : 's'}`);
    if (classes.length) lines.push(`Clases: ${listOf(classes)}`);
    if (!lines.length && !force) {
      await putConfig(db, { ...settings, lastNotifiedDay: today }); // nothing to say today
      return;
    }

    await self.registration.showNotification('Notux · Hoy', {
      body: lines.length ? lines.join('\n') : 'Nada vence hoy y no tienes clases. ¡Buen día!',
      icon: new URL('icons/icon-192.png', SCOPE).href,
      badge: new URL('icons/icon-maskable-192.png', SCOPE).href,
      tag: 'notux-daily', // replaces yesterday's instead of piling up
      data: { url: new URL('./#/', SCOPE).href },
    });
    if (!force) await putConfig(db, { ...settings, lastNotifiedDay: today });
  } finally {
    db.close();
  }
}
