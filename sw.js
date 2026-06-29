const CACHE_NAME = "wilde-wegwijzer-pwa-20260629-stateful-1";

const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/admin.html",
  "/manifest.webmanifest",
  "/styles.css?v=stateful-20260629",
  "/app.js?v=stateful-20260629",
  "/admin.js?v=stateful-20260629",
  "/vendor/leaflet/leaflet.css?v=1.9.4",
  "/vendor/leaflet/leaflet.js?v=1.9.4",
  "/api/bootstrap",
  "/assets/map.webp?v=stateful-20260629",
  "/assets/map.png?v=stateful-20260629",
  "/icons/icon-180.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith("wilde-wegwijzer-pwa-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", copy));
          return response;
        })
        .catch(() => caches.match("/index.html").then((response) => response || caches.match("/")))
    );
    return;
  }

  if (url.pathname === "/api/bootstrap") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request)
      .then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      })
  );
});
