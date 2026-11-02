// Bill Planner service worker: the app opens without a connection and shows the last month viewed.
// API reads are network-first with a cached fallback; writes are never cached (the app queues them itself).
const VERSION = 'bp-v3';
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

// Over-budget alerts and card sync problems (sent by the planner server).
self.addEventListener('push', e => {
  let msg = { title: 'Bill Planner', body: '' };
  try { msg = { ...msg, ...e.data.json() }; } catch { if (e.data) msg.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(msg.title, {
    body: msg.body, tag: msg.tag, renotify: !!msg.tag, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: msg.url || '/' }
  }));
});

// Tapping a notification opens the planner (or focuses it) on the right tab.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => new URL(c.url).origin === self.location.origin);
    if (open) { open.postMessage({ type: 'open', url }); return open.focus(); }
    return self.clients.openWindow(url);
  }));
});
