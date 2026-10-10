/**
 * Dropbeam service worker (PRD FR-50).
 *
 * Plain JavaScript in `public/` so Vite copies it verbatim into `dist/`
 * — a service worker must be a same-origin, non-module script at a
 * stable URL. `scripts/postbuild.mjs` stamps the cache name after
 * every build, which rolls the cache: a new deploy gets a fresh cache
 * and the activate step deletes every older one.
 *
 * Strategy (PRD 6.5): static assets are served cache-first so the app
 * works offline once loaded; navigations go network-first so a fresh
 * deploy is picked up on the next visit, with the cached shell as the
 * offline answer.
 */
"use strict";

const CACHE = "dropbeam-" + "__BUILD_ID__";
/** FR-51 staging cache: survives deploys (activate spares it). */
const SHARE_CACHE = "dropbeam-share";
/** The app shell. Hashed assets (JS/CSS) are cached on first visit. */
const SHELL = ["./"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  // Take over immediately: the update flow below is what tells an
  // already-open page to reload, so waiting would only delay it.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name !== CACHE && name !== SHARE_CACHE)
          .map((name) => caches.delete(name)),
      );
      // Clients controlled by the *previous* worker — captured before
      // claim() — are tabs running an old build. On a first-ever
      // install nothing is controlled yet, so nobody is told to reload.
      const stale = await self.clients.matchAll({ type: "window" });
      await self.clients.claim();
      for (const client of stale) {
        client.postMessage({ type: "dropbeam.updated" });
      }
    })(),
  );
});

/** FR-51: stage share-target files locally, land on #shared. */
async function stageSharedFiles(request, pageUrl) {
  try {
    const form = await request.formData();
    const files = form.getAll("files").filter((file) => file && typeof file.name === "string");
    const cache = await caches.open(SHARE_CACHE);
    // Replace previous staging so the index matches this share.
    const old = await cache.keys();
    await Promise.all(old.map((entry) => cache.delete(entry)));
    const index = [];
    for (let i = 0; i < files.length; i++) {
      index.push({ i, name: files[i].name, type: files[i].type });
      await cache.put(new Request("./__share/" + i), new Response(files[i]));
    }
    await cache.put(
      new Request("./__share/index"),
      new Response(JSON.stringify(index), { headers: { "content-type": "application/json" } }),
    );
  } catch (error) {
    // Best effort: land on the screen even if staging failed.
    console.warn("dropbeam: share staging failed", error);
  }
  return Response.redirect(new URL("./#shared", pageUrl).href, 303);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.method === "POST" && url.pathname.endsWith("/share")) {
    event.respondWith(stageSharedFiles(request, url.href));
    return;
  }
  if (request.method !== "GET") return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put("./", copy));
          return response;
        })
        .catch(() => caches.match("./")),
    );
    return;
  }

  // Cache-first for everything else (script, style, font, icon…).
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (!response || response.status !== 200) return response;
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return response;
      });
    }),
  );
});
