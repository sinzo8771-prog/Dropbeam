/**
 * PRD NFR-1: initial JS must stay under 150 KB gzipped (scanner/QR libs are
 * lazy-loaded and excluded from this budget; they are listed separately).
 *
 * Two numbers, because there are two questions. The **gzipped** size is what
 * a browser downloads, and it is the one NFR-1 is about, so it is the figure
 * the README quotes. The **uncompressed** size is what the code weighs, and
 * this project has been holding it to the same ceiling all along - so it stays
 * budgeted too, rather than being quietly dropped when the headline moved to
 * the compressed number.
 *
 * The two used to be confused: the script decompressed each asset and printed
 * the result labelled "B gz", so the published figure was the uncompressed
 * size wearing the gzip label - three times larger than the truth.
 */
import { readFileSync, readdirSync } from "node:fs";
import { statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
/** NFR-1's own budget, on the gzipped size. */
const GZIP_BUDGET = 150 * 1024;
/** The project's own stricter line, on the uncompressed size. */
const RAW_BUDGET = 150 * 1024;

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

// The assets in dist/ are not gzipped on disk - a static host compresses them
// on the way out - so the download size is computed here, with the same
// zlib level a server would use. The uncompressed size is what the code
// weighs.
const rawSize = (file) => readFileSync(path.join(dist, file)).length;

const gzSize = (file) => gzipSync(readFileSync(path.join(dist, file))).length;

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

let gzTotal = 0;
let rawTotal = 0;
for (const f of initial) {
  const gz = gzSize(f);
  gzTotal += gz;
  rawTotal += rawSize(f);
  console.log(`  initial  ${f.padEnd(40)} ${String(gz).padStart(7)} B gz`);
}
for (const f of lazy) {
  console.log(`  lazy     ${f.padEnd(40)} ${String(gzSize(f)).padStart(7)} B gz`);
}

console.log(`initial JS total: ${gzTotal} B gz (budget ${GZIP_BUDGET} B)`);
if (gzTotal > GZIP_BUDGET) {
  console.error(`FAIL: initial JS exceeds the ${GZIP_BUDGET} byte gzipped budget (NFR-1)`);
  process.exit(1);
}
console.log(`initial JS uncompressed: ${rawTotal} B (budget ${RAW_BUDGET} B)`);
if (rawTotal > RAW_BUDGET) {
  console.error(`FAIL: initial JS exceeds the ${RAW_BUDGET} byte uncompressed budget`);
  process.exit(1);
}
console.log("OK: within budget");
