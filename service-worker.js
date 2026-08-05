const CACHE_NAME = 'casa-vm-v6';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/store.js',
  './js/modal.js',
  './js/recurrence.js',
  './js/members.js',
  './js/recipes.js',
  './js/mealPlanner.js',
  './js/stock.js',
  './js/shoppingList.js',
  './js/tasks.js',
  './js/auth.js',
  './js/calendar.js',
  './js/photos.js',
  './js/dashboard.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first para Google/Firebase e para config.js (muda durante o setup e
// não pode ficar preso em cache); cache-first para o resto do app shell.
self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  const isExternal = url.includes('googleapis.com') || url.includes('firebaseio.com') || url.includes('gstatic.com');
  const isConfig = url.includes('/js/config.js');

  if (isExternal || isConfig) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return resp;
      });
    })
  );
});
