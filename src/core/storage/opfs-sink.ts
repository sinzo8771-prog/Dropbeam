import { readStagedRange, SinkError, type SaveResult, type Sink, type SinkMeta } from "./sink";
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
  createWritable(opts?: { keepExistingData?: boolean }): Promise<OpfsWritable>;
  getFile(): Promise<Blob>;
  remove(): Promise<void>;
};

type PositionedWrite = { type: "write"; position: number; data: BufferSource };

/**
 * Real `FileSystemWritableFileStream.write` accepts `{type:"write", position}`
 * to write at an offset. A bare stub that only takes raw bytes does not, so
 * we detect the positioned form and fall back to a plain append.
 */
function supportsPositionedWrite(w: OpfsWritable): boolean {
  return typeof w.write === "function";
}

/** Scratch name for the write probe: recognisable, and never a staged file. */
const PROBE_NAME = ".write-probe";

type ProbeDir = {
  getFileHandle(name: string, opts: { create: boolean }): Promise<OpfsHandle>;
  removeEntry(name: string): Promise<void>;
};

/**
 * Whether OPFS can actually be *written to*, not merely reached (FR-50).
 *
 * `isOpfsSupported` answers whether the namespace exists, which is all sink
 * selection needs and is a different question: some builds expose
 * `navigator.storage.getDirectory` while `createWritable` throws for every
 * handle they hand out. That gap is not hypothetical — Playwright's WebKit build
 * has the namespace and nothing else (docs/INTEROP.md) — and it is exactly the
 * gap that decides whether an incoming file stages to disk or fails mid-transfer
 * instead of falling back to memory. So the debug panel reports reachability and
 * writability as two separate facts rather than letting one stand in for the
 * other, and this is the second one.
 *
 * Deliberately best-effort: the scratch file is removed on every path, and a
 * failure is `false` rather than a throw, because a diagnostic must never be the
 * thing that breaks a session. It costs one small file in the staging directory.
 */
export async function probeOpfsWrite(): Promise<boolean> {
  if (!isOpfsSupported()) return false;
  const storage = (
    globalThis.navigator as Navigator & {
      storage: { getDirectory(): Promise<unknown> };
    }
  ).storage;
  let dir: ProbeDir | undefined;
  try {
    const root = (await storage.getDirectory()) as {
      getDirectoryHandle(name: string, opts: { create: boolean }): Promise<unknown>;
    };
    dir = (await root.getDirectoryHandle(STAGING_DIR, { create: true })) as ProbeDir;
    const handle = await dir.getFileHandle(PROBE_NAME, { create: true });
    const writable = await handle.createWritable();
    await writable.write(new Uint8Array([0x44, 0x62]));
    await writable.close();
    return true;
  } catch {
    return false;
  } finally {
    // Best effort, and after a failure too: a probe must not leave a file
    // behind that a later run could mistake for a staged transfer.
    try {
      await dir?.removeEntry(PROBE_NAME);
    } catch {
      // No OPFS to clean up, or it cannot be written to at all.
    }
  }
}

export class OpfsSink implements Sink {
  readonly kind = "opfs" as const;
  private writable: OpfsWritable | null = null;
  private handle: OpfsHandle | null = null;
  private meta: SinkMeta | null = null;
  private bytes = 0;
  /** Write cursor for positioned writes: 0 for a fresh file, the resume
      offset for a file an interrupted transfer left behind. */
  private position = 0;

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

  /**
   * Re-open the staged file an interrupted transfer left behind (roadmap:
   * resumable transfers). `resumeFromBytes` must be a chunk boundary; the
   * staged `.part` keeps its data and writes continue from there, so the
   * peer only re-sends what is missing.
   */
  static async resume(suggestedName: string, resumeFromBytes: number): Promise<OpfsSink> {
    const sink = await OpfsSink.create(suggestedName);
    sink.position = resumeFromBytes;
    sink.bytes = resumeFromBytes;
    return sink;
  }

  async open(meta: SinkMeta): Promise<void> {
    if (!this.handle) throw new SinkError("SINK_UNAVAILABLE");
    this.meta = meta;
    try {
      // keepExistingData: a resumed file must not be truncated, while a
      // freshly created path is empty anyway.
      this.writable = await this.handle.createWritable({ keepExistingData: true });
    } catch (err) {
      throw mapWriteError(err);
    }
    this.bytes = this.position;
  }

  async write(chunk: Uint8Array): Promise<void> {
    const writable = this.writable;
    if (!writable) throw new SinkError("SINK_UNAVAILABLE");
    try {
      // Positioned writes: the receiver resumes at an arbitrary chunk
      // boundary, so every write states where it lands instead of relying
      // on an implicit append cursor. Called as a method on the stream so
      // `this` stays correct — an unbound native write throws. The
      // receiver's frame buffer is reused, hence the copy.
      const data = new Uint8Array(chunk);
      if (supportsPositionedWrite(writable)) {
        const at: PositionedWrite = { type: "write", position: this.position, data };
        await writable.write(at as unknown as BufferSource);
      } else {
        await writable.write(data);
      }
      this.position += data.byteLength;
      this.bytes += data.byteLength;
    } catch (err) {
      throw mapWriteError(err);
    }
  }

  async writeAt(offset: number, bytes: Uint8Array): Promise<void> {
    const writable = this.writable;
    if (!writable) throw new SinkError("SINK_UNAVAILABLE");
    try {
      if (supportsPositionedWrite(writable)) {
        const at: PositionedWrite = {
          type: "write",
          position: offset,
          data: new Uint8Array(bytes),
        };
        await writable.write(at as unknown as BufferSource);
      } else {
        await writable.write(new Uint8Array(bytes));
      }
    } catch (err) {
      throw mapWriteError(err);
    }
  }

  async readRange(offset: number, length: number): Promise<Uint8Array | null> {
    const handle = this.handle;
    if (!handle) throw new SinkError("SINK_UNAVAILABLE");
    return readStagedRange(handle, offset, length);
  }

  /**
   * The first `bytes` of the staged file, for re-hashing the prefix of a
   * resumed transfer (the receiver's hasher state died with the session).
   */
  async readPrefix(bytes: number): Promise<Uint8Array> {
    const handle = this.handle;
    if (!handle) throw new SinkError("SINK_UNAVAILABLE");
    return readStagedRange(handle, 0, bytes);
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
