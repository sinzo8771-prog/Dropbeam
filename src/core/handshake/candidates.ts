/**
 * ICE candidate handling for the handshake codecs (PRD 8.2.2).
 *
 * Compact wire format: `<foundation>|<prio>|<proto>|<addr>|<port>|<type>`.
 * Structural validation is strict (a malformed entry makes the whole code
 * invalid); policy filtering is lenient — TCP, relay, prflx and IPv6
 * link-local candidates are dropped, never fatal. At most MAX_CANDIDATES
 * survive, preserving SDP order (the per-candidate `priority` field is what
 * ICE uses to choose, not line order).
 */

export const MAX_CANDIDATES = 6;

export type ParsedCandidate = {
  foundation: string;
  component: number;
  proto: string;
  priority: number;
  address: string;
  port: number;
  type: string;
};

// SDP: a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ <cand-type> ...
const SDP_LINE_RE = /^a=candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ (\S+)/i;

const FOUNDATION_RE = /^[A-Za-z0-9/+.-]{1,32}$/;
const ADDRESS_RE = /^[A-Za-z0-9.:%_-]{1,253}$/;
const KEYWORD_RE = /^[a-z]+$/i;

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && max >= value;
}

/**
 * IPv6 link-local (fe80::/10) candidates are not usable across hosts and are
 * excluded by PRD 8.2.2. Addresses carrying a zone id are scope-limited too.
 */
export function isLinkLocalAddress(address: string): boolean {
  if (address.includes("%")) return true;
  if (!address.includes(":")) return false;
  const firstHextet = address.split(":")[0] ?? "";
  return /^fe[89ab]/i.test(firstHextet);
}

/** PRD 8.2.2: only UDP host + srflx candidates, never link-local. */
export function isUsableCandidate(c: ParsedCandidate): boolean {
  if (c.component !== 1) return false;
  if (c.proto.toLowerCase() !== "udp") return false;
  const type = c.type.toLowerCase();
  if (type !== "host" && type !== "srflx") return false;
  if (isLinkLocalAddress(c.address)) return false;
  return true;
}

export function selectCandidates(candidates: ParsedCandidate[]): ParsedCandidate[] {
  return candidates.filter(isUsableCandidate).slice(0, MAX_CANDIDATES);
}

/** Parse a compact candidate; returns null when structurally malformed. */
export function parseCompactCandidate(text: string): ParsedCandidate | null {
  if (typeof text !== "string") return null;
  const parts = text.split("|");
  if (parts.length !== 6) return null;
  const [foundation, priority, proto, address, port, type] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (!FOUNDATION_RE.test(foundation)) return null;
  if (!ADDRESS_RE.test(address)) return null;
  if (!KEYWORD_RE.test(proto) || !KEYWORD_RE.test(type)) return null;
  const prio = Number(priority);
  const portNum = Number(port);
  if (!/^\d{1,10}$/.test(priority) || !isIntInRange(prio, 0, 4294967295)) return null;
  if (!/^\d{1,5}$/.test(port) || !isIntInRange(portNum, 1, 65535)) return null;
  return {
    foundation,
    component: 1, // compact format carries no component; data channels use 1
    proto: proto.toLowerCase(),
    priority: prio,
    address,
    port: portNum,
    type: type.toLowerCase(),
  };
}

export function formatCompactCandidate(c: ParsedCandidate): string {
  return `${c.foundation}|${c.priority}|${c.proto}|${c.address}|${c.port}|${c.type}`;
}

/**
 * Parse an SDP `a=candidate:` line. Returns null when structurally malformed;
 * non-1 components parse fine and are dropped later by `selectCandidates`
 * (RTCP components cannot appear in a data-channel-only description).
 */
export function parseSdpCandidateLine(line: string): ParsedCandidate | null {
  const match = SDP_LINE_RE.exec(line);
  if (!match) return null;
  const [, foundation, component, proto, priority, address, port, type] = match;
  if (!FOUNDATION_RE.test(foundation!)) return null;
  if (!ADDRESS_RE.test(address!)) return null;
  if (!KEYWORD_RE.test(proto!) || !KEYWORD_RE.test(type!)) return null;
  const prio = Number(priority);
  const portNum = Number(port);
  const componentNum = Number(component);
  if (!isIntInRange(prio, 0, 4294967295)) return null;
  if (!isIntInRange(portNum, 1, 65535)) return null;
  if (!isIntInRange(componentNum, 1, 256)) return null;
  return {
    foundation,
    component: componentNum,
    proto: proto.toLowerCase(),
    priority: prio,
    address: address!,
    port: portNum,
    type: type.toLowerCase(),
  };
}
