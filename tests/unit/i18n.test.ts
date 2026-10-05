import { describe, expect, it } from "vitest";
import en from "../../src/ui/i18n/en.json";
import hi from "../../src/ui/i18n/hi.json";
import {
  createTranslator,
  interpolate,
  isLanguage,
  messageForError,
  translatorFor,
  type StringKey,
} from "../../src/core/platform/i18n";
import { ERROR_CODES } from "../../src/core/errors";

const enKeys = Object.keys(en).sort();
const hiKeys = Object.keys(hi).sort();

describe("i18n catalogs (PRD FR-41, §12, DoD 12)", () => {
  it("keeps English and Hindi in sync", () => {
    // A key missing from one catalog renders as raw text at runtime, which is
    // exactly the "clipped/blank UI" defect DoD 12 guards against.
    expect(hiKeys).toEqual(enKeys);
  });

  it("has a message for every PRD 12 error code in both languages", () => {
    for (const code of ERROR_CODES) {
      const key = `err.${code}`;
      expect(enKeys).toContain(key);
      expect(hiKeys).toContain(key);
      const enText = messageForError(code, "en");
      const hiText = messageForError(code, "hi");
      expect(enText).not.toBe(key);
      expect(hiText).not.toBe(key);
      expect(hiText.trim().length).toBeGreaterThan(0);
    }
  });

  it("uses identical placeholders in both languages", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of enKeys) {
      expect(placeholders((hi as Record<string, string>)[key]!)).toEqual(
        placeholders((en as Record<string, string>)[key]!),
      );
    }
  });

  it("interpolates named placeholders", () => {
    expect(interpolate("{count} file, {size}", { count: 3, size: "12 MB" })).toBe("3 file, 12 MB");
    // Unknown placeholders stay literal rather than throwing mid-render.
    expect(interpolate("{missing}", { count: 1 })).toBe("{missing}");
    expect(interpolate("plain")).toBe("plain");
  });

  it("translates through a language-bound translator", () => {
    const t = createTranslator("hi");
    expect(t("action.copy")).toBe("कॉपी करें");
    expect(t("transfer.incomingBody", { count: 2, size: "5 MB" })).toBe("2 फ़ाइल, 5 MB");
    expect(t("action.copied", undefined)).toBe("कॉपी हो गया");
  });

  it("falls back to English for an unsupported language", () => {
    expect(isLanguage("en")).toBe(true);
    expect(isLanguage("hi")).toBe(true);
    expect(isLanguage("fr")).toBe(false);
    expect(translatorFor("fr")("action.copy")).toBe("Copy");
    expect(translatorFor(null)("action.copy")).toBe("Copy");
  });

  it("exposes a typed key union that includes every catalog key", () => {
    // Compile-time guarantee: this line fails to typecheck if a key is missing
    // from the English catalog.
    const key: StringKey = "pair.assemblingProgress";
    expect(createTranslator("en")(key, { received: 1, total: 3 })).toBe(
      "Collecting code frames… 1 of 3",
    );
  });
});
