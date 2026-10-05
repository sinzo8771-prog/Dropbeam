import { describe, expect, it } from "vitest";
import { SessionController, type PeerTransport } from "../../src/core/peer/session-controller";
import { ConnectionApproval } from "../../src/core/peer/approval";
import { phrasesMatch } from "../../src/core/peer/verify-phrase";
import { buildSdp } from "../../src/core/handshake/sdp-template";
import type { Handshake } from "../../src/core/handshake/codec-db1";
import { toBase64Url } from "../../src/core/handshake/encoding";
import { MemoryChannel } from "../helpers/memory-channel";
import type { ChannelLike } from "../../src/core/transfer/channel";

/**
 * PRD 9.3 + 9.5 end to end: the two devices must derive the *same* phrase from
 * the pair of DTLS fingerprints they exchanged, and an attacker who swaps one
 * fingerprint must make the phrases differ. The codec, SDP template and code
 * pipeline are real; only the transport is faked.
 */

const NOW = 1_760_000_000;
const BASE = "https://dropbeam.example";

/** Each side owns a distinct DTLS identity, as a real peer connection would. */
function fingerprintFor(fill: number): string {
  return toBase64Url(new Uint8Array(32).fill(fill));
}

function handshake(type: "o" | "a", fp: string, name?: string): Handshake {
  return {
    v: 1,
    t: type,
    ts: NOW,
    u: "Zx9+Qk",
    p: "p4ssw0rdBASE64abcDEF123",
    f: fp,
    s: type === "o" ? "actpass" : "active",
    c: ["1|2122260223|udp|192.168.1.7|54321|host"],
    m: { sp: 5000, mms: 1048576 },
    n: name,
  };
}

/** One side's transport; `fp` is the fingerprint it claims as its own. */
function transportFor(fp: string): PeerTransport {
  return {
    async createOffer() {
      const hs = handshake("o", fp);
      return { sdp: buildSdp(hs), handshake: hs };
    },
    async createAnswer(remoteSdp: string) {
      // The transport must see a real, parseable offer.
      expect(remoteSdp).toContain("m=application");
      const hs = handshake("a", fp);
      return { sdp: buildSdp(hs), handshake: hs };
    },
    async applyAnswer() {
      return new MemoryChannel({}) as unknown as ChannelLike;
    },
    close() {
      /* nothing to release */
    },
  };
}

function controller(side: "host" | "guest", fp: string, deviceName?: string): SessionController {
  return new SessionController({
    side,
    baseUrl: BASE,
    transport: transportFor(fp),
    deviceName,
    nowSeconds: () => NOW,
    machine: { timeouts: { gathering: 60_000, connecting: 60_000, waitingForReply: 600_000 } },
  });
}

const HOST_FP = fingerprintFor(0xab);
const GUEST_FP = fingerprintFor(0x3c);

/** Pair two devices and return both controllers once the channel is open. */
async function paired(hostFp = HOST_FP, guestFp = GUEST_FP) {
  const host = controller("host", hostFp, "Arya's laptop");
  const guest = controller("guest", guestFp, "Phone");
  const offer = await host.startHosting();
  const answer = await guest.joinWithCode(offer.code);
  const connected = await host.applyReplyCode(answer.code);
  expect(connected.state).toBe("CONNECTED");
  guest.markConnected(connected.channel!);
  return { host, guest };
}

describe("verification phrase across two devices (PRD 9.3)", () => {
  it("gives both devices the same phrase from the same fingerprint pair", async () => {
    const { host, guest } = await paired();
    const fromHost = await host.verificationPhrase();
    const fromGuest = await guest.verificationPhrase();
    expect(fromHost).not.toBeNull();
    expect(fromGuest).not.toBeNull();
    // Same three words on both screens, which is what the user compares.
    expect(fromHost!.words).toHaveLength(3);
    expect(fromHost!.words).toEqual(fromGuest!.words);
    expect(fromHost!.digits).toBe(fromGuest!.digits);
    expect(fromHost!.digits).toMatch(/^\d{6}$/);
  });

  it("has no phrase until both halves of the handshake are known", async () => {
    const host = controller("host", HOST_FP);
    await host.startHosting();
    // The host knows only its own fingerprint until the reply arrives.
    expect(await host.verificationPhrase()).toBeNull();

    const guest = controller("guest", GUEST_FP);
    const answer = await guest.joinWithCode(
      (await controller("host", HOST_FP).startHosting()).code,
    );
    // The guest knows both immediately: it decoded the offer and built an answer.
    expect(await guest.verificationPhrase()).not.toBeNull();
    expect(
      await host.applyReplyCode(answer.code).then(() => host.verificationPhrase()),
    ).not.toBeNull();
  });

  it("changes the phrase when one fingerprint is substituted (the MITM case)", async () => {
    const honest = await paired();
    // An attacker swaps in their own fingerprint on one side only.
    const tampered = await paired(HOST_FP, fingerprintFor(0x77));

    const honestPhrase = (await honest.host.verificationPhrase())!;
    const tamperedPhrase = (await tampered.host.verificationPhrase())!;
    expect(phrasesMatch(honestPhrase, tamperedPhrase)).toBe(false);
    // Words or digits must differ, so the check cannot pass by coincidence of
    // the words alone while the digits still match.
    expect(
      honestPhrase.digits === tamperedPhrase.digits &&
        honestPhrase.words.join(" ") === tamperedPhrase.words.join(" "),
    ).toBe(false);
  });

  it("does not carry a phrase across attempts", async () => {
    const { host } = await paired();
    expect(await host.verificationPhrase()).not.toBeNull();
    // A new attempt must start clean, or a stale phrase would vouch for a
    // session it was never derived from.
    host.reset();
    expect(await host.verificationPhrase()).toBeNull();
  });
});

describe("connection approval over a real session (PRD 9.5)", () => {
  it("blocks a real paired channel until the host allows it", async () => {
    const { host, guest } = await paired();
    // The host is the approver, so the peer it names is the guest's label.
    const gate = new ConnectionApproval(host.snapshot().peerName);
    expect(gate.peer).toBe("Phone");
    expect(() => gate.requireAllowed()).toThrow();

    gate.request();
    gate.approve();
    expect(() => gate.requireAllowed()).not.toThrow();
    expect(host.snapshot().state).toBe("CONNECTED");
    // Both sides see the same state; the guest never sees an approval prompt.
    expect(guest.snapshot().state).toBe("CONNECTED");
  });
});
