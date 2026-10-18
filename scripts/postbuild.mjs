/**
 * Stamps the build id and the precache list into the service worker.
 *
 * Two things have to be written after Vite runs, because neither exists until
 * it does: the build id (FR-50's update flow detects a new version by it) and
 * the list of hashed asset filenames the worker precaches (DoD 6). The second
 * is not cosmetic — see `public/sw.js` for why caching the shell alone leaves
 * the app's code-split chunks missing offline.
 *
 * Both are stamped as a rewrite of existing source lines rather than a
 * separate manifest, so the worker stays one same-origin non-module script at a
 * stable URL, which is what a service worker has to be.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
const swPath = path.join(dist, "sw.js");

/** The placeholder in `public/sw.js` that marks the line to rewrite. */
const PRECACHE_MARKER = "__PRECACHE__";

/**
 * Every emitted file in `dist`, as posix-relative paths.
 *
 * `dist` is the whole served tree, so this picks up the entry script, the CSS,
 * the code-split chunks, the worker script and the self-hosted fonts together —
 * which is the point: an asset nobody has requested yet is exactly the one that
 * would otherwise be missing when the network is gone.
 */
async function emittedFiles(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await emittedFiles(path.join(dir, entry.name), rel)));
    } else {
      files.push(rel);
    }
  }
  return files;
}

try {
  const sw = await readFile(swPath, "utf8");
  const buildId = `${Date.now().toString(36)}`;

  const shellLine = sw.split("\n").find((line) => line.startsWith("const SHELL = "));
  if (!shellLine || !shellLine.includes(PRECACHE_MARKER)) {
    // Failing loudly here is the point: a silent no-op would ship a worker whose
    // precache is still the shell alone, which is the bug this stamping exists
    // to fix, and it would look like a passing build.
    throw new Error(
      `postbuild: no const SHELL line carrying ${PRECACHE_MARKER} in dist/sw.js; ` +
        "the worker source and this script have drifted apart",
    );
  }

  const files = await emittedFiles(dist);
  const precache = [
    "./",
    ...files
      // The shell entry already caches the document; sw.js must not be
      // precached because the browser fetches the worker itself, through its
      // own update path, where a stale copy would be the wrong copy.
      .filter((file) => file !== "index.html" && file !== "sw.js")
      .map((file) => `./${file}`),
  ];
  const literal = `const SHELL = [${precache.map((url) => JSON.stringify(url)).join(", ")}];`;

  const stamped = sw
    .replace(/^const SHELL = \[[^\]]*\];$/m, literal)
    .replaceAll("__BUILD_ID__", buildId);

  await writeFile(swPath, stamped);
  console.log(
    `postbuild: stamped sw.js with build id ${buildId} and ${precache.length - 1} precached assets`,
  );
} catch (err) {
  if (err && err.code === "ENOENT") {
    console.log("postbuild: no dist/sw.js yet, skipping");
  } else {
    throw err;
  }
}
