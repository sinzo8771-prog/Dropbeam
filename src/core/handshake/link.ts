import { DropbeamError } from "../errors";
import { DB0_PREFIX } from "./codec-db0";
import { DB1_PREFIX } from "./codec-db1";
import { MAX_CODE_LENGTH } from "./encoding";

/**
 * Shareable pairing links (PRD 8.2.3): the offer travels in `#j=<code>`
 * (opens the site in Join mode), the answer in `#a=<code>`. Codes are
 * base64url + a dotted prefix — every character is fragment-safe — so the
 * code is never percent-encoded on the way out; on the way in we still
 * tolerate percent-encoding and whitespace because messengers and users
 * mangle links.
 */

export type PairKind = "j" | "a";
export type PairLink = { kind: PairKind; code: string };

function invalid(message: string): DropbeamError {
  return new DropbeamError("CODE_INVALID", message);
}

export function buildPairLink(base: string, kind: PairKind, code: string): string {
  if (typeof base !== "string" || typeof code !== "string") {
    throw invalid("link arguments must be text");
  }
  const clean = code.replace(/\s+/g, "");
  if (clean.length === 0 || clean.length > MAX_CODE_LENGTH) {
    throw invalid("code has an invalid length");
  }
  if (!clean.startsWith(DB1_PREFIX) && !clean.startsWith(DB0_PREFIX)) {
    throw invalid("code has an unknown codec prefix");
  }
  // `https://site/#j=…` (PRD 8.2.3): strip any old fragment and trailing
  // slashes so the fragment always sits right after the root path.
  const root = base.replace(/#.*$/, "").replace(/\/+$/, "");
  return `${root}/#${kind}=${clean}`;
}

/**
 * Parse a pairing link from a full URL, a bare `#j=…` fragment, or the
 * fragment without `#`. Returns null for anything else (unknown anchors are
 * legitimate in-page routes, not pairing links).
 */
export function parsePairLink(text: string): PairLink | null {
  if (typeof text !== "string") return null;
  const hashAt = text.indexOf("#");
  const fragment = hashAt >= 0 ? text.slice(hashAt + 1) : text;
  const match = /^([aj])=([\s\S]+)$/.exec(fragment);
  if (!match) return null;
  let raw = match[2]!;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // Malformed escapes: keep the fragment as literal text.
  }
  const code = raw.replace(/\s+/g, "");
  if (code.length === 0 || code.length > MAX_CODE_LENGTH) return null;
  if (!code.startsWith(DB1_PREFIX) && !code.startsWith(DB0_PREFIX)) return null;
  return { kind: match[1] as PairKind, code };
}

/**
 * One scanned or pasted string → a code, whether it arrived raw
 * (`DB1.…`/`DB0.…`, possibly whitespace-wrapped in blocks of 5 per
 * PRD 8.2.3) or inside a pairing link. Anything else is null.
 */
export function extractCode(text: string): string | null {
  const link = parsePairLink(text);
  if (link) return link.code;
  if (typeof text !== "string") return null;
  const code = text.replace(/\s+/g, "");
  if (code.length === 0 || code.length > MAX_CODE_LENGTH) return null;
  if (code.startsWith(DB1_PREFIX) || code.startsWith(DB0_PREFIX)) return code;
  return null;
}
