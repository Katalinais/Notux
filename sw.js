const CACHE_NAME = 'notux-v7';
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
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting()),
  );
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
