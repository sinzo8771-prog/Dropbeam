import { DropbeamError } from "../errors";
import {
  formatCompactCandidate,
  parseCompactCandidate,
  parseSdpCandidateLine,
  selectCandidates,
  type ParsedCandidate,
} from "./candidates";
import { fromBase64Url, toBase64Url } from "./encoding";
import type { Handshake } from "./codec-db1";

/**
 * Fixed data-channel-only SDP template (PRD 8.2.1): BUNDLE group,
 * `m=application ... UDP/DTLS/SCTP webrtc-datachannel`, `a=mid:0`,
 * `a=sctp-port`, ice-ufrag/pwd, fingerprint, setup, candidates,
 * `a=end-of-candidates`.
 *
 * The reverse direction (`handshakeFromSdp`) is what the offerer uses to
 * build a code from its local description once ICE gathering completes.
 */

export const DEFAULT_SCTP_PORT = 5000;
export const DEFAULT_MAX_MESSAGE_SIZE = 64 * 1024;

function invalid(message: string): DropbeamError {
  return new DropbeamError("CODE_INVALID", message);
}

/** sha-256 fingerprint: colon-separated hex → base64url of the 32 bytes. */
function fingerprintToBase64Url(hex: string): string {
  const clean = hex.trim().replace(/:/g, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw invalid("DTLS fingerprint is not sha-256");
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return toBase64Url(bytes);
}

/** Inverse: base64url (43 chars) → `AB:CD:...` uppercase. */
function fingerprintToHexColon(b64: string): string {
  const bytes = fromBase64Url(b64);
  if (bytes.length !== 32) throw invalid("DTLS fingerprint is not sha-256");
  const parts: string[] = [];
  for (let i = 0; i < 32; i++) {
    parts.push(bytes[i]!.toString(16).padStart(2, "0").toUpperCase());
  }
  return parts.join(":");
}

/**
 * Rebuild a standards-valid SDP from a Handshake so it can be fed to
 * `setRemoteDescription` (PRD 8.2.1). The input must already be validated by
 * `validateHandshake` when it came from the wire.
 */
export function buildSdp(hs: Handshake): string {
  if (hs.v !== 1) throw invalid("unsupported handshake version");
  if (hs.c.length === 0) throw invalid("handshake has no candidates");

  const lines = [
    "v=0",
    `o=- ${hs.ts} 2 IN IP4 127.0.0.1`,
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    `a=ice-ufrag:${hs.u}`,
    `a=ice-pwd:${hs.p}`,
    `a=fingerprint:sha-256 ${fingerprintToHexColon(hs.f)}`,
    `a=setup:${hs.s}`,
    "a=mid:0",
    `a=sctp-port:${hs.m?.sp ?? DEFAULT_SCTP_PORT}`,
  ];
  if (hs.m) lines.push(`a=max-message-size:${hs.m.mms}`);

  for (const compact of hs.c) {
    const c = parseCompactCandidate(compact);
    if (!c) throw invalid("candidate entry is malformed");
    lines.push(
      `a=candidate:${c.foundation} ${c.component} ${c.proto} ${c.priority} ${c.address} ${c.port} typ ${c.type}`,
    );
  }
  lines.push("a=end-of-candidates");
  return lines.join("\r\n") + "\r\n";
}

/** Split an `a=name:value` line into its name and value. */
function attribute(line: string): { name: string; value: string } | null {
  if (!line.startsWith("a=")) return null;
  const body = line.slice(2);
  const colon = body.indexOf(":");
  if (colon <= 0) return null;
  return { name: body.slice(0, colon), value: body.slice(colon + 1) };
}

/**
 * Extract a Handshake from our own local SDP after ICE gathering completes
 * (PRD FR-2, non-trickle). Throws `CODE_INVALID` when the description is not
 * a usable data-channel-only offer/answer, or `ICE_GATHER_TIMEOUT` when no
 * candidates were gathered at all.
 */
export function handshakeFromSdp(
  sdp: string,
  type: "o" | "a",
  ts: number,
  deviceName?: string,
): Handshake {
  if (typeof sdp !== "string" || !sdp.startsWith("v=0")) {
    throw invalid("local SDP is malformed");
  }
  const lines = sdp.split(/\r?\n/);
  let ufrag: string | undefined;
  let pwd: string | undefined;
  let fingerprint: string | undefined;
  let setup: string | undefined;
  let sctpPort: number | undefined;
  let maxMessageSize: number | undefined;
  const candidates: ParsedCandidate[] = [];
  let sawMedia = false;

  for (const line of lines) {
    if (line.startsWith("m=")) {
      if (!line.startsWith("m=application ")) {
        throw invalid("local SDP has a non-data-channel media line");
      }
      sawMedia = true;
      continue;
    }
    if (line.startsWith("a=candidate:")) {
      const c = parseSdpCandidateLine(line);
      if (c) candidates.push(c);
      continue;
    }
    const attr = attribute(line);
    if (!attr) continue;
    switch (attr.name) {
      case "ice-ufrag":
        ufrag ??= attr.value;
        break;
      case "ice-pwd":
        pwd ??= attr.value;
        break;
      case "fingerprint": {
        const [alg, hex] = attr.value.split(/\s+/);
        if (alg?.toLowerCase() !== "sha-256" || !hex) {
          throw invalid("local SDP fingerprint is not sha-256");
        }
        fingerprint ??= hex;
        break;
      }
      case "setup":
        setup ??= attr.value;
        break;
      case "sctp-port":
        sctpPort ??= Number(attr.value);
        break;
      case "max-message-size":
        maxMessageSize ??= Number(attr.value);
        break;
      default:
        break;
    }
  }

  if (!sawMedia) throw invalid("local SDP has no media line");
  if (!ufrag || !pwd) throw invalid("local SDP is missing ICE credentials");
  if (!fingerprint) throw invalid("local SDP is missing a DTLS fingerprint");
  if (setup !== "actpass" && setup !== "active" && setup !== "passive") {
    throw invalid("local SDP is missing a DTLS setup role");
  }
  if (candidates.length === 0) {
    throw new DropbeamError("ICE_GATHER_TIMEOUT", "no ICE candidates were gathered");
  }

  const usable = selectCandidates(candidates);
  if (usable.length === 0) throw invalid("local SDP has no usable ICE candidates");

  const hs: Handshake = {
    v: 1,
    t: type,
    ts,
    u: ufrag,
    p: pwd,
    f: fingerprintToBase64Url(fingerprint),
    // Our answers are always active; offers must be actpass so the remote
    // side can pick its role (RFC 4145).
    s: type === "a" ? "active" : setup === "passive" ? "active" : setup,
    c: usable.map(formatCompactCandidate),
  };

  if (sctpPort !== undefined && Number.isInteger(sctpPort) && sctpPort > 0 && sctpPort <= 65535) {
    const mms =
      maxMessageSize !== undefined &&
      Number.isInteger(maxMessageSize) &&
      maxMessageSize >= 0 &&
      maxMessageSize <= 64 * 1024 * 1024
        ? maxMessageSize
        : DEFAULT_MAX_MESSAGE_SIZE;
    hs.m = { sp: sctpPort, mms };
  }
  if (deviceName) hs.n = deviceName;
  return hs;
}
