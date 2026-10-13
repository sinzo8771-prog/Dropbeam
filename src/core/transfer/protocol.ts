import { isErrorCode, type ErrorCode } from "../errors";

/** PRD 8.4: 16 KiB payload chunks (cross-browser safe). */
export const CHUNK_SIZE = 16 * 1024;
/** PRD 8.4: 1 MiB read-ahead blocks when reading a Blob. */
export const READ_AHEAD = 1024 * 1024;
export const PROTOCOL_VERSION = 1;
export const CHANNEL_LABEL = "dropbeam";
export const MAX_TEXT_BYTES = 1024 * 1024; // FR-12
export const PING_INTERVAL_MS = 5_000;
export const PONG_TIMEOUT_MS = 15_000;

export type OfferedFile = {
  fid: number;
  name: string;
  size: number;
  type: string;
  path?: string;
  /**
   * Resume point: how many leading chunks of this file the receiver already
   * holds (roadmap: resumable transfers). Absent for a fresh offer; the sender
   * sets it when it re-offers a file that matches the receiver's parked partial.
   */
  chunks?: number;
};

export type PeerCaps = { fsa: boolean; opfs: boolean };

/** One parked partial file, as announced by a receiver after `hello`. */
export type ResumedFile = {
  /** The fid the *previous* session used, for UI continuity. */
  fid: number;
  name: string;
  size: number;
  /** Contiguous chunks already written to the receiving sink. */
  chunks: number;
};

export type ControlMessage =
  | { k: "hello"; v: number; name?: string; caps: PeerCaps }
  | { k: "offer"; id: string; files: OfferedFile[]; totalSize: number }
  | { k: "resume"; files: ResumedFile[] }
  | { k: "accept"; id: string; fids: number[] }
  | { k: "decline"; id: string }
  | { k: "done"; fid: number; sha256: string }
  | { k: "ok"; fid: number }
  /**
   * Whole-file hash mismatch (roadmap: per-chunk repair). Receiver → sender:
   * the staged bytes failed verification, ask for a repair plan.
   */
  | { k: "mismatch"; fid: number }
  /**
   * Repair plan (roadmap: per-chunk repair). Sender → receiver: the SHA-256
   * of every 16 KiB chunk of the source, in order, so the receiver can diff
   * them against what it staged and name only the bad indices.
   */
  | { k: "plan"; fid: number; hashes: string[] }
  /**
   * Repair request (roadmap: per-chunk repair). Receiver → sender: re-send
   * exactly these chunk indices. Single-pass — the receiver never asks twice.
   */
  | { k: "repair"; fid: number; indices: number[] }
  | { k: "err"; fid: number; code: ErrorCode }
  | { k: "cancel"; fid: number }
  | { k: "text"; id: string; body: string }
  | { k: "ping" }
  | { k: "pong" };

export function encodeControl(msg: ControlMessage): string {
  return JSON.stringify(msg);
}

function isOfferedFile(v: unknown): v is OfferedFile {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.fid === "number" &&
    Number.isInteger(f.fid) &&
    typeof f.name === "string" &&
    typeof f.size === "number" &&
    typeof f.type === "string" &&
    (f.path === undefined || typeof f.path === "string") &&
    // Resume point, when the peer re-offers a parked file. Bounded by the
    // file size (PRD 9.4): a peer cannot claim an offset past the end and
    // make us zero-fill the staged bytes.
    (f.chunks === undefined ||
      (typeof f.chunks === "number" &&
        Number.isInteger(f.chunks) &&
        f.chunks >= 0 &&
        f.chunks * CHUNK_SIZE <= (f.size as number)))
  );
}

function isResumedFile(v: unknown): v is ResumedFile {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.fid === "number" &&
    Number.isInteger(f.fid) &&
    typeof f.name === "string" &&
    typeof f.size === "number" &&
    typeof f.chunks === "number" &&
    Number.isInteger(f.chunks) &&
    f.chunks >= 0 &&
    f.chunks * CHUNK_SIZE <= (f.size as number)
  );
}

/* ---------------- chunk arithmetic ---------------- */

/** Chunks a `size`-byte file needs; the last one may be short (PRD 8.4). */
export function chunkCount(size: number): number {
  return Math.ceil(size / CHUNK_SIZE);
}

/** Chunk `index` covers `[offset, offset + size)`, except the last chunk. */
export function chunkOffset(index: number): number {
  return index * CHUNK_SIZE;
}

/**
 * Decode a control frame from the peer. Never throws: peer data is untrusted
 * (PRD 9.4), so anything malformed returns null and is dropped.
 */
export function decodeControl(raw: unknown): ControlMessage | null {
  if (typeof raw !== "string" || raw.length > 4 * 1024 * 1024) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const m = parsed as Record<string, unknown>;
  switch (m.k) {
    case "hello":
      if (typeof m.v !== "number") return null;
      return {
        k: "hello",
        v: m.v,
        name: typeof m.name === "string" ? m.name.slice(0, 64) : undefined,
        caps: {
          fsa: !!(m.caps as PeerCaps | undefined)?.fsa,
          opfs: !!(m.caps as PeerCaps | undefined)?.opfs,
        },
      };
    case "offer": {
      if (typeof m.id !== "string" || !Array.isArray(m.files)) return null;
      const files = m.files.filter(isOfferedFile).slice(0, 4096);
      if (files.length === 0) return null;
      const totalSize =
        typeof m.totalSize === "number" && m.totalSize >= 0
          ? m.totalSize
          : files.reduce((n, f) => n + f.size, 0);
      return { k: "offer", id: m.id.slice(0, 64), files, totalSize };
    }
    case "resume": {
      // Receiver → sender, right after hello: the partials this side still
      // holds. A peer that does not know the message drops it (null above
      // is only for malformed frames, so an unknown `k` lands in `default`).
      if (!Array.isArray(m.files)) return null;
      const files = m.files.filter(isResumedFile).slice(0, 4096);
      return { k: "resume", files };
    }
    case "accept": {
      if (typeof m.id !== "string" || !Array.isArray(m.fids)) return null;
      const fids = m.fids.filter((f): f is number => typeof f === "number" && Number.isInteger(f));
      return { k: "accept", id: m.id.slice(0, 64), fids };
    }
    case "decline":
      if (typeof m.id !== "string") return null;
      return { k: "decline", id: m.id.slice(0, 64) };
    case "done":
      if (typeof m.fid !== "number" || typeof m.sha256 !== "string") return null;
      if (!/^[0-9a-f]{64}$/.test(m.sha256)) return null;
      return { k: "done", fid: m.fid, sha256: m.sha256 };
    case "ok":
      if (typeof m.fid !== "number") return null;
      return { k: "ok", fid: m.fid };
    case "mismatch":
      if (typeof m.fid !== "number") return null;
      return { k: "mismatch", fid: m.fid };
    case "plan": {
      if (typeof m.fid !== "number" || !Array.isArray(m.hashes)) return null;
      // Bounded by PRD 9.4: a plan can never describe more chunks than the
      // file has, and every entry must be a lowercase 64-hex digest.
      const hashes = m.hashes
        .slice(0, 1_048_576)
        .filter((h): h is string => typeof h === "string" && /^[0-9a-f]{64}$/.test(h));
      return { k: "plan", fid: m.fid, hashes };
    }
    case "repair": {
      if (typeof m.fid !== "number" || !Array.isArray(m.indices)) return null;
      const indices = m.indices
        .slice(0, 1_048_576)
        .filter((i): i is number => typeof i === "number" && Number.isInteger(i) && i >= 0);
      return { k: "repair", fid: m.fid, indices };
    }
    case "err":
      if (typeof m.fid !== "number" || !isErrorCode(m.code)) return null;
      return { k: "err", fid: m.fid, code: m.code };
    case "cancel":
      if (typeof m.fid !== "number") return null;
      return { k: "cancel", fid: m.fid };
    case "text": {
      if (typeof m.id !== "string" || typeof m.body !== "string") return null;
      if (m.body.length > MAX_TEXT_BYTES) return null;
      return { k: "text", id: m.id.slice(0, 64), body: m.body };
    }
    case "ping":
      return { k: "ping" };
    case "pong":
      return { k: "pong" };
    default:
      return null;
  }
}

/* ---------------- binary data frames ---------------- */

export const FRAME_TYPE_DATA = 0x01;
export const FRAME_HEADER_SIZE = 9; // [1 type][4 fid][4 seq] big-endian

/**
 * `[1 byte type=0x01][4 bytes fid BE][4 bytes seq BE][payload]` (PRD 8.4).
 * Returns a standalone ArrayBuffer suitable for `channel.send`.
 */
export function encodeDataFrame(fid: number, seq: number, payload: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(FRAME_HEADER_SIZE + payload.byteLength);
  out[0] = FRAME_TYPE_DATA;
  const view = new DataView(out.buffer);
  view.setUint32(1, fid >>> 0, false);
  view.setUint32(5, seq >>> 0, false);
  out.set(payload, FRAME_HEADER_SIZE);
  return out.buffer;
}

export type DataChunk = { fid: number; seq: number; payload: Uint8Array };

export function decodeDataFrame(data: unknown): DataChunk | null {
  let bytes: Uint8Array;
  if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  } else return null;

  if (bytes.byteLength < FRAME_HEADER_SIZE) return null;
  if (bytes[0] !== FRAME_TYPE_DATA) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    fid: view.getUint32(1, false),
    seq: view.getUint32(5, false),
    payload: bytes.subarray(FRAME_HEADER_SIZE),
  };
}

export function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
