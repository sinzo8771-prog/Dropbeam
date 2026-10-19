import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The legal and policy deliverables (PRD 15).
 *
 * §15 asks for four things: an MIT licence with third-party notices, a
 * privacy page that states exactly what it does not do, terms, and the naming
 * rule that keeps this project clear of Apple's. Three of them are files, and
 * a file that is missing is a release that ships without it - so they are
 * checked here, the way the README's figures are checked.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const pkg = JSON.parse(read("package.json")) as {
  license?: string;
  dependencies?: Record<string, string>;
};

/** Every file the browser is given, so the naming rule can be checked on them. */
function shippedFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...shippedFiles(full));
    else if (/\.(ts|tsx|json|html|css|js)$/.test(name)) out.push(full);
  }
  return out;
}

describe("the legal and policy deliverables (PRD 15)", () => {
  it("ships the licence the package declares", () => {
    expect(pkg.license, "package.json no longer declares a licence").toBe("MIT");
    expect(existsSync(join(root, "LICENSE")), "there is no LICENSE file").toBe(true);
    const licence = read("LICENSE");
    expect(licence).toContain("MIT License");
    expect(licence).toContain("Permission is hereby granted, free of charge");
    expect(licence).toContain("THE SOFTWARE IS PROVIDED \"AS IS\"");
  });

  it("lists every shipped dependency in the third-party notices", () => {
    expect(existsSync(join(root, "THIRD-PARTY-NOTICES.md")), "there are no third-party notices").toBe(
      true,
    );
    const notices = read("THIRD-PARTY-NOTICES.md");
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      expect(notices, `${name} ships but is not in the notices`).toContain(name);
    }
  });

  it("names the licence of every shipped dependency", () => {
    // Read from the installed packages rather than from a list written by hand,
    // so a dependency that changes licence is caught here.
    const notices = read("THIRD-PARTY-NOTICES.md");
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      const manifest = join(root, "node_modules", name, "package.json");
      if (!existsSync(manifest)) continue;
      const licence = (JSON.parse(readFileSync(manifest, "utf8")) as { license?: string }).license;
      if (!licence) continue;
      const row = notices.split("\n").find((line) => line.includes(`\`${name}\``));
      expect(row, `${name} has no row in the notices`).toBeDefined();
      expect(row, `${name} is licensed ${licence}, and the notices say otherwise`).toContain(licence);
    }
  });

  it("states the four things the privacy page has to state", () => {
    const privacy = read("docs/PRIVACY.md").toLowerCase();
    // No data collected.
    expect(privacy).toMatch(/no data is collected|does not collect|collects no data/);
    // No cookies.
    expect(privacy).toContain("cookie");
    // The optional STUN disclosure.
    expect(privacy).toContain("stun");
    // The hosting provider's logs are outside our control.
    expect(privacy).toMatch(/hosting-provider logs|hosting provider|provider logs/);
  });

  it("has terms that cover what the PRD asks them to cover", () => {
    expect(existsSync(join(root, "docs/TERMS.md")), "there are no terms").toBe(true);
    const terms = read("docs/TERMS.md").toLowerCase();
    // Provided as-is.
    expect(terms).toContain("as-is");
    // The user is responsible for what they send.
    expect(terms).toMatch(/responsible for (the files you send|what you send)/);
    // A prohibited-use notice.
    expect(terms).toContain("prohibited");
  });

  it("keeps the naming rule: no AirDrop in anything that ships", () => {
    // §15: the comparison is descriptive and only appears in this project's own
    // documentation - never in the logo, the domain, or what the user sees.
    for (const file of [...shippedFiles(join(root, "src")), join(root, "index.html")]) {
      expect(readFileSync(file, "utf8"), `${file} names a product that is not this one`).not.toMatch(
        /airdrop/i,
      );
    }
  });
});
