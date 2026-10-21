/* Technician PWA worker is route-scoped; it must never hijack /app, /admin or public pages. */
const CACHE='pooldocai-tech-v2';
const ASSETS=['/technician','/technician.html','/technician.webmanifest','/technician-icon.svg','/js/config.js','/js/core.js'];
const OWN_PATHS=new Set(['/technician','/technician.html','/technician.webmanifest','/technician-icon.svg','/js/config.js','/js/core.js']);
self.addEventListener('install',e=>e.waitUntil((async()=>{const c=await caches.open(CACHE);await c.addAll(ASSETS);await self.skipWaiting()})()));
self.addEventListener('activate',e=>e.waitUntil((async()=>{const keys=await caches.keys();await Promise.all(keys.filter(k=>k.startsWith('pooldocai-tech-')&&k!==CACHE).map(k=>caches.delete(k)));await self.clients.claim()})()));
self.addEventListener('fetch',e=>{const req=e.request;if(req.method!=='GET')return;const u=new URL(req.url);if(u.origin!==self.location.origin||!OWN_PATHS.has(u.pathname))return;e.respondWith((async()=>{const c=await caches.open(CACHE);try{const res=await fetch(req);if(res.ok)await c.put(req,res.clone());return res}catch{const hit=await c.match(req);if(hit)return hit;return new Response('Technician field notes need an internet connection for this resource. Reconnect and reload.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}})}})())});
