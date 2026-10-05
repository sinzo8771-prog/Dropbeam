import type { ChannelLike, ChannelState } from "../../src/core/transfer/channel";

type Listener = (ev: never) => void;

export type MemoryChannelOptions = {
  /** Simulated send-buffer drain rate. */
  drainPerTick?: number;
  /** Simulated send-buffer drain interval (ms). */
  tickMs?: number;
  /** Deliver to the peer after this delay (ms); 0 = next microtask. */
  latencyMs?: number;
  /** Mutate outgoing binary frames (used for hash-mismatch injection). */
  interceptOutgoing?: (data: string | ArrayBuffer | ArrayBufferView, from: MemoryChannel) => void;
  /** Return true to drop an outgoing message (used for SEQ_GAP injection). */
  dropOutgoing?: (data: string | ArrayBuffer | ArrayBufferView, from: MemoryChannel) => boolean;
};

/**
 * In-memory `RTCDataChannel` stand-in with a real bufferedAmount model, so the
 * backpressure controller is exercised in tests (PRD 8.4).
 */
export class MemoryChannel implements ChannelLike {
  readonly label = "dropbeam";
  readyState: ChannelState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = "arraybuffer";
  closed = false;

  peer!: MemoryChannel;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly inbox: (string | ArrayBuffer)[] = [];
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private readonly opts: MemoryChannelOptions;

  constructor(opts: MemoryChannelOptions = {}) {
    this.opts = opts;
    const tickMs = opts.tickMs ?? 1;
    const drainPerTick = opts.drainPerTick ?? 512 * 1024;
    this.drainTimer = setInterval(() => {
      if (this.bufferedAmount > 0) {
        this.bufferedAmount = Math.max(0, this.bufferedAmount - drainPerTick);
        this.emit("bufferedamountlow", new Event("bufferedamountlow"));
      }
    }, tickMs);
  }

  /** Both ends share one options object, so interceptors see both directions. */
  static pair(opts: MemoryChannelOptions = {}): [MemoryChannel, MemoryChannel] {
    const a = new MemoryChannel(opts);
    const b = new MemoryChannel(opts);
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  private emit(type: string, ev: unknown): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) (l as (e: unknown) => void)(ev);
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== "open") throw new Error("InvalidStateError: channel not open");
    this.opts.interceptOutgoing?.(data, this);
    if (this.opts.dropOutgoing?.(data, this)) return;
    const bytes =
      typeof data === "string"
        ? data.length
        : data instanceof ArrayBuffer
          ? data.byteLength
          : data.byteLength;
    this.bufferedAmount += bytes;

    let outgoing: string | ArrayBuffer;
    if (typeof data === "string") outgoing = data;
    else if (data instanceof ArrayBuffer) outgoing = data.slice(0);
    else {
      const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      outgoing = view.slice().buffer;
    }

    const deliver = (): void => {
      if (this.peer.closed) return;
      this.peer.inbox.push(outgoing);
      this.peer.deliverNext();
    };
    if (this.opts.latencyMs) setTimeout(deliver, this.opts.latencyMs);
    else queueMicrotask(deliver);
  }

  private deliverNext(): void {
    if (this.inbox.length === 0) return;
    const next = this.inbox.shift();
    if (next === undefined) return;
    const ev = { data: next } as unknown as MessageEvent;
    this.emit("message", ev);
    if (this.inbox.length > 0) queueMicrotask(() => this.deliverNext());
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.closed = true;
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.emit("close", new Event("close"));
    if (this.peer.readyState !== "closed") this.peer.close();
  }

  /** Clears pending outbound drain timers (test cleanup). */
  dispose(): void {
    if (this.drainTimer) clearInterval(this.drainTimer);
  }
}

/** Waits until `predicate` returns true or the timeout elapses. */
export async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 30_000, intervalMs = 5, label = "condition" } = {},
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
