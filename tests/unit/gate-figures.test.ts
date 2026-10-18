import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyFigures,
  figureMode,
  formatFigures,
  type GateFigures,
  parseFigures,
} from "../../scripts/gate-figures.mjs";

/**
 * The README's gate figures are measurements, taken by `scripts/gate.mjs` out
 * of the run it just performed. These are its two fragile halves, tested
 * directly instead of through a 60-second gate run:
 *
 * - reading the counts out of the stages' console output, which is where the
 *   numbers come from and the part that a tool's release notes can break;
 * - rewriting the README, which must edit digits and nothing else, and must
 *   refuse rather than guess whenever a pattern does not match exactly once.
 *
 * The failure mode being designed out is the silent no-op: a rewrite that
 * quietly stops applying would hand the numbers back to whoever edits the file
 * by hand, which is how they went stale three times in one day.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** The three summaries, as one gate run concatenates them. */
const OUTPUT = [
  "> dropbeam@1.0.0 test",
  "> vitest run",
  "",
  " Test Files  28 passed (28)",
  "      Tests  305 passed (305)",
  "   Duration  12.34s",
  "",
  "> dropbeam@1.0.0 test:e2e",
  "> playwright test",
  "",
  "  13 passed (25.3s)",
  "",
  "> dropbeam@1.0.0 size",
  "> node scripts/size-budget.mjs",
  "  initial  assets/index-Ck3n.js                135100 B gz",
  "initial JS total: 135100 B gz (budget 153600 B)",
  "",
].join("\n");

const FIGURES: GateFigures = {
  unitTests: 305,
  e2eTests: 13,
  totalTests: 318,
  initialKb: "135.1",
  budgetKb: "153.6",
};

/** The figure-bearing sentences of README.md, with deliberately wrong numbers. */
const README = [
  "Current gate: 300 tests green (287 unit/integration + 13 e2e), initial JS",
  "~130.0 KB gz against a 150.0 KB budget, and a network audit.",
  "",
  "shell, and the release audit are all covered by 287 unit/integration and",
  "13 e2e tests, plus the documented manual matrix.",
].join("\n");

describe("gate figures (what a run does with them)", () => {
  it("writes locally and checks under CI", () => {
    expect(figureMode({})).toBe("write");
    expect(figureMode({ ci: true })).toBe("check");
  });

  it("lets an explicit flag override where the run is", () => {
    expect(figureMode({ args: ["--check"], ci: false })).toBe("check");
    expect(figureMode({ args: ["--write"], ci: true })).toBe("write");
  });

  it("refuses a typo or a contradiction instead of falling back to a default", () => {
    expect(() => figureMode({ args: ["--chek"] })).toThrow(/unknown argument: --chek/);
    expect(() => figureMode({ args: ["--check", "--write"] })).toThrow(/contradict each other/);
  });

  it("refuses a WebKit run, which cannot measure these figures", () => {
    // WebKit's project excludes the pairing spec, so its suite is smaller than
    // README.md describes. A write mode there would record the smaller count as
    // the published one - the wrong number this whole arrangement exists to
    // prevent - and a check mode would fail on a difference that is not a
    // regression. So the run stops, naming the command that is meant for WebKit.
    expect(() => figureMode({ env: { E2E_BROWSERS: "webkit" } })).toThrow(/npm run test:webkit/);
    expect(() => figureMode({ env: { E2E_BROWSERS: "webkit" }, ci: true })).toThrow(
      /cannot measure the figures/,
    );
    // Spaced, cased, or among other engines: still a WebKit run.
    expect(() => figureMode({ env: { E2E_BROWSERS: "chromium, WEBKIT " } })).toThrow(/webkit/);
    // The engines the gate does drive are unaffected.
    expect(figureMode({ env: { E2E_BROWSERS: "firefox" } })).toBe("write");
    expect(figureMode({ env: { E2E_BROWSERS: "chromium,firefox" }, ci: true })).toBe("check");
    expect(figureMode({ env: {} })).toBe("write");
  });
});

describe("gate figures (read out of a gate run)", () => {
  it("reads all three figures from one run's combined output", () => {
    // A `Test Files  28 passed (28)` line sits above the count that is wanted;
    // the patterns are anchored full-line matches, so it cannot be mistaken for
    // the Playwright total.
    expect(parseFigures(OUTPUT)).toEqual(FIGURES);
  });

  it("reads through the escape codes Vitest emits even into a pipe", () => {
    // This is not hypothetical: with the codes left in, the summary line reads
    // `ESC[2m      Tests ESC[22m...` and matches nothing at all.
    const [testFiles, tests] = [
      "\u001b[2m Test Files \u001b[22m\u001b[1m\u001b[32m28 passed\u001b[39m\u001b[22m\u001b[90m (28)\u001b[39m",
      "\u001b[2m      Tests \u001b[22m\u001b[1m\u001b[32m305 passed\u001b[39m\u001b[22m\u001b[90m (305)\u001b[39m",
    ];
    const coloured = OUTPUT.replace(" Test Files  28 passed (28)", testFiles).replace(
      "      Tests  305 passed (305)",
      tests,
    );
    expect(coloured).not.toBe(OUTPUT);
    expect(parseFigures(coloured)).toEqual(FIGURES);
  });

  it("refuses an ambiguous summary instead of picking one", () => {
    // Two counts of the same kind means the shape changed under it; guessing
    // which one counts is how a wrong number gets written down.
    expect(() => parseFigures(`${OUTPUT}      Tests  4 passed (4)\n`)).toThrow(
      /the unit\/integration total/,
    );
  });

  it("names a missing figure, and the likeliest reason it is missing", () => {
    const withoutE2e = OUTPUT.replace("  13 passed (25.3s)\n", "");
    expect(() => parseFigures(withoutE2e)).toThrow(/the e2e total/);
    // Both causes are worth naming: the tool's summary may have changed, or the
    // stage that prints it may have left the gate's stage list.
    expect(() => parseFigures(withoutE2e)).toThrow(/no longer in the gate's stage list/);
  });
});

describe("gate figures (written into README.md)", () => {
  it("rewrites every place a figure appears, and nothing else", () => {
    const updated = applyFigures(README, FIGURES);
    expect(updated).toBe(
      [
        "Current gate: 318 tests green (305 unit/integration + 13 e2e), initial JS",
        "~135.1 KB gz against a 153.6 KB budget, and a network audit.",
        "",
        "shell, and the release audit are all covered by 305 unit/integration and",
        "13 e2e tests, plus the documented manual matrix.",
      ].join("\n"),
    );
  });

  it("is a fixed point, so a current README is left alone", () => {
    // Identity is what the runner uses to decide whether to write at all, and
    // the second application proves the rewrite still matches its own patterns.
    const updated = applyFigures(README, FIGURES);
    expect(applyFigures(updated, FIGURES)).toBe(updated);
    expect(applyFigures(updated, FIGURES)).toBe(updated);
  });

  it("keeps the line endings it was given, including across the wrapped sentence", () => {
    // A whole-file diff is the failure here: on a CRLF checkout, emitting a bare
    // "\n" for the one pattern that spans a line break would leave the file with
    // mixed endings. The separator is captured and re-emitted for that reason.
    const crlfReadme = README.replace(/\n/g, "\r\n");
    const updated = applyFigures(crlfReadme, FIGURES);
    expect(updated.match(/\r\n/g) ?? []).toHaveLength((README.match(/\n/g) ?? []).length);
    expect(updated).toContain("covered by 305 unit/integration and\r\n13 e2e tests");
    expect(updated.replace(/\r\n/g, "\n")).toBe(applyFigures(README, FIGURES));
  });

  it("refuses a README whose wording moved, rather than editing nothing", () => {
    // The abort path is the important one: a pattern that matches zero times
    // must stop the run, not pass silently.
    const reworded = README.replace("Current gate: 300 tests green", "Everything green:");
    expect(() => applyFigures(reworded, FIGURES)).toThrow(/the Checks summary matched 0 times/);
  });

  it("still finds the sentences it edits in the real README", () => {
    // Pins the coupling between this module and the document: rewording those
    // three sentences fails here rather than at the end of a gate run.
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(() => applyFigures(readme, FIGURES)).not.toThrow();
  });

  it("describes the figures in one line", () => {
    expect(formatFigures(FIGURES)).toBe(
      "318 tests (305 unit/integration + 13 e2e), 135.1 KB gz of 153.6 KB",
    );
  });
});
