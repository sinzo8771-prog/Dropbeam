import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { assertNetworkIsDown, loadWithCache } from "../helpers/offline";

/**
 * Real-browser pairing and transfer (PRD 5.1, 8.4, 9.3, 9.5, 12).
 *
 * Two separate browser contexts stand in for two devices: they pair
 * through the production build over loopback WebRTC — real offer and
 * answer codes, real DTLS, real data channel — then move a file and a
 * note. This is the automated half of the manual device matrix in
 * docs/INTEROP.md: the same code path a laptop and a phone take, minus
 * the second piece of hardware.
 *
 * Nothing here stubs the transport. The only setup is seeding the
 * clipboard, because a pasted code is the pairing route under test — and
 * the clipboard is the one thing that differs by engine, so it is the one
 * place below that asks which engine is running (see `seedClipboard`).
 *
 * The suite is engine-agnostic above that line, and the nightly runs it on
 * Chromium and Firefox both, which is why the describe names the route rather
 * than the engine: the project in the report says which browser it was.
 */

/** The stub's backing store, read by the stubbed clipboard (see below). */
type PasteSeed = { __pasteCode?: string };

/**
 * Seed the paste route's clipboard, per engine.
 *
 * Chromium can be granted the real clipboard and this spec uses it: the host
 * pastes the reply through the OS clipboard, and reading it back is part of what
 * is exercised. Firefox cannot — Playwright answers `Unknown permission:
 * clipboard-read` — so there the clipboard API is replaced with a
 * seed-the-code stub, the same trick `scripts/interop-matrix.mjs` uses when it
 * pairs two engines. Either way the app calls `navigator.clipboard` and the
 * paste button runs the same code; what differs is which platform
 * implementation answers it, which is the layer this suite cannot move.
 */
async function seedClipboard(engine: string, ...contexts: BrowserContext[]): Promise<void> {
  for (const context of contexts) {
    if (engine === "chromium") {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      continue;
    }
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          readText: async () => (window as unknown as PasteSeed).__pasteCode ?? "",
          writeText: async (text: string) => {
            (window as unknown as PasteSeed).__pasteCode = text;
          },
        },
      });
    });
  }
}

/** Put `text` where the next paste in that page will read it. */
async function copyForPaste(engine: string, page: Page, text: string): Promise<void> {
  if (engine === "chromium") {
    await page.evaluate((code) => navigator.clipboard.writeText(code), text);
    return;
  }
  await page.evaluate((code) => {
    (window as unknown as PasteSeed).__pasteCode = code;
  }, text);
}

/** Every page error and console error either page produces. */
function collectErrors(...pages: Page[]): string[] {
  const errors: string[] = [];
  for (const page of pages) {
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
  }
  return errors;
}

/** Start hosting and return the offer code as one unbroken string. */
async function startHosting(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("code-text")).toBeVisible({ timeout: 60_000 });
  const grouped = (await page.getByTestId("code-text").textContent()) ?? "";
  return grouped.replace(/\s+/g, "");
}

/** Read the answer code the guest shows. */
async function answerCodeOf(page: Page): Promise<string> {
  await expect(page.getByTestId("code-text")).toBeVisible({ timeout: 60_000 });
  const grouped = (await page.getByTestId("code-text").textContent()) ?? "";
  return grouped.replace(/\s+/g, "");
}

async function waitForConnected(page: Page): Promise<void> {
  await expect(page.locator("main")).toHaveAttribute("data-screen", "CONNECTED", {
    timeout: 60_000,
  });
}

/** The three verification words, as shown on the connected screen (PRD 9.3). */
async function verificationWords(page: Page): Promise<string> {
  await expect(page.locator(".verify-card-words")).toBeVisible({ timeout: 30_000 });
  return ((await page.locator(".verify-card-words").textContent()) ?? "").trim();
}

test.describe("pairing and transfer (INTEROP: one engine, two contexts, paste route)", () => {
  test("pairs two browsers, matches words, and exchanges a file and a note", async ({
    browser,
    browserName,
  }) => {
    test.setTimeout(180_000);

    const hostContext: BrowserContext = await browser.newContext();
    const guestContext: BrowserContext = await browser.newContext();
    // The paste route reads the code back from the clipboard.
    await seedClipboard(browserName, hostContext, guestContext);
    // The guest saves the way Firefox and Safari do (PRD 8.5): with File
    // System Access removed it stages into OPFS instead of opening a native
    // save picker, which a headless browser can never complete.
    await guestContext.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
    });

    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const errors = collectErrors(host, guest);

    try {
      await host.goto("/");
      const offer = await startHosting(host);
      await expect(host.getByText(/This code expires in (10:00|9:5\d)/)).toBeVisible();

      // The guest arrives on the shared link as its first load — exactly how
      // a second device opens it (and what the SW serves from cache offline).
      await guest.goto(`/#j=${offer}`);
      const answer = await answerCodeOf(guest);

      // The host pastes the reply through the clipboard.
      await copyForPaste(browserName, host, answer);
      await host.getByRole("button", { name: "Paste reply" }).click();

      await waitForConnected(host);
      await waitForConnected(guest);

      // PRD 9.3: both sides must derive the same three words from the
      // fingerprints. Different words would mean a man in the middle.
      const hostWords = await verificationWords(host);
      const guestWords = await verificationWords(guest);
      expect(hostWords.split(/\s+/)).toHaveLength(3);
      expect(guestWords).toBe(hostWords);

      // PRD 9.5: the host allows the peer before anything may move.
      await host.getByRole("button", { name: "Allow" }).click();
      await expect(host.locator(".screen-connected")).toHaveAttribute("data-approval", "allowed");

      // The host sends a file; the guest is asked, then receives it.
      const payload = Buffer.from("dropbeam e2e payload\n".repeat(64));
      await host.getByTestId("file-input").setInputFiles({
        name: "e2e-note.txt",
        mimeType: "text/plain",
        buffer: payload,
      });
      await guest.getByRole("button", { name: "Accept" }).click();
      await expect(guest.getByTestId("saved-row")).toBeVisible({ timeout: 60_000 });
      await expect(guest.getByTestId("saved-row")).toContainText("e2e-note.txt");

      // FR-12: a note travels the other way.
      const note = "hello from the other browser";
      await guest.locator("#note-body").fill(note);
      // The note's own Send button, not the "Send back" on a saved file: a role
    // name matches a substring unless it is asked to match exactly.
    await guest.getByRole("button", { name: "Send", exact: true }).click();
      await expect(host.getByTestId("note-row")).toContainText(note, { timeout: 30_000 });

      // A clean session must not have logged a single error on either device.
      expect(errors).toEqual([]);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test("two devices with no server still exchange pairing codes (DoD 6)", async ({
    browser,
    browserName,
  }) => {
    /*
     * DoD 6: "airplane mode + hotspot still pairs".
     *
     * This proves the half of that which is about the *app*: with the origin
     * unreachable on both devices, the offer is still produced, the shared link
     * still parses and consumes it, the reply is still produced, and both sides
     * still agree. Every one of those steps is code that could quietly have
     * reached for the network, and none of them does.
     *
     * What it deliberately does NOT prove is that the transfer completes, and
     * that limit is worth stating plainly rather than hiding behind a test that
     * looks complete. Playwright's `setOffline` cuts the whole network stack,
     * WebRTC included, so the peer connection dies with it — but DoD 6's case
     * is the opposite one, where the internet is gone and the *local link to
     * the other device is not*. Emulating that needs a second network the peer
     * can still reach, which one machine running two browser contexts does not
     * have. So the data-channel half stays a row in the manual matrix in
     * docs/INTEROP.md, with a phone on the other end.
     *
     * It was worth writing the failing version first to find that out: with both
     * contexts offline the pairing reaches `WAITING_FOR_REPLY` and then `FAILED`,
     * which is the emulated network refusing ICE rather than the app refusing
     * anything.
     */
    test.setTimeout(180_000);

    const hostContext: BrowserContext = await browser.newContext();
    const guestContext: BrowserContext = await browser.newContext();
    await seedClipboard(browserName, hostContext, guestContext);

    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    // Collected after the network-down probes below: those requests are meant to
    // fail, and the browser logs every failed request, so listening from here
    // keeps this assertion about the app rather than about the test's sabotage.
    let errors: string[];

    try {
      // One online visit each, so the worker has cached the app they will then
      // run from — the same "after first load" the DoD item is about.
      await loadWithCache(host);
      await loadWithCache(guest);

      await hostContext.setOffline(true);
      await guestContext.setOffline(true);

      // Both pages reload out of the cache, with nothing listening on the origin.
      await host.reload();
      await guest.reload();
      await assertNetworkIsDown(host);
      await assertNetworkIsDown(guest);
      errors = collectErrors(host, guest);

      // The offer is produced by the cached app with no reachable server.
      const offer = await startHosting(host);
      expect(offer.length).toBeGreaterThan(0);
      await expect(host.getByText(/This code expires in (10:00|9:5\d)/)).toBeVisible();

      // The guest opens the shared link. That navigation is answered from the
      // cache too, and the offer still has to be read out of the URL — the route
      // consumes it before any screen renders.
      await guest.goto(`/#j=${offer}`);
      const answer = await answerCodeOf(guest);
      expect(answer.length).toBeGreaterThan(0);
      expect(answer).not.toBe(offer);

      // The host accepts the reply, so both sides commit to the same session
      // with nothing having come from the network.
      await copyForPaste(browserName, host, answer);
      await host.getByRole("button", { name: "Paste reply" }).click();
      await expect(host.locator("main")).not.toHaveAttribute("data-screen", "FAILED", {
        timeout: 60_000,
      });

      // Codes exchanged offline, still no errors.
      expect(errors).toEqual([]);
    } finally {
      await hostContext.setOffline(false);
      await guestContext.setOffline(false);
      await hostContext.close();
      await guestContext.close();
    }
  });

  test("the guest sees the connection drop when the host disappears (PRD 12)", async ({
    browser,
    browserName,
  }) => {
    test.setTimeout(180_000);

    const hostContext: BrowserContext = await browser.newContext();
    const guestContext: BrowserContext = await browser.newContext();
    await seedClipboard(browserName, hostContext, guestContext);

    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    try {
      await host.goto("/");
      const offer = await startHosting(host);
      await guest.goto(`/#j=${offer}`);
      const answer = await answerCodeOf(guest);
      await copyForPaste(browserName, host, answer);
      await host.getByRole("button", { name: "Paste reply" }).click();
      await waitForConnected(guest);

      // The host's device goes away: the guest must fall back to the
      // PEER_LOST reason code rather than sitting on a dead screen.
      //
      // The bound is the app's own contract plus room for the engine to notice:
      // PRD 12 declares PEER_LOST after 15 s of silence, doubled to 30 s while
      // the browser still reports the connection as only `disconnected`. That
      // doubling lands exactly on the 30 s this used to wait for, and Firefox
      // sits in `disconnected` longer than Chromium does, so the wait is 45 s —
      // still far short of the dead screen this test is actually about.
      await hostContext.close();
      await expect(guest.getByRole("alert")).toContainText("Connection lost.", {
        timeout: 45_000,
      });
    } finally {
      await guestContext.close();
    }
  });
});
