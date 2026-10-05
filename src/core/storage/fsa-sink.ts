import { SinkError, type SaveResult, type Sink, type SinkMeta } from "./sink";
import { sanitizeFilename } from "./filename";

/**
 * File System Access sink (PRD 8.5): the best path on Chromium desktop — the
 * user picks a destination once and chunks stream straight to disk, so file
 * size is bounded by the disk rather than by RAM (NFR-2).
 *
 * `showSaveFilePicker` must be called from a user gesture; when it is absent
 * (Firefox, Safari, mobile) construction is refused so the caller can fall
 * back to OPFS or memory instead of failing mid-transfer.
 */

export function isFsaSupported(): boolean {
  return typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function";
}

/** Map DOM write failures onto the PRD 12 reason codes. */
export function mapWriteError(err: unknown): SinkError {
  const name = typeof err === "object" && err !== null && "name" in err ? String(err.name) : "";
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") {
    return new SinkError("DISK_FULL");
  }
  if (name === "AbortError") return new SinkError("CANCELED");
  return new SinkError("DISK_FULL");
}

type FsaWritable = {
  write(chunk: BufferSource): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
};

type FsaFileHandle = { createWritable(): Promise<FsaWritable> };

export class FsaSink implements Sink {
  readonly kind = "fsa" as const;
  private writable: FsaWritable | null = null;
  private meta: SinkMeta | null = null;
  private bytes = 0;

  constructor(private readonly handle: FsaFileHandle) {}

  /** Prompt for a destination. Must be called from a user gesture. */
  static async pick(suggestedName: string): Promise<FsaSink> {
    if (!isFsaSupported()) throw new SinkError("SINK_UNAVAILABLE");
    const picker = (
      globalThis as unknown as {
        showSaveFilePicker: (opts: unknown) => Promise<FsaFileHandle>;
      }
    ).showSaveFilePicker;
    try {
      const handle = await picker({ suggestedName: sanitizeFilename(suggestedName) });
      return new FsaSink(handle);
    } catch (err) {
      const name = typeof err === "object" && err !== null && "name" in err ? String(err.name) : "";
      // The user dismissing the picker is a cancel, not a failure.
      if (name === "AbortError") throw new SinkError("CANCELED");
      throw new SinkError("SINK_UNAVAILABLE");
    }
  }

  async open(meta: SinkMeta): Promise<void> {
    this.meta = meta;
    try {
      this.writable = await this.handle.createWritable();
    } catch (err) {
      throw mapWriteError(err);
    }
    this.bytes = 0;
  }

  async write(chunk: Uint8Array): Promise<void> {
    const writable = this.writable;
    if (!writable) throw new SinkError("SINK_UNAVAILABLE");
    try {
      // Copy to an ArrayBuffer-backed view: the receiver reuses its frame
      // buffer, and `BufferSource` excludes SharedArrayBuffer-backed views.
      await writable.write(new Uint8Array(chunk));
    } catch (err) {
      throw mapWriteError(err);
    }
    this.bytes += chunk.byteLength;
  }

  async close(): Promise<SaveResult> {
    const meta = this.meta;
    const writable = this.writable;
    if (!meta || !writable) throw new SinkError("SINK_UNAVAILABLE");
    try {
      await writable.close();
    } catch (err) {
      throw mapWriteError(err);
    }
    this.writable = null;
    return { name: meta.name, size: this.bytes, sink: "fsa" };
  }

  async abort(): Promise<void> {
    const writable = this.writable;
    this.writable = null;
    try {
      await writable?.abort?.();
    } catch {
      // Aborting a half-written file is best-effort; the caller already knows.
    }
  }
}
