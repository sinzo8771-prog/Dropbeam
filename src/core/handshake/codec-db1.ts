import { DropbeamError } from "../errors";
import {
  formatCompactCandidate,
  parseCompactCandidate,
  selectCandidates,
  type ParsedCandidate,
} from "./candidates";
import {
  deflateRaw,
  inflateRaw,
  takePayload,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  type CompressionImpl,
} from "./encoding";

/**
 * DB1 — minimal data-channel-only descriptor (PRD 8.2.1).
 *
 * Pipeline: Handshake → JSON (short keys) → deflate-raw → base64url →
 * prefix "DB1.". The receiver rebuilds a standards-valid SDP from the fixed
 * template in sdp-template.ts.
 */

export const DB1_PREFIX = "DB1.";
/** PRD FR-7: codes expire client-side after 10 minutes. */
export const HANDSHAKE_TTL_SECONDS = 10 * 60;
/** Allow modest clock skew between the two devices before calling a code stale. */
export const HANDSHAKE_SKEW_SECONDS = 60;

export type Handshake = {
  /** format version */
  v: 1;
  /** offer | answer */
  t: "o" | "a";
  /** created at (unix seconds) for expiry */
  ts: number;
  /** ice-ufrag */
  u: string;
  /** ice-pwd */
  p: string;
  /** DTLS fingerprint, sha-256, base64url of 32 bytes */
  f: string;
  /** DTLS setup role */
  s: "actpass" | "active";
  /** candidates, compact */
  c: string[];
  /** sctp port (default 5000), max message size */
  m?: { sp: number; mms: number };
  /** optional device label */
  n?: string;
};

export type CodecOptions = {
  /** Override for tests; defaults to system clock. */
  nowSeconds?: number;
  impl?: CompressionImpl;
};

const UIFRAG_RE = /^[A-Za-z0-9+/]{1,256}$/;
const ICE_PWD_RE = /^[A-Za-z0-9+/]{1,512}$/;
/** sha-256, 32 bytes, base64url without padding = 43 chars. */
const FINGERPRINT_RE = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_LABEL_MAX = 64;
/** Guard against absurd field sizes before they reach SDP (PRD 9.4). */
const MAX_FIELD_LENGTH = 512;

function invalid(message: string): DropbeamError {
  return new DropbeamError("CODE_INVALID", message);
}

function nowSeconds(opts?: CodecOptions): number {
  return opts?.nowSeconds ?? Math.floor(Date.now() / 1000);
}

/**
 * Validate an untrusted handshake object (PRD 9.4: peer data never throws
 * through raw — it rejects with CODE_INVALID / CODE_EXPIRED).
 */
export function validateHandshake(value: unknown, opts?: CodecOptions): Handshake {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("handshake is not an object");
  }
  const h = value as Record<string, unknown>;

  if (h.v !== 1) throw invalid("unsupported handshake version");
  if (h.t !== "o" && h.t !== "a") throw invalid("handshake type must be offer or answer");
  if (typeof h.ts !== "number" || !Number.isInteger(h.ts) || h.ts <= 0) {
    throw invalid("handshake timestamp is malformed");
  }
  const age = nowSeconds(opts) - h.ts;
  if (age > HANDSHAKE_TTL_SECONDS + HANDSHAKE_SKEW_SECONDS) {
    throw new DropbeamError("CODE_EXPIRED", "handshake code expired");
  }
  if (age < -HANDSHAKE_SKEW_SECONDS) {
    throw invalid("handshake timestamp is in the future");
  }
  if (typeof h.u !== "string" || !UIFRAG_RE.test(h.u)) throw invalid("bad ice-ufrag");
  if (typeof h.p !== "string" || !ICE_PWD_RE.test(h.p)) throw invalid("bad ice-pwd");
  if (typeof h.f !== "string" || !FINGERPRINT_RE.test(h.f)) {
    throw invalid("bad DTLS fingerprint");
  }
  if (h.s !== "actpass" && h.s !== "active") throw invalid("bad DTLS setup role");

  if (!Array.isArray(h.c) || h.c.length === 0) throw invalid("handshake has no candidates");
  if (h.c.length > 64) throw invalid("handshake has too many candidates");
  const parsed: ParsedCandidate[] = [];
  for (const entry of h.c) {
    if (typeof entry !== "string" || entry.length > MAX_FIELD_LENGTH) {
      throw invalid("candidate entry is malformed");
    }
    const c = parseCompactCandidate(entry);
    if (!c) throw invalid("candidate entry is malformed");
    parsed.push(c);
  }
  // Lenient filter: drop TCP/relay/link-local rather than rejecting (8.2.2),
  // but a code with zero usable candidates can never connect.
  const usable = selectCandidates(parsed);
  if (usable.length === 0) throw invalid("handshake has no usable candidates");

  let m: { sp: number; mms: number } | undefined;
  if (h.m !== undefined) {
    if (typeof h.m !== "object" || h.m === null || Array.isArray(h.m)) {
      throw invalid("sctp metadata is malformed");
    }
    const mm = h.m as Record<string, unknown>;
    if (typeof mm.sp !== "number" || !Number.isInteger(mm.sp) || mm.sp < 1 || mm.sp > 65535) {
      throw invalid("sctp port is out of range");
    }
    if (
      typeof mm.mms !== "number" ||
      !Number.isInteger(mm.mms) ||
      mm.mms < 0 ||
      mm.mms > 64 * 1024 * 1024
    ) {
      throw invalid("max message size is out of range");
    }
    m = { sp: mm.sp, mms: mm.mms };
  }

  let n: string | undefined;
  if (h.n !== undefined) {
    if (typeof h.n !== "string") throw invalid("device label is malformed");
    // Control characters stripped; label is display-only (PRD 9.4/10.4).
    n = h.n
      .replace(/\p{Cc}/gu, "")
      .trim()
      .slice(0, DEVICE_LABEL_MAX);
    if (n === "") n = undefined;
  }

  const out: Handshake = {
    v: 1,
    t: h.t,
    ts: h.ts,
    u: h.u,
    p: h.p,
    f: h.f,
    s: h.s,
    c: usable.map(formatCompactCandidate),
  };
  if (m) out.m = m;
  if (n) out.n = n;
  return out;
}

export async function encodeDb1(hs: Handshake, opts?: CodecOptions): Promise<string> {
  const validated = validateHandshake(hs, opts);
  const json = utf8Encode(JSON.stringify(validated));
  const deflated = await deflateRaw(json, opts?.impl);
  return DB1_PREFIX + toBase64Url(deflated);
}

export async function decodeDb1(code: string, opts?: CodecOptions): Promise<Handshake> {
  const payload = takePayload(code, DB1_PREFIX);
  const json = await inflateRaw(payload, opts?.impl);
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(json));
  } catch {
    throw invalid("handshake payload is not valid JSON");
  }
  return validateHandshake(parsed, opts);
}
