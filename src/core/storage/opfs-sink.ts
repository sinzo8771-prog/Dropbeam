import { SinkError, type SaveResult, type Sink, type SinkMeta } from "./sink";
import { mapWriteError } from "./fsa-sink";
import { sanitizeFilename } from "./filename";

/**
 * OPFS staging sink (PRD 8.5): Chrome Android, Firefox and Safari stage the
 * incoming file in the Origin Private File System, then hand it to the user as
 * a download. This is the fallback everywhere File System Access is missing,
 * so it must never buffer the whole file in JS.
 */

const STAGING_DIR = "dropbeam";

export function isOpfsSupported(): boolean {
  const storage = (globalThis.navigator as Navigator | undefined)?.storage as
    { getDirectory?: unknown } | undefined;
  return typeof storage?.getDirectory === "function";
}

type OpfsWritable = {
  write(chunk: BufferSource): Promise<void>;
  close(): Promise<void>;
};

export type OpfsHandle = {
  createWritable(): Promise<OpfsWritable>;
  getFile(): Promise<Blob>;
  remove(): Promise<void>;
};

export class OpfsSink implements Sink {
  readonly kind = "opfs" as const;
  private writable: OpfsWritable | null = null;
  private handle: OpfsHandle | null = null;
  private meta: SinkMeta | null = null;
  private bytes = 0;

  private constructor(
    handle: OpfsHandle,
    private readonly path: string,
  ) {
    this.handle = handle;
  }

  /** Create `<opfs>/dropbeam/<name>.part`; the extension is added on close. */
  static async create(suggestedName: string): Promise<OpfsSink> {
    if (!isOpfsSupported()) throw new SinkError("SINK_UNAVAILABLE");
    const storage = (
      globalThis.navigator as Navigator & {
        storage: { getDirectory(): Promise<unknown> };
      }
    ).storage;
    try {
      const root = (await storage.getDirectory()) as {
        getDirectoryHandle(name: string, opts: { create: boolean }): Promise<unknown>;
      };
      const dir = (await root.getDirectoryHandle(STAGING_DIR, { create: true })) as {
        getFileHandle(name: string, opts: { create: boolean }): Promise<OpfsHandle>;
      };
      const path = `${STAGING_DIR}/${sanitizeFilename(suggestedName)}.part`;
      const handle = await dir.getFileHandle(path.split("/")[1]!, { create: true });
      return new OpfsSink(handle, path);
    } catch (err) {
      throw mapWriteError(err);
    }
  }

  async open(meta: SinkMeta): Promise<void> {
    if (!this.handle) throw new SinkError("SINK_UNAVAILABLE");
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
    const handle = this.handle;
    if (!meta || !writable || !handle) throw new SinkError("SINK_UNAVAILABLE");
    try {
      await writable.close();
      const file = await handle.getFile();
      if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
        return {
          name: meta.name,
          size: this.bytes,
          sink: "opfs",
          url: URL.createObjectURL(file),
        };
      }
      return { name: meta.name, size: this.bytes, sink: "opfs" };
    } catch (err) {
      throw mapWriteError(err);
    } finally {
      this.writable = null;
    }
  }

  async abort(): Promise<void> {
    this.writable = null;
    try {
      await this.handle?.remove();
    } catch {
      // Best-effort cleanup of the staged part file.
    }
    this.handle = null;
  }

  /** Staging path, exposed for the debug panel (PRD 8.5). */
  get stagingPath(): string {
    return this.path;
  }
}
