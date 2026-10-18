// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import {
  DebugGesture,
  DebugPanel,
  TAP_WINDOW_MS,
  type DebugSessionMetrics,
} from "../../src/ui/debug";
import { translatorFor } from "../../src/core/platform/i18n";

afterEach(cleanup);

const t = translatorFor("en");

/** Session metrics with a neutral default, overridden per test. */
function session(overrides: Partial<DebugSessionMetrics> = {}): DebugSessionMetrics {
  return {
    state: "IDLE",
    protocol: null,
    channel: "none",
    filesInFlight: 0,
    verified: false,
    ...overrides,
  };
}

/** Minimal CacheStorage stand-in: fixed cache names and entry count. */
function fakeCaches(names: string[], entries = 1): CacheStorage {
  return {
    keys: async () => names,
    open: async () => ({
      keys: async () => Array.from({ length: entries }, (_, i) => `/shell-${i}`),
    }),
  } as unknown as CacheStorage;
}

/** jsdom has no caches/serviceWorker; install per-test stand-ins. */
function stubCaches(storage: CacheStorage | undefined): void {
  Object.defineProperty(navigator, "caches", { value: storage, configurable: true });
}

function stubServiceWorker(controller: unknown): void {
  Object.defineProperty(navigator, "serviceWorker", {
    value: { controller },
    configurable: true,
  });
}

/** The panel's rows as label/value/health triples. */
function panelRows(container: Element) {
  return [...container.querySelectorAll(".debug-panel-row")].map((row) => ({
    label: row.querySelector(".label")?.textContent ?? "",
    value: row.querySelector(".value")?.textContent ?? "",
    health: row.getAttribute("data-health"),
  }));
}

function row(container: Element, label: string) {
  return panelRows(container).find((r) => r.label === label);
}

describe("DebugPanel (FR-50)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    // `delete`, not `vi.unstubAllGlobals`: this one is defined by hand so the
    // app's own `isFsaSupported` sees exactly what the app would see.
    delete (globalThis as Record<string, unknown>).showSaveFilePicker;
    stubCaches(undefined);
    stubServiceWorker(null);
    stubCapabilities({});
  });

  /**
   * Stub the capabilities the panel reads: the globals the app's own detection
   * functions test (`RTCPeerConnection`, `showSaveFilePicker`, OPFS), so the
   * panel reports a stubbed browser exactly as it would report that browser.
   * `opfs` is a directory stand-in: deadline pending, working, or unwritable.
   */
  function stubCapabilities(opts: {
    webrtc?: boolean;
    fsa?: boolean;
    opfs?: "working" | "unwritable" | "pending";
  }): void {
    if (opts.webrtc) vi.stubGlobal("RTCPeerConnection", class {});
    if (opts.fsa) {
      Object.defineProperty(globalThis, "showSaveFilePicker", {
        value: () => {},
        configurable: true,
      });
    }
    if (!opts.opfs) {
      Object.defineProperty(navigator, "storage", { value: undefined, configurable: true });
      return;
    }
    const getDirectory = async () => {
      if (opts.opfs === "pending") return new Promise(() => {});
      return {
        getDirectoryHandle: async () => ({
          getFileHandle: async () => ({
            createWritable: async () => {
              if (opts.opfs === "unwritable") throw new Error("unknown error");
              return { write: async () => {}, close: async () => {} };
            },
          }),
          removeEntry: async () => {},
        }),
      };
    };
    Object.defineProperty(navigator, "storage", { value: { getDirectory }, configurable: true });
  }

  it("reports build id, service worker and cache health", async () => {
    stubCaches(fakeCaches(["dropbeam-muvjey82"], 4));
    stubServiceWorker({});
    const { container } = render(
      <DebugPanel
        session={session({
          state: "CONNECTED",
          protocol: 3,
          channel: "open",
          filesInFlight: 2,
          verified: true,
        })}
        t={t}
        onClose={() => {}}
      />,
    );
    // Build id and cache contents land asynchronously (the cache API
    // is promise-based even for the synchronous stand-in). Wait on
    // the row values themselves: "uncontrolled" contains the
    // substring "controlled", so a text match would pass too early.
    await waitFor(() => {
      expect(row(container, "Build id")?.value).toBe("muvjey82");
      expect(row(container, "Service worker")?.value).toBe("controlled");
      expect(row(container, "Cache")?.value).toBe("ok");
    });

    expect(container.querySelector(".debug-panel")?.getAttribute("role")).toBe("region");
    expect(container.querySelector(".debug-panel")?.getAttribute("aria-label")).toBe("Debug panel");

    // The build id row carries no health flag: it is a fact, not a status.
    expect(row(container, "Build id")).toEqual({
      label: "Build id",
      value: "muvjey82",
      health: null,
    });
    expect(row(container, "Service worker")).toEqual({
      label: "Service worker",
      value: "controlled",
      health: "good",
    });
    expect(row(container, "Cache")).toEqual({
      label: "Cache",
      value: "ok",
      health: "good",
    });
    expect(row(container, "Connection state")).toEqual({
      label: "Connection state",
      value: "CONNECTED",
      health: null,
    });
    expect(row(container, "Protocol")).toEqual({
      label: "Protocol",
      value: "v3",
      health: null,
    });
    expect(row(container, "Channel")).toEqual({
      label: "Channel",
      value: "open",
      health: "good",
    });
    expect(row(container, "Files in flight")).toEqual({
      label: "Files in flight",
      value: "2",
      health: null,
    });
    expect(row(container, "Verified")).toEqual({
      label: "Verified",
      value: "yes",
      health: null,
    });
  });

  it("flags a degraded session with warn health", async () => {
    stubCaches(fakeCaches(["dropbeam-empty"], 0));
    stubServiceWorker(null);
    const { container } = render(<DebugPanel session={session()} t={t} onClose={() => {}} />);
    // Wait on the row values: the build id takes the cache name
    // ("empty") before the slower cache-contents read lands.
    await waitFor(() => {
      expect(row(container, "Service worker")?.value).toBe("uncontrolled");
      expect(row(container, "Cache")?.value).toBe("empty");
    });

    expect(row(container, "Service worker")).toEqual({
      label: "Service worker",
      value: "uncontrolled",
      health: "warn",
    });
    expect(row(container, "Cache")).toEqual({ label: "Cache", value: "empty", health: "warn" });
    expect(row(container, "Connection state")?.value).toBe("IDLE");
    expect(row(container, "Protocol")?.value).toBe("—");
    expect(row(container, "Channel")).toEqual({
      label: "Channel",
      value: "none",
      health: "warn",
    });
    expect(row(container, "Files in flight")?.value).toBe("0");
    expect(row(container, "Verified")?.value).toBe("no");
  });

  it("reports a missing cache when no dropbeam cache exists", async () => {
    stubCaches(fakeCaches(["some-other-app"]));
    stubServiceWorker(null);
    const { container } = render(<DebugPanel session={session()} t={t} onClose={() => {}} />);
    await waitFor(() => expect(container.textContent).toContain("missing"));
    expect(row(container, "Cache")).toEqual({
      label: "Cache",
      value: "missing",
      health: "warn",
    });
  });

  it("falls back to 'dev' when no cache API exists in dev mode", async () => {
    // jsdom and Node both lack `caches`, so the panel must say
    // "dev" rather than pretend to know a stamped build id.
    stubCaches(undefined);
    stubServiceWorker(null);
    vi.stubEnv("DEV", true);
    const { container } = render(<DebugPanel session={session()} t={t} onClose={() => {}} />);
    await waitFor(() => expect(row(container, "Build id")?.value).toBe("dev"));
    // The rest of the PWA health is still reported honestly.
    expect(row(container, "Service worker")?.value).toBe("uncontrolled");
    expect(row(container, "Cache")?.value).toBe("missing");
  });

  it("shows no build id outside dev mode when no cache API exists", async () => {
    // The complement of the fallback: in a production build with
    // no cache API, the panel must not invent a build id either.
    stubCaches(undefined);
    stubServiceWorker(null);
    vi.stubEnv("DEV", false);
    const { container } = render(<DebugPanel session={session()} t={t} onClose={() => {}} />);
    await waitFor(() => expect(row(container, "Service worker")?.value).toBe("uncontrolled"));
    expect(row(container, "Build id")?.value).toBe("—");
  });

  it("reports what this browser can do, from the app's own detection", async () => {
    stubCaches(fakeCaches(["dropbeam-muvjey82"]));
    stubServiceWorker({});
    stubCapabilities({ webrtc: true, fsa: true, opfs: "working" });
    const { container } = render(<DebugPanel session={session()} t={t} onClose={() => {}} />);

    // The write probe is asynchronous, so the rows are waited on: the sink and
    // the three detections are known on the first render.
    await waitFor(() => expect(row(container, "OPFS write")?.value).toBe("ok"));
    expect(row(container, "WebRTC")).toEqual({
      label: "WebRTC",
      value: "yes",
      health: "good",
    });
    expect(row(container, "File System Access")).toEqual({
      label: "File System Access",
      value: "yes",
      health: "good",
    });
    expect(row(container, "OPFS")).toEqual({ label: "OPFS", value: "yes", health: "good" });
    expect(row(container, "OPFS write")).toEqual({
      label: "OPFS write",
      value: "ok",
      health: "good",
    });
    // The sink row is chooseSink()'s own answer: with File System Access
    // present that is the picker path, not the fallbacks below it.
    expect(row(container, "Save sink")).toEqual({
      label: "Save sink",
      value: "fsa",
      health: "good",
    });
  });

  it("flags a browser that can only stage in memory", async () => {
    stubCaches(fakeCaches(["dropbeam-muvjey82"]));
    stubServiceWorker({});
    stubCapabilities({});
    const { container } = render(<DebugPanel session={session()} t={t} onClose={() => {}} />);

    // No OPFS at all: the write row says there is nothing to write to, and the
    // reachability row above it carries the warning rather than both.
    await waitFor(() => expect(row(container, "Save sink")?.value).toBe("memory"));
    expect(row(container, "WebRTC")).toEqual({ label: "WebRTC", value: "no", health: "warn" });
    expect(row(container, "File System Access")).toEqual({
      label: "File System Access",
      value: "no",
      health: "warn",
    });
    expect(row(container, "OPFS")).toEqual({ label: "OPFS", value: "no", health: "warn" });
    expect(row(container, "OPFS write")).toEqual({
      label: "OPFS write",
      value: "n/a",
      health: null,
    });
    expect(row(container, "Save sink")).toEqual({
      label: "Save sink",
      value: "memory",
      health: "warn",
    });
  });

  it("reports the split between OPFS reachable and OPFS writable", async () => {
    // The measured WebKit shape: the namespace is there and every write throws.
    // Reachability alone would report a healthy sink that cannot save a byte,
    // which is the whole reason these are two rows.
    stubCaches(fakeCaches(["dropbeam-muvjey82"]));
    stubServiceWorker({});
    stubCapabilities({ webrtc: true, opfs: "unwritable" });
    const { container } = render(<DebugPanel session={session()} t={t} onClose={() => {}} />);

    await waitFor(() => expect(row(container, "OPFS write")?.value).toBe("fails"));
    expect(row(container, "OPFS")).toEqual({ label: "OPFS", value: "yes", health: "good" });
    expect(row(container, "OPFS write")).toEqual({
      label: "OPFS write",
      value: "fails",
      health: "warn",
    });
    // The sink the app would take is still OPFS - it is selected by
    // reachability, which is why the contradiction is worth reporting.
    expect(row(container, "Save sink")?.value).toBe("opfs");
  });

  it("keeps the write row unknown until the probe answers", async () => {
    stubCaches(fakeCaches(["dropbeam-muvjey82"]));
    stubServiceWorker({});
    stubCapabilities({ opfs: "pending" });
    const { container } = render(<DebugPanel session={session()} t={t} onClose={() => {}} />);

    // A panel that guessed "ok" while probing would be reporting a fact it
    // does not have yet.
    expect(row(container, "OPFS write")).toEqual({
      label: "OPFS write",
      value: "—",
      health: null,
    });
  });

  it("closes from the Close button", () => {
    stubCaches(fakeCaches(["dropbeam-muvjey82"]));
    stubServiceWorker({});
    const onClose = vi.fn();
    render(<DebugPanel session={session()} t={t} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/**
 * A pointerdown at the given x. jsdom has no PointerEvent, and the
 * gesture handler only reads `clientX`, so a plain event with the
 * property defined is enough.
 */
function tap(target: EventTarget, clientX: number): void {
  const event = new Event("pointerdown", { bubbles: true });
  Object.defineProperty(event, "clientX", { value: clientX });
  target.dispatchEvent(event);
}

/** A tap on the right 52 px of the screen, the gesture's target zone. */
function edgeTap(): void {
  tap(window, window.innerWidth - 10);
}

describe("DebugGesture (hidden reveal)", () => {
  beforeEach(() => {
    // The tap count is module state that survives unmounting, and it
    // decays only after TAP_WINDOW_MS of real (or faked) time. Start the
    // fake clock a safe margin past any timestamp a previous test
    // could have recorded, so no count can leak between tests.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 660_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing: a hidden control must not paint or take space", () => {
    const { container } = render(<DebugGesture onOpen={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("ignores taps away from the right edge", () => {
    const onOpen = vi.fn();
    render(<DebugGesture onOpen={onOpen} />);
    for (let i = 0; i < 8; i++) tap(window, window.innerWidth - 100);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("ignores taps that land inside the panel itself", () => {
    const onOpen = vi.fn();
    render(<DebugGesture onOpen={onOpen} />);
    // Closing the panel taps its surface; those must not re-open it.
    const panel = document.createElement("div");
    panel.className = "debug-panel";
    document.body.appendChild(panel);
    try {
      tap(panel, window.innerWidth - 10);
    } finally {
      panel.remove();
    }
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens only after exactly eight rapid right-edge taps", () => {
    const onOpen = vi.fn();
    render(<DebugGesture onOpen={onOpen} />);
    for (let i = 0; i < 7; i++) edgeTap();
    expect(onOpen).not.toHaveBeenCalled();
    edgeTap();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("resets the count when taps slow down past 700 ms", () => {
    const onOpen = vi.fn();
    render(<DebugGesture onOpen={onOpen} />);
    // Eight taps, each just outside the 700 ms window: the count
    // never accumulates, so the panel stays hidden.
    for (let i = 0; i < 8; i++) {
      edgeTap();
      vi.advanceTimersByTime(TAP_WINDOW_MS + 1);
    }
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("decays to a count of exactly one, not zero", () => {
    const onOpen = vi.fn();
    render(<DebugGesture onOpen={onOpen} />);
    // A tap, then a gap past the window: the decayed count
    // must be exactly 1 — so the tap after the gap plus
    // seven more complete the gesture. Seven rapid taps
    // after the gap must not open it (that would fail if
    // the decay left 2 or more), and the eighth must (a
    // reset-to-zero would still sit at 7 and stay hidden).
    edgeTap();
    vi.advanceTimersByTime(TAP_WINDOW_MS + 1);
    for (let i = 0; i < 7; i++) edgeTap();
    expect(onOpen).not.toHaveBeenCalled();
    edgeTap();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("continues the count when the next tap is 699 ms later", () => {
    const onOpen = vi.fn();
    render(<DebugGesture onOpen={onOpen} />);
    // The window is strictly less than 700 ms, so a
    // 699 ms gap still counts: the second tap continues
    // at 2 and the gesture completes on the eighth tap
    // overall — five more after it. (A decay here would
    // leave the count at 7 and the panel hidden.)
    edgeTap();
    vi.advanceTimersByTime(TAP_WINDOW_MS - 1);
    edgeTap();
    for (let i = 0; i < 5; i++) edgeTap();
    expect(onOpen).not.toHaveBeenCalled();
    edgeTap();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("decays the count when the next tap is exactly 700 ms later", () => {
    const onOpen = vi.fn();
    render(<DebugGesture onOpen={onOpen} />);
    // At exactly 700 ms the gap is no longer inside the
    // window: the second tap decays to 1, so the gesture
    // needs the decayed tap plus seven more — nine taps
    // overall. (Continuing the count here would open the
    // panel on the eighth tap instead.)
    edgeTap();
    vi.advanceTimersByTime(TAP_WINDOW_MS);
    edgeTap();
    for (let i = 0; i < 6; i++) edgeTap();
    expect(onOpen).not.toHaveBeenCalled();
    edgeTap();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("keeps the documented window value of 700 ms", () => {
    // The boundary tests above derive their gaps from the constant,
    // so pin the documented value itself here: 699 continues and 700
    // decays only means something while the window is 700 ms.
    expect(TAP_WINDOW_MS).toBe(700);
  });

  it("forgets a stale count after a long idle", () => {
    const onOpen = vi.fn();
    render(<DebugGesture onOpen={onOpen} />);
    // Five quick taps, then a minute of silence — far past the
    // window. The stale count must not leak through the idle: the
    // first tap back starts over at 1, so the gesture needs eight
    // from there. Seven rapid taps keep the panel hidden (a stale
    // count of 5 would have opened it on the third).
    for (let i = 0; i < 5; i++) edgeTap();
    vi.advanceTimersByTime(60_000);
    for (let i = 0; i < 7; i++) edgeTap();
    expect(onOpen).not.toHaveBeenCalled();
    edgeTap();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
