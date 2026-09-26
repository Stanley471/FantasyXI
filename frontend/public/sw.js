/**
 * FantasyXI Progressive Web App (PWA) Service Worker
 *
 * - Precaches an offline fallback page and the squad page together with the
 *   JS/CSS chunks it needs, so "My Squad" opens with no connection even if it
 *   was never visited online.
 * - Pages: network first, falling back to the cached copy, then /offline.html.
 * - Build assets (/_next/static, content-hashed): cache first.
 * - Public API reads: network first with a cached fallback.
 * - Requests carrying an Authorization header are never cached: this cache is
 *   shared by everyone using the browser. The app keeps a per-user squad
 *   snapshot itself (see src/lib/offlineStore.ts).
 * - Non-GET requests (saving, transfers) always go to the network.
 */

const VERSION = "v2";
const SHELL_CACHE = `fantasyxi-shell-${VERSION}`;
const PAGE_CACHE = `fantasyxi-pages-${VERSION}`;
const ASSET_CACHE = `fantasyxi-assets-${VERSION}`;
const API_CACHE = `fantasyxi-api-${VERSION}`;
const CURRENT_CACHES = [SHELL_CACHE, PAGE_CACHE, ASSET_CACHE, API_CACHE];

const OFFLINE_URL = "/offline.html";

/** Required for the offline experience: installation fails without them. */
const SHELL_ASSETS = [
  OFFLINE_URL,
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-192.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon.png",
];

/** Pages warmed at install, with the build assets they reference. */
const OFFLINE_PAGES = ["/team", "/"];

/** Bounds on the runtime caches so storage cannot grow without limit. */
const MAX_PAGE_ENTRIES = 30;
const MAX_API_ENTRIES = 60;

const STATIC_ASSET_PATTERN = /\.(?:js|css|woff2?|png|jpg|jpeg|svg|ico|webp)$/i;

/** Extracts same-origin /_next/static URLs referenced by a page's HTML. */
function referencedAssets(html) {
  const urls = new Set();
  const pattern = /["'(](\/_next\/static\/[^"'()\s]+)["')]/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    urls.add(match[1]);
  }
  return [...urls];
}

/** Caches a page and every build asset it references. */
async function cachePageWithAssets(url) {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-cache" });
  if (!response.ok || response.type !== "basic") return;

  const html = await response.clone().text();
  await (await caches.open(PAGE_CACHE)).put(url, response);

  const assets = await caches.open(ASSET_CACHE);
  await Promise.allSettled(
    referencedAssets(html).map(async (asset) => {
      if (!(await assets.match(asset))) {
        await assets.add(asset);
      }
    })
  );
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - maxEntries)).map((key) => cache.delete(key)));
}

async function putInCache(cacheName, request, response, maxEntries) {
  const cache = await caches.open(cacheName);
  await cache.put(request, response);
  if (maxEntries) await trimCache(cacheName, maxEntries);
}

// Install: precache the offline shell, then warm the offline pages
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await (await caches.open(SHELL_CACHE)).addAll(SHELL_ASSETS);
      await Promise.allSettled(OFFLINE_PAGES.map(cachePageWithAssets));
      await self.skipWaiting();
    })()
  );
});

// Activate: clean up older cache versions and take control
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("fantasyxi-") && !CURRENT_CACHES.includes(key))
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

async function handleNavigation(request) {
  const url = new URL(request.url);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic") {
      // Keyed by path so a later offline visit finds it regardless of query string
      await putInCache(PAGE_CACHE, url.pathname, response.clone(), MAX_PAGE_ENTRIES);
    }
    return response;
  } catch {
    const cached =
      (await caches.match(url.pathname, { cacheName: PAGE_CACHE })) ||
      (await caches.match(request, { ignoreSearch: true }));
    return cached || (await caches.match(OFFLINE_URL));
  }
}

async function handleBuildAsset(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    await putInCache(ASSET_CACHE, request, response.clone());
  }
  return response;
}

async function handleStaticFile(request) {
  const cached = await caches.match(request);
  const refresh = fetch(request)
    .then(async (response) => {
      if (response.ok) await putInCache(ASSET_CACHE, request, response.clone());
      return response;
    })
    .catch(() => undefined);
  return cached || (await refresh) || Response.error();
}

function offlineApiResponse() {
  return new Response(
    JSON.stringify({
      success: false,
      offline: true,
      message: "You are currently offline.",
    }),
    { status: 503, headers: { "Content-Type": "application/json" } }
  );
}

async function handlePublicApi(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      await putInCache(API_CACHE, request, response.clone(), MAX_API_ENTRIES);
    }
    return response;
  } catch {
    return (await caches.match(request, { cacheName: API_CACHE })) || offlineApiResponse();
  }
}

async function handlePrivateApi(request) {
  try {
    return await fetch(request);
  } catch {
    return offlineApiResponse();
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Writes (saving the squad, transfers, payments) always require the network
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  // Next.js RSC payloads: let a failed soft navigation fall back to a full
  // page load, which is then served by handleNavigation
  if (request.headers.get("RSC") === "1" || url.searchParams.has("_rsc")) return;

  if (sameOrigin && url.pathname.startsWith("/_next/static/")) {
    event.respondWith(handleBuildAsset(request));
    return;
  }

  if (sameOrigin && STATIC_ASSET_PATTERN.test(url.pathname)) {
    event.respondWith(handleStaticFile(request));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    // Server-sent event streams cannot be cached or replayed
    if ((request.headers.get("Accept") || "").includes("text/event-stream")) return;

    event.respondWith(
      request.headers.has("Authorization") ? handlePrivateApi(request) : handlePublicApi(request)
    );
  }
});
