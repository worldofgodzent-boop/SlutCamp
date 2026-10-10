/*
 * SlutCamp — service worker.
 * Network-first for the app shell (always fresh updates when online),
 * cache fallback when offline. API, realtime, and uploads never cached.
 */
const CACHE = 'slutcamp-v2';
const SHELL = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// App shell files: network first (fresh updates), cache fallback offline.
// Icons/manifest: cache first (rarely change).
const NETWORK_FIRST = ['/', '/index.html', '/css/styles.css', '/js/app.js'];

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache API, realtime, or uploaded photos
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws') ||
      url.pathname.startsWith('/uploads/')) return;

  if (NETWORK_FIRST.includes(url.pathname)) {
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html')))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match('/index.html')))
    );
  }
});
