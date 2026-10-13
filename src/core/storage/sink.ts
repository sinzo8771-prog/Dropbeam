/**
 * Storage sinks (PRD 8.5): the receiver writes chunks to a Sink chosen at
 * runtime by feature detection. Implementations: FsaSink, OpfsSink, MemorySink.
 */
export type SinkKind = "fsa" | "opfs" | "memory";

export type SinkMeta = {
  name: string;
  size: number;
  type: string;
};

export type SaveResult = {
  name: string;
  size: number;
  sink: SinkKind;
  /** Object URL for the saved data (download link / preview), when available. */
  url?: string;
  /** Raw bytes when the sink kept them in memory (used by tests). */
  blob?: Blob;
};

export interface Sink {
  readonly kind: SinkKind;
  open(meta: SinkMeta): Promise<void>;
  write(chunk: Uint8Array): Promise<void>;
  /**
   * Overwrite `bytes` at an absolute file offset (roadmap: per-chunk repair).
   * The range must already lie inside the staged file — repair rewrites bytes
   * that were written once, it never extends a file past its announced size.
   */
  writeAt?(offset: number, bytes: Uint8Array): Promise<void>;
  /**
   * Read `length` bytes starting at `offset` from the staged file, for
   * re-hashing after a whole-file mismatch. Only disk-backed sinks can do
   * this; a memory sink returns null and the caller skips per-chunk repair.
   */
  readRange?(offset: number, length: number): Promise<Uint8Array | null>;
  close(): Promise<SaveResult>;
  abort(): Promise<void>;
  /**
   * The first `bytes` already staged on disk, for re-hashing a resumed
   * transfer's prefix. Only sinks that keep data between sessions provide
   * it (OPFS/FSA); memory sinks cannot resume at all.
   */
  readPrefix?(bytes: number): Promise<Uint8Array>;
}

export class SinkError extends Error {
  constructor(readonly code: "SINK_UNAVAILABLE" | "DISK_FULL" | "CANCELED") {
    super(code);
    this.name = "SinkError";
  }
}
