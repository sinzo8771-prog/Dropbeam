import { describe, expect, it } from "vitest";
import {
  DEFAULT_ICE_SETTINGS,
  DEFAULT_STUN_URL,
  buildRtcConfig,
  contactsThirdParty,
  stunUrl,
} from "../../src/core/peer/ice-config";

describe("ICE configuration (PRD 8.3)", () => {
  it("defaults to Local mode with no ICE servers at all", () => {
    // The privacy promise (PRD 5, 9): Local mode must contact nobody.
    expect(DEFAULT_ICE_SETTINGS.mode).toBe("local");
    expect(buildRtcConfig(DEFAULT_ICE_SETTINGS)).toEqual({ iceServers: [] });
    expect(buildRtcConfig()).toEqual({ iceServers: [] });
  });

  it("never contacts a third party in Local mode", () => {
    expect(contactsThirdParty(DEFAULT_ICE_SETTINGS)).toBe(false);
    expect(contactsThirdParty({ mode: "stun", stunUrl: DEFAULT_STUN_URL })).toBe(true);
  });

  it("adds exactly one STUN server when the user opts in", () => {
    const config = buildRtcConfig({ mode: "stun", stunUrl: DEFAULT_STUN_URL });
    expect(config.iceServers).toEqual([{ urls: "stun:stun.l.google.com:19302" }]);
  });

  it("trims a custom STUN url and rejects an empty one", () => {
    expect(stunUrl({ mode: "stun", stunUrl: "  stun:example.test:3478 " })).toBe(
      "stun:example.test:3478",
    );
    expect(() => stunUrl({ mode: "stun", stunUrl: "   " })).toThrow();
    expect(() => buildRtcConfig({ mode: "stun", stunUrl: "" })).toThrow();
  });
});
