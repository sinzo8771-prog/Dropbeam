import { expect, test, type Page } from "@playwright/test";

/**
 * The browser that cannot do direct transfers (PRD 7.1, FR-62, 8.5).
 *
 * Playwright's WebKit build ships without `RTCPeerConnection`, so on that engine
 * this suite runs against the genuine absence of the API: the exact messaging a
 * real user sees in a browser that cannot transfer, with nothing stubbed. On
 * Chromium and Firefox the same API is removed by an init script, so the app's
 * degradation wiring is also exercised on the pull-request legs, where WebKit is
 * not run at all.
 *
 * What is asserted here is every place a missing capability has to surface: both
 * home-screen entry points ("Start" and "Join") and the shared `#j=` link route,
 * which consumes an offer before any screen renders. The Join path is not
 * hypothetical — it used to answer with a *network* failure in exactly this
 * browser, and a unit test pins the fix — so the e2e suite guards the same
 * regression through the real UI.
 *
 * What no engine here can do is pair, so the pairing spec is excluded from the
 * WebKit project rather than skipped inside a spec: a skip would hide the fact
 * that this engine collects a different suite, and that difference is exactly
 * what keeps the WebKit leg off the gate (see playwright.config.ts).
 */

/**
 * Remove the API the app feature-detects on, before any app code runs.
 *
 * On WebKit it is already absent, so this only defines it as `undefined` — which
 * is not a function either way. That keeps the spec one code path on every
 * engine rather than an engine branch, and the assertions below describe the
 * same behaviour whether the absence is real or injected.
 */
async function withoutWebRtc(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "RTCPeerConnection", { value: undefined, configurable: true });
  });
}

/**
 * A code the app's own link parser accepts (`DB1.` prefix, within the length
 * cap), so `#j=` reaches the support check instead of being discarded as an
 * unrelated fragment. It never reaches a codec: the guard fires first.
 */
const OFFER_LIKE = "DB1.degradation-probe";

test.describe("a browser without WebRTC (PRD 7.1)", () => {
  test("Start says this browser can't do direct transfers", async ({ page }) => {
    await withoutWebRtc(page);
    await page.goto("/");

    await page.getByRole("button", { name: "Start" }).click();

    await expect(page.getByRole("alert")).toContainText("This browser can't do direct transfers.");
    // The run stopped at the guard: no offer code, so no expiry countdown and
    // no waiting-for-reply screen to sit on.
    await expect(page.getByTestId("code-text")).toBeHidden();
  });

  test("Join says the same, rather than failing later as a network error", async ({ page }) => {
    await withoutWebRtc(page);
    await page.goto("/");

    await page.getByRole("button", { name: "Join" }).click();

    await expect(page.getByRole("alert")).toContainText("This browser can't do direct transfers.");
    await expect(page.getByTestId("code-text")).toBeHidden();
  });

  test("a shared #j= link says the same", async ({ page }) => {
    // The link route answers the offer before the home screen can render, so
    // its guard is separate from the Join button's.
    await withoutWebRtc(page);
    await page.goto(`/#j=${OFFER_LIKE}`);

    await expect(page.getByRole("alert")).toContainText("This browser can't do direct transfers.");
  });

  test("the connection self-test reports the missing capability (FR-62)", async ({ page }) => {
    await withoutWebRtc(page);
    await page.goto("/?screen=selftest");

    // The screen runs the test on open; a browser without WebRTC fails at the
    // first stage, with the PRD 7.1 wording and a way out.
    const screen = page.locator(".screen-selftest");
    await expect(screen).toHaveAttribute("data-result", "fail");
    await expect(screen.locator(".selftest-status")).toContainText(
      "This browser doesn't support direct connections (WebRTC).",
    );
    await expect(page.getByRole("button", { name: "Troubleshooting" })).toBeVisible();
  });

  test("decides its save path from the capability this engine actually has (PRD 8.5)", async ({
    page,
  }) => {
    /*
     * The receiver picks its sink by feature detection, and only ever while a
     * file is arriving — which needs a peer, which this engine cannot have. What
     * can be pinned without one is the *input* to that decision: the same
     * expression `scripts/interop-matrix.mjs` reads out of its pairs, and the
     * same order `chooseSink()` applies (File System Access → OPFS → memory).
     *
     * On WebKit this is the PRD 8.5 Safari path, genuinely: no
     * `showSaveFilePicker`, but a storage directory, so it resolves to OPFS. If a
     * future WebKit build drops either half, this fails and the nightly says so,
     * because that would silently change which sink the app picks on that engine.
     *
     * What is deliberately NOT asserted here is that writing through that sink
     * succeeds: on this WebKit build `createWritable` throws (`UnknownError`)
     * even though `getDirectory` exists, so an assertion that the OPFS write
     * works would simply be false. The measured gap, and the detection that is
     * shallower than the capability, are recorded in docs/INTEROP.md instead —
     * asserting the browser's own bug here would turn a future WebKit fix into a
     * red build.
     */
    await withoutWebRtc(page);
    await page.goto("/");

    const detected = await page.evaluate(() => {
      const fsa =
        typeof (window as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function";
      const opfs = typeof navigator.storage?.getDirectory === "function";
      return fsa ? "fsa" : opfs ? "opfs" : "memory";
    });

    const engine = test.info().project.name;
    const expected: Record<string, string> = { chromium: "fsa", firefox: "opfs", webkit: "opfs" };
    // A fourth engine has to make its own decision here rather than inherit one.
    expect(Object.keys(expected), `add ${engine} to this table`).toContain(engine);
    expect(detected).toBe(expected[engine]);
  });

  test("the app still works as a normal page in that browser", async ({ page }) => {
    // Degrading is not the same as being broken: everything that does not need a
    // peer has to stay usable, which is what makes the messaging above the only
    // thing the user loses.
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });

    await withoutWebRtc(page);
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Dropbeam" })).toBeVisible();
    // The settings sheet (FR-41) is peer-free, and on this engine it is the only
    // interactive surface left.
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // A failed capability must not be reported as an app error.
    expect(errors).toEqual([]);
  });
});
