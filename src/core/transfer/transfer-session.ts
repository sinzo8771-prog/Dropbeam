import { DropbeamError, type ErrorCode } from "../errors";
import type { ChannelLike } from "./channel";
import { PROTOCOL_VERSION, type ResumedFile } from "./protocol";
import { Receiver, type IncomingOffer, type IncomingText } from "./receiver";
import { Sender } from "./sender";
import type { FilePhase } from "./phase";
import { createSinkFor } from "../storage/select-sink";
import { sanitizeFilename } from "../storage/filename";
import { resumeStore, type ResumeStore } from "./resume-store";
import type { SaveResult, Sink, SinkMeta } from "../storage/sink";
import { OpfsSink } from "../storage/opfs-sink";

/**
 * Binds an open data channel to both halves of the transfer engine (PRD 8.4,
 * 8.5). Once two devices are paired this is the only object the UI talks to:
 * it owns Sender + Receiver, negotiates `hello`, and picks a storage sink per
 * incoming file by feature detection.
 *
 * `fidParity` separates directions so `{fid}` control messages can never be
 * ambiguous: the host (parity 1) allocates even fids, the guest (parity 0)
 * odd.
 */

export type FileProgress = {
  fid: number;
  name: string;
  size: number;
  /** The file's media type, so the row can pick an icon for it (PRD 10.1 #6). */
  type: string;
  phase: FilePhase;
  done: number;
};

export type TransferSessionEvents = {
  onPhase?(file: FileProgress): void;
  onProgress?(file: FileProgress): void;
  onSaved?(result: SaveResult): void;
  /** Incoming offer awaiting the user's decision (FR-13). */
  onOffer?(offer: IncomingOffer): void;
  onText?(text: IncomingText): void;
  onHello?(name: string): void;
  onError?(code: ErrorCode, fid: number | null): void;
  onPeerLost?(): void;
};

export type TransferSessionOptions = {
  channel: ChannelLike;
  events?: TransferSessionEvents;
  fidParity?: 0 | 1;
  deviceName?: string;
  autoAccept?: boolean;
  /** Destination picker for File System Access; must run in a user gesture. */
  pickDestination?: (name: string) => Promise<Sink>;
  /** Sink factory override (tests inject an in-memory staging disk). */
  createSink?: (meta: SinkMeta) => Sink | Promise<Sink>;
  /** Resume-sink factory override (same seam, for the parked-offset path). */
  resumeSink?: (meta: SinkMeta, resumeFromBytes: number) => Sink | Promise<Sink>;
  /** Parked-transfer state (injectable for tests). */
  store?: ResumeStore;
  /**
   * Live `RTCPeerConnection.connectionState` for this session. While it reads
   * `disconnected` the browser is still re-establishing ICE, so the receiver's
   * heartbeat grants a bounded recovery grace instead of declaring PEER_LOST.
   */
  pcState?: () => RTCPeerConnectionState | undefined;
};

export class TransferSession {
  private readonly sender: Sender;
  private readonly receiver: Receiver;
  private readonly files = new Map<number, FileProgress>();
  private readonly store: ResumeStore;

  constructor(private readonly opts: TransferSessionOptions) {
    const events = opts.events ?? {};
    this.store = opts.store ?? resumeStore;

    this.sender = new Sender(
      opts.channel,
      {
        // The sender owns the fids and announces them as it allocates them,
        // so a row is created with the file's real name and size rather than
        // a placeholder. Deriving the ids here instead would be a second
        // allocator that drifts from the first one after the second batch.
        onAllocated: (files) => {
          for (const f of files) this.track(f.fid, f.name, f.size, f.type);
        },
        onPhase: (fid, phase) => {
          const file = this.files.get(fid) ?? this.track(fid, `file-${fid}`, 0);
          file.phase = phase;
          events.onPhase?.({ ...file });
        },
        onProgress: (fid, sent, total) => {
          const file = this.files.get(fid) ?? this.track(fid, `file-${fid}`, total);
          file.done = sent;
          file.size = total;
          events.onProgress?.({ ...file });
        },
        onError: (fid, code) => events.onError?.(code, fid),
        onResumable: (peer) => this.reofferParked(peer),
      },
      opts.fidParity ?? 0,
      this.store,
    );

    this.receiver = new Receiver(
      opts.channel,
      {
        onHello: (hello) => events.onHello?.(hello.name ?? ""),
        onOffer: (offer) => {
          for (const f of offer.files) this.track(f.fid, f.name, f.size, f.type);
          events.onOffer?.(offer);
        },
        onText: (text) => events.onText?.(text),
        onPhase: (fid, phase) => {
          const file = this.files.get(fid) ?? this.track(fid, `file-${fid}`, 0);
          file.phase = phase;
          events.onPhase?.({ ...file });
        },
        onProgress: (fid, received, total) => {
          const file = this.files.get(fid) ?? this.track(fid, `file-${fid}`, total);
          file.done = received;
          file.size = total;
          events.onProgress?.({ ...file });
        },
        onSaved: (fid, result) => {
          // ReceiverEvents.onSaved is (fid, result); forwarding only the first
          // argument would hand the UI a fid number instead of the result.
          const file =
            this.files.get(fid) ?? [...this.files.values()].find((f) => f.name === result.name);
          if (file) file.phase = "DONE";
          events.onSaved?.(result);
        },
        onError: (fid, code) => events.onError?.(code, fid),
        onPeerLost: () => events.onPeerLost?.(),
      },
      {
        autoAccept: opts.autoAccept ?? false,
        store: this.store,
        pcState: opts.pcState,
        createSink:
          opts.createSink ??
          ((meta) => createSinkFor(sanitizeFilename(meta.name), this.opts.pickDestination)),
        // Resumable only where the staged bytes survive the session: OPFS
        // (Firefox/Safari, Chromium without a picker). A memory sink's bytes
        // are gone with the page, so those files simply start over.
        resumeSink:
          opts.resumeSink ??
          (async (meta, resumeFromBytes) => {
            const picker = (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
            const opfs = typeof navigator.storage?.getDirectory === "function" && picker == null;
            if (!opfs) throw new DropbeamError("SINK_UNAVAILABLE", "this sink cannot resume");
            return OpfsSink.resume(meta.name, resumeFromBytes);
          }),
      },
    );
  }

  /**
   * Re-offer files this side was streaming when the channel dropped, from
   * the offset the peer says it already holds (roadmap: resumable
   * transfers). Runs after `hello`, before the user picks new files.
   */
  private reofferParked(peer: ResumedFile[]): void {
    const files: { blob: Blob; name: string; type: string; path?: string }[] = [];
    const resumeChunks: number[] = [];
    for (const announced of peer) {
      const parked = this.store.outboundFor(announced.name, announced.size);
      if (!parked || announced.chunks <= 0) continue;
      files.push({
        blob: parked.blob,
        name: parked.name,
        type: parked.type,
        ...(parked.path ? { path: parked.path } : {}),
      });
      resumeChunks.push(announced.chunks);
      this.store.takeOutbound(announced.name, announced.size);
    }
    if (files.length === 0) return;
    void this.sender.sendFiles(files, resumeChunks).catch(() => {
      // A failed resume leaves the original state: the user can re-offer.
    });
  }

  /** Announce this device and its capabilities (PRD 8.4 `hello`). */
  start(): void {
    this.opts.channel.send(
      JSON.stringify({
        k: "hello",
        v: PROTOCOL_VERSION,
        name: this.opts.deviceName,
        caps: { fsa: false, opfs: false },
      }),
    );
    // Roadmap (resumable transfers): announce the partials a previous,
    // dropped session left behind, so the peer re-offers them instead of
    // starting over.
    this.receiver.announceResumable();
  }

  /** FR-10: offer files; resolves once every accepted file is verified. */
  async sendFiles(
    files: { blob: Blob; name: string; type?: string; path?: string }[],
  ): Promise<void> {
    if (files.length === 0) {
      throw new DropbeamError("CANCELED", "no files selected");
    }
    // FR-32: sanitize here too, so a sender-supplied name can never carry a
    // path into our own bookkeeping or the peer's UI.
    const safe = files.map((f) => ({
      ...f,
      name: sanitizeFilename(f.name),
      type: f.type || f.blob.type || "application/octet-stream",
    }));
    try {
      await this.sender.sendFiles(safe);
    } catch (err) {
      throw err instanceof DropbeamError ? err : new DropbeamError("INTERNAL", "send failed");
    }
  }

  /** FR-12: send a text snippet. */
  sendText(body: string): string {
    return this.sender.sendText(body);
  }

  /** FR-13: the user approved an incoming offer. */
  async acceptOffer(offerId: string, fids?: number[]): Promise<void> {
    await this.receiver.accept(offerId, fids);
  }

  /** FR-13: the user declined. */
  declineOffer(offerId: string): void {
    this.receiver.decline(offerId);
  }

  cancel(fid: number): void {
    this.sender.cancel(fid);
    this.receiver.cancel(fid);
  }

  /** FR-16: stop everything and release the channel listeners. */
  dispose(): void {
    this.sender.dispose();
    this.receiver.dispose();
    this.files.clear();
  }

  /** Snapshot of every file this side has seen, for the transfer list. */
  snapshot(): FileProgress[] {
    return [...this.files.values()].map((f) => ({ ...f }));
  }

  /**
   * Record a file this side has seen, and return it.
   *
   * The first event about a file can arrive before anything says what the
   * file is — the phase that a peer declines a file, for instance — so the
   * row is created as a placeholder and filled in when the name arrives. A
   * file that is already recorded keeps the record it has: the first one
   * knows the real name, and a later placeholder must not overwrite it.
   */
  private track(fid: number, name: string, size: number, type = ""): FileProgress {
    const known = this.files.get(fid);
    if (known) return known;
    const file: FileProgress = { fid, name, size, type, phase: "QUEUED", done: 0 };
    this.files.set(fid, file);
    return file;
  }
}
