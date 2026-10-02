const CACHE_NAME = "planning-shell-v3";
const APP_SHELL = ["/", "/manifest.webmanifest"];

// No unconditional self.skipWaiting() here: on a first-ever install there's
// no existing controller so this new worker activates right away anyway: on
// an update, it deliberately waits so the already-open page can show an
// "update available" banner and let the user choose when to reload, instead
// of silently swapping the app shell under them mid-session.
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

// No self.clients.claim() here: it would let this worker take over any
// already-open tab mid-session, which raced with the very first login on a
// fresh page load (the browser briefly queues in-flight requests while a
// worker claims control) and made the login POST hang for ~20s. It isn't
// needed anyway — the update flow in index.html does a full page reload
// once the new worker activates, and that reload is a fresh navigation the
// now-active worker serves normally without needing to claim anything.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never touch the API or the live SSE stream: this app shows shared,
  // real-time scheduling data, so every such request must hit the network —
  // a cached response here could show stale or wrong planning data.
  if (url.pathname.startsWith("/api/")) return;
  if (req.method !== "GET") return;

  if (req.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html") {
    // Network-first for the app shell itself, so a deploy is picked up
    // immediately; the cache is only an offline fallback.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match("/")))
    );
    return;
  }

  // Static assets (vendored libs, icons): cache-first, network fallback.
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
        fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
    )
  );
});
