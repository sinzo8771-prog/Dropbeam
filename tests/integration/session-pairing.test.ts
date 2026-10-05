import { describe, expect, it, vi } from "vitest";
import {
  SessionController,
  type PeerTransport,
  type SessionControllerOptions,
} from "../../src/core/peer/session-controller";
import { buildSdp } from "../../src/core/handshake/sdp-template";
import type { Handshake } from "../../src/core/handshake/codec-db1";
import { toBase64Url } from "../../src/core/handshake/encoding";
import { MemoryChannel } from "../helpers/memory-channel";
import type { ChannelLike } from "../../src/core/transfer/channel";

/**
 * End-to-end pairing of two controllers using REAL handshake codes and the
 * real DB1 codec; only the WebRTC transport is faked, so every step that
 * could break in production — encode, decode, expiry, state transitions, the
 * `#j=`/`#a=` link route — is exercised (PRD 5.1, 13.3).
 */

const NOW = 1_760_000_000;
const BASE = "https://dropbeam.example";

function fingerprint(): string {
  return toBase64Url(new Uint8Array(32).fill(0xab));
}

function handshake(type: "o" | "a", name?: string, ts = NOW): Handshake {
  return {
    v: 1,
    t: type,
    ts,
    u: "Zx9+Qk",
    p: "p4ssw0rdBASE64abcDEF123",
    f: fingerprint(),
    s: type === "o" ? "actpass" : "active",
    c: ["1|2122260223|udp|192.168.1.7|54321|host"],
    m: { sp: 5000, mms: 1048576 },
    n: name,
  };
}

/** Records the SDP each side produced so the peer can be handed it back. */
function fakeTransport(_role: "host" | "guest", ts = NOW): PeerTransport & { closed: boolean } {
  return {
    closed: false,
    async createOffer() {
      return {
        sdp: buildSdp(handshake("o", undefined, ts)),
        handshake: handshake("o", undefined, ts),
      };
    },
    async createAnswer(remoteSdp: string) {
      // The transport must see a real, parseable offer (PRD FR-2).
      expect(remoteSdp).toContain("m=application");
      expect(remoteSdp.startsWith("v=0")).toBe(true);
      return {
        sdp: buildSdp(handshake("a", undefined, ts)),
        handshake: handshake("a", undefined, ts),
      };
    },
    async applyAnswer() {
      return new MemoryChannel({}) as unknown as ChannelLike;
    },
    close() {
      this.closed = true;
    },
  };
}

function makeController(role: "host" | "guest", opts: Partial<SessionControllerOptions> = {}) {
  const transport = fakeTransport(role);
  const controller = new SessionController({
    side: role,
    baseUrl: BASE,
    transport,
    nowSeconds: () => NOW,
    machine: { timeouts: { gathering: 60_000, connecting: 60_000, waitingForReply: 600_000 } },
    ...opts,
  });
  return { controller, transport };
}

/** A host that produced its offer at a given wall-clock second. */
async function hostOfferingAt(ts: number) {
  return new SessionController({
    side: "host",
    baseUrl: BASE,
    transport: fakeTransport("host", ts),
    nowSeconds: () => ts,
    machine: { timeouts: { gathering: 60_000, connecting: 60_000, waitingForReply: 600_000 } },
  }).startHosting();
}

describe("session pairing, host ↔ guest (PRD 5.1, 13.3)", () => {
  it("pairs two devices through the real code pipeline", async () => {
    const host = makeController("host", { deviceName: "Arya's laptop" });
    const guest = makeController("guest", { deviceName: "Phone" });

    // 1. Host shows an offer.
    const offerSnap = await host.controller.startHosting();
    expect(offerSnap.state).toBe("WAITING_FOR_REPLY");
    expect(offerSnap.code).toMatch(/^DB1\./);
    expect(offerSnap.link).toBe(`${BASE}/#j=${offerSnap.code}`);

    // 2. Guest scans that code and produces an answer.
    const answerSnap = await guest.controller.joinWithCode(offerSnap.code);
    expect(answerSnap.state).toBe("SHOWING_ANSWER");
    expect(answerSnap.code).toMatch(/^DB1\./);
    expect(answerSnap.link).toBe(`${BASE}/#a=${answerSnap.code}`);

    // 3. Host applies the answer and reaches CONNECTED with a live channel.
    const connected = await host.controller.applyReplyCode(answerSnap.code);
    expect(connected.state).toBe("CONNECTED");
    expect(connected.channel).not.toBeNull();
    expect(connected.error).toBeNull();

    // 4. Guest is told the channel opened.
    const guestConnected = guest.controller.markConnected(connected.channel!);
    expect(guestConnected.state).toBe("CONNECTED");
  });

  it("carries the device label across the handshake in both directions (FR-42)", async () => {
    const host = makeController("host", { deviceName: "Arya's laptop" });
    const guest = makeController("guest", { deviceName: "Phone" });
    const offer = await host.controller.startHosting();
    // The guest sees the host's label, and vice versa on the reply.
    const answer = await guest.controller.joinWithCode(offer.code);
    expect(answer.peerName).toBe("Arya's laptop");
    const connected = await host.controller.applyReplyCode(answer.code);
    expect(connected.peerName).toBe("Phone");
  });

  it("works when the reply arrives as a link, not a bare code (FR-6)", async () => {
    const host = makeController("host");
    const guest = makeController("guest");
    const offer = await host.controller.startHosting();
    const answer = await guest.controller.joinWithCode(offer.code);
    const connected = await host.controller.applyReplyCode(answer.link);
    expect(connected.state).toBe("CONNECTED");
  });

  it("reports CODE_INVALID for junk and never opens a transport", async () => {
    const guest = makeController("guest");
    const snap = await guest.controller.joinWithCode("not-a-code");
    expect(snap.state).toBe("FAILED");
    expect(snap.error).toBe("CODE_INVALID");
    expect(snap.channel).toBeNull();
  });

  it("reports CODE_EXPIRED for a stale offer (FR-7)", async () => {
    const guest = makeController("guest");
    // 15 minutes old: past the 10-minute TTL plus the 60s skew allowance.
    const stale = await hostOfferingAt(NOW - 15 * 60);
    expect(stale.code).toMatch(/^DB1\./);
    const snap = await guest.controller.joinWithCode(stale.code);
    expect(snap.error).toBe("CODE_EXPIRED");
  });

  it("keeps accepting a code right at the TTL + skew boundary", async () => {
    const guest = makeController("guest");
    // Exactly 10 min + 60 s skew is still valid (the codec allows `<= TTL+skew`).
    const edge = await hostOfferingAt(NOW - 660);
    const snap = await guest.controller.joinWithCode(edge.code);
    expect(snap.error).toBeNull();
    expect(snap.code).toMatch(/^DB1\./);
  });

  it("surfaces ICE_GATHER_TIMEOUT when the transport cannot gather", async () => {
    const transport = fakeTransport("host");
    vi.spyOn(transport, "createOffer").mockRejectedValue(new Error("no candidates"));
    const controller = new SessionController({
      side: "host",
      baseUrl: BASE,
      transport,
      nowSeconds: () => NOW,
    });
    const snap = await controller.startHosting();
    expect(snap.state).toBe("FAILED");
    expect(snap.error).toBe("ICE_GATHER_TIMEOUT");
    expect(snap.code).toBe("");
  });

  it("closes the transport on Try again (PRD 7.1 cleanup)", async () => {
    const { controller, transport } = makeController("host");
    await controller.startHosting();
    expect(transport.closed).toBe(false);
    controller.reset();
    expect(transport.closed).toBe(true);
    expect(controller.snapshot().state).toBe("IDLE");
    expect(controller.snapshot().code).toBe("");
  });

  it("notifies subscribers as the session progresses", async () => {
    const { controller } = makeController("host");
    const seen: string[] = [];
    controller.subscribe((snap) => seen.push(snap.state));
    await controller.startHosting();
    expect(seen).toContain("CREATING_OFFER");
    expect(seen).toContain("GATHERING");
    expect(seen).toContain("SHOWING_OFFER");
    expect(seen[seen.length - 1]).toBe("WAITING_FOR_REPLY");
  });
});
