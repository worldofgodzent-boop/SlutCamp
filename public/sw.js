/*
 * SlutCamp — service worker.
 * Network-first for the app shell (always fresh updates when online),
 * cache fallback when offline. API, realtime, and uploads never cached.
 * /manager/* (Slut Manager) is fully bypassed: never cached, never
 * answered from cache — the Manager must always load its own fresh
 * assets straight from the network.
 *
 * FORCED REFRESH (Asce's rule, 2026-10-16): nobody sits on a stale build.
 * The '__BUILD__' token in the cache name below is a placeholder —
 * server.js stamps it with the deploy's build id every time it serves
 * this file (see the /sw.js route + /api/build-id in server.js). Every
 * deploy therefore serves a byte-different worker whose cache name is
 * new: the new worker installs, skipWaiting()s past the old one, and on
 * activate deletes EVERY cache that is not its own — a full flush on
 * every phone, no manual cache bump ever. If the server cannot identify
 * its build, it stamps 'v4' and this file behaves exactly like the old
 * static slutcamp-v4 worker.
 */
const CACHE = 'slutcamp-__BUILD__';
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
// The theme engine (/js/theme.js) is network-first too: it carries the
// seasonal banner, promo strip and pop-up schedule, so a stale cached
// copy would freeze a device on an old season forever.
const NETWORK_FIRST = ['/', '/index.html', '/css/styles.css', '/js/app.js', '/js/theme.js'];
// Seasonal theme CSS (theme-base.css + per-holiday packs) lives under
// /css/themes/ and changes with the seasons — network-first by prefix so
// new packs are covered automatically and never sit stale in cache.
const NETWORK_FIRST_PREFIXES = ['/css/themes/'];

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache API, realtime, or uploaded photos
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws') ||
      url.pathname.startsWith('/uploads/')) return;

  // Slut Manager lives under /manager/ — hands off entirely. No
  // respondWith, no cache reads or writes: the browser fetches it
  // directly from the network so this worker can never serve the
  // Manager a stale or wrong-typed asset.
  if (url.pathname === '/manager' || url.pathname.startsWith('/manager/')) return;

  if (NETWORK_FIRST.includes(url.pathname) ||
      NETWORK_FIRST_PREFIXES.some((p) => url.pathname.startsWith(p))) {
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
  // Home-screen icon badge: payloads carry the recipient's unread DM
  // count (badge_unread) — mirror it onto the app icon so waiting
  // messages show even while the app is closed. Best-effort: where the
  // Badging API does not exist this silently does nothing.
  let badgeWork = Promise.resolve();
  try {
    if (typeof d.badge_unread === 'number' && 'setAppBadge' in navigator) {
      badgeWork = Promise.resolve(navigator.setAppBadge(d.badge_unread)).catch(() => {});
    }
  } catch (err) { /* badge is best-effort */ }
  e.waitUntil(Promise.all([badgeWork, self.registration.showNotification(title, {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { link: d.link || '/' },
    vibrate: [80, 40, 80],
  })]));
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
