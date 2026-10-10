// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { App } from "../../src/ui/App";
import { readStagedShare } from "../../src/core/platform/share";
import { SettingsStore, type KeyValueStore } from "../../src/core/platform/storage";

type Staged = { name: string; type: string; body: string };

/** In-memory CacheStorage stand-in keyed by the staging URLs. */
function fakeStaging(entries: Staged[]): CacheStorage {
  const map = new Map<string, Response>();
  const index = entries.map((entry, i) => ({ i, name: entry.name, type: entry.type }));
  map.set(
    "./__share/index",
    new Response(JSON.stringify(index), { headers: { "content-type": "application/json" } }),
  );
  entries.forEach((entry, i) => {
    map.set(
      `./__share/${i}`,
      new Response(entry.body, { headers: { "content-type": entry.type } }),
    );
  });
  const cache = {
    match: async (key: RequestInfo | URL) => map.get(String(key)) ?? undefined,
    delete: async (key: RequestInfo | URL) => map.delete(String(key)),
    keys: async () => [...map.keys()].map((key) => new Request(key)),
    put: async (key: RequestInfo | URL, response: Response) => void map.set(String(key), response),
  };
  return { open: async () => cache } as unknown as CacheStorage;
}

function installCaches(storage: CacheStorage | undefined): void {
  Object.defineProperty(window, "caches", { value: storage, configurable: true });
}

function freshSettings(): SettingsStore {
  const map = new Map<string, string>();
  const backing: KeyValueStore = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
  return new SettingsStore(backing);
}

beforeEach(() => {
  history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  installCaches(undefined);
  vi.unstubAllEnvs();
});

describe("readStagedShare (FR-51 staging)", () => {
  it("returns staged files in index order and empties the staging cache", async () => {
    const storage = fakeStaging([
      { name: "notes.txt", type: "text/plain", body: "hello" },
      { name: "photo.jpg", type: "image/jpeg", body: "jpegbytes" },
    ]);
    const files = await readStagedShare(storage);
    expect(files.map((f) => f.name)).toEqual(["notes.txt", "photo.jpg"]);
    expect(files[0].type).toBe("text/plain");
    expect(await files[0].text()).toBe("hello");
    // Staging is one-shot: a second read (reload) gets nothing.
    expect(await readStagedShare(storage)).toEqual([]);
  });

  it("returns nothing when nothing was staged", async () => {
    expect(await readStagedShare(fakeStaging([]))).toEqual([]);
  });

  it("returns nothing when CacheStorage is unavailable", async () => {
    // jsdom has no caches; the guard must not throw (best-effort FR-51).
    expect(await readStagedShare()).toEqual([]);
  });
});

describe("Send screen from a share-target landing (FR-51)", () => {
  it("shows the staged file and lets it be removed", async () => {
    history.replaceState(null, "", "/#shared");
    installCaches(fakeStaging([{ name: "holiday.mp4", type: "video/mp4", body: "bytes" }]));
    render(<App settings={freshSettings()} baseUrl="https://dropbeam.example" />);

    await waitFor(() => expect(screen.getByText("Ready to send")).toBeTruthy());
    expect(screen.getByText("holiday.mp4")).toBeTruthy();
    expect(screen.getByText(/1 file was shared/)).toBeTruthy();
    const send = document.querySelector(".screen-send");
    expect(send?.getAttribute("data-staged")).toBe("1");
    // The landing hash is cleared so a reload doesn't replay the share.
    expect(location.hash).toBe("");

    fireEvent.click(screen.getByText("Remove"));
    expect(send?.getAttribute("data-staged")).toBe("0");
    expect(screen.queryByText("holiday.mp4")).toBeNull();
  });

  it("stays on the home screen when the share was empty", async () => {
    history.replaceState(null, "", "/#shared");
    installCaches(fakeStaging([]));
    render(<App settings={freshSettings()} baseUrl="https://dropbeam.example" />);
    await waitFor(() => expect(location.hash).toBe(""));
    expect(screen.queryByText("Ready to send")).toBeNull();
    expect(screen.getByText("Start")).toBeTruthy();
  });
});
