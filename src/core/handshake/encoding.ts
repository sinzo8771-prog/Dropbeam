import { Inflate, deflateSync } from "fflate";
import { DropbeamError } from "../errors";

/**
 * Wire encoding shared by the DB0/DB1 codecs (PRD 8.2.1): bytes →
 * deflate-raw → base64url, plus strict base64url helpers.
 *
 * Compression uses the native `CompressionStream("deflate-raw")` when the
 * runtime provides it (PRD 8.1) and falls back to the pinned `fflate`
 * package. Tests exercise both implementations, including cross-decoding.
 */

export type CompressionImpl = "native" | "fflate";

/** Max code length after whitespace stripping (text/link routes stay far below). */
export const MAX_CODE_LENGTH = 16 * 1024;
/** Cap on inflated output — guards decompression bombs in peer-supplied codes (PRD 9.4). */
export const MAX_INFLATED_BYTES = 1024 * 1024;

const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_RE = /^[A-Za-z0-9_-]*={0,2}$/;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function utf8Encode(text: string): Uint8Array {
  return textEncoder.encode(text);
}

/** Strict UTF-8 decode; invalid byte sequences are a malformed code (PRD 9.4). */
export function utf8Decode(bytes: Uint8Array): string {
  try {
    return textDecoder.decode(bytes);
  } catch {
    throw new DropbeamError("CODE_INVALID", "code payload is not valid UTF-8");
  }
}

export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const remaining = bytes.length - i;
    const b0 = bytes[i]!;
    out += B64URL_ALPHABET[b0 >> 2];
    if (remaining === 1) {
      out += B64URL_ALPHABET[(b0 & 3) << 4];
      break;
    }
    const b1 = bytes[i + 1]!;
    out += B64URL_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    if (remaining === 2) {
      out += B64URL_ALPHABET[(b1 & 15) << 2];
      break;
    }
    const b2 = bytes[i + 2]!;
    out += B64URL_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)];
    out += B64URL_ALPHABET[b2 & 63];
  }
  return out;
}

export function fromBase64Url(text: string): Uint8Array {
  if (!B64URL_RE.test(text)) {
    throw new DropbeamError("CODE_INVALID", "code payload is not valid base64url");
  }
  const clean = text.replace(/=+$/, "");
  if (clean.length % 4 === 1) {
    throw new DropbeamError("CODE_INVALID", "code payload has an invalid base64url length");
  }
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let j = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64URL_ALPHABET.indexOf(clean[i]!);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

function nativeAvailable(): boolean {
  return (
    typeof globalThis.CompressionStream === "function" &&
    typeof globalThis.DecompressionStream === "function"
  );
}

export function defaultCompressionImpl(): CompressionImpl {
  return nativeAvailable() ? "native" : "fflate";
}

async function nativeTransform(
  bytes: Uint8Array,
  stream: {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<BufferSource>;
  },
): Promise<Uint8Array> {
  // Copy guarantees an ArrayBuffer-backed view for WritableStream<BufferSource>.
  const data = new Uint8Array(bytes);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const readTask = (async () => {
    const reader = stream.readable.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_INFLATED_BYTES) {
          throw new DropbeamError("CODE_INVALID", "inflated payload exceeds size limit");
        }
        chunks.push(value);
      }
    } catch (err) {
      await reader.cancel().catch(() => undefined);
      throw err;
    } finally {
      reader.releaseLock();
    }
  })();
  const writeTask = (async () => {
    const writer = stream.writable.getWriter();
    try {
      await writer.write(data);
      await writer.close();
    } finally {
      writer.releaseLock();
    }
  })();
  await Promise.all([readTask, writeTask]);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

export async function deflateRaw(
  bytes: Uint8Array,
  impl: CompressionImpl = defaultCompressionImpl(),
): Promise<Uint8Array> {
  if (impl === "native") {
    return nativeTransform(bytes, new CompressionStream("deflate-raw"));
  }
  return deflateSync(bytes, { level: 6 });
}

export async function inflateRaw(
  bytes: Uint8Array,
  impl: CompressionImpl = defaultCompressionImpl(),
): Promise<Uint8Array> {
  try {
    return await inflateRawImpl(bytes, impl);
  } catch (err) {
    // Native DecompressionStream rejects with runtime errors (e.g. Node's
    // Z_BUF_ERROR TypeError); every inflate failure is a malformed code.
    if (err instanceof DropbeamError) throw err;
    throw new DropbeamError("CODE_INVALID", "code payload is not valid deflate data");
  }
}

async function inflateRawImpl(bytes: Uint8Array, impl: CompressionImpl): Promise<Uint8Array> {
  if (impl === "native") {
    return nativeTransform(bytes, new DecompressionStream("deflate-raw"));
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflator = new Inflate();
  inflator.ondata = (chunk) => {
    total += chunk.length;
    if (total > MAX_INFLATED_BYTES) {
      // Throws out of push() to abort early; the post-check below also
      // covers runtimes that swallow callback errors.
      throw new DropbeamError("CODE_INVALID", "inflated payload exceeds size limit");
    }
    chunks.push(chunk);
  };
  try {
    inflator.push(bytes, true);
  } catch (err) {
    if (err instanceof DropbeamError) throw err;
    throw new DropbeamError("CODE_INVALID", "code payload is not valid deflate data");
  }
  if (total > MAX_INFLATED_BYTES) {
    throw new DropbeamError("CODE_INVALID", "inflated payload exceeds size limit");
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * Strip an incoming code: users paste QR text, chat-wrapped text, or the
 * blocks-of-5 display format (PRD 8.2.3), none of which may survive into the
 * payload. Then enforce length and the codec prefix.
 */
export function takePayload(code: string, prefix: string): Uint8Array {
  if (typeof code !== "string") {
    throw new DropbeamError("CODE_INVALID", "code must be text");
  }
  const text = code.replace(/\s+/g, "");
  if (text.length === 0 || text.length > MAX_CODE_LENGTH) {
    throw new DropbeamError("CODE_INVALID", "code has an invalid length");
  }
  if (!text.startsWith(prefix)) {
    throw new DropbeamError("CODE_INVALID", `code is missing the ${prefix} prefix`);
  }
  const payload = text.slice(prefix.length);
  if (payload.length === 0) {
    throw new DropbeamError("CODE_INVALID", "code payload is empty");
  }
  return fromBase64Url(payload);
}
