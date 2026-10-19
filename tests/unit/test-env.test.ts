// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

/**
 * The component tests render App, whose effects register window listeners.
 *
 * preact/hooks flushes those effects on a frame when requestAnimationFrame
 * exists, and on a one-second debounce when it does not. The debounce is the
 * reason this file exists: a fast test file could end with an effect still
 * queued, and the late timer then ran against a torn-down document and threw an
 * unhandled ReferenceError — which failed the whole gate on CI, on a runner
 * quick enough to outrun a one-second timer, while passing everywhere slower.
 * That is a timing bug with no test to catch it, so the frame clock itself is
 * the assertion.
 */
describe("the component test environment", () => {
  it("has a frame clock, so preact does not fall back to its one-second debounce", () => {
    expect(typeof window.requestAnimationFrame).toBe("function");
    expect(typeof window.cancelAnimationFrame).toBe("function");
  });

  it("advances frames, so a queued effect cannot outlive the document", async () => {
    const stamp = await new Promise<number>((resolve) => {
      window.requestAnimationFrame(() => resolve(performance.now()));
    });
    expect(typeof stamp).toBe("number");
    expect(Number.isFinite(stamp)).toBe(true);
  });
});