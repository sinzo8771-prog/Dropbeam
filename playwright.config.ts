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
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Build first so the served bundle always matches the source.
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    port: PORT,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
