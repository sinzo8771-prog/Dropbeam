import { defineConfig } from "vitest/config";

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  // NOTE: frame-ancestors is deliberately absent. Browsers ignore it when the
  // policy is delivered via <meta>, and it logs a console error there. Clickjacking
  // protection must instead be set as a real HTTP header by the static host
  // (recorded in docs/DECISIONS.md and README deploy notes).
].join("; ");

/**
 * Dev-only relaxation: Vite injects compiled CSS as <style> elements and opens
 * an HMR websocket, both blocked by the strict production CSP (recorded in
 * docs/DECISIONS.md). Production ships PROD_CSP verbatim via index.html.
 */
const DEV_CSP = PROD_CSP.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'").replace(
  "connect-src 'self'",
  "connect-src 'self' ws: wss:",
);

/**
 * The one `<meta>` that carries the policy.
 *
 * A document may carry more than one policy, but a resource then has to
 * satisfy all of them: the effective restriction is the intersection, so the
 * stricter policy wins. Adding a looser dev policy *next to* the strict
 * shipped one therefore leaves the strict one in charge — and the dev page
 * loses its styles, because Vite injects them as `<style>` elements that
 * `style-src 'self'` blocks. The dev policy has to replace the shipped one,
 * not sit beside it.
 */
const CSP_META = /<meta[^>]*http-equiv="Content-Security-Policy"[^>]*>/i;

/**
 * The dev server's page, with the shipped policy swapped for the dev one.
 *
 * Exported so the test can hold the transform to what it promises: exactly
 * one policy in the document, and it is the dev one.
 */
export function applyDevCsp(html: string): string {
  return html.replace(
    CSP_META,
    `<meta http-equiv="Content-Security-Policy" content="${DEV_CSP}" />`,
  );
}

export default defineConfig({
  base: "./",
  plugins: [
    {
      name: "dropbeam-csp-dev",
      apply: "serve",
      transformIndexHtml(html: string): string {
        return applyDevCsp(html);
      },
    },
  ],
  build: {
    target: "es2022",
    sourcemap: false,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        /**
         * Name the fflate fallback chunk explicitly. It is a dynamic
         * import (encoding.ts only reaches it when the native
         * CompressionStream is missing), and scripts/size-budget.mjs
         * recognises lazy chunks by name.
         */
        manualChunks: (id) => (id.includes("node_modules/fflate") ? "fflate-fallback" : undefined),
      },
    },
  },
  worker: {
    format: "es",
  },
  test: {
    environment: "node",
    // The component files opt into jsdom per-file. Without a frame clock,
    // preact/hooks flushes effects on a one-second debounce, so an effect can
    // still be pending when a fast test file ends and jsdom is torn down under
    // it -- an unhandled ReferenceError that fails the gate on the runner and
    // nowhere else. pretendToBeVisual gives jsdom requestAnimationFrame, which
    // is what a browser has and what preact prefers (see vitest.setup.ts).
    environmentOptions: { jsdom: { pretendToBeVisual: true } },
    include: ["tests/unit/**/*.test.{ts,tsx}", "tests/integration/**/*.test.{ts,tsx}"],
    exclude: ["tests/e2e/**"],
    setupFiles: ["vitest.setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: ["src/core/**"],
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
});
