import { expect, test, type BrowserContext, type Page } from "@playwright/test";

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
 * clipboard, because a pasted code is the pairing route under test.
 */

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

test.describe("pairing and transfer (INTEROP: Chromium ↔ Chromium, paste route)", () => {
  test("pairs two browsers, matches words, and exchanges a file and a note", async ({
    browser,
  }) => {
    test.setTimeout(180_000);

    const hostContext: BrowserContext = await browser.newContext();
    const guestContext: BrowserContext = await browser.newContext();
    // The paste route reads the code back from the clipboard.
    await hostContext.grantPermissions(["clipboard-read", "clipboard-write"]);
    await guestContext.grantPermissions(["clipboard-read", "clipboard-write"]);
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

      // The host pastes the reply — the real clipboard path, not a stub.
      await host.evaluate((code) => navigator.clipboard.writeText(code), answer);
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
      await guest.getByRole("button", { name: "Send" }).click();
      await expect(host.getByTestId("note-row")).toContainText(note, { timeout: 30_000 });

      // A clean session must not have logged a single error on either device.
      expect(errors).toEqual([]);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test("the guest sees the connection drop when the host disappears (PRD 12)", async ({
    browser,
  }) => {
    test.setTimeout(180_000);

    const hostContext: BrowserContext = await browser.newContext();
    const guestContext: BrowserContext = await browser.newContext();
    await hostContext.grantPermissions(["clipboard-read", "clipboard-write"]);
    await guestContext.grantPermissions(["clipboard-read", "clipboard-write"]);

    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    try {
      await host.goto("/");
      const offer = await startHosting(host);
      await guest.goto(`/#j=${offer}`);
      const answer = await answerCodeOf(guest);
      await host.evaluate((code) => navigator.clipboard.writeText(code), answer);
      await host.getByRole("button", { name: "Paste reply" }).click();
      await waitForConnected(guest);

      // The host's device goes away: the guest must fall back to the
      // PEER_LOST reason code rather than sitting on a dead screen.
      await hostContext.close();
      await expect(guest.getByRole("alert")).toContainText("Connection lost.", {
        timeout: 30_000,
      });
    } finally {
      await guestContext.close();
    }
  });
});
