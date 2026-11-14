// Offline support: app shell is precached; map + terrain tiles are cache-first.
const SHELL = 'fpv-shell-v10';
const TILES = 'fpv-tiles-v1';
const ASSETS = [
  './', 'index.html', 'manual.html', 'css/manual.css', 'manifest.webmanifest', 'css/app.css', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png', 'vendor/leaflet/images/marker-icon-2x.png', 'vendor/leaflet/images/marker-shadow.png',
  'vendor/leaflet/images/layers.png', 'vendor/leaflet/images/layers-2x.png',
  'js/app.js', 'js/data.js', 'js/store.js', 'js/rf.js', 'js/solver.js', 'js/vtxtable.js', 'js/terrain.js', 'js/mapview.js', 'js/export.js', 'js/geo.js', 'js/firmware.js', 'js/coords.js', 'js/paths.js', 'js/missions.js',
];
const TILE_HOSTS = ['basemap.nationalmap.gov', 's3.amazonaws.com', 'elevation-tiles-prod.s3.amazonaws.com'];

self.addEventListener('install', e => e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('fpv-shell-') && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim())));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (TILE_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(e.request.url);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok || r.type === 'opaque') c.put(e.request.url, r.clone());
      return r;
    }));
    return;
  }
  if (url.origin === location.origin) {
    // network-first so updates arrive when online; fall back to cache offline
    // revalidate with the server (bypass stale HTTP cache) so updates arrive; fall back to cache offline
    e.respondWith(fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })));
  }
});
