/**
 * DoD 8 (Lighthouse, mobile profile) and DoD 5 (network audit) against
 * the production build.
 *
 *   node scripts/audit-release.mjs
 *
 * Runs as `npm run audit:release`, inside the `npm run ci` gate, so a
 * regression against either DoD stops the build instead of waiting to be
 * noticed by hand. It starts and stops its own `vite preview` server, so
 * `npm run build` must have run first.
 *
 * Lighthouse attaches to a Chromium launched by Playwright with remote
 * debugging, so the browser here is the same pinned one the e2e suite
 * uses. Lighthouse stays a devDependency and is never shipped.
 */
import { preview } from "vite";
import { chromium } from "@playwright/test";
import lighthouse from "lighthouse";

const HOST = "127.0.0.1";
const PORT = 4198;
const BASE = `http://${HOST}:${PORT}`;
const TARGETS = [{ label: "home", url: `${BASE}/` }];

/**
 * The gates, as numbers rather than prose.
 *
 * Performance and accessibility are DoD 8 verbatim (PRD 18: "Performance
 * >= 90, Accessibility >= 95"). Installability is not scored here —
 * Lighthouse 13 dropped its PWA category — so `npm run pwa:health` owns
 * that half of the same requirement.
 *
 * Best practices and SEO are printed for context but deliberately *not*
 * gated: neither is a DoD threshold, and gating them would turn an
 * unrelated Lighthouse scoring change into a red build.
 */
const CATEGORY_GATES = { performance: 90, accessibility: 95 };
const OFF_ORIGIN_GATE = 0;

const failures = [];
/** Everything that can log a verdict must go through this, so the gates
 *  cannot pass while a section quietly printed FAIL. */
const check = (ok, description) => {
  if (!ok) failures.push(description);
  return ok ? "PASS" : "FAIL";
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer(attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(BASE, { redirect: "manual" });
      if (response.ok) return;
    } catch {
      /* not listening yet */
    }
    await sleep(500);
  }
  throw new Error(`preview server never answered at ${BASE}`);
}

/* ---------------- 0. the preview server ---------------- */

/**
 * Bound explicitly to IPv4. A bare `localhost` follows whatever the host
 * resolves first — the IPv6 loopback on some Windows machines, which is
 * the trap playwright.config.ts documents for :4199 — and a Node `fetch`
 * to `localhost` can then resolve to IPv4 and get ECONNREFUSED against a
 * server that is in fact up. Pinning both ends removes that class of
 * "works on my machine" failure from a gate.
 */
let server;
try {
  server = await preview({
    preview: { host: HOST, port: PORT, strictPort: true },
    logLevel: "warn",
  });
} catch (error) {
  console.error(`could not start vite preview on ${BASE} — run \`npm run build\` first`);
  console.error(error?.message ?? error);
  process.exit(1);
}

try {
  await waitForServer();

  /* ---------------- 1. Lighthouse, mobile profile ---------------- */

  const browser = await chromium.launch({ args: ["--remote-debugging-port=9222"] });
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
      console.log(`\nLighthouse ${target.label} (mobile):`);
      for (const [key, score] of Object.entries(scores)) {
        console.log(`   ${key.padEnd(16)} ${score}`);
      }
      for (const [category, minimum] of Object.entries(CATEGORY_GATES)) {
        const score = scores[category] ?? 0;
        console.log(
          `   gate ${category.padEnd(11)} ${String(score).padStart(3)} >= ${minimum}   ` +
            check(
              score >= minimum,
              `Lighthouse ${target.label}: ${category} ${score} < gate ${minimum}`,
            ),
        );
      }
      const failing = Object.entries(lhr.audits)
        .filter(([, a]) => a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== "manual")
        .map(([id, a]) => `   ${id}: ${Math.round((a.score ?? 0) * 100)} — ${a.title}`);
      if (failing.length) console.log("   sub-0.9 audits (informational):\n" + failing.join("\n"));
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
  console.log(
    "NETWORK AUDIT: " +
      check(
        offOrigin.length <= OFF_ORIGIN_GATE,
        `network: ${offOrigin.length} off-origin request(s), gate is ${OFF_ORIGIN_GATE}`,
      ),
  );
} finally {
  // Always release the port, so a failed audit cannot block the next run.
  await server.close();
}

/* ---------------- 3. verdict ---------------- */

console.log("");
if (failures.length === 0) {
  console.log("RELEASE AUDIT: PASS");
} else {
  console.error("RELEASE AUDIT: FAIL");
  for (const failure of failures) console.error(`   ${failure}`);
  process.exitCode = 1;
}
