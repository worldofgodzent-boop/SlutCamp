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

// Web Push: show the alert on the phone (lock screen / home screen).
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch (err) { d = { title: 'SlutCamp 💋', body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'SlutCamp 💋';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { link: d.link || '/' },
    vibrate: [80, 40, 80],
  }));
});

// Tapping the alert opens (or focuses) the app.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const link = (e.notification.data && e.notification.data.link) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          if ('navigate' in c) c.navigate(link).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(link);
    })
  );
});
