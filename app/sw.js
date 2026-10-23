// DirtScout service worker: keeps the app itself (HTML, JS, CSS, icons) so it opens with no network.
// Map tiles are not handled here: the page stores them in IndexedDB. The build fills in VERSION and PRECACHE.
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CACHE = `dirtscout-${VERSION}`;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('dirtscout-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// The page asks for this when the rider taps "Update".
self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // ignoreVary: module scripts carry an Origin header the precache requests did not, and servers may send Vary: Origin.
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('index.html', { ignoreVary: true }).then((r) => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true, ignoreVary: true }).then((r) => r || fetch(req)));
});
