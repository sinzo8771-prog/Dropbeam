import { describe, expect, it } from "vitest";
import { runSelfTest } from "../../src/core/peer/self-test";

/** Structural stand-ins: precise enough for this test, no `any`. */
type FakeChannel = {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send: (data: string) => void;
};
type Ev<E> = ((ev: E) => void) | null;

/**
 * A scripted `RTCPeerConnection` pair wired back to back, close
 * enough to the spec order for the self-test's choreography:
 * ICE candidates fire after setLocal, the answerer learns the data
 * channel at setRemote(offer), and the offerer's channel opens at
 * setRemote(answer). Channels echo like a loopback link.
 */
function fakePair(opts: { connect?: boolean } = {}): {
  create: () => RTCPeerConnection;
} {
  const connect = opts.connect ?? true;
  let chanA: FakeChannel | null = null;

  const makeChannel = (peer: "A" | "B"): FakeChannel => {
    const channel: FakeChannel = {
      onopen: null,
      onmessage: null,
      send(data: string) {
        const target = peer === "A" ? wire.toB : wire.toA;
        queueMicrotask(() => target?.onmessage?.({ data }));
      },
    };
    return channel;
  };

  const wire: { toA: FakeChannel | null; toB: FakeChannel | null } = { toA: null, toB: null };

  class FakePC {
    role: "A" | "B" = "A";
    localDescription: { type?: string } | null = null;
    remoteDescription: { type?: string } | null = null;
    connectionState = "new";
    onicecandidate: Ev<{
      candidate: { sdpMid: string; sdpMLineIndex: number; candidate: string };
    }> = null;
    ondatachannel: Ev<{ channel: FakeChannel }> = null;
    onconnectionstatechange: Ev<unknown> = null;

    async createOffer(): Promise<{ type: string; sdp: string }> {
      return { type: "offer", sdp: "v=0" };
    }
    async createAnswer(): Promise<{ type: string; sdp: string }> {
      return { type: "answer", sdp: "v=0" };
    }
    async setLocalDescription(desc: { type?: string }): Promise<void> {
      this.localDescription = desc;
      queueMicrotask(() =>
        this.onicecandidate?.({
          candidate: {
            sdpMid: "0",
            sdpMLineIndex: 0,
            candidate: "candidate:1 1 UDP 1 127.0.0.1 1 typ host",
          },
        }),
      );
    }
    async setRemoteDescription(desc: { type?: string }): Promise<void> {
      this.remoteDescription = desc;
      if (this.role === "B" && desc.type === "offer") {
        wire.toB = makeChannel("B");
        queueMicrotask(() => this.ondatachannel?.({ channel: wire.toB as FakeChannel }));
      }
      if (this.role === "A" && desc.type === "answer" && connect) {
        queueMicrotask(() => chanA?.onopen?.({}));
      }
    }
    async addIceCandidate(_candidate: unknown): Promise<void> {}
    createDataChannel(_label: string): FakeChannel {
      if (!chanA) {
        chanA = makeChannel("A");
        wire.toA = chanA;
      }
      return chanA;
    }
    close(): void {}
  }

  let created = 0;
  return {
    create: () => {
      const pc = new FakePC();
      pc.role = created++ === 0 ? "A" : "B";
      return pc as unknown as RTCPeerConnection;
    },
  };
}

describe("runSelfTest (FR-62)", () => {
  it("passes once the loopback round trip completes", async () => {
    const pair = fakePair();
    const result = await runSelfTest({ createPeerConnection: pair.create, timeoutMs: 1_000 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it("fails at the connecting stage when the handshake never opens", async () => {
    // Candidates and descriptions exchange; the channel never opens.
    const pair = fakePair({ connect: false });
    const result = await runSelfTest({ createPeerConnection: pair.create, timeoutMs: 20 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("connecting");
      expect(result.ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("fails at the gathering stage when even the offer never arrives", async () => {
    const stuck = {
      create: () =>
        ({
          createDataChannel: () => ({ onopen: null, onmessage: null, send: () => undefined }),
          createOffer: () => new Promise<never>(() => undefined),
          close: () => undefined,
        }) as unknown as RTCPeerConnection,
    };
    const result = await runSelfTest({ createPeerConnection: stuck.create, timeoutMs: 20 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("gathering");
  });

  it("reports unsupported when the browser has no RTCPeerConnection", async () => {
    // Node/jsdom test environments have none; no factory injected.
    const result = await runSelfTest({ timeoutMs: 20 });
    expect(result).toEqual({ ok: false, ms: 0, stage: "unsupported" });
  });

  it("reports unsupported when the constructor throws", async () => {
    const result = await runSelfTest({
      createPeerConnection: () => {
        throw new Error("blocked by policy");
      },
      timeoutMs: 20,
    });
    expect(result).toEqual({ ok: false, ms: 0, stage: "unsupported" });
  });
});
