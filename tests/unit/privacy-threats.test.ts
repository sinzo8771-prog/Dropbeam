import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The threat table's promises (PRD M6, DoD 9).
 *
 * `docs/PRIVACY.md` answers "who attacks this and what stops them" with a
 * table whose third column says *which test proves it*. That column is only
 * worth anything while it is true: a row that points at a test that has been
 * renamed is a promise with nothing behind it, and the table is the document a
 * reader checks before trusting the app with a stranger's file.
 *
 * So the links are checked, the same way the README's figures are checked: a
 * rename that breaks the table fails here rather than quietly.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const privacy = readFileSync(join(root, "docs/PRIVACY.md"), "utf8");

describe("the threat model's evidence (PRD M6, DoD 9)", () => {
  it("links every threat to a file that exists", () => {
    const links = [...privacy.matchAll(/\]\((\.\.\/[^)]+)\)/g)].map((m) => m[1] as string);

    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const target = resolve(root, "docs", link);
      expect(existsSync(target), `${link} is linked from the threat table but does not exist`).toBe(
        true,
      );
    }
  });

  it("gives every threat a row, a mitigation and an evidence column", () => {
    const header = privacy.split("\n").findIndex((line) => line.startsWith("| Threat"));
    expect(header).toBeGreaterThanOrEqual(0);
    const rows = privacy
      .split("\n")
      .slice(header + 2)
      .filter((line) => line.startsWith("| "));
    // A threat, a mitigation and where it is proven - every row, no blanks.
    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const row of rows) {
      const cells = row.split("|").slice(1, -1);
      expect(cells.length, `a row is missing a cell: ${row}`).toBe(3);
      for (const cell of cells) {
        expect(cell.trim(), `a cell is empty: ${row}`).not.toBe("");
      }
    }
  });
});
