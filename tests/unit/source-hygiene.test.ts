import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Source hygiene: no control characters in the repository's text files.
 *
 * A control byte — a NUL above all — makes git treat the whole file as
 * binary, and a binary file is one nobody reviews: `git diff` prints
 * `Binary files differ`, so edits to it land in a commit unseen. This is
 * pinned because it happened: two literal NUL bytes reached
 * tests/unit/sinks.test.ts through a tool call, and the file went quiet
 * in diffs until a test count gave it away.
 *
 * The file list comes from git, so ignored and generated output
 * (`dist/`, `test-results/`) never enters it. Which files count as text
 * is decided by extension rather than by asking git, because git's own
 * verdict is the thing being tested: a file already carrying a NUL is
 * reported as binary and would simply be skipped, which would make the
 * check blind precisely where it has to see.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Tab, line feed, carriage return. Everything else below 0x20, plus DEL. */
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

/**
 * Formats that are binary by nature and are excluded from the scan. Skipping
 * a file is the conservative direction here — a missed hit is a smaller
 * failure than a gate that cries wolf on every new icon.
 */
const BINARY_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mp3",
  ".mp4",
  ".otf",
  ".pdf",
  ".png",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

/** Every tracked file that is not binary by extension. */
function trackedTextFiles(): string[] {
  const out = execSync("git ls-files", {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((file) => !BINARY_EXTENSIONS.has(extname(file).toLowerCase()));
}

describe("tracked sources", () => {
  it("keeps every text file free of control characters", () => {
    const offenders = trackedTextFiles().flatMap((file) => {
      const bytes = readFileSync(join(root, file));
      const hits: string[] = [];
      for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i]!;
        const control = byte < 0x20 || byte === 0x7f;
        if (control && !ALLOWED.has(byte)) {
          hits.push(`${file}: 0x${byte.toString(16).padStart(2, "0")} at byte ${i}`);
        }
      }
      return hits;
    });
    // A NUL hides the rest of the diff, so name every hit rather than the first.
    expect(offenders).toEqual([]);
  });
});
