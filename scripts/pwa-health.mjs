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
const hasCacheFirst = sw.includes("caches.match(request)");
const hasThirdPartyFetch = /https?:\/\/(?!['"])/.test(sw);

const problems = [];

if (!buildId)
  problems.push(
    swSource.startsWith(distDir)
      ? "dist/sw.js was not stamped — run `npm run build`"
      : "run `npm run build` to stamp the cache name",
  );
if (!hasSkipWaiting) problems.push("sw.js missing self.skipWaiting()");
if (!hasClaim) problems.push("sw.js missing self.clients.claim()");
if (!hasCacheFirst) problems.push("sw.js missing cache-first static asset handling");
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

// --- output ---
const bar = (label, value) =>
  typeof value === "string" ? `[${label}] ${value}` : `[${label}] ${value ? "yes" : "no"}`;

console.log("");
console.log("PWA health");
console.log(" ".repeat(6) + bar("source", swSource.slice(root.length + 1)));
console.log(" ".repeat(6) + bar("build id", buildId ?? "—"));
console.log(" ".repeat(6) + bar("skip waiting", hasSkipWaiting));
console.log(" ".repeat(6) + bar("claim", hasClaim));
console.log(" ".repeat(6) + bar("cache first", hasCacheFirst));
console.log(" ".repeat(6) + bar("external fetch", !hasThirdPartyFetch));
console.log(" ".repeat(6) + bar("icons", icons.length));
for (const icon of icons) {
  const file = join(publicDir, icon.src.replace("./", ""));
  const { width } = pngSize(file);
  console.log(" ".repeat(9) + `${icon.src}  ${width}x${width}  purpose=${icon.purpose}`);
}

console.log("");
if (problems.length) {
  console.error("problems:");
  for (const p of problems) console.error("  " + p);
  process.exitCode = 1;
} else {
  console.log("OK — installable PWA looks healthy.");
}
