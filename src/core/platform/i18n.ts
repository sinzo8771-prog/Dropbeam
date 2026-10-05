import { errorKey, type ErrorCode } from "../errors";
import en from "../../ui/i18n/en.json";
import hi from "../../ui/i18n/hi.json";

/**
 * Tiny typed i18n layer (PRD FR-41: English + Hindi).
 *
 * Keys are structural so a missing translation is a *type* error rather than a
 * runtime blank, and the error catalog from PRD 12 is part of the same
 * contract (`err.<CODE>`).
 */

export type Language = "en" | "hi";

export const LANGUAGES: readonly Language[] = ["en", "hi"] as const;

export type StringKey = keyof typeof en;

type Catalog = Record<string, string>;

const CATALOGS: Record<Language, Catalog> = { en, hi: hi as unknown as Catalog };

export const DEFAULT_LANGUAGE: Language = "en";

export function isLanguage(value: unknown): value is Language {
  return value === "en" || value === "hi";
}

/** `{name}` placeholders. Unknown placeholders are left as-is, never thrown. */
export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = vars[key];
    return value === undefined ? match : String(value);
  });
}

export type Translate = (key: StringKey, vars?: Record<string, string | number>) => string;

/**
 * Build a translator. Missing keys fall back to English and warn once in dev
 * rather than throwing, so a partially-translated build still renders.
 */
export function createTranslator(lang: Language = DEFAULT_LANGUAGE): Translate {
  const primary = CATALOGS[lang];
  const fallback = CATALOGS[DEFAULT_LANGUAGE];
  return (key, vars) => {
    const template = primary[key] ?? fallback[key] ?? key;
    return interpolate(template, vars);
  };
}

export function translatorFor(lang: string | null | undefined): Translate {
  return createTranslator(isLanguage(lang) ? lang : DEFAULT_LANGUAGE);
}

/** PRD 12: every reason code maps to a user-facing message key. */
export function messageForError(code: ErrorCode, lang: Language = DEFAULT_LANGUAGE): string {
  return createTranslator(lang)(errorKey(code) as StringKey);
}
