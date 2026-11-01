// Bill Planner service worker: the app opens without a connection and shows the last month viewed.
// API reads are network-first with a cached fallback; writes are never cached (the app queues them itself).
const VERSION = 'bp-v2';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const put = (req, res) => { if (res && res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return res; };

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname === '/api/export') return;

  if (url.pathname.startsWith('/api/')) {
    // Only month data is kept offline (cleared on sign-out); sign-in state never is.
    const keep = /^\/api\/months(\/\d{4}-\d{2})?$/.test(url.pathname);
    e.respondWith(fetch(req).then(res => (keep ? put(req, res) : res)).catch(async () =>
      (keep && await caches.match(req)) || new Response(JSON.stringify({ error: 'Offline.' }), { status: 503, headers: { 'Content-Type': 'application/json' } })));
    return;
  }
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => put('/', res)).catch(() => caches.match('/')));
    return;
  }
  // Hashed build files never change: cache first.
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => put(req, res))));
    return;
  }
  e.respondWith(fetch(req).then(res => put(req, res)).catch(() => caches.match(req)));
});
