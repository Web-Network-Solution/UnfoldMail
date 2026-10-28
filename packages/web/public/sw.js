/**
 * UnfoldMail — Progressive Web App Service Worker
 *
 * Provides instant app startup, offline fallback, asset caching,
 * and reliable background lifecycle handling.
 */

const CACHE_NAME = 'unfoldmail-cache-v3';

function offlineResponse() {
  return new Response('You are offline. Reconnect and refresh to open UnfoldMail.', {
    status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function cacheResponse(event, request, response) {
  event.waitUntil(caches.open(CACHE_NAME)
    .then(cache => cache.put(request, response))
    .catch(err => console.warn('[SW] Cache write failed:', err)));
}

const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/logo.svg',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-180.png',
  '/icons/maskable-icon-512.png'
];

// Install: Pre-cache shell assets & activate immediately
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[SW] Pre-cache error:', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate: Clean up old caches & take control
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => {
            console.log('[SW] Deleting outdated cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Strategy routing
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. Never intercept API calls, WebSocket upgrades, or non-GET requests
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/api') ||
    event.request.headers.get('Upgrade') === 'websocket'
  ) {
    return;
  }

  // 2. Navigation requests (SPA page loads): Network-first with cache fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Every mail URL serves the same shell: keep one copy, under the key the
          // fallback reads, and never let a navigated non-HTML file replace it.
          if (response && response.status === 200 && (response.headers.get('content-type') || '').includes('text/html')) {
            cacheResponse(event, '/index.html', response.clone());
          }
          return response;
        })
        .catch(async () => {
          // Offline fallback to cached index.html
          try { return (await caches.match('/index.html')) || (await caches.match('/')) || offlineResponse(); }
          catch { return offlineResponse(); }
        })
    );
    return;
  }

  // 3. Static assets (JS, CSS, Images, Fonts): Stale-While-Revalidate
  event.respondWith(
    caches.match(event.request).catch(() => undefined).then((cachedResponse) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            cacheResponse(event, event.request, responseClone);
          }
          return networkResponse;
        })
        .catch(() => {
          return offlineResponse();
        });

      event.waitUntil(fetchPromise);
      return cachedResponse || fetchPromise;
    })
  );
});
