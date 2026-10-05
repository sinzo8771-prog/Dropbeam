import { DropbeamError, type ErrorCode } from "../errors";
import type { ChannelLike } from "./channel";
import { PROTOCOL_VERSION } from "./protocol";
import { Receiver, type IncomingOffer, type IncomingText } from "./receiver";
import { Sender } from "./sender";
import type { FilePhase } from "./phase";
import { createSinkFor } from "../storage/select-sink";
import { sanitizeFilename } from "../storage/filename";
import type { SaveResult, Sink } from "../storage/sink";

/**
 * Binds an open data channel to both halves of the transfer engine (PRD 8.4,
 * 8.5). Once two devices are paired this is the only object the UI talks to:
 * it owns Sender + Receiver, negotiates `hello`, and picks a storage sink per
 * incoming file by feature detection.
 *
 * `fidParity` separates directions so `{fid}` control messages can never be
 * ambiguous: the handshake offerer uses odd fids, the answerer even.
 */

export type FileProgress = {
  fid: number;
  name: string;
  size: number;
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
};

export class TransferSession {
  private readonly sender: Sender;
  private readonly receiver: Receiver;
  private readonly files = new Map<number, FileProgress>();

  constructor(private readonly opts: TransferSessionOptions) {
    const events = opts.events ?? {};
    const track = (fid: number, name: string, size: number) => {
      if (!this.files.has(fid)) this.files.set(fid, { fid, name, size, phase: "QUEUED", done: 0 });
      return this.files.get(fid)!;
    };

    this.sender = new Sender(
      opts.channel,
      {
        onPhase: (fid, phase) => {
          const file = this.files.get(fid) ?? track(fid, `file-${fid}`, 0);
          file.phase = phase;
          events.onPhase?.({ ...file });
        },
        onProgress: (fid, sent, total) => {
          const file = this.files.get(fid) ?? track(fid, `file-${fid}`, total);
          file.done = sent;
          file.size = total;
          events.onProgress?.({ ...file });
        },
        onError: (fid, code) => events.onError?.(code, fid),
      },
      opts.fidParity ?? 0,
    );

    this.receiver = new Receiver(
      opts.channel,
      {
        onHello: (hello) => events.onHello?.(hello.name ?? ""),
        onOffer: (offer) => {
          for (const f of offer.files) track(f.fid, f.name, f.size);
          events.onOffer?.(offer);
        },
        onText: (text) => events.onText?.(text),
        onPhase: (fid, phase) => {
          const file = this.files.get(fid) ?? track(fid, `file-${fid}`, 0);
          file.phase = phase;
          events.onPhase?.({ ...file });
        },
        onProgress: (fid, received, total) => {
          const file = this.files.get(fid) ?? track(fid, `file-${fid}`, total);
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
        createSink: (meta) => createSinkFor(sanitizeFilename(meta.name), this.opts.pickDestination),
      },
    );
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
    // Sender allocates fids as `parity + 1 + index * 2` (see Sender.allocFid),
    // so the names are known up front and progress rows can show them.
    const parity = this.opts.fidParity ?? 0;
    safe.forEach((f, index) => this.track(parity + 1 + index * 2, f.name, f.blob.size));
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

  private track(fid: number, name: string, size: number): void {
    if (!this.files.has(fid)) this.files.set(fid, { fid, name, size, phase: "QUEUED", done: 0 });
  }
}
