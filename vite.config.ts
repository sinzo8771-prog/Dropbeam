import type { HtmlTagDescriptor } from "vite";
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

export default defineConfig({
  base: "./",
  plugins: [
    {
      name: "dropbeam-csp-dev",
      apply: "serve",
      transformIndexHtml(): HtmlTagDescriptor[] {
        return [
          {
            tag: "meta",
            attrs: { "http-equiv": "Content-Security-Policy", content: DEV_CSP },
            injectTo: "head-prepend",
          },
        ];
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
