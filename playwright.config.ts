/// <reference types="node" />
import { defineConfig, devices } from "@playwright/test";

/**
 * E2E specs run against the production build: the debug panel's
 * health rows read the real service worker and its cache, which
 * only exist once `vite build` has stamped the build id into
 * `sw.js`. 4173/5173 are Vite's own preview/dev ports; 4199
 * stays clear of both so a dev server can keep running while
 * the specs execute.
 *
 * The base URL uses `localhost`, not `127.0.0.1`: vite preview
 * binds to whatever `localhost` resolves to first, which is the
 * IPv6 loopback (::1) on some Windows hosts — an IPv4-only base
 * URL would get ECONNREFUSED there.
 */
const PORT = 4199;

/**
 * The specs Playwright's WebKit build cannot run.
 *
 * Two, for two different reasons, and both are properties of the harness rather
 * than of the app:
 *
 * 1. `pairing-transfer` needs a real `RTCPeerConnection`. The Windows build
 *    ships without one, measured (the debug panel reads `WebRTC no` there); the
 *    Linux build has the API but nothing here has ever put it through a real
 *    peer connection, so it stays out rather than entering the run on the
 *    strength of an API existing. One WebKit build cannot cover both platforms
 *    anyway - see the capability table in `tests/e2e/debug-panel.spec.ts`.
 * 2. `offline` navigates while the network is emulated down, and that makes
 *    WebKit fail the navigation with an internal error rather than serving it.
 *    Service workers themselves work there - the app installs, claims and caches
 *    on this engine - so it is specifically navigating offline that the build
 *    cannot do. DoD 6 is a claim about Safari, so excluding this spec is a real
 *    gap in coverage and not a formality: it stays a hardware row in
 *    docs/INTEROP.md, and nothing here pretends otherwise.
 *
 * Scoped per project rather than skipped inside a file, because a skip hides the
 * fact that this engine collects a smaller suite - and that difference is
 * exactly what keeps the WebKit leg off the gate (see `e2e-browsers.test.ts`).
 */
const WEBKIT_UNRUNNABLE = /pairing-transfer\.spec\.ts$|offline\.spec\.ts$/;

/**
 * The engines this suite can actually drive.
 *
 * Chromium is the default: it is the only one that runs everywhere, and the
 * gate's e2e stage has to give the same answer on a laptop and on a runner.
 * Firefox is added by setting `E2E_BROWSERS` (the nightly does), because its
 * WebRTC works — `scripts/interop-matrix.mjs` already pairs it with Chromium
 * over real connections.
 *
 * WebKit is included, but scoped rather than driven whole. It genuinely cannot
 * pair — Playwright's WebKit build ships without `RTCPeerConnection` on Windows,
 * and WebKitGTK's `enable-webrtc` setting defaults to false on Linux — so the
 * pairing spec is excluded for it. It also cannot navigate while the network is
 * emulated down, so the offline spec is excluded for it too. Everything else
 * runs, and on WebKit it runs against the *real* absence of the API: the
 * unsupported-browser messaging, the connection self-test and the OPFS-detection
 * contract are exercised there with nothing stubbed, which no other engine can
 * do (`tests/e2e/degradation.spec.ts` runs on all three, but only WebKit brings
 * the genuine article).
 *
 * It is also why WebKit is not a leg of the gate: without the pairing spec it
 * collects a smaller suite, so its counts cannot be the counts `README.md`
 * states. The scheduled WebKit job runs `npm run test:webkit` instead, and
 * `scripts/gate-figures.mjs` refuses `E2E_BROWSERS=webkit` rather than measure
 * the README against a suite that was never run.
 */

/**
 * Firefox preferences the suite needs — and the one thing it must not do is
 * change what is being tested.
 *
 * By default Firefox mDNS-obfuscates its host ICE candidates, which is the
 * right default for a person on a laptop: the other device finds you by a
 * `.local` name instead of by your LAN address. It needs working multicast for
 * that, and the hosted CI runner has none — so under the app's Local ICE mode
 * (`iceServers: []`, PRD 8.3) Firefox gathered nothing at all and failed
 * outright, `WebRTC: ICE failed, add a STUN server`. That is the runner's
 * network, not the app: nothing in the transfer path changed, and the fix is
 * emphatically not to add a STUN server, which would bend the privacy model to
 * suit a harness.
 *
 * Turning the obfuscation off makes Firefox behave like every other engine here:
 * plain host candidates, no third party, no multicast. It is a launch
 * preference rather than an init script so it is in force before any peer
 * connection exists, and it costs the specs nothing — they pair two contexts on
 * one machine, where an obfuscated candidate would have been useless anyway.
 *
 * Whether a real user's machine behaves the same when its network blocks
 * multicast is not something this suite can answer. That is recorded in
 * docs/INTEROP.md rather than assumed either way.
 */
const FIREFOX_LAUNCH = {
  firefoxUserPrefs: { "media.peerconnection.ice.obfuscate_host_addresses": false },
} as const;

const ENGINES = {
  chromium: { use: devices["Desktop Chrome"] },
  firefox: { use: { ...devices["Desktop Firefox"], launchOptions: FIREFOX_LAUNCH } },
  webkit: { use: devices["Desktop Safari"], testIgnore: WEBKIT_UNRUNNABLE },
} as const;

/**
 * Which engine list this run drives.
 *
 * `E2E_BROWSERS` when it is set: that is how CI names the leg, and how a
 * developer runs a second engine locally. Otherwise the npm script's own name,
 * because `npm run test:webkit` has to mean WebKit — a script that quietly ran
 * Chromium instead would be the widest possible gap between what a command says
 * and what it does. The alternative, setting the variable inside the script,
 * needs a cross-platform env helper this project does not depend on.
 */
export function engineList(env: Record<string, string | undefined>): string {
  if (env.E2E_BROWSERS) return env.E2E_BROWSERS;
  return env.npm_lifecycle_event === "test:webkit" ? "webkit" : "chromium";
}

/**
 * The projects for a comma-separated engine list.
 *
 * An unknown name is an error rather than a skipped project, and so is a
 * non-empty-but-empty list: a typo in the environment variable would otherwise
 * leave a run green while testing what it already tested, which is the one
 * outcome a widened run must not produce quietly.
 */
export function projectsFor(list: string) {
  const names = list
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    throw new Error(`E2E_BROWSERS is empty; name one of ${Object.keys(ENGINES).join(", ")}`);
  }
  const chosen: string[] = [];
  for (const name of names) {
    const known = ENGINES[name as keyof typeof ENGINES];
    if (!known) {
      throw new Error(
        `E2E_BROWSERS names ${name}, which is not one of ${Object.keys(ENGINES).join(", ")}`,
      );
    }
    // Repeats collapse rather than running the same engine twice.
    if (!chosen.includes(name)) chosen.push(name);
  }
  return chosen.map((name) => {
    const engine = ENGINES[name as keyof typeof ENGINES];
    return {
      name,
      use: { ...engine.use },
      // Only WebKit carries one; the others run every spec in the directory.
      testIgnore: "testIgnore" in engine ? engine.testIgnore : undefined,
    };
  });
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: projectsFor(engineList(process.env)),
  webServer: {
    // Build first so the served bundle always matches the source.
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    port: PORT,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
