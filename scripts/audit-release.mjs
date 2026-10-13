/**
 * DoD 8 (Lighthouse, mobile profile) and DoD 5 (network audit) against
 * the production build served by `vite preview`.
 *
 *   node scripts/audit-release.mjs
 *
 * Lighthouse attaches to a Chromium launched by Playwright with remote
 * debugging, so the browser here is the same pinned one the e2e suite
 * uses. One-off audit tool: keep it out of package.json.
 */
import { chromium } from "@playwright/test";
import lighthouse from "lighthouse";

const PORT = 4198;
const BASE = `http://localhost:${PORT}`;
const TARGETS = [{ label: "home", url: `${BASE}/` }];

/* ---------------- 1. Lighthouse, mobile profile ---------------- */

const browser = await chromium.launch({ args: ["--remote-debugging-port=9222"] });
const results = [];
try {
  for (const target of TARGETS) {
    const runner = await lighthouse(
      target.url,
      {
        port: 9222,
        output: "json",
        logLevel: "error",
        formFactor: "mobile",
        screenEmulation: {
          mobile: true,
          width: 412,
          height: 823,
          deviceScaleFactor: 1.75,
          disabled: false,
        },
        // Lighthouse 13 dropped its PWA category, so nothing in this run
        // measures installability. `npm run pwa:health` owns that half of
        // DoD 8 (manifest, service worker, icons, shortcuts).
        throttlingMethod: "simulate",
      },
      undefined,
    );
    const lhr = JSON.parse(runner.report);
    const scores = Object.fromEntries(
      Object.entries(lhr.categories).map(([key, category]) => [
        key,
        Math.round((category.score ?? 0) * 100),
      ]),
    );
    results.push({ label: target.label, scores, audits: lhr.audits });
    console.log(`\nLighthouse ${target.label} (mobile):`);
    for (const [key, score] of Object.entries(scores)) {
      console.log(`   ${key.padEnd(16)} ${score}`);
    }
    const failing = Object.entries(lhr.audits)
      .filter(([, a]) => a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== "manual")
      .map(([id, a]) => `   ${id}: ${Math.round((a.score ?? 0) * 100)} — ${a.title}`);
    if (failing.length) console.log("   sub-0.9 audits:\n" + failing.join("\n"));
  }
} finally {
  await browser.close();
}

/* ---------------- 2. Network audit ---------------- */

const audit = await chromium.launch();
const hostCtx = await audit.newContext();
const guestCtx = await audit.newContext();
await hostCtx.grantPermissions(["clipboard-read", "clipboard-write"]);
await guestCtx.grantPermissions(["clipboard-read", "clipboard-write"]);
// The guest saves into OPFS like Firefox/Safari (PRD 8.5): a headless
// browser can never finish a native save picker.
await guestCtx.addInitScript(() => {
  Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
});

const requests = [];
const host = await hostCtx.newPage();
const guest = await guestCtx.newPage();
for (const [who, page] of [
  ["host", host],
  ["guest", guest],
]) {
  page.on("request", (r) => requests.push({ who, url: r.url(), type: r.resourceType() }));
  page.on("websocket", (ws) => requests.push({ who, url: ws.url(), type: "websocket" }));
  page.on("pageerror", (err) => console.log(`[${who} pageerror]`, err.message));
}

try {
  await host.goto(`${BASE}/`);
  await guest.goto(`${BASE}/`);
  await host.getByRole("button", { name: "Start" }).click();
  await host.getByTestId("code-text").waitFor({ timeout: 60000 });
  const offer = (await host.getByTestId("code-text").textContent()).replace(/\s+/g, "");
  await guest.goto(`${BASE}/#j=${offer}`);
  await guest.getByTestId("code-text").waitFor({ timeout: 60000 });
  const answer = (await guest.getByTestId("code-text").textContent()).replace(/\s+/g, "");
  await host.evaluate((code) => navigator.clipboard.writeText(code), answer);
  await host.getByRole("button", { name: "Paste reply" }).click();
  await host.locator('main[data-screen="CONNECTED"]').waitFor({ timeout: 60000 });
  await guest.locator('main[data-screen="CONNECTED"]').waitFor({ timeout: 60000 });
  await host.getByRole("button", { name: "Allow" }).click();
  await host.getByTestId("file-input").setInputFiles({
    name: "holiday-notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("nothing leaves this device\n".repeat(16)),
  });
  await guest.getByRole("button", { name: "Accept" }).click();
  await guest.getByTestId("saved-row").waitFor({ timeout: 60000 });
  await guest.locator("#note-body").fill("back the other way");
  await guest.getByRole("button", { name: "Send" }).click();
  await host.getByTestId("note-row").waitFor({ timeout: 30000 });
  await host.waitForTimeout(1500);
} finally {
  await hostCtx.close();
  await guestCtx.close();
  await audit.close();
}

const offOrigin = requests.filter((r) => {
  try {
    return new URL(r.url).origin !== BASE;
  } catch {
    return true;
  }
});
console.log(`\nNetwork audit: ${requests.length} requests total, ${offOrigin.length} off-origin`);
for (const r of offOrigin) console.log("   ", r.who, r.type, r.url);
const byType = {};
for (const r of requests) byType[r.type] = (byType[r.type] ?? 0) + 1;
console.log("    by type:", JSON.stringify(byType));
console.log(offOrigin.length === 0 ? "NETWORK AUDIT: PASS" : "NETWORK AUDIT: FAIL");
