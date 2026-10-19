import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CI parity: the workflow runs the gate, and the gate is defined once.
 *
 * This is pinned because it drifted. `.github/workflows/ci.yml` used to list
 * the stages itself, and that list fell behind `package.json`'s `ci` script —
 * it never ran `pwa:health`, so CI could go green on a gate that fails
 * locally, and nothing could notice, because the definition lived in two
 * places. The workflow now runs `npm run ci` verbatim, and this suite fails
 * if a stage is ever written out in the workflow again.
 *
 * The stages themselves are `package.json`'s `gate` list, run in order by
 * `scripts/gate.mjs`, which is also what takes the README's figures in the same
 * run that measures them. The list is data rather than a function so this suite
 * can read it without importing an executable module — the same reason the
 * workflow is read with a line regex instead of a YAML parser (the project
 * ships no YAML dependency, and a parser to guard one file of fixed shape would
 * cost more than it protects). The one shape that would defeat that reader — a
 * `run: |` block scalar, whose commands live on the following indented lines —
 * is rejected outright rather than skipped, so the checks below cannot pass
 * vacuously.
 *
 * A stage that stops printing one of the figures is caught by `scripts/gate.mjs`
 * itself: it cannot read that figure out of the run and stops, naming both
 * possible causes. What is pinned here is the wiring, not the numbers.
 *
 * The WebKit job is pinned here too, because it is the one job that runs e2e
 * specs without running the gate. It is scoped (its project excludes the pairing
 * spec), so it collects fewer tests than the README describes and cannot be a
 * matrix engine; it runs `test:webkit` on its own, on the schedule, with its own
 * browser installed first. Both halves of that arrangement are checked below, so
 * neither can drift back into the gate's figures.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
const pkg: { scripts: Record<string, string>; gate: string[] } = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
);
const scripts = pkg.scripts;
const stages = pkg.gate;

/** Every `run:` command in the workflow, in step order. */
function runCommands(yaml: string): string[] {
  return yaml
    .split(/\r?\n/)
    .map((line) => /^\s*-\s*run:\s*(.+?)\s*$/.exec(line)?.[1])
    .filter((command): command is string => typeof command === "string");
}

/** The stages as a user would invoke them — which is what the workflow must not do. */
const invocations = stages.map((stage) => `npm run ${stage}`);
const commands = runCommands(workflow);

describe("CI parity (the workflow and the local gate)", () => {
  it("parses both sides, so a broken reader cannot pass vacuously", () => {
    // If either side parses to nothing, every check below becomes trivially
    // true — an empty `stages` has no stage that could appear in the workflow.
    // Pin the shapes this suite relies on.
    expect(stages.length).toBeGreaterThanOrEqual(5);
    expect(commands.length).toBeGreaterThanOrEqual(3);
    expect(commands).toContain("npm run ci");
  });

  it("runs one shared runner, the only thing that reads the stage list", () => {
    // Three entry points, one runner. If `ci` and `docs:figures` ever drift onto
    // different commands, the figures stop being taken by the run that measures
    // them, which is the entire arrangement: a separate figure-only script can
    // only re-run the gate to re-derive numbers it just produced.
    for (const name of ["ci", "docs:figures", "docs:figures:check"]) {
      expect(scripts[name]).toContain("scripts/gate.mjs");
    }
  });

  it("keeps every workflow step a single-line run, which this reader requires", () => {
    // A block scalar would hide its commands from runCommands() and could
    // turn the parity checks into silent no-ops. The list-item form (`- run: |`)
    // is the shape a workflow step actually takes, so it has to be matched
    // too — a pattern anchored straight on `run:` misses the real thing.
    expect(workflow).not.toMatch(/^\s*(?:-\s*)?run:\s*[|>]/m);
  });

  it("names no gate stage itself, so the two lists cannot drift", () => {
    // The whole point: the workflow must not know what the stages are.
    expect(invocations.filter((stage) => commands.includes(stage))).toEqual([]);
  });

  it("names only scripts that exist", () => {
    // A rename in package.json that misses the `gate` list would otherwise fail
    // on the runner as a missing script instead of here.
    expect(stages.filter((stage) => scripts[stage] === undefined)).toEqual([]);
  });

  it("never lists a stage that runs the gate again", () => {
    // `ci` and `docs:figures` spawn the runner; a stage naming one of them would
    // recurse until the machine gave up.
    expect(stages.filter((stage) => (scripts[stage] ?? "").includes("gate.mjs"))).toEqual([]);
  });

  it("runs without a code change, on a schedule", () => {
    // A push or a PR only ever exercises the runner when something in this
    // repository changed. The runner environment drifts on its own — the Ubuntu
    // image, the Chromium build — and the nightly trigger is the only one that
    // sees that. It is also where the Linux half of the README's figures is
    // checked: a local run measures and writes them, CI verifies them.
    const triggers = /^on:\n([\s\S]*?)^jobs:/m.exec(workflow)?.[1] ?? "";
    // The anchor first: if that slice missed the trigger block, this fails
    // rather than the checks below passing against an empty string.
    expect(triggers).toContain("pull_request:");
    expect(triggers).toContain("schedule:");
    expect(triggers).toMatch(/cron:\s*"[^"]+"/);
  });

  it("can be dispatched by hand, so the schedule-only legs are reachable", () => {
    // The WebKit job is gated on the event name. Without a manual trigger there
    // is no way to run it except waiting for 03:17 UTC, so a mistake in that
    // job - a bad browser version, a renamed step, the job wired to the wrong
    // engine - would sit undiscovered for a day at a time, and a green nightly
    // would say nothing about whether the leg had ever executed.
    //
    // The other half of this is the job's own condition, pinned in the test
    // above. A trigger with no matching condition is the quieter failure of the
    // two: the workflow runs, the leg reports `skipped`, and it reads as health.
    const triggers = /^on:\n([\s\S]*?)^jobs:/m.exec(workflow)?.[1] ?? "";
    expect(triggers, "the workflow must have a trigger block").not.toBe("");
    expect(triggers).toContain("workflow_dispatch:");
  });

  it("installs the browser the gate needs, before the gate runs", () => {
    const needsBrowser = stages.some(
      (stage) => stage.includes("test:e2e") || stage.includes("audit:release"),
    );
    if (!needsBrowser) return;
    const install = commands.findIndex((command) => command.startsWith("npx playwright install"));
    const gate = commands.indexOf("npm run ci");
    expect(install).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(gate);
  });

  it("runs the WebKit leg on its own, off the gate, reachable by hand", () => {
    // The job's own slice, from its header to the end of the file: a line-level
    // reader cannot tell which job a step belongs to, and the point here is that
    // WebKit is *not* a leg of the matrix job above.
    const job = /^ {2}webkit:\n([\s\S]*)$/m.exec(workflow)?.[0] ?? "";
    expect(job, "the WebKit job must exist").not.toBe("");
    // Separate job rather than an engine axis entry: an axis entry would run the
    // gate on this engine, and its scoped suite cannot match the README figures.
    expect(job).not.toContain("matrix.");
    // Scheduled *or* dispatched. Both halves matter and they fail differently:
    // drop `workflow_dispatch` from the workflow and the leg is unreachable
    // until 03:17 UTC tomorrow; drop it from this condition and the leg is
    // unreachable ever, because a manual dispatch would skip the very job it was
    // dispatched to run. Neither failure shows up in a green nightly.
    expect(job).toMatch(
      /^\s*if:\s*github\.event_name == 'schedule'\s*\|\|\s*github\.event_name == 'workflow_dispatch'\s*$/m,
    );
    expect(job).toContain("npm run test:webkit");
    expect(job).toMatch(/E2E_BROWSERS:\s*webkit\s*$/m);
    // Its browser, installed before the run - the same ordering the gate leg has.
    const install = job.indexOf("npx playwright install --with-deps webkit");
    const run = job.indexOf("npm run test:webkit");
    expect(install).toBeGreaterThanOrEqual(0);
    expect(run).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(run);
  });

  it("keeps the WebKit runner out of the gate, which measures the README", () => {
    // `test:webkit` collects fewer tests than the README states, so a gate that
    // ran it would either fail the figure check for a structural reason or - in
    // a local `write` run - record the smaller count as the published one.
    // Widening the gate to include it fails here, by name.
    expect(scripts["test:webkit"]).toBeDefined();
    expect(stages).not.toContain("test:webkit");
  });

  it("runs the Firefox leg off the gate too, for the same reason", () => {
    // On the hosted Linux runner the engine cannot offer a local ICE candidate,
    // so its project excludes the pairing spec and collects fewer tests than
    // README.md states - the same situation the WebKit leg is in. A gate that
    // ran it would fail the figure check for a structural reason, and a local
    // `write` run would record the smaller count as the published one.
    //
    // The gate's other stages do not depend on the engine, so the Chromium
    // legs still run them on both Node lines; what this leg adds is the engine
    // on the platform no local run can prove.
    const job = /^ {2}build-and-test-firefox:\n([\s\S]*?)(?=^ {2}\S)/m.exec(workflow)?.[0] ?? "";
    expect(job, "the Firefox job must exist").not.toBe("");
    // A separate job, not an engine axis entry in the gate job: an axis entry
    // would run the gate on this engine. A Node matrix is fine - it is the
    // engine that has to stay out.
    expect(job).not.toContain("matrix.engine");
    // Scheduled *or* dispatched, for the reason the WebKit leg has it: a leg
    // that only runs at 03:17 UTC is a leg nobody can check. Drop the
    // dispatch from this condition and the leg is unreachable until tomorrow
    // morning - and nobody would notice, because the nightly would still run
    // it.
    expect(job).toMatch(
      /^\s*if:\s*github\.event_name == 'schedule'\s*\|\|\s*github\.event_name == 'workflow_dispatch'\s*$/m,
    );
    // Its own script name, which is what selects the engine, so the workflow
    // does not name one of the gate's stages.
    expect(job).toContain("npm run test:firefox");
    expect(job).not.toContain("npm run ci");
    expect(scripts["test:firefox"]).toBeDefined();
    expect(stages).not.toContain("test:firefox");
    // Its browser, installed before the run - the same ordering the gate leg has.
    const install = job.indexOf("npx playwright install --with-deps firefox");
    const run = job.indexOf("npm run test:firefox");
    expect(install).toBeGreaterThanOrEqual(0);
    expect(run).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(run);
    // And the gate job itself is Chromium, so the figures the README states are
    // the ones the gate measures.
    const gateJob = /^ {2}build-and-test:\n([\s\S]*?)(?=^ {2}\S)/m.exec(workflow)?.[0] ?? "";
    expect(gateJob).toContain("npm run ci");
    expect(gateJob).toMatch(/E2E_BROWSERS:\s*chromium\s*$/m);
  });
});
