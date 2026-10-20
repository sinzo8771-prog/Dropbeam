import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The agent-discovery files the site publishes (Lighthouse's agentic-browsing
 * category).
 *
 * Both exist because the static host answers *every* path with the app's
 * `index.html`, so a crawler asking for `/llms.txt` or for
 * `/.well-known/ai-catalog.json` used to be handed a page of markup and
 * nothing else. Publishing the two files is what makes those answers mean
 * something.
 *
 * What they must not do is claim something untrue. The catalogue lists no
 * entries because the app publishes no agent-callable resources: it has no
 * server-side API, and a manifest full of invented URLs would be worse than
 * an empty one. So the test holds the *shape* of both files, and the
 * emptiness of the catalogue is asserted on purpose.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const llmsTxtPath = join(root, "public/llms.txt");
const catalogPath = join(root, "public/.well-known/ai-catalog.json");

/** The URN form the catalogue's identifiers have to take (RFC 8141). */
const URN = /^urn:air:[a-zA-Z0-9.-]+(:[a-zA-Z0-9._-]+)+$/;

describe("llms.txt", () => {
  it("is published", () => {
    expect(existsSync(llmsTxtPath)).toBe(true);
  });

  it("says what the site is, in the shape a crawler can use", () => {
    const text = readFileSync(llmsTxtPath, "utf8");
    // One H1, the site's name.
    expect(text).toMatch(/^#\s+\S/m);
    // A short summary, so a crawler can quote it.
    expect(text.length).toBeGreaterThan(50);
    // And links to the documentation, which is the point of the file.
    const links = [...text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)];
    expect(links.length).toBeGreaterThan(0);
    for (const [, label, href] of links) {
      expect(label.trim().length).toBeGreaterThan(0);
      expect(href).toMatch(/^https:\/\//);
    }
  });

  it("links only to files this repository actually has", () => {
    const text = readFileSync(llmsTxtPath, "utf8");
    for (const [, , href] of text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
      // Every link points into the repo's docs/ on the default branch.
      const path = href.replace(/^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/main\//, "");
      expect(path, `llms.txt links to ${href}, which is not in the repository`).toMatch(
        /^docs\/[A-Z-]+\.md$/,
      );
      expect(existsSync(join(root, path)), `llms.txt links to a missing ${path}`).toBe(true);
    }
  });
});

describe("the agent resource catalogue", () => {
  it("is published where the spec looks for it", () => {
    expect(existsSync(catalogPath)).toBe(true);
  });

  it("is a valid manifest", () => {
    const manifest = JSON.parse(readFileSync(catalogPath, "utf8")) as Record<string, unknown>;
    // The two required root properties, and the version the spec recognises.
    expect(manifest.specVersion).toBe("1.0");
    expect(Array.isArray(manifest.entries)).toBe(true);
    // The publisher is named, so an agent knows who is speaking.
    const host = manifest.host as { displayName?: string } | undefined;
    expect(host?.displayName).toBe("Dropbeam");
  });

  it("claims no resources, because the app publishes none", () => {
    // An empty catalogue is the honest one: there is no server-side API for
    // an agent to call, and a manifest full of invented URLs would be a
    // false claim rather than a discovery aid.
    const manifest = JSON.parse(readFileSync(catalogPath, "utf8")) as { entries: unknown[] };
    expect(manifest.entries).toEqual([]);
  });

  it("would accept an entry that follows the spec, if one were ever added", () => {
    // The shape an entry has to have, checked here so that adding one later
    // cannot quietly break the manifest: an identifier in the URN form, a
    // name, a type, and exactly one of a URL or an inline document.
    const manifest = JSON.parse(readFileSync(catalogPath, "utf8")) as {
      entries: {
        identifier?: string;
        displayName?: string;
        type?: string;
        url?: string;
        data?: unknown;
      }[];
    };
    for (const entry of manifest.entries) {
      expect(entry.identifier).toMatch(URN);
      expect(entry.displayName?.length).toBeGreaterThan(0);
      expect(entry.type?.length).toBeGreaterThan(0);
      expect(Boolean(entry.url) !== Boolean(entry.data)).toBe(true);
    }
  });
});
