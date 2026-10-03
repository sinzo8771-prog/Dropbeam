/**
 * Stamps the build id into the service worker so the update flow (FR-50) can
 * detect a new version. Runs after `vite build`.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const swPath = path.join(root, "dist", "sw.js");

try {
  const sw = await readFile(swPath, "utf8");
  const buildId = `${Date.now().toString(36)}`;
  await writeFile(swPath, sw.replaceAll("__BUILD_ID__", buildId));
  console.log(`postbuild: stamped sw.js with build id ${buildId}`);
} catch (err) {
  if (err && err.code === "ENOENT") {
    console.log("postbuild: no dist/sw.js yet, skipping");
  } else {
    throw err;
  }
}
