/**
 * ICE configuration (PRD 8.3).
 *
 * Default "Local" mode uses `iceServers: []` — zero third-party contact, which
 * is what the privacy model promises. The optional "Across networks" mode adds
 * one public STUN server, which *does* disclose the device's public IP to that
 * third party, so it is strictly opt-in and never the default (FR-41).
 *
 * There is no TURN in v1: if both peers sit behind symmetric NAT the connection
 * simply fails and the UI explains why (PRD 8.3).
 */

export type IceMode = "local" | "stun";

export type IceSettings = {
  mode: IceMode;
  /** Configurable STUN constant; overridable so self-hosters can point at their own. */
  stunUrl: string;
};

/** PRD 8.3 default. Public IP is disclosed to this host when STUN mode is on. */
export const DEFAULT_STUN_URL = "stun:stun.l.google.com:19302";

export const DEFAULT_ICE_SETTINGS: IceSettings = {
  mode: "local",
  stunUrl: DEFAULT_STUN_URL,
};

export type RtcIceServer = { urls: string };

export function stunUrl(settings: IceSettings): string {
  const url = settings.stunUrl.trim();
  if (url.length === 0) {
    throw new Error("STUN mode requires a server URL");
  }
  return url;
}

/**
 * Build the `RTCConfiguration` for a mode. Local mode must stay exactly empty
 * so the browser only gathers host candidates (LAN/hotspot).
 */
export function buildRtcConfig(settings: IceSettings = DEFAULT_ICE_SETTINGS): {
  iceServers: RtcIceServer[];
} {
  if (settings.mode === "stun") {
    return { iceServers: [{ urls: stunUrl(settings) }] };
  }
  return { iceServers: [] };
}

/** True when this mode contacts a third party — the UI must disclose it. */
export function contactsThirdParty(settings: IceSettings): boolean {
  return settings.mode === "stun";
}
