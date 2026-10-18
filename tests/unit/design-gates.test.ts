import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * DoD 11's copy clause: "no gradients, nested cards, or banned copy words exist
 * in the shipped UI".
 *
 * Gradients and nesting are checked against real computed styles in
 * `tests/e2e/design-gates.spec.ts`, because those are questions about what the
 * browser actually painted. Banned words are the opposite: they are a question
 * about the words themselves, wherever they are written. So this reads the two
 * i18n catalogues and every shipped component, rather than the DOM — a word
 * typed into a translation is just as much a part of the product as one typed
 * into a component, and one that only appears in `en.json` is exactly how this
 * class of defect reaches production.
 *
 * The list is `PRODUCT.md`'s, and it is read from the same sentence the
 * designer wrote rather than restated here, so editing that line changes the
 * gate instead of quietly leaving it testing the old list.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** The banned words, lifted from PRODUCT.md rather than duplicated. */
function bannedWords(): string[] {
  const product = readFileSync(join(root, "PRODUCT.md"), "utf8");
  const line = product.split("\n").find((text) => text.includes("Banned:"));
  if (!line) {
    throw new Error("PRODUCT.md no longer names the banned words; the gate needs updating");
  }
  const words = line
    .split("Banned:")[1]
    .split(/[.;]/)[0]
    .split(",")
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word.length > 0);
  expect(words.length).toBeGreaterThan(0);
  return words;
}

const BANNED = bannedWords();

/** Every shipped string: both catalogues, plus the components that render text. */
function shippedTextFiles(): { file: string; text: string }[] {
  const files = [
    "src/ui/i18n/en.json",
    "src/ui/i18n/hi.json",
    "src/ui/App.tsx",
    "src/ui/debug.tsx",
    "src/ui/help.tsx",
    "src/ui/settings.tsx",
    "src/ui/selftest.tsx",
    "src/ui/share.tsx",
    "src/ui/components/Beam.tsx",
    "src/ui/components/CodeBox.tsx",
    "src/ui/components/ProgressRow.tsx",
    "src/ui/components/Prompt.tsx",
    "src/ui/components/QrTile.tsx",
    "src/ui/components/TransferPanel.tsx",
    "src/ui/components/VerifyCard.tsx",
  ];
  return files.map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }));
}

describe("banned copy words (PRD 10.7, PRODUCT.md, DoD 11)", () => {
  it("reads a real list out of PRODUCT.md, so the gate cannot go stale", () => {
    // If this ever passes on an empty list the rest of the file would pass
    // vacuously, so the list is asserted to be the one that was written.
    expect(BANNED).toContain("seamless");
    expect(BANNED).toContain("effortless");
  });

  it("ships no banned word in any user-facing string", () => {
    const found: string[] = [];
    for (const { file, text } of shippedTextFiles()) {
      // Whole words only: "unlocked" or "powerfully" would match a substring
      // search, and neither is the thing PRODUCT.md bans.
      for (const word of BANNED) {
        const pattern = new RegExp(`\\b${word}\\b`, "i");
        if (pattern.test(text)) found.push(`${file}: ${word}`);
      }
    }
    expect(
      found,
      `banned word(s) in shipped copy: ${found.join(", ")}. PRODUCT.md bans these in ` +
        "favour of plain, short, concrete text.",
    ).toEqual([]);
  });

  it("has no gradient in any shipped stylesheet", () => {
    /*
     * Checked here as well as in the browser because the two catch different
     * mistakes: this one fails on a gradient someone wrote and has not yet
     * rendered on a walked screen, and the e2e one fails on a gradient that came
     * from a runtime style. `base.css` documents its own no-gradient rule in a
     * comment, so the comments are stripped first — otherwise the file's own
     * declaration of intent would fail the gate.
     */
    const stylesheets = ["src/ui/base.css", "src/ui/tokens.css", "src/ui/fonts.css"];
    const found: string[] = [];
    for (const file of stylesheets) {
      const css = readFileSync(join(root, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      const lines = css.split("\n");
      lines.forEach((line, index) => {
        if (/gradient\s*\(/i.test(line)) found.push(`${file}:${index + 1}`);
      });
    }
    expect(
      found,
      `gradient(s) in shipped CSS: ${found.join(", ")}. PRD 10.2 is flat surfaces only.`,
    ).toEqual([]);
  });
});
