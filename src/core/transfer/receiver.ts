import { DropbeamError, toErrorCode, type ErrorCode } from "../errors";
import { MemorySink } from "../storage/memory-sink";
import { sanitizeFilename } from "../storage/filename";
import type { SaveResult, Sink, SinkMeta } from "../storage/sink";
import type { ChannelLike } from "./channel";
import { createHasher, type Hasher } from "./hash";
import type { FilePhase } from "./phase";
import {
  decodeControl,
  decodeDataFrame,
  encodeControl,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  type DataChunk,
  type OfferedFile,
  type PeerCaps,
} from "./protocol";

export type IncomingOffer = { id: string; files: OfferedFile[]; totalSize: number };
export type IncomingText = { id: string; body: string };

export type ReceiverEvents = {
  onHello?(hello: { name?: string; caps: PeerCaps }): void;
  /** FR-13: show the incoming prompt (unless auto-accept is on). */
  onOffer?(offer: IncomingOffer): void;
  onText?(text: IncomingText): void;
  onPhase?(fid: number, phase: FilePhase): void;
  onProgress?(fid: number, received: number, total: number): void;
  onSaved?(fid: number, result: SaveResult): void;
  onError?(fid: number | null, code: ErrorCode): void;
  /** PRD 12 PEER_LOST: no traffic for 15 s. */
  onPeerLost?(): void;
};

export type ReceiverOptions = {
  /** Sink factory; defaults to MemorySink (PRD 8.5 selection lives in core/storage). */
  createSink?: (meta: SinkMeta) => Sink | Promise<Sink>;
  /** FR-13: auto-accept incoming offers for this session. */
  autoAccept?: boolean;
  /** Start the ping/pong heartbeat (PRD 8.4). */
  heartbeat?: boolean;
  /** Heartbeat tuning (tests use short values; production uses PRD defaults). */
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
};

type RxState = {
  fid: number;
  meta: OfferedFile;
  sink: Sink;
  hasher: Hasher;
  expectedSeq: number;
  received: number;
  phase: FilePhase;
  chain: Promise<void>;
  canceled: boolean;
};

export class Receiver {
  private readonly active = new Map<number, RxState>();
  private offer: IncomingOffer | null = null;
  private autoAccept: boolean;
  private lastSeen = Date.now();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;

  constructor(
    private readonly channel: ChannelLike,
    private readonly events: ReceiverEvents = {},
    private readonly opts: ReceiverOptions = {},
  ) {
    this.autoAccept = opts.autoAccept ?? false;
    this.pingIntervalMs = opts.pingIntervalMs ?? PING_INTERVAL_MS;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? PONG_TIMEOUT_MS;
    this.channel.addEventListener("message", this.onMessage);
    if (opts.heartbeat !== false) {
      this.heartbeatTimer = setInterval(() => this.checkHeartbeat(), this.pingIntervalMs);
      this.channel.send(encodeControl({ k: "ping" }));
    }
  }

  setAutoAccept(value: boolean): void {
    this.autoAccept = value;
  }

  private checkHeartbeat(): void {
    if (this.disposed) return;
    if (Date.now() - this.lastSeen > this.pongTimeoutMs) {
      this.stopHeartbeat();
      this.events.onError?.(null, "PEER_LOST");
      this.events.onPeerLost?.();
      return;
    }
    this.channel.send(encodeControl({ k: "ping" }));
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private setPhase(fid: number, phase: FilePhase): void {
    const st = this.active.get(fid);
    if (st) st.phase = phase;
    this.events.onPhase?.(fid, phase);
  }

  private onMessage = (ev: MessageEvent): void => {
    if (this.disposed) return;
    if (typeof ev.data === "string") {
      const msg = decodeControl(ev.data);
      if (!msg) return;
      this.lastSeen = Date.now();
      this.dispatch(msg);
      return;
    }
    const frame = decodeDataFrame(ev.data);
    if (!frame) return;
    this.lastSeen = Date.now();
    this.onFrame(frame);
  };

  private dispatch(msg: ReturnType<typeof decodeControl>): void {
    if (!msg) return;
    switch (msg.k) {
      case "hello":
        this.events.onHello?.({ name: msg.name, caps: msg.caps });
        break;
      case "offer": {
        this.offer = { id: msg.id, files: msg.files, totalSize: msg.totalSize };
        if (this.autoAccept) void this.accept(msg.id);
        else this.events.onOffer?.(this.offer);
        break;
      }
      case "done":
        void this.verify(msg.fid, msg.sha256);
        break;
      case "cancel": {
        const st = this.active.get(msg.fid);
        if (st && !st.canceled) {
          st.canceled = true;
          void st.sink.abort();
          this.active.delete(msg.fid);
          st.hasher.dispose();
          this.events.onPhase?.(msg.fid, "CANCELED");
        }
        break;
      }
      case "text":
        this.events.onText?.({ id: msg.id, body: msg.body });
        break;
      case "ping":
        this.channel.send(encodeControl({ k: "pong" }));
        break;
      default:
        break; // accept/decline/ok/err are handled by Sender
    }
  }

  private onFrame(frame: DataChunk): void {
    const st = this.active.get(frame.fid);
    if (!st || st.canceled) return; // frame for a file we declined or canceled
    if (frame.seq !== st.expectedSeq) {
      void this.fail(st, "SEQ_GAP");
      return;
    }
    st.expectedSeq += 1;
    if (st.phase === "ACCEPTED") this.setPhase(st.fid, "TRANSFERRING");
    st.received += frame.payload.byteLength;
    st.hasher.update(frame.payload);
    st.chain = st.chain.then(() =>
      st.sink.write(frame.payload).catch((err: unknown) => {
        void this.fail(st, toErrorCode(err) === "INTERNAL" ? "SINK_UNAVAILABLE" : toErrorCode(err));
      }),
    );
    this.events.onProgress?.(st.fid, st.received, st.meta.size);
  }

  private async fail(st: RxState, code: ErrorCode): Promise<void> {
    if (st.canceled) return;
    st.canceled = true;
    this.active.delete(st.fid);
    try {
      await st.chain;
      await st.sink.abort();
    } catch {
      // abort is best-effort
    }
    st.hasher.dispose();
    this.channel.send(encodeControl({ k: "err", fid: st.fid, code }));
    this.events.onPhase?.(st.fid, "FAILED");
    this.events.onError?.(st.fid, code);
  }

  private async verify(fid: number, sha256: string): Promise<void> {
    const st = this.active.get(fid);
    if (!st || st.canceled) return;
    this.setPhase(fid, "VERIFYING");
    try {
      await st.chain;
      const hex = await st.hasher.digest();
      if (hex !== sha256) {
        await this.fail(st, "HASH_MISMATCH");
        return;
      }
      this.channel.send(encodeControl({ k: "ok", fid }));
      const result = await st.sink.close();
      this.active.delete(fid);
      st.hasher.dispose();
      this.events.onPhase?.(fid, "DONE");
      this.events.onSaved?.(fid, result);
    } catch (err) {
      await this.fail(st, toErrorCode(err));
    }
  }

  /** FR-13: accept an incoming offer (optionally a subset of files). */
  async accept(offerId: string, fids?: number[]): Promise<void> {
    const offer = this.offer;
    if (!offer || offer.id !== offerId) {
      throw new DropbeamError("CODE_INVALID", "no such offer");
    }
    const chosen = fids ?? offer.files.map((f) => f.fid);
    // Open every sink *before* telling the peer to start, so no frame arrives
    // for a fid that has no receiving state yet.
    const opened: number[] = [];
    for (const meta of offer.files) {
      if (!chosen.includes(meta.fid)) {
        this.events.onPhase?.(meta.fid, "DECLINED");
        continue;
      }
      try {
        await this.openState(meta);
        opened.push(meta.fid);
      } catch {
        // openState already reported the error for this fid
      }
    }
    this.offer = null;
    if (opened.length > 0) {
      this.channel.send(encodeControl({ k: "accept", id: offerId, fids: opened }));
    } else {
      this.channel.send(encodeControl({ k: "decline", id: offerId }));
    }
  }

  /** FR-13: decline an incoming offer. */
  decline(offerId: string): void {
    if (this.offer?.id !== offerId) return;
    const offered = this.offer.files.map((f) => f.fid);
    this.offer = null;
    this.channel.send(encodeControl({ k: "decline", id: offerId }));
    for (const fid of offered) this.events.onPhase?.(fid, "DECLINED");
  }

  private async openState(meta: OfferedFile): Promise<void> {
    const previous = this.active.get(meta.fid);
    if (previous) await this.fail(previous, "INTERNAL");

    const safeName = sanitizeFilename(meta.name);
    const sinkMeta: SinkMeta = { name: safeName, size: meta.size, type: meta.type };
    const sink = this.opts.createSink ? await this.opts.createSink(sinkMeta) : new MemorySink();
    try {
      await sink.open(sinkMeta);
    } catch (err) {
      const code = toErrorCode(err) === "INTERNAL" ? "SINK_UNAVAILABLE" : toErrorCode(err);
      this.channel.send(encodeControl({ k: "err", fid: meta.fid, code }));
      this.events.onPhase?.(meta.fid, "FAILED");
      this.events.onError?.(meta.fid, code);
      throw err instanceof DropbeamError ? err : new DropbeamError(code);
    }
    const hasher = await createHasher();
    this.active.set(meta.fid, {
      fid: meta.fid,
      meta: { ...meta, name: safeName },
      sink,
      hasher,
      expectedSeq: 0,
      received: 0,
      phase: "ACCEPTED",
      chain: Promise.resolve(),
      canceled: false,
    });
    this.events.onPhase?.(meta.fid, "ACCEPTED");
  }

  /** FR-16: cancel a file we are receiving. */
  cancel(fid: number): void {
    const st = this.active.get(fid);
    if (!st) return;
    this.channel.send(encodeControl({ k: "cancel", fid }));
    st.canceled = true;
    this.active.delete(fid);
    void st.sink.abort();
    st.hasher.dispose();
    this.events.onPhase?.(fid, "CANCELED");
  }

  /** FR-16: cancel every file we are receiving. */
  cancelAll(): void {
    for (const fid of [...this.active.keys()]) this.cancel(fid);
  }

  activeCount(): number {
    return this.active.size;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopHeartbeat();
    this.channel.removeEventListener("message", this.onMessage);
    for (const st of this.active.values()) {
      void st.sink.abort();
      st.hasher.dispose();
    }
    this.active.clear();
  }
}
