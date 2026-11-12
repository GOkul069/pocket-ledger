// Offline support: the app shell is cached on first visit and served from cache afterwards.
// Bump CACHE whenever any file below changes so installed copies pick up the new version.
const CACHE = 'pocket-ledger-v2';
const ASSETS = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await cache.match('./') : null);
    const refresh = fetch(req.url, { cache: 'no-cache' }).then(res => { if (res.ok) cache.put(req.url, res.clone()); return res; });
    if (cached) { refresh.catch(() => {}); return cached; }
    return refresh;
  })());
});
