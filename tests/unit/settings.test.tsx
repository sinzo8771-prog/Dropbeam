// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { SettingsSheet } from "../../src/ui/settings";
import { App, CodeExpiry } from "../../src/ui/App";
import { useWakeLock } from "../../src/ui/use-wake-lock";
import {
  DEFAULT_SETTINGS,
  SettingsStore,
  type KeyValueStore,
} from "../../src/core/platform/storage";
import { createTranslator } from "../../src/core/platform/i18n";

/**
 * FR-41: the settings sheet and the document wiring behind it (theme,
 * language, reduce motion), plus the wake lock the sheet controls.
 * Everything is driven through the real `SettingsStore` the app uses.
 */

function freshSettings(): SettingsStore {
  const map = new Map<string, string>();
  const backing: KeyValueStore = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
  return new SettingsStore(backing);
}

/** A minimal stand-in for the platform wake lock, counting acquires/releases. */
function stubWakeLock(): { requested: number; released: number } {
  const state = { requested: 0, released: 0 };
  const sentinel = {
    released: false,
    type: "screen" as const,
    release: async () => {
      state.released += 1;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(navigator, "wakeLock", {
    value: {
      request: async () => {
        state.requested += 1;
        return sentinel;
      },
    },
    configurable: true,
  });
  return state;
}

function unstubWakeLock(): void {
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, "wakeLock");
}

/** Root attributes the app shell applies from the settings. */
function rootAttrs(): { theme?: string; lang?: string; reduceMotion?: string } {
  const root = document.documentElement;
  return {
    theme: root.dataset.theme,
    lang: root.lang,
    reduceMotion: root.dataset.reduceMotion,
  };
}

function renderSheet(overrides: Partial<ReturnType<SettingsStore["current"]>> = {}) {
  const settings = freshSettings();
  const onChange = vi.fn((patch) => settings.update(patch));
  const onClose = vi.fn();
  const view = render(
    <SettingsSheet
      open
      settings={{ ...settings.current, ...overrides }}
      t={createTranslator("en")}
      onChange={onChange}
      onClose={onClose}
    />,
  );
  return { view, settings, onChange, onClose };
}

beforeEach(() => {
  unstubWakeLock();
});

afterEach(() => {
  cleanup();
  unstubWakeLock();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-reduce-motion");
  document.documentElement.lang = "";
});

describe("SettingsSheet (PRD FR-41)", () => {
  it("shows the stored values, with switches reading as text not colour", () => {
    const { view } = renderSheet({
      theme: "dark",
      language: "hi",
      autoAccept: true,
      ice: { mode: "stun", stunUrl: "stun:stun.example:3478" },
    });

    expect(screen.getByRole("radio", { name: "Dark" })).toMatchObject({ checked: true });
    expect(screen.getByRole("radio", { name: "हिन्दी" })).toMatchObject({ checked: true });
    expect(screen.getByRole("switch", { name: "Auto-accept incoming files" })).toMatchObject({
      checked: true,
    });
    expect(screen.getByRole("switch", { name: "Across networks" })).toMatchObject({
      checked: true,
    });

    // PRD 10.6: state text ("On"/"Off") sits beside every switch.
    const on = screen.getAllByText("On");
    const off = screen.getAllByText("Off");
    expect(on.length).toBeGreaterThan(0);
    expect(off.length).toBeGreaterThan(0);

    // jsdom has no showModal, so the sheet takes the attribute-fallback path
    // the component guards for — it still opens, which is the point.
    const dialog = view.container.querySelector("dialog");
    expect(dialog?.open).toBe(true);
  });

  it("emits a patch when the theme segment changes", () => {
    const { onChange } = renderSheet();
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(onChange).toHaveBeenCalledWith({ theme: "dark" });
  });

  it("emits a patch when the language segment changes", () => {
    const { onChange } = renderSheet();
    fireEvent.click(screen.getByRole("radio", { name: "हिन्दी" }));
    expect(onChange).toHaveBeenCalledWith({ language: "hi" });
  });

  it("flips auto-accept and reduce motion through the store", () => {
    const { settings, onChange } = renderSheet();
    fireEvent.click(screen.getByRole("switch", { name: "Auto-accept incoming files" }));
    expect(onChange).toHaveBeenCalledWith({ autoAccept: true });
    expect(settings.current.autoAccept).toBe(true);

    fireEvent.click(screen.getByRole("switch", { name: "Reduce motion" }));
    expect(onChange).toHaveBeenCalledWith({ reduceMotion: true });
    expect(settings.current.reduceMotion).toBe(true);
  });

  it("turns STUN on and back off, keeping the URL (PRD 8.3)", () => {
    const { settings, onChange } = renderSheet();
    fireEvent.click(screen.getByRole("switch", { name: "Across networks" }));
    expect(onChange).toHaveBeenCalledWith({
      ice: { mode: "stun", stunUrl: DEFAULT_SETTINGS.ice.stunUrl },
    });
    expect(settings.current.ice.mode).toBe("stun");

    fireEvent.click(screen.getByRole("switch", { name: "Across networks" }));
    expect(onChange).toHaveBeenLastCalledWith({
      ice: { mode: "local", stunUrl: settings.current.ice.stunUrl },
    });
    expect(settings.current.ice.mode).toBe("local");
  });

  it("edits the device label without persisting it (FR-42)", () => {
    const { settings, onChange } = renderSheet();
    const input = screen.getByLabelText("Device name") as HTMLInputElement;
    expect(input.maxLength).toBe(64);
    fireEvent.input(input, { target: { value: "Qweq's phone" } });
    expect(onChange).toHaveBeenCalledWith({ deviceName: "Qweq's phone" });
    expect(settings.current.deviceName).toBe("Qweq's phone");
  });

  it("offers the wake-lock row only where the browser has the API", () => {
    // No navigator.wakeLock in jsdom: the row must not appear at all, since a
    // switch that silently does nothing is worse than no switch.
    const first = renderSheet();
    expect(screen.queryByRole("switch", { name: "Keep screen awake" })).toBeNull();
    first.view.unmount();

    stubWakeLock();
    renderSheet();
    expect(screen.getByRole("switch", { name: "Keep screen awake" })).toBeTruthy();
  });

  it("closes on the button and on Escape", async () => {
    const { onClose } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    const dialog = screen.getByRole("dialog");
    // Escape routes through cancel, which the sheet funnels to the same
    // handler rather than closing the dialog behind the app's back.
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("App settings wiring (PRD FR-41)", () => {
  /**
   * The sheet is a dynamic import (NFR-1 keeps it out of the initial
   * bundle), so opening it always lands a tick later.
   */
  async function openSheet(): Promise<void> {
    render(<App settings={freshSettings()} baseUrl="https://dropbeam.example" />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("radio", { name: "Dark" });
  }

  it("opens the sheet from the home screen settings button", async () => {
    await openSheet();
    // The sheet is a real, open modal over the home screen. (The pairing
    // and approval prompts are also <dialog>s, so scope to the sheet.)
    await waitFor(() => expect(document.querySelector("dialog.settings")?.open).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    // Closing unmounts the sheet: the layer is gone, not just hidden.
    await waitFor(() => expect(document.querySelector("dialog.settings")).toBeNull());
  });

  it("applies the theme to the document, and back to system", async () => {
    await openSheet();
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(rootAttrs().theme).toBe("dark");
    // "system" must hand the decision back to the media query.
    fireEvent.click(screen.getByRole("radio", { name: "System" }));
    expect(rootAttrs().theme).toBeUndefined();
  });

  it("switches the document language to Hindi", async () => {
    await openSheet();
    fireEvent.click(screen.getByRole("radio", { name: "हिन्दी" }));
    expect(rootAttrs().lang).toBe("hi");
    // The translator follows the same setting: the shell re-renders in Hindi.
    expect(screen.getByText("सेटिंग")).toBeTruthy();
  });

  it("mirrors reduce motion onto the root for the token override", async () => {
    await openSheet();
    fireEvent.click(screen.getByRole("switch", { name: "Reduce motion" }));
    expect(rootAttrs().reduceMotion).toBe("true");
    fireEvent.click(screen.getByRole("switch", { name: "Reduce motion" }));
    expect(rootAttrs().reduceMotion).toBeUndefined();
  });

  it("counts the offer code down and stops at zero (FR-7)", async () => {
    const t = createTranslator("en");
    const { container, rerender } = render(
      <CodeExpiry expiresAt={Math.floor(Date.now() / 1000) + 600} lang="en" t={t} />,
    );
    // A fresh code shows the full FR-7 window, ticking once a second.
    expect(container.textContent).toMatch(/This code expires in (10:00|9:5\d)/);

    rerender(<CodeExpiry expiresAt={1} lang="en" t={t} />);
    // At zero the line becomes the expiry message, not a negative timer.
    expect(container.textContent).toBe("This code expired. Start again.");
  });

  it("renders nothing before any code exists", () => {
    const { container } = render(
      <CodeExpiry expiresAt={null} lang="en" t={createTranslator("en")} />,
    );
    expect(container.textContent).toBe("");
  });
});

describe("useWakeLock (PRD FR-41, M5)", () => {
  function Probe({ active }: { active: boolean }) {
    useWakeLock(active);
    return null;
  }

  it("holds a screen lock while active and releases it afterwards", async () => {
    const lock = stubWakeLock();
    const { rerender, unmount } = render(<Probe active />);
    await waitFor(() => expect(lock.requested).toBe(1));

    rerender(<Probe active={false} />);
    await waitFor(() => expect(lock.released).toBe(1));
    // Going inactive must not ask again.
    expect(lock.requested).toBe(1);

    unmount();
    expect(lock.released).toBe(1);
  });

  it("re-requests the lock when the tab becomes visible again", async () => {
    const lock = stubWakeLock();
    render(<Probe active />);
    await waitFor(() => expect(lock.requested).toBe(1));

    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(lock.requested).toBe(2));
  });

  it("does nothing at all where the API is missing", async () => {
    const { rerender } = render(<Probe active />);
    // No wakeLock in this environment: the hook must be inert, not throw.
    await Promise.resolve();
    rerender(<Probe active={false} />);
    expect(true).toBe(true);
  });

  it("swallows a rejected request instead of breaking the transfer", async () => {
    Object.defineProperty(navigator, "wakeLock", {
      value: { request: () => Promise.reject(new Error("denied")) },
      configurable: true,
    });
    const { unmount } = render(<Probe active />);
    await Promise.resolve();
    expect(() => unmount()).not.toThrow();
  });
});
