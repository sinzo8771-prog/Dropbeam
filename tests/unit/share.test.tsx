// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { App } from "../../src/ui/App";
import { readStagedShare } from "../../src/core/platform/share";
import { SettingsStore, type KeyValueStore } from "../../src/core/platform/storage";

type Staged = { name: string; type: string; body: string };

/** In-memory CacheStorage stand-in keyed by the staging URLs. */
function fakeStaging(entries: Staged[], text?: string): CacheStorage {
  const map = new Map<string, Response>();
  const index = entries.map((entry, i) => ({ i, name: entry.name, type: entry.type })) as {
    i: number | "text";
    name: string;
    type: string;
  }[];
  // A shared text lands in the index under the sentinel entry, exactly as
  // the service worker stages it.
  if (text !== undefined) index.push({ i: "text", name: "text", type: "text/plain" });
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
  if (text !== undefined) map.set("./__share/text", new Response(text));
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
    const staged = await readStagedShare(storage);
    expect(staged.files.map((f) => f.name)).toEqual(["notes.txt", "photo.jpg"]);
    expect(staged.files[0].type).toBe("text/plain");
    expect(await staged.files[0].text()).toBe("hello");
    expect(staged.text).toBe("");
    // Staging is one-shot: a second read (reload) gets nothing.
    expect(await readStagedShare(storage)).toEqual({ files: [], text: "" });
  });

  it("returns shared text alongside the files (clipboard sync)", async () => {
    const storage = fakeStaging(
      [{ name: "notes.txt", type: "text/plain", body: "hello" }],
      "https://example.test/article",
    );
    const staged = await readStagedShare(storage);
    expect(staged.files).toHaveLength(1);
    // The text comes back trimmed, ready for the note field.
    expect(staged.text).toBe("https://example.test/article");
  });

  it("returns only text when a share carried no files", async () => {
    const storage = fakeStaging([], "just some text");
    const staged = await readStagedShare(storage);
    expect(staged.files).toEqual([]);
    expect(staged.text).toBe("just some text");
  });

  it("returns nothing when nothing was staged", async () => {
    expect(await readStagedShare(fakeStaging([]))).toEqual({ files: [], text: "" });
  });

  it("returns nothing when CacheStorage is unavailable", async () => {
    // jsdom has no caches; the guard must not throw (best-effort FR-51).
    expect(await readStagedShare()).toEqual({ files: [], text: "" });
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

  it("shows a staged text share on the Send screen, ready to note", async () => {
    history.replaceState(null, "", "/#shared");
    installCaches(fakeStaging([], "https://example.test/story"));
    render(<App settings={freshSettings()} baseUrl="https://dropbeam.example" />);
    await waitFor(() => expect(screen.getByText("Ready to send")).toBeTruthy());
    // The shared text is visible before pairing, and echoed in the label
    // that says what will be sent.
    expect(screen.getByText("Text ready to send")).toBeTruthy();
    expect(screen.getByText("https://example.test/story")).toBeTruthy();
  });

  /**
   * PWA shortcut route (roadmap "send to this device"): the manifest's
   * shortcut URLs open the app with ?screen=…, which selects the same page
   * the home screen's quiet links do. The query string is then cleared so
   * a reload does not replay it.
   */
  it("opens the Send screen from the ?screen=send shortcut", async () => {
    history.replaceState(null, "", "/?screen=send");
    render(<App settings={freshSettings()} baseUrl="https://dropbeam.example" />);
    await waitFor(() => expect(screen.getByText("Ready to send")).toBeTruthy());
    expect(location.search).toBe("");
    expect(screen.getByText("Start")).toBeTruthy();
  });

  it("opens the self-test from the ?screen=selftest shortcut", async () => {
    history.replaceState(null, "", "/?screen=selftest");
    render(<App settings={freshSettings()} baseUrl="https://dropbeam.example" />);
    await waitFor(() => expect(screen.getByText("Connection test")).toBeTruthy());
    expect(location.search).toBe("");
  });
});
