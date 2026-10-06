// sw.js — Service Worker : serveur local PWA offline-first
const VERSION = 'hunter-v5';
const STATIC_CACHE = VERSION + '-static';
const CDN_CACHE = VERSION + '-cdn';
const RUNTIME_CACHE = VERSION + '-runtime';

const PRECACHE_ASSETS = [
  './', './index.html', './manifest.webmanifest', './style.css',
  './app.js', './worker.js', './bip39-fr.js', './server.js',
  './storage.js', './crypto-export.js', './simulation.js', './networks.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'
];

const CDN_PRECACHE = [
  'https://esm.sh/@scure/bip39@1.5.0',
  'https://esm.sh/@scure/bip39@1.5.0/wordlists/english.js',
  'https://esm.sh/@scure/bip32@1.6.0',
  'https://esm.sh/@noble/hashes@1.7.0/sha256.js',
  'https://esm.sh/@noble/hashes@1.7.0/ripemd160.js',
  'https://esm.sh/@noble/hashes@1.7.0/argon2.js',
  'https://esm.sh/@noble/hashes@1.7.0/utils.js',
  'https://esm.sh/@scure/base@1.2.0'
];

const CDN_HOSTS = ['esm.sh', 'raw.githubusercontent.com', 'cdn.jsdelivr.net', 'unpkg.com'];

const BIP39_BASE = 'https://raw.githubusercontent.com/bitcoin/bips/master/bip-0039';
const BIP39_FILES = [
  'english.txt', 'french.txt', 'spanish.txt', 'russian.txt',
  'chinese_simplified.txt', 'german.txt', 'italian.txt', 'hindi.txt', 'portuguese.txt'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // Phase 1 : précacher les assets locaux (indispensable, rapide)
    const staticCache = await caches.open(STATIC_CACHE);
    await staticCache.addAll(PRECACHE_ASSETS).catch(e => 
      console.warn('[SW] precache local partiel', e));

    // Activer immédiatement — le SW devient utilisable sans attendre le CDN
    await self.skipWaiting();

    // Phase 2 : précacher CDN + wordlists en arrière-plan (non bloquant)
    (async () => {
      const cdnCache = await caches.open(CDN_CACHE);
      
      // CDN libs — parallélisé
      await Promise.allSettled(CDN_PRECACHE.map(async (url) => {
        try {
          const res = await fetch(url, { mode: 'cors' });
          if (res.ok) await cdnCache.put(url, res.clone());
        } catch {}
      }));

      // Wordlists — parallélisé
      await Promise.allSettled(BIP39_FILES.map(async (file) => {
        const url = BIP39_BASE + '/' + file;
        try {
          const res = await fetch(url);
          if (res.ok) await cdnCache.put(url, res.clone());
        } catch {}
      }));

      console.log('[SW] Précache CDN + wordlists terminé');
    })().catch(e => console.warn('[SW] Précache arrière-plan', e));
  })());
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.postMessage({ type: 'server-ready', version: VERSION }));
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (CDN_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) {
    event.respondWith(cacheFirst(request, CDN_CACHE));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }
  event.respondWith(networkWithCacheFallback(request, RUNTIME_CACHE));
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    return new Response('Ressource indisponible hors ligne', { status: 503 });
  }
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    const fallback = await cache.match('./index.html');
    if (fallback) return fallback;
    return new Response('App hors ligne', { status: 503 });
  }
}

async function networkWithCacheFallback(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw new Error('Ressource inaccessible');
  }
}

self.addEventListener('message', (event) => {
  const { type } = event.data || {};
  if (type === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (type === 'CACHE_STATUS') {
    (async () => {
      const keys = await caches.keys();
      const stats = {};
      for (const k of keys) {
        const c = await caches.open(k);
        const entries = await c.keys();
        stats[k] = entries.length;
      }
      event.ports[0]?.postMessage({ version: VERSION, caches: stats, ready: true });
    })();
    return;
  }
  if (type === 'PURGE_CACHE') {
    (async () => {
      const keys = await caches.keys();
      const purged = keys.filter(k => k.startsWith(VERSION));
      await Promise.all(purged.map(k => caches.delete(k)));
      event.ports[0]?.postMessage({ purged: purged.length });
    })();
  }
});
