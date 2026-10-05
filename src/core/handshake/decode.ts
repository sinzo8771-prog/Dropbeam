import { DropbeamError } from "../errors";
import { DB0_PREFIX, decodeDb0, type Db0Options } from "./codec-db0";
import { DB1_PREFIX, decodeDb1, type CodecOptions, type Handshake } from "./codec-db1";
import { buildSdp } from "./sdp-template";

/**
 * Decode any Dropbeam code on receive (PRD 8.2.1: both codecs must decode).
 * Dispatches on the `DB1.` / `DB0.` prefix and always returns an SDP ready
 * for `setRemoteDescription`, plus the parsed handshake for DB1 (used for the
 * expiry display and verification phrase).
 */

export type DecodedHandshake =
  | { codec: "DB1"; sdp: string; handshake: Handshake }
  | { codec: "DB0"; sdp: string; handshake: null };

export type DecodeOptions = CodecOptions & Db0Options;

export async function decodeHandshake(
  code: string,
  opts?: DecodeOptions,
): Promise<DecodedHandshake> {
  if (typeof code !== "string") {
    throw new DropbeamError("CODE_INVALID", "code must be text");
  }
  const head = code.replace(/\s+/g, "").slice(0, DB1_PREFIX.length);
  if (head === DB1_PREFIX) {
    const handshake = await decodeDb1(code, opts);
    return { codec: "DB1", sdp: buildSdp(handshake), handshake };
  }
  if (head === DB0_PREFIX) {
    const sdp = await decodeDb0(code, opts);
    return { codec: "DB0", sdp, handshake: null };
  }
  throw new DropbeamError("CODE_INVALID", "code has an unknown codec prefix");
}
