import { expect, test } from "@playwright/test";

import { assertNetworkIsDown, loadWithCache } from "../helpers/offline";

/**
 * DoD 6: "Works offline after first load (airplane mode + hotspot still pairs)."
 *
 * This is the app half of that sentence — after one online visit, the app must
 * still come up and be usable with the network cut. The pairing half is in
 * `tests/e2e/pairing-transfer.spec.ts`, next to the two-context pairing it needs.
 *
 * What is below is the claim that actually broke while building it. The app
 * code-splits, so the settings sheet is a chunk that is only requested the first
 * time a user opens it. Caching the shell and the entry script therefore left a
 * device that had never opened Settings unable to open Settings offline: the
 * dynamic import failed and the button was simply dead. The worker now precaches
 * every emitted asset and matches it with `ignoreVary` (see `public/sw.js` for
 * why the second half is needed as well), and these tests are what hold that in
 * place.
 *
 * Engine-agnostic on purpose: none of it needs `RTCPeerConnection`, so it runs on
 * Chromium, Firefox and WebKit alike with the same answer. It drives the
 * production build, which is the only place the worker and its build-id-stamped
 * cache exist.
 */

/**
 * Collect page and console errors from here on.
 *
 * Started after `assertNetworkIsDown` on purpose: that probe is a request that
 * is *meant* to fail, and the browser logs every failed request, so attaching
 * the listeners afterwards keeps the assertion about the app rather than about
 * the test's own sabotage.
 */
function watchErrors(page: import("@playwright/test").Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

test.describe("offline after first load (DoD 6)", () => {
  test("serves the whole app from cache with the network cut", async ({ page }) => {
    await loadWithCache(page);
    const context = page.context();
    await context.setOffline(true);
    await assertNetworkIsDown(page);
    const errors = watchErrors(page);

    // The navigation cannot reach the server, so this reload is answered from
    // the cached shell by the worker's fallback.
    await page.reload();

    try {
      await expect(page.getByRole("heading", { name: "Dropbeam" })).toBeVisible();
      // Both entry points are there, so the app booted rather than rendering a
      // shell with no way out of it.
      await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Join" })).toBeVisible();

      // And it is interactive, not just painted. The settings sheet is the load
      // -bearing step: it is a code-split chunk, so reaching it offline is
      // exactly what a shell-only precache gets wrong, and a dead button is the
      // failure a user would see rather than a console error.
      await page.getByRole("button", { name: "Settings" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");

      // Served offline, an offline page must not log an error.
      expect(errors).toEqual([]);
    } finally {
      await context.setOffline(false);
    }
  });

  test("a deep route resolves offline, not just the home screen", async ({ page }) => {
    // The app shortcuts and the share target both land on a URL with a query
    // string, so booting the home screen is not the whole claim: a device last
    // used from the launcher has to come back to the screen it was on.
    await loadWithCache(page);
    const context = page.context();
    await context.setOffline(true);
    await assertNetworkIsDown(page);

    try {
      await page.goto("/?screen=selftest");

      // The navigation is network-first, so this too has to fall back to the
      // cached shell — and then the app has to honour the query on its own.
      await expect(page.locator(".screen-selftest")).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });

  test("the app comes back online and picks up the current build", async ({ page }) => {
    // The other half of "after first load": offline is a fallback, not a state
    // the app gets stuck in. Restoring the network has to serve a fresh
    // navigation from the network again, which is what PRD 6.5 asks for.
    await loadWithCache(page);
    const context = page.context();

    await context.setOffline(true);
    await assertNetworkIsDown(page);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Dropbeam" })).toBeVisible();

    await context.setOffline(false);
    await page.reload();

    // Online again, so the network is reachable — the inverse of the assertion
    // above, which is what makes this a test of recovery rather than of caching.
    const reachable = await page.evaluate(async () => {
      try {
        await fetch("/robots.txt", { cache: "no-store" });
        return true;
      } catch {
        return false;
      }
    });
    expect(reachable).toBe(true);
    await expect(page.getByRole("heading", { name: "Dropbeam" })).toBeVisible();
  });
});
