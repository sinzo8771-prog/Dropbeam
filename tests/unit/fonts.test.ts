import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Self-hosted font contract (PRD 9.1, 10.2, DoD 12).
 *
 * Two generation bugs are pinned here:
 *
 *  1. fonts.css once shipped the *latin* subset of the Devanagari family —
 *     a file with Latin glyphs under a Devanagari name and a
 *     `unicode-range` Hindi text can never match.
 *  2. base.css referenced that face as "Noto Sans Devanagari" while
 *     fonts.css declares "noto-sans-devanagari". Family names are
 *     case-insensitive, but not space- or hyphen-insensitive, so the
 *     face never loaded and Hindi rendered in a system fallback.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const fontsCss = readFileSync(join(root, "src/ui/fonts.css"), "utf8");
const baseCss = readFileSync(join(root, "src/ui/base.css"), "utf8");
const tokensCss = readFileSync(join(root, "src/ui/tokens.css"), "utf8");

type Face = { family: string; src: string; range: string; weight: string };

const faces: Face[] = [...fontsCss.matchAll(/@font-face\s*\{([^}]+)\}/g)].map((match) => {
  const block = match[1] ?? "";
  const pick = (name: string): string =>
    new RegExp(`${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim() ?? "";
  // `src: url("./fonts/x.woff2") format("woff2")` — keep only the file URL.
  const url = /url\((["']?)([^"')]+)\1\)/.exec(pick("src"))?.[2] ?? "";
  return {
    family: pick("font-family").replace(/"/g, ""),
    src: url,
    range: pick("unicode-range"),
    weight: pick("font-weight"),
  };
});

/** Every family name declared by an @font-face rule, lowercased. */
const declared = new Set(faces.map((face) => face.family.toLowerCase()));

/** Every quoted family name a font stack references. */
function stackFamilies(css: string): string[] {
  return [...css.matchAll(/--font-[a-z]+:\s*([^;}]+)/g)].flatMap((match) =>
    [...(match[1] ?? "").matchAll(/"([^"]+)"|'([^']+)'/g)].map((q) => (q[1] ?? q[2] ?? "").trim()),
  );
}

describe("self-hosted fonts (PRD 9.1, 10.2)", () => {
  it("keeps every referenced file in the repo", () => {
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      const file = join(root, "src/ui", face.src.replace("./", ""));
      expect(existsSync(file), `${face.family} -> ${face.src}`).toBe(true);
    }
  });

  it("loads nothing from a third party (PRD 9.1)", () => {
    expect(fontsCss).not.toMatch(/https?:\/\//);
  });

  it("ships the Devanagari face with the Devanagari subset (DoD 12)", () => {
    // The regression: the generator used to keep the family's latin block,
    // so the file held Latin glyphs and `unicode-range` never matched
    // U+0900-097F — Hindi then rendered in a system fallback.
    const deva = faces.filter((face) => face.family === "noto-sans-devanagari");
    expect(deva.length).toBeGreaterThan(0);
    for (const face of deva) {
      expect(face.range).toMatch(/U\+0900-097F/);
    }
  });

  it("scopes every face to a unicode-range so nothing loads eagerly", () => {
    for (const face of faces) {
      // An unset range means the browser downloads the face on every page
      // load, whatever language is shown — the opposite of the budget.
      expect(face.range.length).toBeGreaterThan(0);
    }
  });

  it("references every stack family by a name fonts.css declares", () => {
    // CSS family names are ASCII case-insensitive, but spaces and hyphens
    // are significant: "Noto Sans Devanagari" and "noto-sans-devanagari"
    // are two different families, and a mismatch silently falls back to
    // whatever the system has. Base and tokens both define font stacks.
    const referenced = [...stackFamilies(baseCss), ...stackFamilies(tokensCss)];
    expect(referenced.length).toBeGreaterThan(0);
    for (const family of referenced) {
      // Generic families (serif, sans-serif…) are keywords, not ours.
      if (/^(serif|sans-serif|monospace|system-ui|ui-monospace|Georgia)$/i.test(family)) continue;
      expect(declared.has(family.toLowerCase()), `undeclared family "${family}"`).toBe(true);
    }
  });

  it("activates the Devanagari face when the document language is Hindi", () => {
    // The attribute the app shell sets (App.tsx) is what activates the face;
    // without this rule the sheet could switch language and change nothing.
    const hiRule = /:root:lang\(hi\)[^{]*\{([^}]+)\}/.exec(baseCss)?.[1] ?? "";
    expect(hiRule).not.toBe("");
    expect(hiRule).toMatch(/--font-ui/);
  });
});
