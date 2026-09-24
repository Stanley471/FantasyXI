/**
 * FantasyXI Progressive Web App (PWA) Service Worker
 *
 * Caches app shell, static assets, and user active team / gameweek data
 * for resilient offline viewing when internet connectivity drops.
 */

const CACHE_NAME = "fantasyxi-cache-v1";
const DATA_CACHE_NAME = "fantasyxi-data-v1";

const APP_SHELL = [
  "/",
  "/team",
  "/fixtures",
  "/players",
  "/leagues",
  "/manifest.json",
  "/favicon.ico",
];

// Install: pre-cache critical app shell routes
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch((err) => console.warn("[SW] App shell precache warning:", err))
  );
});

// Activate: clean up older cache versions and take control
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME && key !== DATA_CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Fetch: smart network-first for API with offline fallback, cache-first for static assets
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignore non-GET requests
  if (request.method !== "GET") {
    return;
  }

  // 1. API Calls (squads, gameweeks, fixtures, players): Network first, cache fallback
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(DATA_CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(async () => {
          const cachedResponse = await caches.match(request);
          if (cachedResponse) {
            return cachedResponse;
          }
          // Return offline JSON message if API is completely unavailable and not cached
          return new Response(
            JSON.stringify({
              success: false,
              offline: true,
              message: "You are currently offline. Displaying cached data.",
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 503,
            }
          );
        })
    );
    return;
  }

  // 2. Static Next.js assets (_next/static, images, fonts): Cache-first with stale-while-revalidate
  if (
    url.pathname.startsWith("/_next/static") ||
    url.pathname.endsWith(".svg") ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".ico")
  ) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  // 3. Navigation / HTML pages: Network first, fallback to cached HTML or /team
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const teamFallback = await caches.match("/team");
        if (teamFallback) return teamFallback;
        return caches.match("/");
      })
    );
    return;
  }

  // 4. Default fetch
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
