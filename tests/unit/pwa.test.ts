import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const publicDir = join(root, "public");

/** Minimal PNG probe: signature plus the IHDR header fields. */
function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("installable PWA (PRD FR-50)", () => {
  const manifest = JSON.parse(readFileSync(join(publicDir, "manifest.webmanifest"), "utf8"));

  it("declares the app with a shell URL", () => {
    expect(manifest.name).toBe("Dropbeam");
    expect(manifest.short_name).toBe("Dropbeam");
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("./");
    expect(manifest.scope).toBe("./");
  });

  it("lists only icons that exist, with a maskable entry", () => {
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
    const purposes = manifest.icons.map((icon: { purpose: string }) => icon.purpose);
    expect(purposes).toContain("maskable");
    for (const icon of manifest.icons) {
      const file = join(publicDir, icon.src.replace("./", ""));
      const { width, height } = pngSize(file);
      const [declared] = icon.sizes.split("x").map(Number);
      expect(width).toBe(declared);
      expect(height).toBe(declared);
      expect(icon.type).toBe("image/png");
    }
  });

  it("sets a plain-string theme_color (the media-array form is invalid)", () => {
    // The per-scheme tinting lives in index.html's <meta name="theme-color">
    // tags; the manifest value must be a single string or browsers and
    // Lighthouse treat the manifest as having no theme color at all.
    expect(manifest.theme_color).toBe("#F6F2EA");
    expect(manifest.background_color).toBe("#F6F2EA");
  });

  it("declares a share target that posts files into the app (FR-51)", () => {
    expect(manifest.share_target).toEqual({
      action: "./share",
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        title: "title",
        text: "text",
        files: [{ name: "files", accept: ["*/*"], multiple: true }],
      },
    });
  });

  it("declares app shortcuts that land inside the app (roadmap quick-send)", () => {
    // The long-press launcher entries open the SPA with ?screen=…, which
    // App.tsx consumes into the same page state the quiet links use.
    const urls = manifest.shortcuts.map((s: { url: string }) => s.url);
    expect(urls).toEqual(["./?screen=send", "./?screen=selftest"]);
    for (const shortcut of manifest.shortcuts as { name: string; icons: { src: string }[] }[]) {
      expect(shortcut.name.length).toBeGreaterThan(0);
      for (const icon of shortcut.icons) {
        // Every referenced icon must exist: a dead icon silently drops the
        // shortcut from the launcher.
        expect(existsSync(join(publicDir, icon.src.replace("./", "")))).toBe(true);
      }
    }
  });

  it("stages share-target posts in the worker and keeps them across deploys", () => {
    const sw = readFileSync(join(publicDir, "sw.js"), "utf8");
    // The POST route is answered by the worker, never the network…
    expect(sw).toContain('url.pathname.endsWith("/share")');
    expect(sw).toContain('request.method === "POST"');
    expect(sw).toContain('form.getAll("files")');
    // …staged in a dedicated cache, landed on via #shared, and the
    // activate sweep must spare it (a deploy must not eat a share).
    expect(sw).toContain('"dropbeam-share"');
    expect(sw).toContain('"./#shared"');
    expect(sw).toContain("name !== SHARE_CACHE");
    // Shared text is staged under its own sentinel entry ("clipboard sync").
    expect(sw).toContain('form.get("text")');
    expect(sw).toContain("TEXT_ENTRY");
  });

  it("ships a service worker whose cache name is version-stamped", () => {
    const sw = readFileSync(join(publicDir, "sw.js"), "utf8");
    // scripts/postbuild.mjs replaces the placeholder after every build,
    // so a new deploy rolls the cache name and purges the old one. The
    // name is assembled at runtime from the prefixed literal, so the
    // stamp actually reaches the cache variable.
    expect(sw).toContain("dropbeam-");
    expect(sw).toContain('"__BUILD_ID__"');
    expect(sw).toContain("self.skipWaiting()");
    expect(sw).toContain("self.clients.claim()");
    // Cache-first for static assets (PRD 6.5): the cache is consulted
    // before the network on non-navigation requests.
    expect(sw).toContain("caches.match(request");
    // No third-party calls may sneak in through the worker (PRD 9.1).
    expect(sw).not.toMatch(/https?:\/\/(?!['"])/);
  });

  it("precaches every emitted asset, not just the shell (DoD 6)", () => {
    /*
     * The bug this pins: the app code-splits, so the settings sheet, the repair
     * paths and the hashing worker are chunks that are only requested the first
     * time a user reaches them. With only the shell precached, a device that had
     * never opened Settings could not open Settings offline — the dynamic import
     * failed and the button was dead with nothing in the log to say why.
     *
     * `public/sw.js` cannot list those filenames itself because Vite has not
     * hashed them yet, so the source carries a marker that
     * `scripts/postbuild.mjs` rewrites. Both halves are asserted here: the
     * marker must be present in the source, or the stamping would silently do
     * nothing and ship the broken worker behind a green build.
     */
    const sw = readFileSync(join(publicDir, "sw.js"), "utf8");
    const shellLine = sw.split("\n").find((line) => line.startsWith("const SHELL = "));
    expect(shellLine, "public/sw.js must declare const SHELL").toBeDefined();
    expect(shellLine).toContain("__PRECACHE__");
    // The shell entry is always there: a navigation falls back to it.
    expect(shellLine).toContain('"./"');
    // The install must add the rest one at a time, so one missing file cannot
    // fail the whole install and cost the app every offline asset.
    expect(sw).toContain("cache.add(url).catch");
  });

  it("looks the precache up ignoring Vary (DoD 6)", () => {
    /*
     * The second half of the same failure, and the subtler one. `vite preview`
     * sends `Vary: Origin`, and the Cache API honours `Vary` by default, so a
     * module script fetched by `import()` — which sends an `Origin` header where
     * this worker's own `cache.add` requests send none — missed the copy the
     * worker had stored. The response was there the whole time; the lookup simply
     * declined it. A precached chunk became a `net::ERR_FAILED` on a live button.
     *
     * `Vary` is about a server varying its answer on request headers, which is
     * not a statement about whether two requests want the same static file, so
     * every lookup in the worker has to opt out of it.
     */
    const sw = readFileSync(join(publicDir, "sw.js"), "utf8");
    expect(sw).toContain("ignoreVary: true");
    // No bare `caches.match(` left in a fetch handler: one unguarded lookup is
    // the bug again, and it would be easy to reintroduce in a new route.
    expect(sw).not.toMatch(/caches\.match\((?!request, \{ ignoreVary)/);
  });
});
