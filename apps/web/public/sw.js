/*
 * The service worker: what makes Symplist installable, and nothing more than that.
 *
 * It caches the build's own immutable assets and gets out of the way. It deliberately does NOT cache
 * API responses or the HTML of signed-in pages: task titles and documents are encrypted at rest on
 * the server precisely so they are not lying around, and writing rendered ones into the Cache API
 * puts them on the device's disk outside that guarantee — where the next person to pick up a shared
 * phone could be served them after a sign-out. Everything here is either hashed-and-public or not
 * stored at all.
 *
 * Hand-written rather than generated, because what a worker caches is a security decision and not a
 * plugin default, and because a 90-line file is one a reviewer can actually read.
 */

const VERSION = "symplist-v1";
const ASSETS = `${VERSION}-assets`;

/** Immutable, content-hashed, and public: safe to keep and cheap to serve. */
function isBuildAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/brand/") ||
    url.pathname.startsWith("/ai/") ||
    url.pathname === "/icon.svg" ||
    url.pathname === "/apple-icon.png"
  );
}

self.addEventListener("install", (event) => {
  // The new worker takes over at the next load rather than waiting for every tab to close.
  self.skipWaiting();
  event.waitUntil(caches.open(ASSETS));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // A release renames the cache, so the previous build's assets go rather than accumulate.
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => !name.startsWith(VERSION)).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Another origin's response is not ours to store.
  if (url.origin !== self.location.origin) return;
  // The api carries the person's content. Never cached, never intercepted.
  if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/oauth/")) return;

  if (!isBuildAsset(url)) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      // Only a clean response is worth keeping; an error page cached as an asset is a broken build
      // that survives the fix.
      if (response.ok && response.status === 200) {
        const cache = await caches.open(ASSETS);
        cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});

/*
 * Signing out empties the cache. Nothing user-specific is in it by design, but a device that has been
 * handed over should keep nothing from the session before it, and this costs one message.
 */
self.addEventListener("message", (event) => {
  if (event.data === "symplist:signed-out") {
    event.waitUntil(caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n)))));
  }
});
