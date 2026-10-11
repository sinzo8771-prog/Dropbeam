/**
 * Resume state that outlives a dropped data channel (roadmap: resumable
 * transfers).
 *
 * When the connection dies mid-transfer both sides park what they had:
 * the receiver parks the *offset* it reached (the bytes themselves stay in
 * the OPFS staging file on disk, so nothing has to be re-sent), and the
 * sender parks the `Blob` it was streaming. The next session pairs the two
 * halves back together by (name, size) and continues from that offset.
 *
 * The store lives for the tab, not the transfer: a reload loses the
 * sender's `Blob` and therefore the ability to resume (FR-40 forbids
 * persisting file data), which is exactly the honest limit of a
 * no-server design — the pairing itself is always re-done by the user.
 */

import type { SinkKind } from "../storage/sink";

export type ParkedInbound = {
  /** The fid the previous session used, kept for UI continuity. */
  fid: number;
  name: string;
  size: number;
  /** Contiguous chunks already written to the sink. */
  chunks: number;
  /** Only OPFS/FSA keep the bytes; a memory sink dies with the page. */
  sink: SinkKind;
};

export type ParkedOutbound = {
  name: string;
  size: number;
  type: string;
  path?: string;
  blob: Blob;
};

/** Identity two halves of an interrupted transfer agree on. */
export type FileKey = { name: string; size: number };

export function fileKey(name: string, size: number): string {
  return `${size}:${name}`;
}

export class ResumeStore {
  private readonly inbound = new Map<string, ParkedInbound>();
  private readonly outbound = new Map<string, ParkedOutbound>();

  /** Park a partial we were receiving. Only disk-backed sinks may resume. */
  parkInbound(partial: ParkedInbound): void {
    if (partial.chunks <= 0 || partial.sink === "memory") return;
    this.inbound.set(fileKey(partial.name, partial.size), partial);
  }

  /** Park a file we were sending, so a re-paired session can continue it. */
  parkOutbound(file: ParkedOutbound): void {
    this.outbound.set(fileKey(file.name, file.size), file);
  }

  inboundFor(name: string, size: number): ParkedInbound | undefined {
    return this.inbound.get(fileKey(name, size));
  }

  outboundFor(name: string, size: number): ParkedOutbound | undefined {
    return this.outbound.get(fileKey(name, size));
  }

  /** Every partial the receiver still holds, oldest parked first. */
  inboundList(): ParkedInbound[] {
    return [...this.inbound.values()];
  }

  /**
   * Drop a parked partial (the receiver hit Discard) and stop announcing it.
   * Returns the entry so the caller can delete the staged bytes.
   */
  takeInbound(name: string, size: number): ParkedInbound | undefined {
    const key = fileKey(name, size);
    const partial = this.inbound.get(key);
    this.inbound.delete(key);
    return partial;
  }

  /** The sender finished (or failed) a resumed file: stop offering it. */
  takeOutbound(name: string, size: number): ParkedOutbound | undefined {
    const key = fileKey(name, size);
    const file = this.outbound.get(key);
    this.outbound.delete(key);
    return file;
  }

  /** True when either side holds something resumable. */
  get hasPending(): boolean {
    return this.inbound.size > 0 || this.outbound.size > 0;
  }

  get inboundCount(): number {
    return this.inbound.size;
  }

  get outboundCount(): number {
    return this.outbound.size;
  }
}

/** One store per tab: the pairing UI and both engines share it. */
export const resumeStore = new ResumeStore();
