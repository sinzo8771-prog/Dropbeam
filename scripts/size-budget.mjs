/**
 * PRD NFR-1: initial JS must stay under 150 KB gzipped (scanner/QR libs are
 * lazy-loaded and excluded from this budget; they are listed separately).
 */
import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
const BUDGET = 150 * 1024;

let files;
try {
  files = readdirSync(dist);
} catch {
  console.error("size: dist/ not found — run `npm run build` first");
  process.exit(1);
}

// Lazy chunks (scanner, hash worker) are excluded from the initial budget.
const isLazy = (name) => /scan|jsqr|worker|hash|frame/i.test(name);
const gzSize = (file) => gunzipSync(readFileSync(path.join(dist, file))).length;

const initial = files.filter((f) => f.endsWith(".js") && !isLazy(f));
const lazy = files.filter((f) => f.endsWith(".js") && isLazy(f));

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
