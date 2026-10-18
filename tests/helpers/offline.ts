import { expect, type BrowserContext, type Page } from "@playwright/test";

/**
 * DoD 6: "Works offline after first load (airplane mode + hotspot still pairs)."
 *
 * The service worker is what makes that true (PRD 6.5): it precaches the app
 * shell, serves every other same-origin GET cache-first, and answers a
 * navigation with the cached shell when the network is gone. Two details of that
 * strategy decide how a test has to load the page, and both are easy to get
 * wrong:
 *
 * 1. **A single load is not enough.** On the very first visit the page's own
 *    script and stylesheet are requested *before* the worker installs and calls
 *    `claim()`, so they never pass through its fetch handler and never reach the
 *    cache. Only the shell does, via `addAll` on install. Reloading once the
 *    worker controls the page is what puts the hashed assets in there.
 * 2. **`skipWaiting()` + `claim()` mean the page is controlled without a second
 *    load in some engines**, so waiting on `ready` alone is not proof that the
 *    worker is driving requests. The assertions below wait on `controller`.
 *
 * So `loadWithCache` loads, waits for control, reloads, and then refuses to
 * return until every script and stylesheet the document references is actually
 * in a cache. That last wait is what keeps the offline tests honest: without it
 * they would fail on a genuinely offline-capable app for the boring reason that
 * the test never gave the worker a chance to see the assets.
 */

/**
 * Load the app and leave its shell *and* its hashed assets in the worker's
 * cache, so a later `setOffline(true)` reload has everything it needs.
 */
export async function loadWithCache(page: Page): Promise<void> {
  await page.goto("/");

  // Installed and activated…
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // …and actually driving this page's requests.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  // Second load: now the assets are fetched through the worker's cache-first
  // handler and written into the cache on the way past.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Dropbeam" })).toBeVisible();

  // A script loads from `src` and a stylesheet from `href`, and
  // `HTMLScriptElement` has no `href` at all, so the two are narrowed rather
  // than read through one union-typed property.
  await page.waitForFunction(async () => {
    const urls = Array.from(
      document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>(
        "script[src], link[rel='stylesheet']",
      ),
    ).map((el) => (el instanceof HTMLScriptElement ? el.src : (el as HTMLLinkElement).href));
    // A document with no script or stylesheet would make this vacuously true.
    if (urls.length === 0) return false;
    const hits = await Promise.all(urls.map((url) => caches.match(url)));
    return hits.every(Boolean);
  });
}

/**
 * Assert the network really is down, so an offline test cannot pass by
 * accident. Nothing under `/__uncached-…` is ever precached, so the only way to
 * fail to fetch it is for the request to genuinely not reach a server.
 */
export async function assertNetworkIsDown(page: Page): Promise<void> {
  const failed = await page.evaluate(async () => {
    try {
      await fetch(`/__uncached-${Math.random()}`, { cache: "no-store" });
      return false;
    } catch {
      return true;
    }
  });
  expect(failed, "the page could still reach the server, so this run would prove nothing").toBe(
    true,
  );
}

/** Turn the network off for a context and put it back afterwards. */
export async function withNetworkDown<T>(
  context: BrowserContext,
  body: () => Promise<T>,
): Promise<T> {
  await context.setOffline(true);
  try {
    return await body();
  } finally {
    await context.setOffline(false);
  }
}
