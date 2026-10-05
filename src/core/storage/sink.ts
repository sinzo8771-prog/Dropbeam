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
  close(): Promise<SaveResult>;
  abort(): Promise<void>;
}

export class SinkError extends Error {
  constructor(readonly code: "SINK_UNAVAILABLE" | "DISK_FULL" | "CANCELED") {
    super(code);
    this.name = "SinkError";
  }
}
