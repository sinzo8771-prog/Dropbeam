import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PRD 10.2 / DoD 11: "verify every text/background pair is at least
 * 4.5:1, and interactive-control borders at least 3:1 using
 * --border-strong". The pairs are computed from the shipped
 * `tokens.css`, so changing a token away from the PRD table is caught
 * here rather than in a manual audit.
 */

const tokensCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../src/ui/tokens.css"),
  "utf8",
);

/** The `#hex` custom properties inside one selector's block. */
function tokensIn(selector: string): Record<string, string> {
  const start = tokensCss.indexOf(selector);
  expect(start, `selector ${selector} present in tokens.css`).toBeGreaterThanOrEqual(0);
  const open = tokensCss.indexOf("{", start);
  const close = tokensCss.indexOf("}", open);
  const body = tokensCss.slice(open + 1, close);
  const tokens: Record<string, string> = {};
  for (const match of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    tokens[match[1]] = match[2];
  }
  return tokens;
}

const light = tokensIn(":root {");
const dark = tokensIn(':root[data-theme="dark"] {');

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  const channel = (value: number): number => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const rgb = parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((rgb >> 16) & 0xff) +
    0.7152 * channel((rgb >> 8) & 0xff) +
    0.0722 * channel(rgb & 0xff)
  );
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Text colors PRD 10.2 lists, on both surfaces. */
const TEXT_COLORS = ["ink", "ink-muted", "success", "warning", "danger"] as const;
const SURFACES = ["paper", "panel"] as const;

const THEMES = { light, dark } as const;

describe("color contrast (PRD 10.2, DoD 11)", () => {
  for (const [theme, tokens] of Object.entries(THEMES)) {
    it(`${theme}: text colors reach 4.5:1 on both surfaces`, () => {
      for (const text of TEXT_COLORS) {
        for (const surface of SURFACES) {
          const ratio = contrast(tokens[text], tokens[surface]);
          expect(
            ratio,
            `${text} (${tokens[text]}) on ${surface} (${tokens[surface]}) = ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`${theme}: on-accent text reaches 4.5:1 on the accent fill`, () => {
      const ratio = contrast(tokens["on-accent"], tokens.accent);
      expect(
        ratio,
        `on-accent (${tokens["on-accent"]}) on accent (${tokens.accent})`,
      ).toBeGreaterThanOrEqual(4.5);
    });

    it(`${theme}: interactive borders and the focus ring reach 3:1`, () => {
      for (const surface of SURFACES) {
        const border = contrast(tokens["border-strong"], tokens[surface]);
        expect(
          border,
          `border-strong (${tokens["border-strong"]}) on ${surface} (${tokens[surface]})`,
        ).toBeGreaterThanOrEqual(3);
        // The focus ring uses --accent against the page surfaces.
        const focus = contrast(tokens.accent, tokens[surface]);
        expect(
          focus,
          `accent (${tokens.accent}) on ${surface} (${tokens[surface]})`,
        ).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it("keeps the QR tile black on white in both themes (PRD 10.2)", () => {
    expect(contrast("#000000", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    // The shipped tile hard-codes these; the check documents why.
    expect(tokensCss).toContain("background: #fff");
  });
});
