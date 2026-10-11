/**
 * Cross-engine interop matrix (PRD 13.4 / docs/INTEROP.md).
 *
 * Physical devices stay the last v1.0 gate, but the rows that only need
 * *different browser engines* — Chrome ↔ Firefox and Chrome ↔ WebKit
 * (the Safari engine) over the paste route — can be run locally with
 * real browsers. Each pair launches two engines, pairs through the real
 * DB1 code, and records what actually happened: codec, sink, timings.
 *
 *   node scripts/interop-matrix.mjs
 *
 * Firefox and WebKit are installable on demand:
 *   npx playwright install firefox webkit
 */

import { chromium, firefox, webkit } from "@playwright/test";

const PORT = 4198;
const BASE = `http://localhost:${PORT}`;

const ENGINES = { chromium, firefox, webkit };

/** Seeds the clipboard read the app uses for the paste route. The e2e suite
    already covers the real OS clipboard in Chromium; here the point is which
    engines interoperate, so the OS layer is stubbed per browser. */
function seedClipboard(context) {
  return context.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: async () => window.__pasteCode ?? "",
        writeText: async (text) => {
          window.__pasteCode = text;
        },
      },
    });
  });
}

/** Receivers save into OPFS like Firefox/Safari (PRD 8.5); a headless
    Chromium would otherwise open a native save picker that never completes. */
function saveToOpfs(context) {
  return context.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
  });
}

async function runPair(hostEngine, guestEngine) {
  const label = `${hostEngine} \u2194 ${guestEngine}`;
  const hostBrowser = await ENGINES[hostEngine].launch();
  const guestBrowser = await ENGINES[guestEngine].launch();

  try {
    const hostCtx = await hostBrowser.newContext();
    const guestCtx = await guestBrowser.newContext();
    await seedClipboard(hostCtx);
    await seedClipboard(guestCtx);
    await saveToOpfs(hostCtx);
    await saveToOpfs(guestCtx);
    const host = await hostCtx.newPage();
    const guest = await guestCtx.newPage();
    const problems = [];
    for (const [who, page] of [
      ["host", host],
      ["guest", guest],
    ]) {
      page.on("pageerror", (err) => problems.push(`${who}: ${err.message}`));
      page.on("console", (msg) => {
        if (msg.type() === "error") problems.push(`${who} console: ${msg.text()}`);
      });
    }

    const started = Date.now();
    await host.goto(`${BASE}/`);
    await guest.goto(`${BASE}/`);
    await host.getByRole("button", { name: "Start" }).click();

    // Playwright's WebKit build for Windows ships without RTCPeerConnection,
    // so it cannot pair at all. That is a build limitation, not an app
    // failure — the row is hardware-gated for real Safari — but the app's
    // UNSUPPORTED path is worth recording as a check.
    const unsupported = await host
      .getByRole("alert")
      .filter({ hasText: "direct transfers" })
      .waitFor({ timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (unsupported) {
      return {
        label,
        pass: false,
        blocked: "no RTCPeerConnection in this WebKit build (Windows); app reports UNSUPPORTED",
      };
    }

    await host.getByTestId("code-text").waitFor({ timeout: 60000 });
    const offer = (await host.getByTestId("code-text").textContent()).replace(/\s+/g, "");

    await guest.getByRole("button", { name: "Join" }).click();
    // The guest path reports UNSUPPORTED for engines with no WebRTC, so
    // check for that before waiting for the pairing screen.
    const guestBlocked = await guest
      .getByRole("alert")
      .filter({ hasText: "direct transfers" })
      .waitFor({ timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (guestBlocked) {
      return {
        label,
        pass: false,
        blocked:
          "no RTCPeerConnection in this WebKit build (Windows); app reports UNSUPPORTED on Join",
      };
    }
    await guest.evaluate((code) => {
      window.__pasteCode = code;
    }, offer);
    await guest.getByRole("button", { name: "Paste" }).click();
    await guest.getByTestId("code-text").waitFor({ timeout: 60000 });
    const answer = (await guest.getByTestId("code-text").textContent()).replace(/\s+/g, "");

    await host.evaluate((code) => {
      window.__pasteCode = code;
    }, answer);
    await host.getByRole("button", { name: "Paste reply" }).click();
    await host.locator('main[data-screen="CONNECTED"]').waitFor({ timeout: 90000 });
    await guest.locator('main[data-screen="CONNECTED"]').waitFor({ timeout: 90000 });
    const connectedMs = Date.now() - started;

    // PRD 9.3: both engines must derive the same three words.
    const hostWords = (await host.locator(".verify-card-words").textContent()).trim();
    const guestWords = (await guest.locator(".verify-card-words").textContent()).trim();
    const wordsMatch = hostWords === guestWords && hostWords.split(/\s+/).length === 3;

    await host.getByRole("button", { name: "Allow" }).click();
    await host.getByTestId("file-input").setInputFiles({
      name: "interop.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("cross-engine payload\n".repeat(8)),
    });
    await guest.getByRole("button", { name: "Accept" }).click();
    await guest.getByTestId("saved-row").waitFor({ timeout: 90000 });

    await guest.locator("#note-body").fill("back the other way");
    await guest.getByRole("button", { name: "Send" }).click();
    await host.getByTestId("note-row").waitFor({ timeout: 30000 });

    // Which sink did the receiving engine use? (PRD 8.5 per-browser note.)
    const sink = await guest.evaluate(() => {
      const hasFsa = typeof globalThis.showSaveFilePicker === "function";
      const hasOpfs = typeof navigator.storage?.getDirectory === "function";
      return hasFsa ? "fsa" : hasOpfs ? "opfs" : "memory";
    });

    return {
      label,
      pass: wordsMatch && problems.length === 0,
      codec: offer.startsWith("DB0.") ? "DB0" : "DB1",
      words: wordsMatch,
      sink,
      connectedMs,
      versions: { host: hostBrowser.version(), guest: guestBrowser.version() },
      problems,
    };
  } catch (err) {
    return { label, pass: false, codec: "DB1", error: String(err.message).slice(0, 200) };
  } finally {
    await hostBrowser.close();
    await guestBrowser.close();
  }
}

const PAIRS = [
  ["chromium", "firefox"],
  ["firefox", "chromium"],
  ["chromium", "webkit"],
  ["webkit", "chromium"],
];

const results = [];
for (const [hostEngine, guestEngine] of PAIRS) {
  const result = await runPair(hostEngine, guestEngine);
  results.push(result);
  const line = result.pass
    ? `PASS  ${result.label.padEnd(22)} codec=${result.codec} words=${result.words} sink=${result.sink ?? "?"} connect=${result.connectedMs ?? "?"}ms`
    : `FAIL  ${result.label.padEnd(22)} ${result.error ?? JSON.stringify(result.problems)}`;
  console.log(line);
}

console.log("\n| Pair | Route | Codec | Result | Notes |");
console.log("| --- | --- | --- | --- | --- |");
for (const r of results) {
  if (r.blocked) {
    console.log(`| ${r.label} | paste | — | blocked (needs hardware) | ${r.blocked} |`);
    continue;
  }
  if (!r.pass) {
    console.log(`| ${r.label} | paste | ${r.codec} | FAIL | ${r.error ?? "see log"} |`);
    continue;
  }
  console.log(
    `| ${r.label} | paste | ${r.codec} | pass | words match (PRD 9.3); guest sink=${r.sink}; ${r.connectedMs} ms to connected; ${r.versions.host} / ${r.versions.guest} |`,
  );
}
