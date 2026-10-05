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
};

export type PeerCaps = { fsa: boolean; opfs: boolean };

export type ControlMessage =
  | { k: "hello"; v: number; name?: string; caps: PeerCaps }
  | { k: "offer"; id: string; files: OfferedFile[]; totalSize: number }
  | { k: "accept"; id: string; fids: number[] }
  | { k: "decline"; id: string }
  | { k: "done"; fid: number; sha256: string }
  | { k: "ok"; fid: number }
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
    (f.path === undefined || typeof f.path === "string")
  );
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
