import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { engineList, projectsFor } from "../../playwright.config";

/**
 * Which engines the e2e stage drives, and what it drives on each of them.
 *
 * The default has to stay Chromium alone: the README's figures are taken from a
 * default gate run, and a default that quietly grew a second engine would double
 * the e2e count - each project collects the same specs, so a second engine is a
 * second project and twice the tests. Every gate leg still measures the same
 * figures it checks, because each leg drives exactly one engine.
 *
 * WebKit is the exception that proves that rule, and the reason it is scoped
 * rather than refused. It cannot run the pairing spec - the Windows build has no
 * `RTCPeerConnection` at all and the Linux build's has never been put through a
 * real peer connection - and it cannot navigate while the network is emulated
 * down, which is what the offline spec needs. So it collects fewer tests than the
 * README states. Rather than start a run that would fail for a cause nobody here
 * can fix (the old behaviour) or quietly test Chromium under WebKit's name, its
 * project excludes those two specs and is kept off the gate: the scheduled and
 * dispatched jobs run `npm run test:webkit`, and `scripts/gate-figures.mjs`
 * refuses a WebKit gate run outright.
 *
 * What is pinned below is the shape of that arrangement: the excluded specs are
 * named explicitly and self-update as specs are added, the default and the nightly
 * legs are untouched, and the engine name a run is asked for is the engine it gets
 * — including the script-name fallback that makes `npm run test:webkit` mean
 * WebKit on any platform.
 *
 * The refusals matter as much as the happy path: a misspelled engine name has to
 * stop the run, because a widened run that silently tested Chromium anyway would
 * report the coverage it was supposed to add.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const specDir = join(root, "tests/e2e");

describe("e2e engine selection", () => {
  it("defaults to Chromium alone", () => {
    expect(projectsFor(engineList({})).map((project) => project.name)).toEqual(["chromium"]);
  });

  it("drives the engines it is given, in the order given", () => {
    expect(projectsFor("chromium,firefox").map((project) => project.name)).toEqual([
      "chromium",
      "firefox",
    ]);
    expect(projectsFor(" firefox , chromium ").map((project) => project.name)).toEqual([
      "firefox",
      "chromium",
    ]);
  });

  it("runs each engine once however it was spelled", () => {
    expect(projectsFor("chromium,CHROMIUM, chromium").map((project) => project.name)).toEqual([
      "chromium",
    ]);
  });

  it("resolves the engine from E2E_BROWSERS, then from the script name", () => {
    // `E2E_BROWSERS` is how CI names the leg and how a developer asks for the
    // second engine locally; it wins whenever it is set.
    expect(engineList({ E2E_BROWSERS: "firefox" })).toBe("firefox");
    expect(engineList({ E2E_BROWSERS: "webkit", npm_lifecycle_event: "test:e2e" })).toBe("webkit");
    // `npm run test:webkit` has to mean WebKit. A script that quietly ran
    // Chromium instead would be the widest possible gap between what a command
    // says and what it does, and this project has no cross-platform way to set
    // the variable inside the script itself.
    expect(engineList({ npm_lifecycle_event: "test:webkit" })).toBe("webkit");
    // The same for the Firefox leg, which is a job of its own for the same
    // reason the WebKit one is: its suite is smaller, so it cannot be a leg of
    // the gate.
    expect(engineList({ npm_lifecycle_event: "test:firefox" })).toBe("firefox");
    // Every other invocation - the gate's own `test:e2e`, a bare
    // `npx playwright test` - is the default engine.
    expect(engineList({ npm_lifecycle_event: "test:e2e" })).toBe("chromium");
    expect(engineList({ npm_lifecycle_event: "ci" })).toBe("chromium");
  });

  it("scopes WebKit to the specs its build cannot run", () => {
    const [project] = projectsFor("webkit");
    // The browser actually launched, not just the project's name: the device
    // descriptor is what sets `defaultBrowserType`.
    expect(project?.name).toBe("webkit");
    expect(project?.use.defaultBrowserType).toBe("webkit");
    expect(project?.testIgnore).toBeInstanceOf(RegExp);

    // Self-updating on purpose: whatever specs exist, the excluded ones are
    // listed here explicitly, so a widened ignore list fails here rather than on
    // a runner — and so a new spec cannot silently fall outside the run. Sorted
    // on both sides because `readdirSync` order is a filesystem detail.
    const specs = readdirSync(specDir)
      .filter((name) => name.endsWith(".spec.ts"))
      .sort();
    expect(specs.length).toBeGreaterThanOrEqual(6);
    const ignore = project?.testIgnore as RegExp;
    const excluded = specs.filter((name) => ignore.test(name));
    expect(excluded).toEqual([
      // Cannot navigate with the network emulated down. Service workers work on
      // this engine; navigating offline does not, which is what DoD 6 needs.
      "offline.spec.ts",
      // Never paired on either build: absent on Windows, unproven on Linux.
      "pairing-transfer.spec.ts",
    ]);
  });

  it("leaves the engines that can pair whole", () => {
    // Chromium runs every spec in the directory - no per-engine skip, since a
    // skip is what would make its counts disagree with the README. Firefox
    // does too, except on Linux, where the runner's engine cannot gather a
    // local candidate at all; the next test covers that.
    for (const project of projectsFor("chromium")) {
      expect(project.testIgnore).toBeUndefined();
    }
    const [firefox] = projectsFor("firefox");
    if (process.platform === "linux") {
      expect(firefox?.testIgnore).toBeInstanceOf(RegExp);
    } else {
      expect(firefox?.testIgnore).toBeUndefined();
    }
  });

  it("excludes the pairing spec from Firefox on Linux, and only there", () => {
    // The hosted Linux runner's Firefox goes straight to `failed` before
    // gathering starts, so the pairing specs cannot pair there and the app
    // reports ICE_GATHER_TIMEOUT. The exclusion is per project rather than a
    // skip inside the file, because a skip hides the fact that this engine
    // collects a smaller suite - and that difference is what keeps the Firefox
    // leg off the gate's figure check. On Windows the spec still runs.
    const [firefox] = projectsFor("firefox");
    const ignore = firefox?.testIgnore as RegExp | undefined;
    if (process.platform === "linux") {
      expect(ignore).toBeInstanceOf(RegExp);
      expect(ignore?.test("pairing-transfer.spec.ts")).toBe(true);
      // Nothing else is excluded: the rest of the suite is exactly what
      // Firefox can run here.
      const others = readdirSync(specDir)
        .filter((name) => name.endsWith(".spec.ts"))
        .filter((name) => name !== "pairing-transfer.spec.ts");
      expect(others.filter((name) => ignore?.test(name))).toEqual([]);
    } else {
      expect(ignore).toBeUndefined();
    }
  });

  it("launches Firefox without host-candidate obfuscation", () => {
    // Firefox mDNS-obfuscates its host ICE candidates by default, which leaves
    // them as `.local` names that the other end has to resolve over multicast.
    // The specs here pair two contexts on one machine, where a name that has
    // to be resolved is one more thing that can fail for reasons that have
    // nothing to do with the app, so the suite asks for plain addresses.
    //
    // This preference is not what makes Firefox work on the hosted runner -
    // it does not (see the exclusion above, and docs/INTEROP.md): it is here
    // because plain candidates are the ones a loopback pairing can use.
    const [project] = projectsFor("firefox");
    const use = project?.use as unknown as {
      launchOptions?: { firefoxUserPrefs?: Record<string, unknown> };
    };
    expect(use?.launchOptions?.firefoxUserPrefs).toMatchObject({
      "media.peerconnection.ice.obfuscate_host_addresses": false,
    });
  });

  it("refuses an unknown engine, and an empty list", () => {
    expect(() => projectsFor("chromium,chrome")).toThrow(/chrome, which is not/);
    expect(() => projectsFor("webkit,chrome")).toThrow(/chrome, which is not/);
    expect(() => projectsFor(" , ")).toThrow(/E2E_BROWSERS is empty/);
  });
});
