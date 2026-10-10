import { DropbeamError, type ErrorCode } from "../errors";
import { encodeDb1, HANDSHAKE_TTL_SECONDS, type Handshake } from "../handshake/codec-db1";
import { decodeHandshake } from "../handshake/decode";
import { defaultCompressionImpl, type CompressionImpl } from "../handshake/encoding";
import { buildPairLink, extractCode, type PairKind } from "../handshake/link";
import { ConnectionStateMachine, type MachineOptions, type Side } from "./state-machine";
import { deriveVerificationPhrase, type VerificationPhrase } from "./verify-phrase";
import type { ChannelLike } from "../transfer/channel";
import { PROTOCOL_VERSION } from "../transfer/protocol";

/**
 * Drives one side of a pairing session end to end (PRD 5.1, 7.1, 8.1):
 *
 *   host:  createOffer → show offer code → apply answer → CONNECTED
 *   guest: accept offer code → createAnswer → show answer code → CONNECTED
 *
 * The UI only renders what this exposes, and the connection state machine is
 * still the single source of truth for transitions. The WebRTC transport is
 * injected (`PeerTransport`) so the whole flow is testable without a browser.
 */

export type PeerTransport = {
  createOffer(): Promise<{ sdp: string; handshake: Handshake }>;
  createAnswer(remoteSdp: string): Promise<{ sdp: string; handshake: Handshake }>;
  applyAnswer(answerSdp: string): Promise<ChannelLike>;
  close(): void;
};

export type SessionSnapshot = {
  state: string;
  side: Side;
  /** Handshake code to show as QR / link / text, once gathering has finished. */
  code: string;
  /** Ready-to-share link; `#j=` for an offer, `#a=` for an answer. */
  link: string;
  /**
   * Unix seconds after which a peer rejects this code (FR-7 TTL, carried in
   * the handshake `ts`). The pairing screen counts it down so the expiry is
   * visible before the other device discovers it.
   */
  codeExpiresAt: number | null;
  /** Peer device label from the decoded code (FR-42), if any. */
  peerName: string;
  channel: ChannelLike | null;
  error: ErrorCode | null;
};

export type SessionControllerOptions = {
  side: Side;
  /** Base URL for pairing links. */
  baseUrl: string;
  transport: PeerTransport;
  deviceName?: string;
  /** Compression implementation override for tests. */
  impl?: CompressionImpl;
  machine?: MachineOptions;
  /**
   * Share an existing machine instead of creating one. The UI owns the machine
   * so it can render from it; injecting it keeps a single source of truth
   * instead of running two state machines that can disagree.
   */
  machineInstance?: ConnectionStateMachine;
  nowSeconds?: () => number;
};

function toCode(err: unknown, fallback: ErrorCode): ErrorCode {
  if (err instanceof DropbeamError) return err.code;
  return fallback;
}

export class SessionController {
  private readonly machine: ConnectionStateMachine;
  private code = "";
  private link = "";
  private codeExpiresAt: number | null = null;
  private peerName = "";
  private channel: ChannelLike | null = null;
  private error: ErrorCode | null = null;
  /** Our own DTLS fingerprint and the peer's, for the phrase (PRD 9.3). */
  private localFingerprint = "";
  private remoteFingerprint = "";

  constructor(private readonly opts: SessionControllerOptions) {
    this.machine =
      opts.machineInstance ??
      new ConnectionStateMachine({
        ...opts.machine,
        side: opts.side,
        onCleanup: () => {
          // PRD 7.1: cleanup closes the transport on failure/disconnect.
          if (this.opts.transport) this.opts.transport.close();
        },
      });
  }

  get state(): string {
    return this.machine.state;
  }

  get channelOrNull(): ChannelLike | null {
    return this.channel;
  }

  snapshot(): SessionSnapshot {
    return {
      state: this.machine.state,
      side: this.opts.side,
      code: this.code,
      link: this.link,
      codeExpiresAt: this.codeExpiresAt,
      peerName: this.peerName,
      channel: this.channel,
      error: this.error,
    };
  }

  subscribe(listener: (snap: SessionSnapshot) => void): () => void {
    return this.machine.subscribe(() => listener(this.snapshot()));
  }

  /**
   * Guest: enter SCANNING_OFFER and wait for the host's code. Split from
   * `joinWithCode` so the UI can show the camera screen first and the code
   * may arrive later (via scan, paste or a `#j=` link).
   */
  beginJoin(): SessionSnapshot {
    this.clear();
    this.machine.send("join");
    return this.snapshot();
  }

  /** Host: create the offer and produce the code the guest scans. */
  async startHosting(): Promise<SessionSnapshot> {
    this.clear();
    this.machine.send("start");
    try {
      this.machine.send("offer-created");
      const offer = await this.opts.transport.createOffer();
      this.localFingerprint = offer.handshake.f;
      this.machine.send("gather-complete");
      await this.publish(offer.handshake, "j");
      // The guest's reply moves the host into CONNECTING (PRD 7.1).
      this.machine.send("reply-applied");
      return this.snapshot();
    } catch (err) {
      return this.fail(toCode(err, "ICE_GATHER_TIMEOUT"));
    }
  }

  /** Guest: consume the host's offer code (or `#j=` link) and answer it. */
  async joinWithCode(raw: string): Promise<SessionSnapshot> {
    this.clear();
    // Already scanning, or a code pasted straight from the home screen.
    if (this.machine.state === "IDLE") this.machine.send("join");
    let decoded;
    try {
      const code = extractCode(raw);
      if (!code) throw new DropbeamError("CODE_INVALID", "offer is not a Dropbeam code");
      decoded = await decodeHandshake(code, {
        impl: this.opts.impl,
        nowSeconds: this.nowSeconds(),
      });
    } catch (err) {
      return this.fail(toCode(err, "CODE_INVALID"));
    }
    this.peerName = decoded.handshake?.n ?? "";
    this.remoteFingerprint = decoded.handshake?.f ?? "";
    try {
      this.machine.send("offer-received");
      this.machine.send("answer-created");
      const answer = await this.opts.transport.createAnswer(decoded.sdp);
      this.localFingerprint = answer.handshake.f;
      this.machine.send("gather-complete");
      await this.publish(answer.handshake, "a");
      // The answerer's channel arrives via the transport's own events.
      return this.snapshot();
    } catch (err) {
      return this.fail(toCode(err, "ICE_GATHER_TIMEOUT"));
    }
  }

  /** Host: apply the guest's answer code and wait for the channel to open. */
  async applyReplyCode(raw: string): Promise<SessionSnapshot> {
    let decoded;
    try {
      // The reply may arrive as a bare code or as a `#a=` link (FR-6).
      const code = extractCode(raw);
      if (!code) throw new DropbeamError("CODE_INVALID", "reply is not a Dropbeam code");
      decoded = await decodeHandshake(code, {
        impl: this.opts.impl,
        nowSeconds: this.nowSeconds(),
      });
    } catch (err) {
      return this.fail(toCode(err, "CODE_INVALID"));
    }
    try {
      const channel = await this.opts.transport.applyAnswer(decoded.sdp);
      this.channel = channel;
      this.peerName = decoded.handshake?.n || this.peerName;
      this.remoteFingerprint = decoded.handshake?.f || this.remoteFingerprint;
      // PRD 7.1: WAITING_FOR_REPLY ─reply applied─▶ CONNECTING ─▶ CONNECTED.
      this.machine.send("reply-applied");
      this.machine.send("connected");
      return this.snapshot();
    } catch (err) {
      return this.fail(toCode(err, "CONNECT_TIMEOUT"));
    }
  }

  /**
   * The transport reports the channel is open. A guest goes
   * SHOWING_ANSWER → CONNECTING → CONNECTED, a host is already in CONNECTING,
   * so both hops are driven until the machine settles (PRD 7.1).
   */
  markConnected(channel: ChannelLike): SessionSnapshot {
    this.channel = channel;
    this.machine.send("connected");
    if (this.machine.state === "CONNECTING") this.machine.send("connected");
    return this.snapshot();
  }

  /**
   * The man-in-the-middle check (PRD 9.3). Both sides hold one local and one
   * remote fingerprint and sort the pair before hashing, so an attacker who
   * substitutes a fingerprint cannot make the two devices agree. `null` until
   * both halves are known (the guest only learns the remote one once it has
   * decoded the offer).
   */
  async verificationPhrase(): Promise<VerificationPhrase | null> {
    if (!this.localFingerprint || !this.remoteFingerprint) return null;
    return deriveVerificationPhrase(this.localFingerprint, this.remoteFingerprint);
  }

  /** Protocol version this build speaks (PRD 8.4 `hello`). */
  get protocolVersion(): number {
    return PROTOCOL_VERSION;
  }

  reset(): void {
    this.clear();
    this.machine.reset();
  }

  dispose(): void {
    this.opts.transport.close();
    this.machine.dispose();
  }

  private nowSeconds(): number {
    return this.opts.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
  }

  private async publish(handshake: Handshake, kind: PairKind): Promise<void> {
    // Carry the peer label (FR-42) and the FR-7 expiry timestamp.
    const created = handshake.ts || this.nowSeconds();
    const enriched: Handshake = {
      ...handshake,
      n: this.opts.deviceName || undefined,
      ts: created,
    };
    this.code = await encodeDb1(enriched, {
      impl: this.opts.impl ?? (await defaultCompressionImpl()),
      nowSeconds: this.nowSeconds(),
    });
    this.codeExpiresAt = created + HANDSHAKE_TTL_SECONDS;
    this.link = buildPairLink(this.opts.baseUrl, kind, this.code);
  }

  private clear(): void {
    this.code = "";
    this.link = "";
    this.codeExpiresAt = null;
    this.channel = null;
    this.error = null;
    // Fingerprints belong to one attempt; never carry them across sessions.
    this.localFingerprint = "";
    this.remoteFingerprint = "";
  }

  private fail(code: ErrorCode): SessionSnapshot {
    this.error = code;
    this.machine.failWith(code);
    return this.snapshot();
  }
}
