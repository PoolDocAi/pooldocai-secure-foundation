const CACHE = 'pooldocai-tech-v2';
const ASSETS = ['/technician.html', '/technician.webmanifest', '/technician-icon.svg'];
const TECH_PATHS = new Set(['/technician.html', '/technician', '/technician.webmanifest', '/technician-icon.svg']);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('pooldocai-tech-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || !TECH_PATHS.has(url.pathname)) return;

  // Network-first for the technician HTML so auth and current code are not served stale;
  // only the exact technician route falls back offline. Never intercept /app, /admin, or other pages.
  if (url.pathname === '/technician.html' || url.pathname === '/technician') {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put('/technician.html', response.clone()));
      return response;
    }).catch(async () => (await caches.match('/technician.html')) || Response.error()));
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
    return response;
  })));
});
