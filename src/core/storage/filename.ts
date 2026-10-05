import { FILENAME_MAX } from "./limits";

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// Unicode `Cc` category: all C0/C1 control chars plus DEL, without literal control escapes.
const CONTROL_CHARS = /\p{Cc}/gu;
const PATH_SEPARATORS = /[/\\]+/g;

/** PRD FR-33: extensions that can execute code; warn before opening. */
export const EXECUTABLE_EXTENSIONS = [
  ".exe",
  ".msi",
  ".apk",
  ".bat",
  ".sh",
  ".js",
  ".jar",
  ".scr",
  ".cmd",
] as const;

/**
 * PRD FR-32: strip path separators, control chars and reserved Windows names;
 * clamp to 200 chars; keep the extension.
 */
export function sanitizeFilename(input: string, fallback = "file"): string {
  let name = (input ?? "")
    .replace(PATH_SEPARATORS, "_")
    .replace(CONTROL_CHARS, "")
    .replace(/^[.\s]+/, "")
    .trim();

  if (name === "" || name === "." || name === "..") name = fallback;
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;

  if (name.length > FILENAME_MAX) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    name = name.slice(0, FILENAME_MAX - ext.length) + ext;
  }
  return name;
}

/** PRD FR-32: `report.pdf` → `report (1).pdf` when the name is taken. */
export function dedupeFilename(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}

export function isExecutableFilename(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = name.slice(dot).toLowerCase();
  return (EXECUTABLE_EXTENSIONS as readonly string[]).includes(ext);
}

/** Middle-ellipsis for display: keeps the extension visible (PRD 10.2.1). */
export function middleEllipsis(name: string, max = 42): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : "";
  const stem = ext ? name.slice(0, name.length - ext.length) : name;
  const keep = max - ext.length - 1;
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${stem.slice(0, head)}…${stem.slice(stem.length - tail)}${ext}`;
}
