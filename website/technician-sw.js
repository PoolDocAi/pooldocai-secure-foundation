const CACHE = 'pooldocai-tech-v5';
const ASSETS = [
  '/technician',
  '/technician.html',
  '/technician.webmanifest',
  '/technician-icon.svg',
  '/pooldocai-app-icon-192.png',
  '/pooldocai-app-icon-512.png',
  '/css/design-tokens.css',
  '/js/config.js',
  '/js/core.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      // Precache local assets safely with redirect follow
      for (const asset of ASSETS) {
        try {
          const res = await fetch(asset, { redirect: 'follow' });
          if (res.ok) {
            await cache.put(asset, res.clone());
            // If caching /technician or /technician.html, ensure both keys exist in cache
            if (asset === '/technician' || asset === '/technician.html') {
              await cache.put('/technician', res.clone());
              await cache.put('/technician.html', res.clone());
            }
          }
        } catch (err) {
          console.warn('[SW] Technician SW precache skipped asset:', asset, err);
        }
      }
      // Precache CDN supabase-js if accessible
      try {
        const cdnRes = await fetch('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', { mode: 'cors' });
        if (cdnRes.ok) {
          await cache.put('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', cdnRes);
        }
      } catch (err) {
        console.warn('[SW] Technician SW cdn precache skipped:', err);
      }
    }).then(() => self.skipWaiting())
  );
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
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 1. Navigation requests for technician app shell: network-first with resilient offline fallback
  if (request.mode === 'navigate' || url.pathname === '/technician' || url.pathname === '/technician.html') {
    if (url.origin === self.location.origin && (url.pathname === '/technician' || url.pathname === '/technician.html' || url.pathname.startsWith('/technician'))) {
      event.respondWith(
        fetch(request)
          .then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE).then((cache) => {
                cache.put('/technician', clone.clone());
                cache.put('/technician.html', clone);
              });
            }
            return response;
          })
          .catch(async () => {
            // Offline fallback: serve cached shell
            const cache = await caches.open(CACHE);
            const cached = (await cache.match('/technician')) || (await cache.match('/technician.html'));
            if (cached) return cached;
            return new Response(
              '<!doctype html><html><head><meta charset="utf-8"><title>PoolDocAI Offline</title></head><body><h1>PoolDocAI Technician Offline</h1><p>Please reconnect once to install the offline technician shell.</p></body></html>',
              { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
            );
          })
      );
      return;
    }
  }

  // 2. Local technician assets & CDN scripts
  const isLocalAsset = url.origin === self.location.origin && (
    url.pathname.startsWith('/css/') ||
    url.pathname.startsWith('/js/') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.webmanifest')
  );
  const isSupabaseCdn = url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('supabase-js');

  if (isLocalAsset || isSupabaseCdn) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, clone));
          }
          return response;
        }).catch(() => {
          return caches.match(url.pathname);
        });
      })
    );
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

  // Privacy-minimized fallback
  const title = data.title || 'PoolDocAI Notification';
  const options = {
    body: data.body || 'You have a new company update.',
    icon: '/pooldocai-app-icon-192.png',
    badge: '/technician-icon.svg',
    tag: data.tag || 'pooldocai-alert',
    renotify: true,
    data: {
      url: data.url || '/technician',
      companyId: data.companyId || null,
      notificationId: data.notificationId || null
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Deep-link navigation on notification click
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetPath = event.notification.data?.url || '/technician';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url && client.url.includes('/technician') && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetPath);
      }
    })
  );
});
