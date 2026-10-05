import { expect, type Page, test } from "@playwright/test";

/**
 * FR-50 e2e: the debug panel is a hidden affordance with no
 * visible trigger — the only way in is eight taps inside the
 * right 52 px of the screen, each within 700 ms of the last.
 *
 * These specs drive the real gesture (real mouse events, real
 * timing) against the served production build, so the service
 * worker, its precache and the build id stamped into it are
 * all real — not the stubs the unit tests use.
 */

/** The gesture zone: the right 52 px of the viewport. */
const GESTURE_ZONE_PX = 52;

function viewportOf(page: Page): { width: number; height: number } {
  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error("no viewport set — configure one in playwright.config.ts");
  }
  return viewport;
}

/** A tap inside the gesture zone, 10 px from the right edge. */
function edgeTap(page: Page): Promise<void> {
  const { width, height } = viewportOf(page);
  return page.mouse.click(width - 10, height / 2);
}

/** A tap outside the gesture zone, left of the right 52 px. */
function offEdgeTap(page: Page): Promise<void> {
  const { width, height } = viewportOf(page);
  return page.mouse.click(width - GESTURE_ZONE_PX - 10, height / 2);
}

/** The row whose label is exactly `label`. */
function row(page: Page, label: string) {
  return page
    .locator(".debug-panel-row")
    .filter({ has: page.locator("dt.label", { hasText: new RegExp(`^${label}$`) }) });
}

test.describe("debug panel (FR-50)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // The panel reads the SW's precache for the build id and
    // navigator.serviceWorker.controller for SW health, so wait
    // until the worker has installed and claimed before
    // asserting on either.
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
  });

  test("reveals the panel after exactly eight right-edge taps", async ({ page }) => {
    const panel = page.locator(".debug-panel");

    // Seven taps must not leak the hidden affordance.
    for (let i = 0; i < 7; i++) await edgeTap(page);
    await expect(panel).toBeHidden();

    // The eighth tap opens it.
    await edgeTap(page);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("role", "region");
    await expect(panel).toHaveAttribute("aria-label", "Debug panel");
    await expect(page.locator(".debug-panel-title")).toHaveText("Debug panel");

    // The build id is the one stamped into the SW's cache name
    // at build time — read it back from the real cache registry.
    const cacheName = await page.evaluate(() =>
      caches.keys().then((names) => names.find((name) => name.startsWith("dropbeam-"))),
    );
    expect(cacheName, "the SW precache must exist").toBeTruthy();
    await expect(row(page, "Build id").locator(".value")).toHaveText(
      cacheName!.slice("dropbeam-".length),
    );

    // Live PWA health: the SW controls this page and its cache
    // holds the app shell.
    await expect(row(page, "Service worker").locator(".value")).toHaveText("controlled");
    await expect(row(page, "Service worker")).toHaveAttribute("data-health", "good");
    await expect(row(page, "Cache").locator(".value")).toHaveText("ok");
    await expect(row(page, "Cache")).toHaveAttribute("data-health", "good");

    // A fresh load has no active session.
    await expect(row(page, "Connection state").locator(".value")).toHaveText("IDLE");
    await expect(row(page, "Protocol").locator(".value")).toHaveText("—");
    await expect(row(page, "Channel").locator(".value")).toHaveText("none");
    await expect(row(page, "Channel")).toHaveAttribute("data-health", "warn");
    await expect(row(page, "Files in flight").locator(".value")).toHaveText("0");
    await expect(row(page, "Verified").locator(".value")).toHaveText("no");

    // The panel dismisses itself like any other surface.
    await page.getByRole("button", { name: "Close" }).click();
    await expect(panel).toBeHidden();
  });

  test("taps outside the gesture zone never reveal it", async ({ page }) => {
    const panel = page.locator(".debug-panel");

    for (let i = 0; i < 8; i++) await offEdgeTap(page);
    await expect(panel).toBeHidden();
  });

  test("taps spaced past the 700 ms window never reveal it", async ({ page }) => {
    // Deliberate real-time waiting: 7 gaps of 701 ms each.
    test.slow();
    const panel = page.locator(".debug-panel");

    // Eight taps — the exact count that opens the panel when
    // rapid — each spaced just past the 700 ms window, so the
    // counter must reset to 1 on every tap and never reach 8.
    // Unlike the fake-clock unit tests, this runs the window
    // against real timers in a live browser.
    for (let i = 0; i < 8; i++) {
      await edgeTap(page);
      if (i < 7) await page.waitForTimeout(701);
    }

    await expect(panel).toBeHidden();

    // The counter must have decayed to a fresh state, not
    // merely gone quiet: a rapid burst now has to open the
    // panel. If the listener were dead (or the counter
    // wedged past recovery), eight quick taps would do
    // nothing — so this distinguishes "reset" from "dead".
    for (let i = 0; i < 8; i++) await edgeTap(page);
    await expect(panel).toBeVisible();
  });
});
