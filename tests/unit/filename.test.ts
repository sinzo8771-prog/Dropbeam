import { describe, expect, it } from "vitest";
import {
  dedupeFilename,
  isExecutableFilename,
  middleEllipsis,
  sanitizeFilename,
} from "../../src/core/storage/filename";
import { FILENAME_MAX } from "../../src/core/storage/limits";

/**
 * The filename guard (PRD FR-32, PRD 13.1).
 *
 * §13.1 asks for this one "table-driven with hostile inputs", and the reason
 * is the threat model: a name arrives from the *other* device, so it is
 * attacker-controlled text that ends up in a file path, a download name and a
 * save dialog. The table below is the hostile set - path traversal, control
 * characters, Windows' reserved device names, names that are only dots, and
 * names long enough to overflow a filesystem - with the answer written beside
 * each one, so a change in the rules shows up as a changed row rather than as
 * a surprise on a user's disk.
 */

/** A control character that is not a tab or a newline. */
const NUL = "\u0000";
const BELL = "\u0007";
const DEL = "\u007f";

const HOSTILE: { name: string; input: string; expect: string; why: string }[] = [
  {
    name: "a plain name",
    input: "report.pdf",
    expect: "report.pdf",
    why: "the common case is left alone",
  },
  {
    name: "a unix path",
    input: "../../etc/passwd",
    expect: "_.._etc_passwd",
    why: "separators cannot survive, or the name escapes the directory",
  },
  {
    name: "a windows path",
    input: "C:\\Windows\\System32\\config",
    expect: "C:_Windows_System32_config",
    why: "both separators have to go, not just the unix one",
  },
  {
    name: "a leading dot",
    input: ".hidden",
    expect: "hidden",
    why: "a leading dot is hidden on unix and refused on Windows",
  },
  {
    name: "leading spaces",
    input: "   spaced.txt",
    expect: "spaced.txt",
    why: "trailing spaces are silently dropped by some filesystems",
  },
  {
    name: "a NUL byte",
    input: `evil${NUL}.txt`,
    expect: "evil.txt",
    why: "a NUL truncates the name in C APIs",
  },
  {
    name: "a bell and a delete",
    input: `ring${BELL}er${DEL}.txt`,
    expect: "ringer.txt",
    why: "control characters have no business in a filename",
  },
  {
    name: "only dots",
    input: "..",
    expect: "file",
    why: "the parent directory is not a filename",
  },
  {
    name: "nothing at all",
    input: "",
    expect: "file",
    why: "there has to be a name to save under",
  },
  {
    name: "a reserved device name",
    input: "CON",
    expect: "_CON",
    why: "Windows refuses to create a file with that name",
  },
  {
    name: "a reserved name with an extension",
    input: "nul.txt",
    expect: "_nul.txt",
    why: "the extension does not make the name safe",
  },
  {
    name: "a name that only looks reserved",
    input: "console",
    expect: "console",
    why: "only the exact device names are reserved",
  },
];

describe("the filename guard (PRD FR-32, 13.1)", () => {
  it("handles the hostile set", () => {
    for (const row of HOSTILE) {
      expect(sanitizeFilename(row.input), `${row.name}: ${row.why}`).toBe(row.expect);
    }
  });

  it("keeps the extension when a long name is clamped", () => {
    const long = `${"x".repeat(FILENAME_MAX + 50)}.pdf`;
    const safe = sanitizeFilename(long);
    expect(safe.length).toBeLessThanOrEqual(FILENAME_MAX);
    expect(safe.endsWith(".pdf")).toBe(true);
  });

  it("clamps a name whose extension is longer than the budget", () => {
    const long = `${"x".repeat(FILENAME_MAX + 50)}.averyverylongextension`;
    const safe = sanitizeFilename(long);
    expect(safe.length).toBeLessThanOrEqual(FILENAME_MAX);
  });

  it("uses the caller's fallback for an empty name", () => {
    expect(sanitizeFilename("", "download")).toBe("download");
  });

  it("adds a counter to a name that is taken", () => {
    const taken = new Set(["report.pdf", "report (1).pdf"]);
    expect(dedupeFilename("report.pdf", (n) => taken.has(n))).toBe("report (2).pdf");
  });

  it("leaves a free name alone", () => {
    expect(dedupeFilename("report.pdf", () => false)).toBe("report.pdf");
  });

  it("knows which names can execute", () => {
    expect(isExecutableFilename("setup.exe")).toBe(true);
    expect(isExecutableFilename("script.SH")).toBe(true);
    expect(isExecutableFilename("notes.txt")).toBe(false);
    expect(isExecutableFilename("noextension")).toBe(false);
  });

  it("shortens a long name for display, keeping the extension visible", () => {
    const shown = middleEllipsis(`${"a".repeat(80)}.pdf`);
    expect(shown.length).toBeLessThanOrEqual(42);
    expect(shown.endsWith(".pdf")).toBe(true);
    expect(shown).toContain("…");
  });

  it("leaves a short name for display alone", () => {
    expect(middleEllipsis("notes.txt")).toBe("notes.txt");
  });
});
