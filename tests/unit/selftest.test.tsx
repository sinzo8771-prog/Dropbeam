// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { SelfTestScreen } from "../../src/ui/selftest";
import { translatorFor } from "../../src/core/platform/i18n";
import type { SelfTestResult } from "../../src/core/peer/self-test";

const t = translatorFor("en");

afterEach(cleanup);

describe("SelfTestScreen (FR-62: test my connection)", () => {
  it("runs on open and reports a pass with the measured time", async () => {
    const run = vi.fn(() => Promise.resolve<SelfTestResult>({ ok: true, ms: 42 }));
    render(<SelfTestScreen t={t} onBack={() => {}} onTroubleshoot={() => {}} run={run} />);
    expect(run).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText(/Pass\./)).toBeTruthy());
    expect(screen.getByText(/42 ms/)).toBeTruthy();
    const section = document.querySelector(".screen-selftest");
    expect(section?.getAttribute("data-result")).toBe("pass");
  });

  it("reports a fail with the failed stage as text, not colour alone", async () => {
    const run = vi.fn(() =>
      Promise.resolve<SelfTestResult>({ ok: false, ms: 5, stage: "gathering" }),
    );
    const onTroubleshoot = vi.fn();
    render(<SelfTestScreen t={t} onBack={() => {}} onTroubleshoot={onTroubleshoot} run={run} />);
    await waitFor(() => expect(screen.getByText(/Fail\./)).toBeTruthy());
    expect(screen.getByText(/No network path was found\./)).toBeTruthy();
    expect(document.querySelector(".screen-selftest")?.getAttribute("data-result")).toBe("fail");
    // A failed run offers the troubleshooting page.
    fireEvent.click(screen.getByText("Troubleshooting"));
    expect(onTroubleshoot).toHaveBeenCalledTimes(1);
  });

  it("re-runs on demand after the first attempt settles", async () => {
    const run = vi.fn(() => Promise.resolve<SelfTestResult>({ ok: true, ms: 1 }));
    render(<SelfTestScreen t={t} onBack={() => {}} onTroubleshoot={() => {}} run={run} />);
    await waitFor(() => expect(screen.getByText(/Pass\./)).toBeTruthy());
    fireEvent.click(screen.getByText("Run test"));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  });

  it("stays silent about results after unmount (no stray state updates)", async () => {
    // Holder object: a plain `let` would be narrowed to `null` at the
    // call site, since the assignment happens inside the executor.
    const deferred: { resolve: ((r: SelfTestResult) => void) | null } = { resolve: null };
    const run = vi.fn(
      () =>
        new Promise<SelfTestResult>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    const { unmount } = render(
      <SelfTestScreen t={t} onBack={() => {}} onTroubleshoot={() => {}} run={run} />,
    );
    expect(screen.getByText(/Testing…/)).toBeTruthy();
    unmount();
    deferred.resolve?.({ ok: true, ms: 1 });
    // Nothing to assert beyond "no throw": the effect's cancellation
    // guard must swallow the late resolution.
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
