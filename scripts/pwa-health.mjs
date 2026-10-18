"use strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(root, "public");
const distDir = join(root, "dist");

/** Minimal PNG probe. */
function pngSize(file) {
  const bytes = readFileSync(file);
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
    throw new Error(`${file} not a PNG`);
  if (bytes.subarray(12, 16).toString("ascii") !== "IHDR") throw new Error(`${file} missing IHDR`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// --- manifest ---
const manifest = JSON.parse(readFileSync(join(publicDir, "manifest.webmanifest"), "utf8"));
const icons = manifest.icons;

// --- service worker ---
// `scripts/postbuild.mjs` stamps the build id into dist/sw.js,
// so the built copy is the effective one when it exists; the
// public copy is the pre-stamp source.
const swSource = existsSync(join(distDir, "sw.js"))
  ? join(distDir, "sw.js")
  : join(publicDir, "sw.js");
const sw = readFileSync(swSource, "utf8");
const stamped = sw.match(/const CACHE = "dropbeam-" \+ "([^"]+)"/)?.[1] ?? null;
const buildId = stamped === "__BUILD_ID__" ? null : stamped;
const hasSkipWaiting = sw.includes("self.skipWaiting()");
const hasClaim = sw.includes("self.clients.claim()");
// The static-asset path goes through the `lookup()` helper, which is where the
// `ignoreVary` lives, so cache-first is proven by the helper existing and being
// used — not by one exact call site that a refactor would silently rename.
const hasLookupHelper = sw.includes("function lookup(") && sw.includes("lookup(request)");
const hasCacheFirst = sw.includes("caches.match(request");
const hasIgnoreVary = sw.includes("ignoreVary: true");
const hasThirdPartyFetch = /https?:\/\/(?!['"])/.test(sw);

// DoD 6. The precache has to hold every emitted asset, not just the shell: the
// app code-splits, so a shell-only precache leaves Settings and the repair
// paths unreachable offline. In `public/` that list is still the `__PRECACHE__`
// marker (Vite has not hashed the filenames yet); in `dist/` it is the stamped
// list. Checking the wrong one would pass a build that stamped nothing.
const shellLine = sw.match(/^const SHELL = \[(.*)\];$/m)?.[1] ?? "";
const hasPrecacheMarker = shellLine.includes("__PRECACHE__");
const precacheCount = (shellLine.match(/"/g) ?? []).length / 2;
const stampedBuild = !swSource.startsWith(publicDir);

const problems = [];

if (!buildId)
  problems.push(
    swSource.startsWith(distDir)
      ? "dist/sw.js was not stamped — run `npm run build`"
      : "run `npm run build` to stamp the cache name",
  );
if (!hasSkipWaiting) problems.push("sw.js missing self.skipWaiting()");
if (!hasClaim) problems.push("sw.js missing self.clients.claim()");
if (!hasCacheFirst || !hasLookupHelper)
  problems.push("sw.js missing cache-first static asset handling");
// Without this the precached chunks are in the cache and still never match, so
// offline fails on the very assets the precache exists for (see public/sw.js).
if (!hasIgnoreVary) problems.push("sw.js cache lookups must ignore Vary (DoD 6)");
if (stampedBuild && precacheCount <= 1)
  problems.push(
    "dist/sw.js precaches only the shell — postbuild did not stamp the asset list (DoD 6)",
  );
if (!stampedBuild && !hasPrecacheMarker)
  problems.push("public/sw.js is missing the __PRECACHE__ marker postbuild rewrites (DoD 6)");
if (hasThirdPartyFetch) problems.push("sw.js references an external URL");

for (const icon of icons) {
  const file = join(publicDir, icon.src.replace("./", ""));
  const { width, height } = pngSize(file);
  const [declared] = icon.sizes.split("x").map(Number);
  if (width !== declared || height !== declared)
    problems.push(`icon ${icon.src}: declared ${icon.sizes}, file is ${width}x${height}`);
  if (icon.type !== "image/png")
    problems.push(`icon ${icon.src}: type ${icon.type}, expected image/png`);
}
if (buildId) {
  if (icons.every((i) => i.sizes === "512x512"))
    problems.push("no 192 icon listed for the taskbar favicon");
}
const purposes = icons.map((i) => i.purpose);
if (!purposes.includes("maskable")) problems.push("no maskable icon for Android circular cropping");

// --- shortcuts: every URL stays in scope, every icon file exists ---
for (const shortcut of manifest.shortcuts ?? []) {
  if (!shortcut.url?.startsWith("./") || shortcut.url.includes("://"))
    problems.push(`shortcut "${shortcut.name}": url must be in-scope and relative`);
  for (const icon of shortcut.icons ?? []) {
    const file = join(publicDir, icon.src.replace("./", ""));
    if (!existsSync(file)) problems.push(`shortcut "${shortcut.name}": icon ${icon.src} missing`);
  }
}

// --- output ---
const bar = (label, value) =>
  typeof value === "string" ? `[${label}] ${value}` : `[${label}] ${value ? "yes" : "no"}`;

console.log("");
console.log("PWA health");
console.log(" ".repeat(6) + bar("source", swSource.slice(root.length + 1)));
console.log(" ".repeat(6) + bar("build id", buildId ?? "—"));
console.log(" ".repeat(6) + bar("skip waiting", hasSkipWaiting));
console.log(" ".repeat(6) + bar("claim", hasClaim));
console.log(" ".repeat(6) + bar("cache first", hasCacheFirst && hasLookupHelper));
console.log(" ".repeat(6) + bar("ignore vary", hasIgnoreVary));
console.log(
  " ".repeat(6) +
    (stampedBuild
      ? `[precache] ${precacheCount} entries`
      : `[precache] ${hasPrecacheMarker ? "awaiting build stamp" : "MISSING MARKER"}`),
);
console.log(" ".repeat(6) + bar("external fetch", !hasThirdPartyFetch));
console.log(" ".repeat(6) + bar("icons", icons.length));
for (const icon of icons) {
  const file = join(publicDir, icon.src.replace("./", ""));
  const { width } = pngSize(file);
  console.log(" ".repeat(9) + `${icon.src}  ${width}x${width}  purpose=${icon.purpose}`);
}

console.log(" ".repeat(9) + `shortcuts  ${(manifest.shortcuts ?? []).length}`);
for (const shortcut of manifest.shortcuts ?? []) {
  console.log(" ".repeat(11) + `${shortcut.name}  ${shortcut.url}`);
}

console.log("");
if (problems.length) {
  console.error("problems:");
  for (const p of problems) console.error("  " + p);
  process.exitCode = 1;
} else {
  console.log("OK — installable PWA looks healthy.");
}
