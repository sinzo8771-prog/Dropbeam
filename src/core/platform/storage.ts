import { DEFAULT_ICE_SETTINGS, type IceSettings } from "../peer/ice-config";
import { DEFAULT_LANGUAGE, isLanguage, type Language } from "./i18n";

/**
 * Session settings (PRD FR-40/FR-41).
 *
 * FR-40 is a hard privacy rule: only theme, language, "auto-accept" and the
 * STUN setting may ever touch `localStorage`. Files, codes and device names
 * never do. ESLint bans direct `localStorage` use outside this module, so the
 * allowed surface stays greppable.
 *
 * A memory fallback keeps the app working when storage is unavailable (private
 * mode, blocked cookies) instead of throwing on startup.
 */

export type Theme = "system" | "light" | "dark";

export type Settings = {
  theme: Theme;
  language: Language;
  autoAccept: boolean;
  ice: IceSettings;
  wakeLock: boolean;
  reduceMotion: boolean;
  deviceName: string;
};

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  language: DEFAULT_LANGUAGE,
  autoAccept: false,
  ice: DEFAULT_ICE_SETTINGS,
  wakeLock: true,
  reduceMotion: false,
  deviceName: "",
};

const STORAGE_KEY = "dropbeam.settings.v1";

/** The only keys FR-40 permits us to persist. */
const PERSISTED_KEYS = [
  "theme",
  "language",
  "autoAccept",
  "ice",
  "wakeLock",
  "reduceMotion",
] as const;

/** Minimal storage shape so tests can inject a fake without a DOM. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

class MemoryStore implements KeyValueStore {
  private readonly map = new Map<string, string>();
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

/** `localStorage` when usable, otherwise an in-memory store for this session. */
export function defaultStore(): KeyValueStore {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return new MemoryStore();
    const probe = `${STORAGE_KEY}.probe`;
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return new MemoryStore();
  }
}

function isTheme(value: unknown): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * Parse persisted JSON defensively: settings arrive from a previous version
 * or a hand-edited store, so every field is validated and unknown shapes fall
 * back to defaults instead of propagating garbage into the UI.
 */
export function parseSettings(raw: string | null): Settings {
  if (!raw) return { ...DEFAULT_SETTINGS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_SETTINGS };
  }
  const value = parsed as Record<string, unknown>;
  const ice = value.ice as Partial<IceSettings> | undefined;
  return {
    theme: isTheme(value.theme) ? value.theme : DEFAULT_SETTINGS.theme,
    language: isLanguage(value.language) ? value.language : DEFAULT_SETTINGS.language,
    autoAccept:
      typeof value.autoAccept === "boolean" ? value.autoAccept : DEFAULT_SETTINGS.autoAccept,
    ice:
      ice && (ice.mode === "local" || ice.mode === "stun")
        ? {
            mode: ice.mode,
            stunUrl:
              typeof ice.stunUrl === "string" && ice.stunUrl.trim().length > 0
                ? ice.stunUrl
                : DEFAULT_ICE_SETTINGS.stunUrl,
          }
        : DEFAULT_SETTINGS.ice,
    wakeLock: typeof value.wakeLock === "boolean" ? value.wakeLock : DEFAULT_SETTINGS.wakeLock,
    reduceMotion:
      typeof value.reduceMotion === "boolean" ? value.reduceMotion : DEFAULT_SETTINGS.reduceMotion,
    // FR-42: the device label is sent to the peer, never persisted.
    deviceName: "",
  };
}

export class SettingsStore {
  private value: Settings;
  private readonly listeners = new Set<(settings: Settings) => void>();

  constructor(private readonly store: KeyValueStore = defaultStore()) {
    this.value = parseSettings(this.read());
  }

  /** Storage can throw on access (private mode, blocked cookies, quota). */
  private read(): string | null {
    try {
      return this.store.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

  get current(): Settings {
    return this.value;
  }

  subscribe(listener: (settings: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(patch: Partial<Settings>): Settings {
    this.value = { ...this.value, ...patch };
    this.persist();
    for (const listener of this.listeners) listener(this.value);
    return this.value;
  }

  reset(): void {
    this.value = { ...DEFAULT_SETTINGS };
    this.persist();
    for (const listener of this.listeners) listener(this.value);
  }

  private persist(): void {
    const persisted: Record<string, unknown> = {};
    for (const key of PERSISTED_KEYS) {
      persisted[key] = this.value[key];
    }
    try {
      this.store.setItem(STORAGE_KEY, JSON.stringify(persisted));
    } catch {
      // Storage full or blocked: settings stay in memory for this session.
    }
  }
}
