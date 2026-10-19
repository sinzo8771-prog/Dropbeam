import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The shipped Content-Security-Policy (PRD 9.1, 9.2, DoD 9).
 *
 * The policy is written down in two places that are both real: `index.html`,
 * which is what the browser enforces on the page that ships, and
 * `vite.config.ts`, which injects one into the page the dev server serves. If
 * those drift, the development page and the shipped page stop agreeing about
 * what the app is allowed to do, and the difference is invisible until a
 * deploy.
 *
 * The PRD is the authority, and it says the policy may be adjusted "only with a
 * DECISIONS.md entry". So the test reads the PRD's own line and holds the
 * shipped policy to it, with exactly one difference: `frame-ancestors` has to
 * arrive as a real HTTP header from the static host, because a `frame-ancestors`
 * in a meta tag is ignored and only logs a console error. That deviation is
 * recorded in `vite.config.ts` and in `docs/DECISIONS.md`; this test makes sure
 * it is the *only* one.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const prd = readFileSync(join(root, "docs/PRD.md"), "utf8");
const viteConfig = readFileSync(join(root, "vite.config.ts"), "utf8");

/** The policy the PRD states, read from the PRD rather than copied here. */
function prdPolicy(): string {
  const line = prd.split("\n").find((text) => text.trim().startsWith("`default-src 'self';"));
  if (!line) throw new Error("docs/PRD.md no longer states the policy in §9.2");
  const match = /`([^`]+)`/.exec(line);
  if (!match) throw new Error("the PRD's policy is no longer in backticks");
  return match[1] as string;
}

/** The policy the shipped page carries. */
function shippedPolicy(): string {
  const match = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/.exec(indexHtml);
  if (!match) throw new Error("index.html no longer ships a Content-Security-Policy");
  return match[1] as string;
}

/** The policy the dev server injects, as a joined list. */
function devPolicy(): string {
  const block = /const PROD_CSP = \[\n([\s\S]*?)\n\]/.exec(viteConfig);
  if (!block) throw new Error("vite.config.ts no longer builds a PROD_CSP");
  const directives = [...(block[1] as string).matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
  return directives.join("; ");
}

describe("the shipped policy (PRD 9.1, 9.2)", () => {
  it("is the PRD's policy, less the one directive a meta tag cannot carry", () => {
    // `frame-ancestors` in a meta tag is ignored and only logs an error; it
    // has to be a real header from the static host (docs/SELF-HOSTING.md).
    const expected = prdPolicy().replace("; frame-ancestors 'none'", "");
    expect(shippedPolicy()).toBe(expected);
  });

  it("is the same policy the dev server injects, so the two cannot drift", () => {
    expect(devPolicy()).toBe(shippedPolicy());
  });

  it("keeps the directives the PRD names", () => {
    const policy = shippedPolicy();
    for (const directive of [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "media-src 'self' blob:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
    ]) {
      expect(policy, `the policy is missing ${directive}`).toContain(directive);
    }
  });

  it("relaxes only the two directives the dev server is allowed to relax", () => {
    // The dev variant adds 'unsafe-inline' to style-src and ws:/wss: to
    // connect-src, for Vite's injected styles and its HMR socket. It must not
    // relax anything else, and it must not reach the shipped page.
    const dev = /const DEV_CSP = PROD_CSP\.replace\(\s*"([^"]+)",\s*"([^"]+)"\s*\)/.exec(viteConfig);
    expect(dev, "the dev relaxation is no longer a pair of replacements").not.toBeNull();
    const from = dev?.[1] as string;
    const to = dev?.[2] as string;
    expect(from).toBe("style-src 'self'");
    expect(to).toBe("style-src 'self' 'unsafe-inline'");
    // And the shipped page carries none of it.
    expect(shippedPolicy()).not.toContain("unsafe-inline");
    expect(shippedPolicy()).not.toContain("ws:");
  });
});
