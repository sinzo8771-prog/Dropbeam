import { DropbeamError, toErrorCode, type ErrorCode } from "../errors";
import { MemorySink } from "../storage/memory-sink";
import { sanitizeFilename } from "../storage/filename";
import type { SaveResult, Sink, SinkMeta } from "../storage/sink";
import type { ChannelLike } from "./channel";
import { createHasher, type Hasher } from "./hash";
import type { FilePhase } from "./phase";
import {
  CHUNK_SIZE,
  chunkOffset,
  decodeControl,
  decodeDataFrame,
  encodeControl,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  type DataChunk,
  type OfferedFile,
  type PeerCaps,
  type ResumedFile,
} from "./protocol";
import { resumeStore, type ParkedInbound, type ResumeStore } from "./resume-store";

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
  /**
   * Sink factory for a file an interrupted transfer left behind. Resuming
   * keeps the staged bytes and writes at the parked offset; implementations
   * that cannot (memory) simply do not resume.
   */
  resumeSink?: (meta: SinkMeta, resumeFromBytes: number) => Sink | Promise<Sink>;
  /** FR-13: auto-accept incoming offers for this session. */
  autoAccept?: boolean;
  /** Start the ping/pong heartbeat (PRD 8.4). */
  heartbeat?: boolean;
  /** Heartbeat tuning (tests use short values; production uses PRD defaults). */
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  /**
   * Live `RTCPeerConnection.connectionState` for this session (PRD: a dropped
   * connection ends the session). While it reads `disconnected` the browser is
   * still re-establishing ICE, so heartbeat silence is expected mid-recovery
   * and we hold off on PEER_LOST for a bounded grace window instead of
   * forcing a re-pair the link was about to undo on its own.
   */
  pcState?: () => RTCPeerConnectionState | undefined;
  /** Where parked partials live across a dropped channel (injectable for tests). */
  store?: ResumeStore;
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
  /** True when this state continues a parked partial (never prompt for it). */
  resumed: boolean;
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
  private readonly store: ResumeStore;
  /** Fids waiting on the sender's per-chunk digest plan (per-chunk repair). */
  private readonly planWaiters = new Map<number, (hashes: string[] | null) => void>();
  /** Fids whose re-sent chunks are written in place instead of appended. */
  private readonly repairing = new Set<number>();
  /** Per-fid per-chunk-index "landed" resolvers, registered before we ask. */
  private readonly repairWaits = new Map<number, Map<number, () => void>>();

  constructor(
    private readonly channel: ChannelLike,
    private readonly events: ReceiverEvents = {},
    private readonly opts: ReceiverOptions = {},
  ) {
    this.autoAccept = opts.autoAccept ?? false;
    this.pingIntervalMs = opts.pingIntervalMs ?? PING_INTERVAL_MS;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? PONG_TIMEOUT_MS;
    this.store = opts.store ?? resumeStore;
    this.channel.addEventListener("message", this.onMessage);
    if (opts.heartbeat !== false) {
      this.heartbeatTimer = setInterval(() => this.checkHeartbeat(), this.pingIntervalMs);
      this.channel.send(encodeControl({ k: "ping" }));
    }
  }

  /**
   * Announce the partials this side still holds (roadmap: resumable
   * transfers). Called once the channel is usable, right after `hello`, so
   * the peer can re-offer those files instead of starting over.
   */
  announceResumable(): void {
    const files: ResumedFile[] = this.store
      .inboundList()
      .map((p) => ({ fid: p.fid, name: p.name, size: p.size, chunks: p.chunks }));
    if (files.length === 0) return;
    this.channel.send(encodeControl({ k: "resume", files }));
  }

  setAutoAccept(value: boolean): void {
    this.autoAccept = value;
  }

  private checkHeartbeat(): void {
    if (this.disposed) return;
    const silent = Date.now() - this.lastSeen;
    // A `disconnected` connection is still re-establishing ICE on its own, so
    // heartbeat silence is expected mid-recovery: double the deadline instead
    // of forcing a re-pair the link was about to undo. Anything else
    // (`connected` but silent, `failed`, `closed`, or no state wired) is a
    // real loss at the plain pong timeout.
    const recovering = this.opts.pcState?.() === "disconnected";
    if (silent <= this.pongTimeoutMs * (recovering ? 2 : 1)) {
      this.channel.send(encodeControl({ k: "ping" }));
      return;
    }
    this.stopHeartbeat();
    this.events.onError?.(null, "PEER_LOST");
    this.events.onPeerLost?.();
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
        // Files the peer re-offers from a resume point continue a parked
        // partial: the user already approved them once, so they never
        // prompt again (FR-13 applies to new files).
        const fresh = msg.files.filter((f) => !this.parkedFor(f));
        if (this.autoAccept || fresh.length === 0) void this.accept(msg.id);
        else this.events.onOffer?.({ id: msg.id, files: fresh, totalSize: msg.totalSize });
        break;
      }
      case "done":
        void this.verify(msg.fid, msg.sha256);
        break;
      case "plan":
        this.onPlan(msg.fid, msg.hashes);
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

  /**
   * Whole-file hash mismatch (roadmap: per-chunk repair). If the sink can
   * read its staged bytes back, load the repair path (lazy — it is dead code
   * until a transfer actually corrupts) and drive a single-pass handshake: ask
   * for the sender's per-chunk digests, name the bad indices once, rewrite
   * them in place, then re-verify the whole file one final time. A sink that
   * cannot read back has nothing to diff against, so the mismatch stays
   * terminal. Any failure in this path is terminal too — never retried.
   */
  private async repairOrFail(st: RxState, sha256: string): Promise<void> {
    if (typeof st.sink.readRange !== "function" || typeof st.sink.writeAt !== "function") {
      await this.fail(st, "HASH_MISMATCH");
      return;
    }
    try {
      const mod = await import("./repair");
      const file = { sink: st.sink, size: st.meta.size };
      this.channel.send(encodeControl({ k: "mismatch", fid: st.fid }));
      const plan = await this.awaitPlan(st.fid);
      if (!plan) {
        await this.fail(st, "HASH_MISMATCH");
        return;
      }
      const staged = await mod.hashStagedChunks(file);
      if (!staged) {
        await this.fail(st, "HASH_MISMATCH");
        return;
      }
      const bad = mod.diffChunks(staged, plan);
      if (bad.length === 0) {
        await this.fail(st, "HASH_MISMATCH");
        return;
      }
      // Single pass: name every bad index once. Waiters are registered
      // *before* the request goes out so a fast reply cannot land before we
      // are listening; onFrame resolves each as its rewrite lands.
      const landed = new Map<number, () => void>();
      const waits = bad.map((idx) => new Promise<void>((resolve) => landed.set(idx, resolve)));
      this.repairWaits.set(st.fid, landed);
      this.repairing.add(st.fid);
      this.channel.send(encodeControl({ k: "repair", fid: st.fid, indices: bad }));
      // Bound the wait so a silent sender cannot hang the transfer; a partial
      // or missing rewrite is caught by the final re-verify below.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.pongTimeoutMs * 4);
        void Promise.all(waits).then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.repairing.delete(st.fid);
      this.repairWaits.delete(st.fid);
      const good = await mod.reverifyWholeFile(file, sha256);
      if (!good) {
        await this.fail(st, "HASH_MISMATCH");
        return;
      }
      this.channel.send(encodeControl({ k: "ok", fid: st.fid }));
      const result = await st.sink.close();
      this.active.delete(st.fid);
      st.hasher.dispose();
      this.events.onPhase?.(st.fid, "DONE");
      this.events.onSaved?.(st.fid, result);
    } catch {
      await this.fail(st, "HASH_MISMATCH");
    }
  }

  /**
   * Resolves with the sender's `plan` digests, or null if it never answers in
   * time. A dead or silent sender must not hang the transfer: after the grace
   * window the waiter is dropped and the caller treats it as a terminal
   * mismatch rather than waiting forever.
   */
  private awaitPlan(fid: number): Promise<string[] | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.planWaiters.delete(fid);
        resolve(null);
      }, this.pongTimeoutMs * 4);
      const done = (hashes: string[] | null): void => {
        clearTimeout(timer);
        this.planWaiters.delete(fid);
        resolve(hashes);
      };
      this.planWaiters.set(fid, done);
    });
  }

  /** Route an incoming `plan` to the transfer waiting on it, if any. */
  private onPlan(fid: number, hashes: string[]): void {
    const resolve = this.planWaiters.get(fid);
    if (resolve) {
      this.planWaiters.delete(fid);
      resolve(hashes.length > 0 ? hashes : null);
    }
  }

  private parkedFor(file: OfferedFile): ParkedInbound | undefined {
    return file.chunks !== undefined ? this.store.inboundFor(file.name, file.size) : undefined;
  }

  private onFrame(frame: DataChunk): void {
    const st = this.active.get(frame.fid);
    if (!st || st.canceled) return; // frame for a file we declined or canceled
    // Re-sent repair chunks land at their original offset, not the append
    // cursor, and never advance the sequence or the incremental hasher (the
    // whole file is re-hashed from staged bytes after the rewrite).
    if (this.repairing.has(st.fid)) {
      // `repairing` is only set after repairOrFail confirmed writeAt exists.
      // Resolve this index's waiter only after the rewrite has landed, so the
      // final re-verify never races an in-flight write.
      void st.sink.writeAt!(frame.seq * CHUNK_SIZE, frame.payload)
        .catch(() => {
          void this.fail(st, "SINK_UNAVAILABLE");
        })
        .then(() => this.repairWaits.get(st.fid)?.get(frame.seq)?.());
      return;
    }
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
        await this.repairOrFail(st, sha256);
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

    // Resume: the peer re-offered a file we already hold a prefix of. The
    // staged bytes stay on disk and only the missing chunks are written, so
    // the parked partial's chunk count is where the stream continues.
    const parked = this.parkedFor(meta);
    const chunks = parked?.chunks ?? meta.chunks ?? 0;
    const resuming = chunks > 0;
    if (resuming && !this.opts.resumeSink) {
      // No resume path for this receiver (memory sink, or a test double):
      // start the file over rather than corrupting the partial.
      this.store.takeInbound(meta.name, meta.size);
      this.events.onError?.(meta.fid, "SINK_UNAVAILABLE");
      throw new DropbeamError("SINK_UNAVAILABLE", "cannot resume this file");
    }
    // Building the sink and opening it are one guarded step: a sink that
    // cannot be built and one that cannot be opened are the same outcome for
    // the user, and what decides the recovery is whether a byte has landed
    // yet — which, this early, it never has.
    let sink: Sink | null = null;
    try {
      sink = resuming
        ? await this.opts.resumeSink!(sinkMeta, chunkOffset(chunks))
        : this.opts.createSink
          ? await this.opts.createSink(sinkMeta)
          : new MemorySink();
      await sink.open(sinkMeta);
    } catch (err) {
      // Kept before the fallback overwrites `sink`: a refused sink may have
      // created a staging file (an empty `.part` in OPFS) that has to go.
      const refused = sink;
      const code = toErrorCode(err) === "INTERNAL" ? "SINK_UNAVAILABLE" : toErrorCode(err);
      sink = null;
      // One last resort for a file with nothing staged yet: the sink refused
      // before a single byte landed, so memory can still take it whole (PRD
      // 8.5's fallback order ends there anyway). A resumed transfer is
      // excluded — its prefix lives in the sink that just refused, and
      // continuing the tail into RAM would produce a file with a hole in it —
      // and so is a cancellation, which is the user's decision rather than the
      // storage layer failing.
      //
      // This is the measured WebKit shape (docs/INTEROP.md): the OPFS
      // namespace exists, so the sink is selected, and every `createWritable`
      // throws. Without this the file fails for a capability the browser
      // advertised, and nothing was wrong with the transfer.
      if (!resuming && code !== "CANCELED") {
        const memory = new MemorySink();
        try {
          await memory.open(sinkMeta);
          sink = memory;
        } catch {
          // Too large for the memory cap: report the sink's own reason, which
          // is the informative one (a full disk, not a full RAM budget).
        }
      }
      if (sink === null) {
        this.channel.send(encodeControl({ k: "err", fid: meta.fid, code }));
        this.events.onPhase?.(meta.fid, "FAILED");
        this.events.onError?.(meta.fid, code);
        throw err instanceof DropbeamError ? err : new DropbeamError(code);
      }
      if (refused) await refused.abort().catch(() => undefined);
    }
    const hasher = await createHasher();
    if (resuming) {
      // The hasher state died with the previous session, so re-hash the
      // parked prefix from the staged bytes before appending.
      const prefix = await (sink as Sink).readPrefix?.(chunkOffset(chunks));
      if (prefix && prefix.byteLength > 0) hasher.update(prefix);
    }
    this.store.takeInbound(meta.name, meta.size);
    this.active.set(meta.fid, {
      fid: meta.fid,
      meta: { ...meta, name: safeName },
      sink,
      hasher,
      expectedSeq: chunks,
      received: chunkOffset(chunks),
      phase: "ACCEPTED",
      chain: Promise.resolve(),
      canceled: false,
      resumed: resuming,
    });
    // The row starts at the resumed offset, not from zero, so the user sees
    // the transfer continuing rather than restarting.
    this.events.onProgress?.(meta.fid, chunkOffset(chunks), meta.size);
    this.events.onPhase?.(meta.fid, "ACCEPTED");
  }

  /**
   * Park what was in flight so a re-paired session can resume it (roadmap:
   * resumable transfers). Called when the channel goes away: the staged
   * bytes stay where the sink put them, and only disk-backed sinks are
   * worth announcing — a memory sink's bytes are already gone.
   */
  private parkActive(): void {
    for (const st of this.active.values()) {
      if (st.canceled) continue;
      const chunks = Math.floor(st.received / CHUNK_SIZE);
      if (chunks <= 0) continue;
      this.store.parkInbound({
        fid: st.fid,
        name: st.meta.name,
        size: st.meta.size,
        chunks,
        sink: st.sink.kind,
      });
    }
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
    // The channel is gone: park what was in flight (the sink keeps its
    // staged bytes on disk) instead of aborting, so a re-paired session can
    // resume exactly where it stopped.
    this.parkActive();
    for (const st of this.active.values()) {
      st.hasher.dispose();
    }
    this.active.clear();
  }
}
