/**
 * READ FLUENT — SERVICE WORKER (PWA)
 * Ultra-Fast Local Asset Caching & Offline App Shell
 */

const CACHE_NAME = 'readfluent-cache-v1';
const STATIC_ASSETS = [
  './',
  './index.html',
  './login.html',
  './style.css',
  './app.js',
  './api-client.js',
  './config.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // NEVER cache API proxy routes or Supabase auth/data endpoints
  if (url.pathname.startsWith('/api/') || url.hostname.includes('supabase.co')) {
    return; // Pass through to standard network
  }

  // Stale-While-Revalidate for app assets
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (
          networkResponse &&
          networkResponse.status === 200 &&
          event.request.method === 'GET'
        ) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Fallback for document navigation
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html') || caches.match('./login.html');
        }
      });

      return cachedResponse || fetchPromise;
    })
  );
});

