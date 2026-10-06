// sw.js — Service Worker : minimal, non bloquant, activation garantie
const VERSION = 'hunter-v7';
const STATIC_CACHE = VERSION + '-static';
const CDN_CACHE = VERSION + '-cdn';

const PRECACHE_ASSETS = [
  './', './index.html', './manifest.webmanifest', './style.css',
  './app.js', './worker.js', './bip39-fr.js', './server.js',
  './storage.js', './crypto-export.js', './simulation.js', './networks.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'
];

const CDN_HOSTS = ['esm.sh', 'raw.githubusercontent.com', 'cdn.jsdelivr.net', 'unpkg.com'];

// INSTALL — durée ~1s, ne fait AUCUN fetch réseau bloquant
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(STATIC_CACHE);
      // Précache local : chaque fetch est isolé, aucun ne peut bloquer
      await Promise.all(
        PRECACHE_ASSETS.map(asset =>
          fetch(asset).then(res => {
            if (res.ok) cache.put(asset, res);
          }).catch(() => {})
        )
      );
    } catch (e) {
      console.warn('[SW] install cache error:', e);
    }
    // Toujours activer immédiatement, peu importe le résultat
    self.skipWaiting();
  })());
});

// ACTIVATE — nettoyage + contrôle + précache arrière-plan
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k))
      );
    } catch (e) {}
    await self.clients.claim();

    // Notifier
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.postMessage({ type: 'server-ready', version: VERSION }));

    // Précache CDN en arrière-plan (silencieux)
    precacheCDNInBackground();
  })());
});

async function precacheCDNInBackground() {
  try {
    const cdnCache = await caches.open(CDN_CACHE);
    const base = 'https://raw.githubusercontent.com/bitcoin/bips/master/bip-0039';
    const files = ['english.txt','french.txt','spanish.txt','russian.txt',
                   'chinese_simplified.txt','german.txt','italian.txt','hindi.txt','portuguese.txt'];
    for (const f of files) {
      const url = base + '/' + f;
      if (!(await cdnCache.match(url))) {
        try {
          const res = await fetch(url);
          if (res.ok) await cdnCache.put(url, res);
        } catch (e) {}
      }
    }
  } catch (e) {}
}

// FETCH — cache-first pour CDN, network-first pour local
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // CDN : cache-first permanent
  if (CDN_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) {
    event.respondWith(cacheFirst(request, CDN_CACHE));
    return;
  }

  // Local : network-first avec fallback cache (garantit la mise à jour)
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request, STATIC_CACHE));
    return;
  }
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    return new Response('offline', { status: 503 });
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const hit = await cache.match(req);
    if (hit) return hit;
    return new Response('offline', { status: 503 });
  }
}

// MESSAGES
self.addEventListener('message', (event) => {
  const { type } = event.data || {};
  if (type === 'SKIP_WAITING') self.skipWaiting();
  if (type === 'PURGE_CACHE') {
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      event.ports[0]?.postMessage({ purged: keys.length });
    })();
  }
});
