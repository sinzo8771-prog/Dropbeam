import { DropbeamError, toErrorCode, type ErrorCode } from "../errors";
import type { ChannelLike } from "./channel";
import { BackpressureController } from "./backpressure";
import { createHasher, type Hasher } from "./hash";
import {
  CHUNK_SIZE,
  decodeControl,
  encodeControl,
  encodeDataFrame,
  uuid,
  type ControlMessage,
} from "./protocol";
import type { FilePhase } from "./phase";

export type { FilePhase };

export type OutboundFile = {
  fid: number;
  blob: Blob;
  /** Already sanitized (core/storage/filename.sanitizeFilename). */
  name: string;
  type: string;
  path?: string;
};

export type SendOffer = { id: string; files: OutboundFile[]; totalSize: number };

export type SenderEvents = {
  onResponse?(id: string, accepted: boolean): void;
  onPhase?(fid: number, phase: FilePhase): void;
  onProgress?(fid: number, sent: number, total: number): void;
  onError?(fid: number | null, code: ErrorCode): void;
};

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/**
 * Outbound half of the transfer protocol (PRD 8.4).
 *
 * Notes:
 * - Offers are serialized: one batch is in flight at a time, so fid ranges
 *   never overlap (see docs/DECISIONS.md on fid parity).
 * - `fidParity` separates the two directions: the handshake offerer uses odd
 *   fids, the answerer even, so `ok/err/cancel {fid}` are never ambiguous.
 */
export class Sender {
  private readonly bp: BackpressureController;
  private readonly phases = new Map<number, FilePhase>();
  private readonly responseWaiters = new Map<
    string,
    { resolve: (fids: number[] | null) => void }
  >();
  private readonly verifiedWaiters = new Map<
    number,
    { resolve: () => void; reject: (e: Error) => void }
  >();
  /** Errors the peer reported for a fid before we started waiting for `ok`. */
  private readonly pendingErrors = new Map<number, ErrorCode>();
  private readonly cancelRequested = new Set<number>();
  private currentFid: number | null = null;
  private offerQueue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private nextFidIndex = 0;

  constructor(
    private readonly channel: ChannelLike,
    private readonly events: SenderEvents = {},
    private readonly fidParity: 0 | 1 = 0,
  ) {
    this.bp = new BackpressureController(channel);
    this.channel.addEventListener("message", this.onMessage);
  }

  private onMessage = (ev: MessageEvent): void => {
    if (typeof ev.data !== "string") return;
    const msg = decodeControl(ev.data);
    if (!msg) return;
    switch (msg.k) {
      case "accept": {
        const w = this.responseWaiters.get(msg.id);
        if (w) {
          this.responseWaiters.delete(msg.id);
          this.events.onResponse?.(msg.id, msg.fids.length > 0);
          w.resolve(msg.fids);
        }
        break;
      }
      case "decline": {
        const w = this.responseWaiters.get(msg.id);
        if (w) {
          this.responseWaiters.delete(msg.id);
          this.events.onResponse?.(msg.id, false);
          w.resolve(null);
        }
        break;
      }
      case "ok": {
        this.verifiedWaiters.get(msg.fid)?.resolve();
        break;
      }
      case "err": {
        const waiter = this.verifiedWaiters.get(msg.fid);
        if (waiter) waiter.reject(new DropbeamError(msg.code));
        else this.pendingErrors.set(msg.fid, msg.code);
        // Stop streaming this file immediately; the peer has already failed it.
        this.cancelRequested.add(msg.fid);
        break;
      }
      case "cancel": {
        // Peer stopped receiving this fid (see DECISIONS.md on direction).
        if (
          this.phases.get(msg.fid) === "TRANSFERRING" ||
          this.phases.get(msg.fid) === "ACCEPTED"
        ) {
          this.cancelRequested.add(msg.fid);
        }
        break;
      }
      default:
        break;
    }
  };

  phase(fid: number): FilePhase | undefined {
    return this.phases.get(fid);
  }

  private setPhase(fid: number, phase: FilePhase): void {
    this.phases.set(fid, phase);
    this.events.onPhase?.(fid, phase);
  }

  private allocFid(): number {
    const fid = this.fidParity + 1 + this.nextFidIndex * 2;
    this.nextFidIndex += 1;
    return fid;
  }

  private waitResponse(id: string): Promise<number[] | null> {
    return new Promise<number[] | null>((resolve) => {
      this.responseWaiters.set(id, { resolve });
    });
  }

  private waitVerified(fid: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.verifiedWaiters.set(fid, { resolve, reject });
    });
  }

  /** Sends text (FR-12). Returns the message id. */
  sendText(body: string): string {
    const id = uuid();
    this.channel.send(encodeControl({ k: "text", id, body }));
    return id;
  }

  /**
   * Offers files to the peer (FR-10). Resolves when every accepted file has
   * been verified by the peer; rejects with a DropbeamError on failure.
   */
  sendFiles(
    files: { blob: Blob; name: string; type?: string; path?: string }[],
  ): Promise<SendOffer> {
    const run = async (): Promise<SendOffer> => {
      const id = uuid();
      const outbound: OutboundFile[] = files.map((f) => ({
        fid: this.allocFid(),
        blob: f.blob,
        name: f.name,
        type: f.type || f.blob.type || "application/octet-stream",
        ...(f.path ? { path: f.path } : {}),
      }));
      for (const f of outbound) this.setPhase(f.fid, "QUEUED");
      const totalSize = files.reduce((n, f) => n + f.blob.size, 0);

      const offer: SendOffer = { id, files: outbound, totalSize };
      this.channel.send(
        encodeControl({
          k: "offer",
          id,
          files: outbound.map((f) => ({
            fid: f.fid,
            name: f.name,
            size: f.blob.size,
            type: f.type,
            ...(f.path ? { path: f.path } : {}),
          })),
          totalSize,
        }),
      );
      for (const f of outbound) this.setPhase(f.fid, "OFFERED");

      const acceptedFids = await this.waitResponse(id);
      if (acceptedFids === null) {
        for (const f of outbound) this.setPhase(f.fid, "DECLINED");
        return offer;
      }

      for (const f of outbound) {
        if (!acceptedFids.includes(f.fid)) {
          this.setPhase(f.fid, "DECLINED");
          continue;
        }
        if (this.cancelRequested.has(f.fid)) {
          this.setPhase(f.fid, "CANCELED");
          continue;
        }
        this.setPhase(f.fid, "ACCEPTED");
        await this.streamFile(f);
      }
      return offer;
    };

    const result = this.offerQueue.then(run, run);
    this.offerQueue = result.catch(() => undefined);
    return result;
  }

  private async streamFile(f: OutboundFile): Promise<void> {
    const earlyError = this.pendingErrors.get(f.fid);
    if (earlyError) {
      this.pendingErrors.delete(f.fid);
      this.setPhase(f.fid, "FAILED");
      this.events.onError?.(f.fid, earlyError);
      throw new DropbeamError(earlyError);
    }
    this.setPhase(f.fid, "TRANSFERRING");
    this.currentFid = f.fid;
    const hasher = await createHasher();
    let seq = 0;
    let canceled = false;

    try {
      const reader = f.blob.stream().getReader();
      let carry: Uint8Array<ArrayBuffer> | null = null;
      for (;;) {
        if (this.cancelRequested.has(f.fid)) {
          canceled = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        const failed = this.pendingErrors.get(f.fid);
        if (failed) {
          this.pendingErrors.delete(f.fid);
          await reader.cancel().catch(() => undefined);
          throw new DropbeamError(failed);
        }
        let data = value;
        if (carry) {
          data = concat(carry, value);
          carry = null;
        }
        let offset = 0;
        while (data.byteLength - offset >= CHUNK_SIZE) {
          await this.emitChunk(f, data.subarray(offset, offset + CHUNK_SIZE), seq, hasher);
          seq += 1;
          offset += CHUNK_SIZE;
        }
        if (offset < data.byteLength) carry = data.slice(offset);
      }
      if (!canceled && carry && carry.byteLength > 0) {
        await this.emitChunk(f, carry, seq, hasher);
        seq += 1;
      }
      if (canceled || this.cancelRequested.has(f.fid)) {
        canceled = true;
        this.channel.send(encodeControl({ k: "cancel", fid: f.fid }));
        this.setPhase(f.fid, "CANCELED");
        return;
      }

      this.setPhase(f.fid, "VERIFYING");
      const hex = await hasher.digest();
      const failedNow = this.pendingErrors.get(f.fid);
      if (failedNow) {
        this.pendingErrors.delete(f.fid);
        throw new DropbeamError(failedNow);
      }
      this.channel.send(encodeControl({ k: "done", fid: f.fid, sha256: hex }));
      await this.waitVerified(f.fid);
      this.setPhase(f.fid, "DONE");
    } catch (err) {
      const code: ErrorCode =
        err instanceof DropbeamError && err.code === "CANCELED" ? "CANCELED" : toErrorCode(err);
      if (code === "CANCELED") this.setPhase(f.fid, "CANCELED");
      else {
        this.setPhase(f.fid, "FAILED");
        this.events.onError?.(f.fid, code);
      }
      throw err instanceof DropbeamError ? err : new DropbeamError(code);
    } finally {
      hasher.dispose();
      this.currentFid = null;
      this.verifiedWaiters.delete(f.fid);
      this.pendingErrors.delete(f.fid);
    }
  }

  private async emitChunk(
    f: OutboundFile,
    chunk: Uint8Array,
    seq: number,
    hasher: Hasher,
  ): Promise<void> {
    await this.bp.drain();
    hasher.update(chunk);
    this.channel.send(encodeDataFrame(f.fid, seq, chunk));
    const sent = (seq + 1) * CHUNK_SIZE;
    this.events.onProgress?.(f.fid, Math.min(sent, f.blob.size), f.blob.size);
  }

  /** Cancels one outbound file (FR-16). */
  cancel(fid: number): void {
    this.cancelRequested.add(fid);
    if (this.phases.get(fid) === "QUEUED" || this.phases.get(fid) === "OFFERED") {
      this.setPhase(fid, "CANCELED");
      this.channel.send(encodeControl({ k: "cancel", fid }));
    } else if (this.currentFid === fid) {
      this.channel.send(encodeControl({ k: "cancel", fid }));
    }
    this.verifiedWaiters.get(fid)?.reject(new DropbeamError("CANCELED"));
  }

  /** Cancels every outbound file (FR-16). */
  cancelAll(): void {
    for (const [fid, phase] of this.phases) {
      if (phase === "DONE" || phase === "FAILED" || phase === "CANCELED") continue;
      this.cancel(fid);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.channel.removeEventListener("message", this.onMessage);
    this.bp.dispose();
    for (const w of this.responseWaiters.values()) w.resolve(null);
    this.responseWaiters.clear();
    for (const w of this.verifiedWaiters.values()) w.reject(new DropbeamError("CANCELED"));
    this.verifiedWaiters.clear();
  }
}

export type { ControlMessage };
