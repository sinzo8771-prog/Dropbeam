import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SettingsStore,
  parseSettings,
  type KeyValueStore,
} from "../../src/core/platform/storage";

class FakeStore implements KeyValueStore {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

class ThrowingStore implements KeyValueStore {
  getItem(): string | null {
    throw new Error("blocked");
  }
  setItem(): void {
    throw new Error("blocked");
  }
  removeItem(): void {}
}

const STORAGE_KEY = "dropbeam.settings.v1";

describe("settings store (PRD FR-40, FR-41)", () => {
  it("starts from defaults with an empty store", () => {
    const store = new SettingsStore(new FakeStore());
    expect(store.current).toEqual(DEFAULT_SETTINGS);
    // STUN must be off by default (PRD 8.3).
    expect(store.current.ice.mode).toBe("local");
    expect(store.current.autoAccept).toBe(false);
  });

  it("persists only the FR-40 allowlisted keys", () => {
    const backing = new FakeStore();
    const store = new SettingsStore(backing);
    store.update({
      theme: "dark",
      language: "hi",
      autoAccept: true,
      ice: { mode: "stun", stunUrl: "stun:example.test:3478" },
      deviceName: "Qweq's phone",
    });
    const persisted = JSON.parse(backing.getItem(STORAGE_KEY)!);
    expect(Object.keys(persisted).sort()).toEqual([
      "autoAccept",
      "ice",
      "language",
      "reduceMotion",
      "theme",
      "wakeLock",
    ]);
    // FR-42: the device label is sent to the peer, never persisted.
    expect(persisted).not.toHaveProperty("deviceName");
    expect(backing.getItem(STORAGE_KEY)).not.toContain("Qweq");
  });

  it("round-trips settings through the store", () => {
    const backing = new FakeStore();
    const first = new SettingsStore(backing);
    first.update({ theme: "dark", language: "hi", autoAccept: true, reduceMotion: true });
    const second = new SettingsStore(backing);
    expect(second.current.theme).toBe("dark");
    expect(second.current.language).toBe("hi");
    expect(second.current.autoAccept).toBe(true);
    expect(second.current.reduceMotion).toBe(true);
  });

  it("notifies subscribers on update and reset", () => {
    const store = new SettingsStore(new FakeStore());
    const seen: string[] = [];
    const unsubscribe = store.subscribe((s) => seen.push(`${s.theme}/${s.language}`));
    store.update({ theme: "light" });
    unsubscribe();
    store.update({ theme: "dark" });
    expect(seen).toEqual(["light/en"]);
  });

  it("falls back to defaults for malformed or hostile payloads", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("{not json")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("[1,2,3]")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('"a string"')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(JSON.stringify({ theme: "neon" })).theme).toBe("system");
    expect(parseSettings(JSON.stringify({ language: "fr" })).language).toBe("en");
    expect(parseSettings(JSON.stringify({ autoAccept: "yes" })).autoAccept).toBe(false);
    expect(parseSettings(JSON.stringify({ ice: { mode: "wormhole" } })).ice.mode).toBe("local");
    expect(parseSettings(JSON.stringify({ ice: { mode: "stun", stunUrl: "" } })).ice.stunUrl).toBe(
      DEFAULT_SETTINGS.ice.stunUrl,
    );
  });

  it("never throws when storage is unavailable", () => {
    const store = new SettingsStore(new ThrowingStore());
    expect(store.current).toEqual(DEFAULT_SETTINGS);
    expect(() => store.update({ theme: "dark" })).not.toThrow();
    expect(store.current.theme).toBe("dark");
  });
});
