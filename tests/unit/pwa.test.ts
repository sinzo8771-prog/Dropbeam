import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
      params: { files: [{ name: "files", accept: ["*/*"], multiple: true }] },
    });
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
    expect(sw).toContain("caches.match(request)");
    // No third-party calls may sneak in through the worker (PRD 9.1).
    expect(sw).not.toMatch(/https?:\/\/(?!['"])/);
  });
});
