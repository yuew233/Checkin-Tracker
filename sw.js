// sw.js — offline support for the clock-in PWA.
//
// Install precaches the app shell (same-origin files only); every same-origin
// GET is then served from the cache and refreshed in the background
// (stale-while-revalidate). No external requests are made.
//
// Bump CACHE_NAME on every release that changes shipped files.

const CACHE_NAME = "clock-in-v8";

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./assets/icons/icon.svg",
  "./src/styles/base.css",
  "./src/styles/app.css",
  "./src/styles/components.css",
  "./src/js/domain.js",
  "./src/js/state.js",
  "./src/js/i18n.js",
  "./src/js/ui.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(staleWhileRevalidate(event, request));
});

async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(CACHE_NAME);
  // Every navigation is the single-page app shell.
  const key = request.mode === "navigate" ? "./index.html" : request;
  const cached = await cache.match(key, { ignoreSearch: request.mode === "navigate" });
  const network = fetch(request.url, { cache: "no-cache" })
    .then((response) => {
      if (response.ok && response.type === "basic") cache.put(key, response.clone());
      return response;
    })
    .catch(() => null);
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  return (await network) ?? new Response("Offline", { status: 503, statusText: "Offline" });
}
