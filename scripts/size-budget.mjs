/**
 * PRD NFR-1: initial JS must stay under 150 KB gzipped (scanner/QR libs are
 * lazy-loaded and excluded from this budget; they are listed separately).
 */
import { readFileSync, readdirSync } from "node:fs";
import { statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
const BUDGET = 150 * 1024;

/** Vite writes hashed assets into dist/assets/, so walk recursively. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else out.push(path.relative(dist, abs).split(path.sep).join("/"));
  }
  return out;
}

let files;
try {
  files = walk(dist);
} catch {
  console.error("size: dist/ not found — run `npm run build` first");
  process.exit(1);
}

// Some chunks (e.g. the hand-written service worker) are not gzipped; fall
// back to the raw size so a missing gzip stream cannot mask the budget.
const gzSize = (file) => {
  const bytes = readFileSync(path.join(dist, file));
  try {
    return gunzipSync(bytes).length;
  } catch {
    return bytes.length;
  }
};

// "Initial" means what the document loads before first paint: the entry
// module referenced by index.html. Vite bundles every static import into
// that entry, so anything else in dist/ is either a dynamic import() chunk
// (scanner/QR render, hash worker, the hash-wasm inline fallback, the
// settings sheet, the fflate fallback, per-chunk repair) or the hand-written
// service worker — none of it blocks first paint. Those are reported as
// `lazy` so the total shipped weight stays visible without padding the
// initial number, and the classification cannot rot as chunks are added
// (a filename pattern silently misses the hash-wasm chunk, which Vite names
// after its package entry rather than its contents).
const htmlFiles = files.filter((f) => f.endsWith(".html"));
const initialNames = new Set();
for (const htmlFile of htmlFiles) {
  const html = readFileSync(path.join(dist, htmlFile), "utf8");
  for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
    const src = decodeURIComponent(m[1]).replace(/^\.?\//, "");
    if (src.endsWith(".js")) initialNames.add(src);
  }
}

const scripts = files.filter((f) => f.endsWith(".js"));
const initial = scripts.filter((f) => initialNames.has(f));
const lazy = scripts.filter((f) => !initialNames.has(f));

if (initial.length === 0) {
  console.error("FAIL: no initial JS chunks found in dist/ — the budget check cannot pass");
  process.exit(1);
}

let total = 0;
for (const f of initial) {
  const size = gzSize(f);
  total += size;
  console.log(`  initial  ${f.padEnd(40)} ${String(size).padStart(7)} B gz`);
}
for (const f of lazy) {
  console.log(`  lazy     ${f.padEnd(40)} ${String(gzSize(f)).padStart(7)} B gz`);
}

console.log(`initial JS total: ${total} B gz (budget ${BUDGET} B)`);
if (total > BUDGET) {
  console.error(`FAIL: initial JS exceeds the ${BUDGET} byte budget (NFR-1)`);
  process.exit(1);
}
console.log("OK: within budget");
