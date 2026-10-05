import { MEMORY_SINK_CAP } from "./limits";
import { SinkError, type SaveResult, type Sink, type SinkMeta } from "./sink";

/**
 * PRD FR-31 last-resort sink: chunks in memory, hard cap, then a Blob URL.
 * Used when neither File System Access nor OPFS can take the file.
 */
export class MemorySink implements Sink {
  readonly kind = "memory" as const;
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private meta: SinkMeta | null = null;
  private url: string | null = null;

  constructor(private readonly capBytes: number = MEMORY_SINK_CAP) {}

  async open(meta: SinkMeta): Promise<void> {
    if (meta.size > this.capBytes) throw new SinkError("SINK_UNAVAILABLE");
    this.meta = meta;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.bytes + chunk.byteLength > this.capBytes) throw new SinkError("SINK_UNAVAILABLE");
    // Copy: the frame buffer is reused by the receiver.
    this.chunks.push(chunk.slice());
    this.bytes += chunk.byteLength;
  }

  async close(): Promise<SaveResult> {
    const meta = this.meta;
    if (!meta) throw new SinkError("SINK_UNAVAILABLE");
    const blob = new Blob(this.chunks as BlobPart[], {
      type: meta.type || "application/octet-stream",
    });
    if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
      this.url = URL.createObjectURL(blob);
    }
    const result: SaveResult = { name: meta.name, size: this.bytes, sink: "memory", blob };
    if (this.url) result.url = this.url;
    this.chunks = [];
    return result;
  }

  async abort(): Promise<void> {
    this.chunks = [];
    this.bytes = 0;
    if (this.url && typeof URL !== "undefined" && URL.revokeObjectURL) {
      URL.revokeObjectURL(this.url);
    }
    this.url = null;
  }

  get receivedBytes(): number {
    return this.bytes;
  }
}
