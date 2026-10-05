import { describe, expect, it, vi } from "vitest";
import { PeerSession, isWebRtcSupported } from "../../src/core/peer/peer-session";

/**
 * A stub peer connection with just enough surface for PeerSession. Teardown is
 * the interesting part: `close()` raises the same events a dropped peer does,
 * so the session must not report peer loss for a close it initiated.
 */

/** Minimal but valid data-channel-only SDP; PeerSession parses it. */
const OFFER_SDP = [
  "v=0",
  "o=- 1 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=mid:0",
  "a=sctp-port:5000",
  "a=max-message-size:262144",
  "a=ice-ufrag:Zx9Qk",
  "a=ice-pwd:p4ssw0rdBASE64abcDEF123",
  `a=fingerprint:sha-256 ${Array.from(new Uint8Array(32).fill(0xab), (b) =>
    b.toString(16).padStart(2, "0").toUpperCase(),
  ).join(":")}`,
  "a=setup:actpass",
  "a=candidate:1 1 udp 2122260223 192.168.1.7 54321 typ host",
  "a=end-of-candidates",
].join("\r\n");

function stubPc(options: { openChannelOnOpen?: boolean } = {}) {
  const handlers = new Map<string, () => void>();
  const instances: FakePc[] = [];
  const channel = {
    binaryType: "",
    readyState: "connecting",
    handlers: new Map<string, () => void>(),
    addEventListener(type: string, fn: () => void) {
      this.handlers.set(type, fn);
    },
    close() {
      this.readyState = "closed";
      this.handlers.get("close")?.();
    },
    open() {
      this.readyState = "open";
      this.handlers.get("open")?.();
    },
  };
  class FakePc {
    connectionState: RTCPeerConnectionState = "new";
    iceGatheringState = "complete";
    localDescription: RTCSessionDescriptionInit | null = null;
    addEventListener(type: string, fn: () => void) {
      handlers.set(type, fn);
    }
    removeEventListener(type: string) {
      handlers.delete(type);
    }
    constructor() {
      instances.push(this);
    }
    async createOffer() {
      return { type: "offer", sdp: OFFER_SDP };
    }
    async setLocalDescription(d: RTCSessionDescriptionInit) {
      this.localDescription = { ...d, sdp: OFFER_SDP };
    }
    async setRemoteDescription() {
      if (options.openChannelOnOpen) setTimeout(() => channel.open(), 0);
    }
    createDataChannel() {
      return channel;
    }
    close() {
      this.connectionState = "closed";
      handlers.get("connectionstatechange")?.();
    }
  }
  return {
    pc: FakePc,
    channel,
    fireState(next: RTCPeerConnectionState) {
      const latest = instances[instances.length - 1];
      if (!latest) throw new Error("no peer connection was created");
      latest.connectionState = next;
      handlers.get("connectionstatechange")?.();
    },
  };
}

function sessionWith(stub: ReturnType<typeof stubPc>, onClosed = vi.fn()) {
  return {
    onClosed,
    session: new PeerSession(
      { onClosed },
      { peerConnectionFactory: () => new stub.pc() as unknown as RTCPeerConnection },
    ),
  };
}

describe("PeerSession teardown vs peer loss", () => {
  it("does not report peer loss when we close the connection ourselves", async () => {
    const stub = stubPc();
    const { session, onClosed } = sessionWith(stub);
    await session.createOffer();

    session.close();
    // A deliberate teardown raises `closed` on the peer connection and the
    // data channel; reporting PEER_LOST here would strand the UI on an error.
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("still reports peer loss when the connection actually fails", async () => {
    const stub = stubPc();
    const { session, onClosed } = sessionWith(stub);
    await session.createOffer();

    stub.fireState("failed");
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("does not reject a pending channel wait for a local close", async () => {
    const stub = stubPc({ openChannelOnOpen: true });
    const { session, onClosed } = sessionWith(stub);
    await session.createOffer();

    // Tear down before the channel ever opens.
    session.close();
    expect(onClosed).not.toHaveBeenCalled();
    // No unhandled rejection escapes from the abandoned promise.
    await Promise.resolve();
  });

  it("reports UNSUPPORTED when no RTCPeerConnection exists", () => {
    expect(typeof RTCPeerConnection).not.toBe("function");
    expect(isWebRtcSupported()).toBe(false);
  });
});
