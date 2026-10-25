/* PoolDocAI app-shell worker: app navigation only; never intercepts Supabase/API requests. */
const CACHE_NAME = 'pooldocai-secure-app-v3';
const APP_PATHS = new Set(['/app', '/app.html']);
const STATIC_PATHS = new Set(['/app.webmanifest', '/pooldocai-app-icon.svg', '/pooldocai-app-icon-192.png', '/pooldocai-app-icon-512.png']);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(['/app', '/app.webmanifest', '/pooldocai-app-icon-192.png', '/pooldocai-app-icon-512.png']);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('pooldocai-secure-app-') && key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // These pages must always fetch their latest HTML. Only generic app shell files are cached.
  if (APP_PATHS.has(url.pathname) && req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(req);
        if (response.ok) await cache.put('/app', response.clone());
        return response;
      } catch {
        const cached = await cache.match('/app');
        return cached || new Response('PoolDocAI needs an internet connection to sign in and troubleshoot. Reconnect and reload this page.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }
  // Do not cache /js/config.js: its public project key may rotate and must not become stale.
  if (STATIC_PATHS.has(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(req);
        if (response.ok) await cache.put(req, response.clone());
        return response;
      } catch {
        const hit = await cache.match(req);
        return hit || new Response('This static resource needs an internet connection.', { status: 503 });
      }
    })());
  }
});

// Push notification delivery handler
self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { body: event.data.text() };
    }
  }

  const title = data.title || 'PoolDocAI Notification';
  const options = {
    body: data.body || 'You have a new company update.',
    icon: '/pooldocai-app-icon-192.png',
    badge: '/pooldocai-app-icon.svg',
    tag: data.tag || 'pooldocai-alert',
    renotify: true,
    data: {
      url: data.url || '/app.html',
      companyId: data.companyId || null,
      notificationId: data.notificationId || null
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Deep-link navigation on notification click
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetPath = event.notification.data?.url || '/app.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url && (client.url.includes('/app') || client.url.includes('/admin')) && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetPath);
      }
    })
  );
});
