import { DropbeamError } from "../errors";
import { buildSdp, handshakeFromSdp } from "../handshake/sdp-template";
import { type Handshake } from "../handshake/codec-db1";
import { type ChannelLike } from "../transfer/channel";
import { CHANNEL_LABEL, PROTOCOL_VERSION } from "../transfer/protocol";
import { buildRtcConfig, DEFAULT_ICE_SETTINGS, type IceSettings } from "./ice-config";

/**
 * Owns the `RTCPeerConnection` and the `dropbeam` data channel (PRD 8.1, FR-2).
 *
 * ICE is **non-trickle**: we wait for gathering to complete, then ship the
 * whole description inside the handshake code, because there is no signalling
 * server to trickle candidates over. Gathering has a hard cap so a stalled
 * network fails fast with a reason code instead of hanging the UI.
 */

export const GATHER_TIMEOUT_MS = 3_000;
/** PRD §12 CONNECT_TIMEOUT: no channel within 20 s. */
export const CONNECT_TIMEOUT_MS = 20_000;

export type PeerSessionOptions = {
  ice?: IceSettings;
  /** Hard cap on ICE gathering before we proceed with what we have. */
  gatherTimeoutMs?: number;
  /** FR-42: friendly device label shown to the peer. */
  deviceName?: string;
  /** Injection seam for tests and for feature detection of RTCPeerConnection. */
  peerConnectionFactory?: (config: RTCConfiguration) => RTCPeerConnection;
  /** Injected clock for the handshake timestamp (tests need determinism). */
  nowSeconds?: () => number;
};

export type PeerHandshakeResult = {
  /** Local handshake descriptor (DB1 payload source). */
  handshake: Handshake;
  /** Rebuilt full SDP for `setRemoteDescription`. */
  sdp: string;
};

export type PeerSessionEvents = {
  onStateChange?(state: RTCPeerConnectionState): void;
  onChannel?(channel: ChannelLike): void;
  onClosed?(): void;
};

export function isWebRtcSupported(): boolean {
  return typeof RTCPeerConnection === "function";
}

function defaultFactory(config: RTCConfiguration): RTCPeerConnection {
  if (!isWebRtcSupported()) {
    throw new DropbeamError("UNSUPPORTED", "this browser cannot do direct transfers");
  }
  return new RTCPeerConnection(config);
}

export class PeerSession {
  private pc: RTCPeerConnection | null = null;
  private channel: ChannelLike | null = null;
  private channelPromise: Promise<ChannelLike> | null = null;
  private resolveChannel: ((channel: ChannelLike) => void) | null = null;
  private rejectChannel: ((err: unknown) => void) | null = null;
  private readonly opts: PeerSessionOptions;
  private closed = false;

  constructor(
    private readonly events: PeerSessionEvents = {},
    opts: PeerSessionOptions = {},
  ) {
    this.opts = opts;
  }

  private createPeerConnection(): RTCPeerConnection {
    const config = buildRtcConfig(this.opts.ice ?? DEFAULT_ICE_SETTINGS);
    const factory = this.opts.peerConnectionFactory ?? defaultFactory;
    const pc = factory(config as RTCConfiguration);
    pc.addEventListener("connectionstatechange", () => {
      this.events.onStateChange?.(pc.connectionState);
      if (pc.connectionState === "closed" || pc.connectionState === "failed") {
        this.events.onClosed?.();
      }
    });
    this.pc = pc;
    return pc;
  }

  /**
   * Wait until ICE gathering completes, or until the cap elapses with at least
   * one candidate. PRD FR-2: no trickle, so this bounds pairing latency.
   */
  private waitForGathering(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    const cap = this.opts.gatherTimeoutMs ?? GATHER_TIMEOUT_MS;
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        pc.removeEventListener("icegatheringstatechange", onGatheringChange);
        clearTimeout(timer);
        resolve();
      };
      const onGatheringChange = (): void => {
        if (pc.iceGatheringState === "complete") done();
      };
      const timer = setTimeout(() => {
        // Proceed with whatever we have; a candidate-less network still fails
        // fast later with ICE_GATHER_TIMEOUT at the connection stage.
        done();
      }, cap);
      pc.addEventListener("icegatheringstatechange", onGatheringChange);
    });
  }

  /** Create the offer, gather, and return the handshake + rebuilt SDP. */
  async createOffer(): Promise<PeerHandshakeResult> {
    const pc = this.createPeerConnection();
    // The offerer owns the data channel; the answerer receives it via
    // `ondatachannel` (PRD 8.4 — a single ordered reliable channel).
    this.attachDataChannel(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.waitForGathering(pc);
    const local = pc.localDescription;
    if (!local) throw new DropbeamError("INTERNAL", "no local description after gathering");
    const handshake = handshakeFromSdp(local.sdp, "o", this.nowSeconds(), this.opts.deviceName);
    return { handshake, sdp: buildSdp(handshake) };
  }

  /** Create the answer for a remote offer and return it for display. */
  async createAnswer(remoteSdp: string): Promise<PeerHandshakeResult> {
    const pc = this.createPeerConnection();
    this.watchIncomingChannel(pc);
    await pc.setRemoteDescription({ type: "offer", sdp: remoteSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.waitForGathering(pc);
    const local = pc.localDescription;
    if (!local) throw new DropbeamError("INTERNAL", "no local description after gathering");
    const handshake = handshakeFromSdp(local.sdp, "a", this.nowSeconds(), this.opts.deviceName);
    return { handshake, sdp: buildSdp(handshake) };
  }

  private nowSeconds(): number {
    return this.opts.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
  }

  /** Host side: apply the guest's answer and wait for the channel to open. */
  async applyAnswer(answerSdp: string): Promise<ChannelLike> {
    const pc = this.pc;
    if (!pc) throw new DropbeamError("INTERNAL", "applyAnswer called before createOffer");
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    return this.waitForChannel();
  }

  private attachDataChannel(pc: RTCPeerConnection): void {
    const dc = pc.createDataChannel(CHANNEL_LABEL, { ordered: true });
    this.adoptChannel(dc);
  }

  /** Guest side: the channel arrives via `ondatachannel`. */
  private watchIncomingChannel(pc: RTCPeerConnection): void {
    pc.addEventListener("datachannel", (ev) => {
      this.adoptChannel((ev as RTCDataChannelEvent).channel);
    });
  }

  private adoptChannel(dc: RTCDataChannel): void {
    dc.binaryType = "arraybuffer";
    this.channel = dc as unknown as ChannelLike;
    dc.addEventListener("open", () => {
      if (!this.channel) return;
      this.events.onChannel?.(this.channel);
      if (this.channel.readyState === "open") this.resolveChannel?.(this.channel);
    });
    dc.addEventListener("close", () => {
      this.rejectChannel?.(new DropbeamError("PEER_LOST", "data channel closed"));
    });
  }

  /**
   * Resolve once the data channel is open. The channel may not exist yet at
   * call time (the answerer receives it via `ondatachannel`), so we wait on a
   * session-level promise that `adoptChannel` settles.
   */
  private waitForChannel(timeoutMs = CONNECT_TIMEOUT_MS): Promise<ChannelLike> {
    const existing = this.channel;
    if (existing && existing.readyState === "open") return Promise.resolve(existing);
    if (!this.channelPromise) {
      this.channelPromise = new Promise<ChannelLike>((resolve, reject) => {
        this.resolveChannel = resolve;
        this.rejectChannel = reject;
      });
    }
    const promise = this.channelPromise;
    return new Promise<ChannelLike>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new DropbeamError("CONNECT_TIMEOUT", "no data channel opened in time"));
      }, timeoutMs);
      promise.then(
        (channel) => {
          clearTimeout(timer);
          resolve(channel);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /** Protocol version this build speaks (PRD 8.4 `hello`). */
  get protocolVersion(): number {
    return PROTOCOL_VERSION;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel?.close();
    this.pc?.close();
    this.channel = null;
    this.pc = null;
  }
}
