/**
 * The gate. Every stage in package.json's `gate` list, in order, followed by the
 * README figures that run just measured.
 *
 *   node scripts/gate.mjs          # measure, then sync (check only under CI)
 *   node scripts/gate.mjs --check  # measure, then fail if README.md is stale
 *   node scripts/gate.mjs --write  # measure, then sync even under CI
 *
 * Why a runner and not the `&&` chain this used to be: the counts in README.md
 * are measurements, and the only way to take them in the same run that produces
 * them is to be the thing that runs the stages. A separate "update the figures"
 * script could only re-run the whole gate to re-derive numbers it had just
 * produced, which left them to be hand-edited in between.
 *
 * The stages themselves are still defined in exactly one place - package.json's
 * `gate` list, kept as data so the parity suite can read it and check that every
 * one of them is a real script, without importing this executable module.
 * `tests/unit/ci-parity.test.ts` also fails if the CI workflow ever spells the
 * stages out again, which is how CI once fell behind the gate.
 *
 * Under CI the figures are checked, never written: a stale README has to fail
 * the build rather than be silently corrected in a throwaway checkout. Every
 * leg of the CI matrix checks them - the same specs are collected on each
 * engine, so every leg measures the same numbers (see `figureMode`).
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyFigures, figureMode, formatFigures, parseFigures } from "./gate-figures.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readmePath = join(root, "README.md");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// `test-results/` is ignored by git. The full run output is kept there because
// when a figure cannot be read, that log is the only way to see what the tool
// actually printed.
const artifacts = join(root, "test-results");
mkdirSync(artifacts, { recursive: true });
const logPath = join(artifacts, "gate.log");

/** Everything the stages have printed, so the figures can be read back out. */
let output = "";

/** Stop, keeping the run output for diagnosis. Never returns. */
function die(message, code = 1) {
  if (output.length > 0) writeFileSync(logPath, output, "utf8");
  console.error(`\ngate: ${message}`);
  if (output.length > 0) console.error(`The full run output is in ${logPath}`);
  process.exit(code);
}

/** Run `fn`, or stop with its message. */
function orDie(fn) {
  try {
    return fn();
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
}

/* ---------------- the mode ---------------- */

// `process.env` is passed because which engines the e2e stage drives decides
// whether this run can describe the README's figures at all: a WebKit leg
// collects a smaller suite and is refused before a stage runs.
const mode = orDie(() =>
  figureMode({ args: process.argv.slice(2), ci: Boolean(process.env.CI), env: process.env }),
);

/* ---------------- the stages ---------------- */

const stages = pkg.gate;
if (!Array.isArray(stages) || stages.length === 0) {
  die("package.json has no `gate` stage list to run");
}

console.log(`gate: ${stages.map((script) => `npm run ${script}`).join(" -> ")}`);
if (mode === "check") console.log("figures: checking README.md (not writing)");

/**
 * One stage, with its output both streamed and kept. Streaming keeps a stage
 * that takes a minute (Playwright, the release audit) legible while it runs;
 * keeping is what the figures are read from.
 */
function run(script) {
  return new Promise((resolve) => {
    const child = spawn(`npm run ${script}`, {
      cwd: root,
      // npm is a shell alias here (npm.cmd on Windows), so the shell resolves it.
      shell: true,
      // The counts are read out of this text, so no colour codes wanted; they
      // are stripped when parsing anyway, because Vitest has been seen emitting
      // them even with NO_COLOR set.
      env: { ...process.env, NO_COLOR: "1" },
      // A tool that reads stdin gets EOF rather than hanging the gate.
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tee = (stream, sink) =>
      stream.on("data", (chunk) => {
        const text = chunk.toString();
        output += text;
        sink.write(text);
      });
    tee(child.stdout, process.stdout);
    tee(child.stderr, process.stderr);
    // A null code means the child was killed by a signal, which is not success.
    child.on("close", (code) => resolve(code ?? 1));
  });
}

for (const [index, script] of stages.entries()) {
  console.log(`\n[${index + 1}/${stages.length}] npm run ${script}`);
  const code = await run(script);
  // Stop at the first red stage, as the `&&` chain did, and write nothing: a red
  // gate would otherwise have its figures recorded as if they described this tree.
  if (code !== 0) {
    die(
      `stage \`npm run ${script}\` failed (exit ${code}); the README figures were not touched`,
      code,
    );
  }
}

/* ---------------- the figures ---------------- */

const figures = orDie(() => parseFigures(output));
const current = readFileSync(readmePath, "utf8");
const updated = orDie(() => applyFigures(current, figures));
const summary = formatFigures(figures);

if (updated === current) {
  console.log(`\nREADME.md is current: ${summary}`);
  process.exit(0);
}

if (mode === "check") {
  console.error(`\nREADME.md is stale. It should say: ${summary}`);
  console.error("Run `npm run ci` (or `npm run docs:figures`) to update it.");
  process.exit(1);
}

writeFileSync(readmePath, updated, "utf8");
console.log(`\nREADME.md updated: ${summary}`);
console.log("It was stale, so the working tree changed - commit README.md.");
