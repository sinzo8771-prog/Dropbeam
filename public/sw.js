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
/** Sentinel staging index entry for a shared text/URL ("clipboard sync"). */
const TEXT_ENTRY = "text";
/**
 * Everything that must be in the cache before the app can be called offline.
 *
 * The shell alone is not enough, and that is not a theoretical worry: the app
 * code-splits, and the settings sheet, the repair paths and the hashing worker
 * are separate chunks that are only requested the first time a user reaches
 * them. Precaching the shell and the entry script therefore still leaves a
 * device that has never opened Settings unable to open Settings offline — the
 * dynamic import fails and the user gets a dead button with no network to
 * explain it. DoD 6 says the app works offline after first load, so every
 * emitted asset belongs here.
 *
 * `scripts/postbuild.mjs` rewrites this line after every build with the full
 * hashed list, because those names do not exist until Vite has hashed them.
 */
const SHELL = ["./", "__PRECACHE__"];

/**
 * Put every asset in the cache, resiliently.
 *
 * `addAll` rejects as a unit, so one missing file would fail the whole install
 * and leave the app with no offline copy at all — trading a broken deep link
 * for a broken app. The shell goes in first and alone, because it is what a
 * navigation falls back to; everything after it is best-effort, and a miss is
 * reported rather than swallowed.
 */
async function precache() {
  const cache = await caches.open(CACHE);
  await cache.addAll(["./"]);
  await Promise.all(
    SHELL.filter((url) => url !== "./").map((url) =>
      cache.add(url).catch((error) => {
        console.warn("dropbeam: precache missed", url, error);
      }),
    ),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache());
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

/** FR-51: stage share-target files locally, land on #shared. A text
    share lands in the same staging index as a sentinel entry, which the
    page reads back into the note field ("clipboard sync", roadmap). */
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
    const text = (form.get("text") || form.get("title") || "").toString().trim();
    if (text) {
      index.push({ i: TEXT_ENTRY, name: "text", type: "text/plain" });
      await cache.put(new Request("./__share/" + TEXT_ENTRY), new Response(text));
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

/**
 * Look this URL up in the precache, ignoring `Vary`.
 *
 * `Vary` is about representation negotiation for a server to vary *its* answer
 * on request headers — `Accept-Encoding`, `Origin`. It is not a statement about
 * whether two requests want the same file. A static asset on a same-origin path
 * is one file whatever headers the browser happened to attach, and several
 * common static servers and dev servers (`vite preview` sends `Vary: Origin`)
 * set the header anyway.
 *
 * Matching it strictly is what makes offline quietly fall apart: the precache is
 * written by this worker, whose own `cache.add` requests carry no `Origin`,
 * while a module script fetched by `import()` does, so the very chunks DoD 6
 * exists to serve fail to match the copy this worker stored — a 200 that becomes
 * a `net::ERR_FAILED` on a dead button, with nothing in the logs to explain it.
 */
function lookup(request) {
  return caches.match(request, { ignoreVary: true });
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
        .catch(() => lookup("./")),
    );
    return;
  }

  // Cache-first for everything else (script, style, font, icon…).
  event.respondWith(
    lookup(request).then((cached) => {
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
