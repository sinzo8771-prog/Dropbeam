import { DropbeamError } from "../errors";
import { extractCode } from "./link";
import { MAX_CODE_LENGTH } from "./encoding";

/**
 * Multi-frame animated QR fallback (PRD 8.2.4, FR-4).
 *
 * Wire format: `DBF|<id>|<index>|<total>|<payload>` — every full frame string
 * is at most MAX_FRAME_BYTES bytes (the code itself is always ASCII, so one
 * character is one byte). The sender animates the frames at 4 fps
 * (FRAME_INTERVAL_MS); the scanner collects them in any order, ignores
 * duplicates, and restarts assembly when the frame id changes (the sender
 * re-issued its code).
 */

export const DBF_PREFIX = "DBF|";
/** PRD 8.2.4: frames (header included) are at most 400 bytes. */
export const MAX_FRAME_BYTES = 400;
/** PRD 8.2.4: sender animates at 4 frames/s. */
export const FRAME_INTERVAL_MS = 250;
/** 16 KiB of code ÷ ~380-byte payloads ≈ 44 frames; 64 leaves headroom. */
export const MAX_FRAMES = 64;

const FRAME_ID_LENGTH = 6;
const FRAME_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const FRAME_ID_RE = /^[A-Za-z0-9]{1,16}$/;
const FRAME_INDEX_RE = /^\d{1,4}$/;

export type QrFrame = { id: string; index: number; total: number; payload: string };

export type ScanEvent =
  | { kind: "ignored" }
  | { kind: "progress"; received: number; total: number }
  | { kind: "code"; code: string };

/** Random id correlating one code's frames; injectable for tests. */
export function newFrameId(): string {
  const bytes = new Uint8Array(FRAME_ID_LENGTH);
  // Web Crypto is universal in browsers and Node ≥ 19; Math.random keeps
  // the id correlating frames even on exotic runtimes (it is not a secret).
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.getRandomValues === "function") {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let id = "";
  for (const byte of bytes) id += FRAME_ID_ALPHABET[byte % FRAME_ID_ALPHABET.length];
  return id;
}

function invalid(message: string): DropbeamError {
  return new DropbeamError("CODE_INVALID", message);
}

export function splitIntoFrames(code: string, opts?: { id?: string }): string[] {
  if (typeof code !== "string" || code.length === 0 || code.length > MAX_CODE_LENGTH) {
    throw invalid("code has an invalid length for multi-frame QR");
  }
  const id = opts?.id ?? newFrameId();
  if (!FRAME_ID_RE.test(id)) throw new DropbeamError("INTERNAL", "invalid frame id");
  const headerLen = (index: number, total: number) => `DBF|${id}|${index}|${total}|`.length;

  // Frame headers grow with the digits of <index>/<total>; size every chunk
  // against the longest header of the final total, then recompute the total
  // until the two agree. With codes ≤ 16 KiB the total never exceeds 44, so
  // this converges within a few passes (bounded by the loop).
  let total = 1;
  for (let pass = 0; pass < 8; pass++) {
    const chunk = MAX_FRAME_BYTES - headerLen(total - 1, total);
    const next = Math.max(1, Math.ceil(code.length / chunk));
    if (next === total) break;
    total = next;
  }
  const chunk = MAX_FRAME_BYTES - headerLen(total - 1, total);
  if (code.length > chunk * total) {
    throw new DropbeamError("INTERNAL", "frame split did not converge");
  }

  const frames: string[] = [];
  for (let index = 0; index < total; index++) {
    const payload = code.slice(index * chunk, (index + 1) * chunk);
    frames.push(`DBF|${id}|${index}|${total}|${payload}`);
  }
  return frames;
}

/** Parse a scanned `DBF|…` frame; null when structurally malformed. */
export function parseFrame(text: string): QrFrame | null {
  if (typeof text !== "string") return null;
  const parts = text.split("|");
  if (parts.length !== 5) return null;
  const [prefix, id, indexText, totalText, payload] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (prefix !== "DBF") return null;
  if (!FRAME_ID_RE.test(id)) return null;
  if (!FRAME_INDEX_RE.test(indexText) || !FRAME_INDEX_RE.test(totalText)) return null;
  const index = Number(indexText);
  const total = Number(totalText);
  if (total < 1 || total > MAX_FRAMES) return null;
  if (index >= total) return null;
  if (payload.length === 0) return null;
  return { id, index, total, payload };
}

/**
 * Feeds scanned strings in and gets back the code:
 *
 * - a direct code or pairing link completes immediately (and resets any
 *   half-assembled frames);
 * - a `DBF` frame advances assembly — any order, duplicates ignored, a new
 *   frame id restarts the assembly (a mismatched total under the same id is
 *   corrupt and dropped);
 * - anything else is ignored.
 */
export class FrameAssembler {
  private id: string | null = null;
  private total = 0;
  private parts: (string | null)[] = [];
  private received = 0;

  reset(): void {
    this.id = null;
    this.total = 0;
    this.parts = [];
    this.received = 0;
  }

  feed(text: string): ScanEvent {
    const direct = extractCode(text);
    if (direct !== null) {
      this.reset();
      return { kind: "code", code: direct };
    }
    const frame = parseFrame(text);
    if (!frame) return { kind: "ignored" };
    if (frame.id !== this.id) {
      // First frame or the sender re-issued its code: start over.
      this.id = frame.id;
      this.total = frame.total;
      this.parts = new Array<string | null>(frame.total).fill(null);
      this.received = 0;
    } else if (frame.total !== this.total) {
      return { kind: "ignored" };
    }
    if (this.parts[frame.index] === null) {
      this.parts[frame.index] = frame.payload;
      this.received += 1;
    }
    if (this.received === this.total) {
      const code = this.parts.join("");
      this.reset();
      return { kind: "code", code };
    }
    return { kind: "progress", received: this.received, total: this.total };
  }
}
