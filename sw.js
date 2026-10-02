/**
 * Keeps pet icons in the browser after the first load.
 *
 * GitHub Pages sends every file with "max-age=600", so without this each icon is
 * re-requested (or at least revalidated) ten minutes after it was first seen, and a
 * grid of a few hundred tiles pays that again and again. Icons are named by their
 * Roblox asset id and never change under the same name, so they can be served from
 * the cache indefinitely. Everything else is left alone and goes to the network as
 * usual.
 *
 * Bump CACHE if the icons are ever re-encoded under their existing names.
 */

const CACHE = "rcu-icons-v1";
const ICON_PATH = "/assets/pets/";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("rcu-icons-") && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.includes(ICON_PATH)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;

      const response = await fetch(request);
      // Only a complete, successful response is worth keeping.
      if (response.ok && response.status === 200) event.waitUntil(cache.put(request, response.clone()));
      return response;
    })(),
  );
});
