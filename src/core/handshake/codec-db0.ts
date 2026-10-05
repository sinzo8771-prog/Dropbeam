import { DropbeamError } from "../errors";
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
 * DB0 — full-SDP fallback codec (PRD 8.2.1). Both codecs must decode on
 * receive; the sender picks DB1 by default and DB0 when compat mode is on or
 * a DB1 self-test failed.
 *
 * Pipeline: SDP string → deflate-raw → base64url → prefix "DB0.".
 */

export const DB0_PREFIX = "DB0.";
/** A data-channel-only SDP is a few KB; bound inflated size (PRD 9.4). */
export const MAX_SDP_LENGTH = 64 * 1024;

export type Db0Options = { impl?: CompressionImpl };

function invalid(message: string): DropbeamError {
  return new DropbeamError("CODE_INVALID", message);
}

function assertSdp(sdp: string): void {
  if (typeof sdp !== "string" || sdp.length === 0 || sdp.length > MAX_SDP_LENGTH) {
    throw invalid("SDP has an invalid length");
  }
  if (!sdp.startsWith("v=0")) throw invalid("SDP is missing its version line");
  if (!sdp.includes("m=application")) throw invalid("SDP has no data-channel media line");
}

export async function encodeDb0(sdp: string, opts?: Db0Options): Promise<string> {
  assertSdp(sdp);
  const deflated = await deflateRaw(utf8Encode(sdp), opts?.impl);
  return DB0_PREFIX + toBase64Url(deflated);
}

export async function decodeDb0(code: string, opts?: Db0Options): Promise<string> {
  const payload = takePayload(code, DB0_PREFIX);
  const sdp = utf8Decode(await inflateRaw(payload, opts?.impl));
  assertSdp(sdp);
  return sdp;
}
