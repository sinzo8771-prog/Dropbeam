/**
 * SHA-256 worker (PRD 8.6): hashing must not block the UI thread.
 * Messages: {t:"init"} → {t:"ready"}; {t:"update", buf}; {t:"digest"} → {t:"digest", hex}.
 */
import { createSHA256, type IHasher } from "hash-wasm";

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(msg: unknown): void;
};

let hasher: IHasher | null = null;
let pending: Promise<void> = Promise.resolve();

ctx.onmessage = (ev: MessageEvent): void => {
  const msg = ev.data as { t: string; buf?: ArrayBuffer };
  if (msg.t === "init") {
    pending = pending.then(async () => {
      hasher = await createSHA256();
      hasher.init();
      ctx.postMessage({ t: "ready" });
    });
  } else if (msg.t === "update" && msg.buf) {
    const buf = msg.buf;
    pending = pending.then(() => {
      hasher?.update(new Uint8Array(buf));
    });
  } else if (msg.t === "digest") {
    pending = pending.then(() => {
      try {
        ctx.postMessage({ t: "digest", hex: hasher?.digest("hex") ?? "" });
      } catch (err) {
        ctx.postMessage({ t: "digest", error: err instanceof Error ? err.message : "hash failed" });
      }
    });
  }
};

ctx.postMessage({ t: "started" });
