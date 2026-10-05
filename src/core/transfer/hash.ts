import { DropbeamError } from "../errors";

/**
 * Incremental SHA-256 (PRD 8.6). Runs in a Web Worker when the platform has
 * one, so hashing never blocks the UI thread; falls back to the current thread
 * (tests, or browsers without module workers).
 */
export interface Hasher {
  /** Updates synchronously (worker path queues the copy internally). */
  update(data: Uint8Array): void;
  /** Resolves with lowercase hex after every queued update. */
  digest(): Promise<string>;
  dispose(): void;
}

type WorkerLike = {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
  addEventListener(type: "error", listener: (ev: ErrorEvent) => void): void;
  removeEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
  removeEventListener(type: "error", listener: (ev: ErrorEvent) => void): void;
  terminate(): void;
};

class WorkerHasher implements Hasher {
  private ready: Promise<void>;
  private failed = false;
  private disposed = false;

  /** Creates a worker-backed hasher and waits for it to be ready. */
  static async create(worker: WorkerLike): Promise<WorkerHasher> {
    const hasher = new WorkerHasher(worker);
    await hasher.ready;
    return hasher;
  }

  private constructor(private readonly worker: WorkerLike) {
    this.ready = new Promise<void>((resolve, reject) => {
      const onMessage = (ev: MessageEvent): void => {
        if ((ev.data as { t?: string })?.t === "ready") {
          worker.removeEventListener("message", onMessage);
          resolve();
        }
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", (ev) => {
        this.failed = true;
        reject(new DropbeamError("INTERNAL", ev.message));
      });
      worker.postMessage({ t: "init" });
    });
  }

  update(data: Uint8Array): void {
    if (this.disposed || this.failed) return;
    const copy = data.slice();
    this.worker.postMessage({ t: "update", buf: copy.buffer }, [copy.buffer]);
  }

  async digest(): Promise<string> {
    await this.ready;
    if (this.failed) throw new DropbeamError("INTERNAL", "hash worker failed");
    return new Promise<string>((resolve, reject) => {
      const onMessage = (ev: MessageEvent): void => {
        const msg = ev.data as { t?: string; hex?: string; error?: string };
        if (msg?.t === "digest") {
          this.worker.removeEventListener("message", onMessage);
          if (msg.error) reject(new DropbeamError("INTERNAL", msg.error));
          else resolve(msg.hex ?? "");
        }
      };
      this.worker.addEventListener("message", onMessage);
      this.worker.postMessage({ t: "digest" });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
  }
}

class InlineHasher implements Hasher {
  private impl: import("hash-wasm").IHasher | null = null;

  private ensure(): import("hash-wasm").IHasher {
    if (!this.impl) throw new DropbeamError("INTERNAL", "hasher not initialised");
    return this.impl;
  }

  static async create(): Promise<InlineHasher> {
    const self = new InlineHasher();
    const { createSHA256 } = await import("hash-wasm");
    self.impl = await createSHA256();
    self.impl.init();
    return self;
  }

  update(data: Uint8Array): void {
    this.ensure().update(data);
  }

  async digest(): Promise<string> {
    return this.ensure().digest("hex");
  }

  dispose(): void {
    this.impl = null;
  }
}

let workerSupported: boolean | null = null;

function hasWorker(): boolean {
  if (workerSupported !== null) return workerSupported;
  try {
    workerSupported = typeof Worker !== "undefined" && typeof URL !== "undefined";
  } catch {
    workerSupported = false;
  }
  return workerSupported;
}

/** Creates a SHA-256 hasher (PRD FR-17). */
export async function createHasher(): Promise<Hasher> {
  if (hasWorker()) {
    try {
      const worker = new Worker(new URL("./hash.worker.ts", import.meta.url), {
        type: "module",
        name: "dropbeam-hash",
      }) as unknown as WorkerLike;
      return await WorkerHasher.create(worker);
    } catch {
      // fall through to inline hashing
    }
  }
  return InlineHasher.create();
}
