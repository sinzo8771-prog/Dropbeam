/**
 * The gate's figures: read them out of a gate run's console output, and write
 * them into README.md.
 *
 * Pure functions, deliberately kept apart from the runner that produces the
 * output, so `tests/unit/gate-figures.test.ts` can drive them with synthetic
 * summaries instead of a 60-second gate run. `scripts/gate.mjs` is the caller.
 *
 * Why any of this exists: those counts were hand-maintained, and they went
 * stale three times in one day - three copies of the same number, drifting
 * independently, each one a claim nobody re-measured. A wrong number is worse
 * than no number, so every pattern here has to match exactly once and the
 * rewrite refuses to happen otherwise: the failure mode being designed out is
 * the silent no-op, which would quietly restore the hand-written problem.
 */

/**
 * The relationship this run has to the README's figures.
 *
 * - `write`: measure and update them. A developer's run, so the tree it leaves
 *   behind is correct.
 * - `check`: measure and fail if they disagree. CI, and the default anywhere CI
 *   is set - a stale README should fail the build rather than be silently
 *   corrected in a throwaway checkout.
 *
 * Precedence is the explicit flag, then where the run is. A typo or a
 * contradiction stops the run rather than falling back to a default, and that
 * decision lives here, so it is testable without running a gate.
 *
 * The one configuration that has no mode at all is a WebKit run, and it is
 * refused rather than accommodated. Playwright's WebKit build has no
 * `RTCPeerConnection`, so its project excludes the pairing spec and collects a
 * smaller suite: measured, that is fewer e2e tests than README.md states. A
 * `write` mode there would record those smaller numbers in README.md as if they
 * described the published suite — the wrong number the rest of this file exists
 * to prevent — and a `check` mode would fail for a difference that is not a
 * regression. So the run stops, naming the command that is meant for WebKit.
 *
 * The other engines need no such branch: the same specs are collected on each
 * of them, so every leg of the gate measures the same figures and can check
 * them.
 */
export function figureMode({ args = [], ci = false, env = {} } = {}) {
  const known = ["--check", "--write"];
  const unknown = args.filter((arg) => !known.includes(arg));
  if (unknown.length > 0) {
    throw new Error(
      `unknown argument: ${unknown.join(", ")} (expected ${known.join(", ")}, or nothing)`,
    );
  }
  if (args.length > 1) {
    throw new Error(`both ${args.join(" and ")} were given; they contradict each other`);
  }

  // Before the mode is chosen, because there is no mode this run could take.
  const engines = String(env.E2E_BROWSERS ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase());
  if (engines.includes("webkit")) {
    throw new Error(
      "E2E_BROWSERS names webkit, whose suite excludes the pairing spec (its build has no " +
        "RTCPeerConnection), so this run cannot measure the figures README.md states. Run " +
        "`npm run test:webkit` for the WebKit leg; the gate's figures come from `npm run ci`",
    );
  }

  if (args.length === 1) return args[0] === "--check" ? "check" : "write";
  return ci ? "check" : "write";
}

/**
 * Vitest emits its summary with escape sequences even into a pipe, so the codes
 * have to be stripped before the counts can be read: with them in place,
 * `Tests  305 passed (305)` arrives as
 * `ESC[2m      Tests ESC[22m ESC[1mESC[32m305 passed...` and matches nothing.
 * The pattern is assembled from a code point rather than written as a literal
 * escape, so this source carries no control character (eslint's
 * `no-control-regex` is right to object to one appearing inline).
 */
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

const clean = (text) => text.replace(/\r\n/g, "\n").replace(ANSI, "");

/**
 * The one match of `pattern`, or a stop. Two matches means the summary is
 * ambiguous and picking one would be worse than failing.
 */
function only(text, label, pattern) {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(
      `could not read ${label} from the gate output (${matches.length} matches). ` +
        `Either that tool's summary changed shape, or the stage that prints it is ` +
        `no longer in the gate's stage list`,
    );
  }
  return matches[0];
}

/**
 * The figures as the README states them, read from the output of a whole gate
 * run (every stage's output concatenated is fine: the patterns are anchored
 * full-line matches that only one stage in the chain produces).
 */
export function parseFigures(output) {
  const text = clean(output);
  const vitest = only(text, "the unit/integration total", /^\s*Tests\s+(\d+) passed \(\d+\)$/gm);
  const playwright = only(text, "the e2e total", /^\s*(\d+) passed \([\d.]+m?s\)$/gm);
  const size = only(
    text,
    "the initial JS size",
    /^initial JS total: (\d+) B gz \(budget (\d+) B\)$/gm,
  );
  const raw = only(
    text,
    "the initial JS size, uncompressed",
    /^initial JS uncompressed: (\d+) B \(budget (\d+) B\)$/gm,
  );

  const unitTests = Number(vitest[1]);
  const e2eTests = Number(playwright[1]);
  return {
    unitTests,
    e2eTests,
    totalTests: unitTests + e2eTests,
    // Decimal KB, matching the budget literal in scripts/size-budget.mjs: the
    // 150 * 1024 byte budget prints as 153.6 KB and the README has always
    // quoted it that way.
    initialKb: (Number(size[1]) / 1000).toFixed(1),
    budgetKb: (Number(size[2]) / 1000).toFixed(1),
    // The uncompressed size is the one the stricter budget is held to, so it is
    // published next to the download size: quoting only the compressed number
    // would read as three times the headroom there is.
    rawKb: (Number(raw[1]) / 1000).toFixed(1),
  };
}

/** One line describing the figures, for the runner's log. */
export function formatFigures(figures) {
  return (
    `${figures.totalTests} tests (${figures.unitTests} unit/integration + ` +
    `${figures.e2eTests} e2e), ${figures.initialKb} KB gz ` +
    `(${figures.rawKb} KB uncompressed) of ${figures.budgetKb} KB`
  );
}

/**
 * README.md with each figure replaced. Returns the text unchanged when it was
 * already correct, so the caller can use identity to decide whether to write.
 */
export function applyFigures(readme, figures) {
  // The one replacement below that crosses a line break has to re-emit the
  // file's own separator. It is derived from the file rather than captured by
  // the pattern because a replacer's arguments are positional, and getting that
  // order wrong is silent: the replacement lands, the digits are wrong, and only
  // a fixed-point check like the one at the end of the loop notices.
  const eol = readme.includes("\r\n") ? "\r\n" : "\n";

  /**
   * Where each figure appears, and what it becomes.
   *
   * Every pattern is a strict full-substring match rather than a line offset, so
   * a re-wrap by Prettier cannot break it, and replacing touches the matched
   * text only - no re-wrapping, so the result stays Prettier-stable. None of
   * them captures anything: what gets written depends on this run's figures
   * alone, never on the numbers being replaced, which is what makes applying a
   * replacement twice a fixed point.
   */
  const EDITS = [
    {
      label: "the Checks summary",
      find: /\d+ tests green \(\d+ unit\/integration \+ \d+ e2e\)/g,
      replace:
        `${figures.totalTests} tests green ` +
        `(${figures.unitTests} unit/integration + ${figures.e2eTests} e2e)`,
    },
    {
      label: "the size figure",
      find: /~[\d.]+ KB gz \([\d.]+ KB uncompressed\) against a [\d.]+ KB budget/g,
      replace:
        `~${figures.initialKb} KB gz (${figures.rawKb} KB uncompressed) ` +
        `against a ${figures.budgetKb} KB budget`,
    },
    {
      label: "the Status counts",
      // `\s+` spans the line break, so a re-wrap by Prettier cannot break the
      // match either.
      find: /covered by \d+ unit\/integration and\s+\d+ e2e tests/g,
      replace: `covered by ${figures.unitTests} unit/integration and${eol}${figures.e2eTests} e2e tests`,
    },
  ];

  let updated = readme;
  for (const edit of EDITS) {
    const matches = [...updated.matchAll(edit.find)];
    if (matches.length !== 1) {
      throw new Error(
        `README.md: ${edit.label} matched ${matches.length} times, expected 1. If the wording ` +
          `changed, update EDITS in scripts/gate-figures.mjs rather than editing the numbers by hand`,
      );
    }
    // A function replacement, so any `$` in the rendered text stays literal.
    updated = updated.replace(edit.find, () => edit.replace);

    // The rewrite has to remain findable by its own pattern: if the text it
    // wrote no longer matches the pattern meant to find it, the next run would
    // match nothing, abort, and hand the figure back to whoever edits by hand -
    // the exact failure this arrangement exists to remove. The rendering is
    // independent of the old text, so applying it to the result is a fixed point.
    const recheck = [...updated.matchAll(edit.find)];
    if (recheck.length !== 1 || updated.replace(edit.find, () => edit.replace) !== updated) {
      throw new Error(
        `README.md: ${edit.label} rewrite no longer matches its own pattern, so the next run ` +
          `could not update it`,
      );
    }
  }

  // A rewrite must not change the file's line-ending convention: a mixed-endings
  // file is a whole-file diff, and `readFileSync`/`writeFileSync` otherwise
  // preserve whatever is on disk.
  const crlf = (text) => (text.match(/\r\n/g) ?? []).length;
  if (crlf(updated) !== crlf(readme)) {
    throw new Error(
      `the rewrite changed README.md's line endings (${crlf(readme)} -> ${crlf(updated)} CRLF pairs)`,
    );
  }

  return updated;
}
