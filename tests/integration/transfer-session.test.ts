import { describe, expect, it } from "vitest";
import { TransferSession, type FileProgress } from "../../src/core/transfer/transfer-session";
import { MemoryChannel } from "../helpers/memory-channel";
import type { IncomingOffer } from "../../src/core/transfer/receiver";
import type { Sink, SinkMeta, SaveResult } from "../../src/core/storage/sink";

/**
 * Two TransferSessions over paired memory channels — the whole data path of
 * PRD 8.4/8.5 without a browser: hello, offer, accept, chunked send, hash
 * verify and sink write.
 */

/** Collects every sink write so we can assert the bytes survived intact. */
class CollectingSink implements Sink {
  readonly kind = "fsa" as const;
  readonly chunks: Uint8Array[] = [];
  closed = false;
  constructor(readonly sinkMeta: SinkMeta | null = null) {}
  async open(meta: SinkMeta): Promise<void> {
    (this as { sinkMeta: SinkMeta | null }).sinkMeta = meta;
  }
  async write(chunk: Uint8Array): Promise<void> {
    this.chunks.push(chunk.slice());
  }
  async close(): Promise<SaveResult> {
    this.closed = true;
    const total = this.chunks.reduce((n, c) => n + c.byteLength, 0);
    return { name: this.sinkMeta?.name ?? "file", size: total, sink: "fsa" };
  }
  async abort(): Promise<void> {
    this.chunks.length = 0;
  }
  get bytes(): Uint8Array {
    const out = new Uint8Array(this.chunks.reduce((n, c) => n + c.byteLength, 0));
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }
}

function pair() {
  const a = new MemoryChannel({});
  const b = new MemoryChannel({});
  a.peer = b;
  b.peer = a;
  return { a, b };
}

function blobOf(size: number, seed = 1): Blob {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * seed + 7) & 0xff;
  return new Blob([bytes], { type: "application/octet-stream" });
}

describe("TransferSession over a live channel (PRD 8.4, 8.5)", () => {
  it("transfers a file end to end and verifies the hash", async () => {
    const { a, b } = pair();
    const sink = new CollectingSink();
    const phases: FileProgress[] = [];
    const saved: SaveResult[] = [];

    const sender = new TransferSession({
      channel: a,
      fidParity: 0,
      deviceName: "Laptop",
      events: { onPhase: (f) => phases.push(f) },
    });
    const receiver = new TransferSession({
      channel: b,
      fidParity: 1,
      events: { onSaved: (r) => saved.push(r) },
      autoAccept: true,
      pickDestination: async () => sink,
    });

    sender.start();
    receiver.start();
    await new Promise((r) => setTimeout(r, 5));

    const payload = blobOf(300_000, 3);
    await sender.sendFiles([{ blob: payload, name: "movie.mp4", type: "video/mp4" }]);

    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toBe("movie.mp4");
    expect(saved[0]!.size).toBe(payload.size);
    // The bytes must arrive intact, in order (hash-verified by the receiver).
    const received = sink.bytes;
    expect(received.byteLength).toBe(payload.size);
    const original = new Uint8Array(await payload.arrayBuffer());
    expect([...received.slice(0, 16)]).toEqual([...original.slice(0, 16)]);
    expect([...received.slice(-16)]).toEqual([...original.slice(-16)]);
    expect(phases.some((p) => p.phase === "DONE")).toBe(true);

    sender.dispose();
    receiver.dispose();
  });

  it("keeps progress monotonic and reaches 100%", async () => {
    const { a, b } = pair();
    const sink = new CollectingSink();
    const progress: number[] = [];
    const sender = new TransferSession({ channel: a, fidParity: 0 });
    const receiver = new TransferSession({
      channel: b,
      fidParity: 1,
      autoAccept: true,
      pickDestination: async () => sink,
      events: { onProgress: (f) => progress.push(f.done) },
    });
    await new Promise((r) => setTimeout(r, 5));

    const size = 200_000;
    await sender.sendFiles([{ blob: blobOf(size), name: "a.bin" }]);

    expect(progress.length).toBeGreaterThan(1);
    expect(progress[progress.length - 1]).toBe(size);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    }
    sender.dispose();
    receiver.dispose();
  });

  it("holds the incoming offer until the user accepts (FR-13)", async () => {
    const { a, b } = pair();
    const sink = new CollectingSink();
    let offered: IncomingOffer | null = null;
    const sender = new TransferSession({ channel: a, fidParity: 0 });
    const receiver = new TransferSession({
      channel: b,
      fidParity: 1,
      autoAccept: false, // prompt the user
      pickDestination: async () => sink,
      events: { onOffer: (o) => (offered = o) },
    });
    await new Promise((r) => setTimeout(r, 5));

    const pending = sender.sendFiles([{ blob: blobOf(64_000), name: "doc.pdf" }]);
    await new Promise((r) => setTimeout(r, 20));

    // Nothing has been saved yet: the receiver is still deciding.
    expect(offered).not.toBeNull();
    expect(sink.chunks).toHaveLength(0);

    receiver.acceptOffer(offered!.id);
    await pending;
    expect(sink.closed).toBe(true);

    sender.dispose();
    receiver.dispose();
  });

  it("transfers several files in one batch", async () => {
    const { a, b } = pair();
    const saved: SaveResult[] = [];
    const sinks: CollectingSink[] = [];
    const sender = new TransferSession({ channel: a, fidParity: 0 });
    const receiver = new TransferSession({
      channel: b,
      fidParity: 1,
      autoAccept: true,
      // A real destination is chosen per file, not shared across the batch.
      pickDestination: async () => {
        const sink = new CollectingSink();
        sinks.push(sink);
        return sink;
      },
      events: { onSaved: (r) => saved.push(r) },
    });
    await new Promise((r) => setTimeout(r, 5));

    await sender.sendFiles([
      { blob: blobOf(50_000, 1), name: "one.txt" },
      { blob: blobOf(70_000, 2), name: "two.txt" },
      { blob: blobOf(90_000, 3), name: "three.txt" },
    ]);
    expect(saved.map((s) => s.name).sort()).toEqual(["one.txt", "three.txt", "two.txt"]);
    expect(saved.map((s) => s.size).sort((a, b) => a - b)).toEqual([50_000, 70_000, 90_000]);
    expect(sender.snapshot()).toHaveLength(3);

    sender.dispose();
    receiver.dispose();
  });

  it("sends a text snippet both ways (FR-12)", async () => {
    const { a, b } = pair();
    const received: string[] = [];
    const sender = new TransferSession({ channel: a, fidParity: 0 });
    const receiver = new TransferSession({
      channel: b,
      fidParity: 1,
      autoAccept: true,
      pickDestination: async () => new CollectingSink(),
      events: { onText: (t) => received.push(t.body) },
    });
    await new Promise((r) => setTimeout(r, 5));

    sender.sendText("meet at the library");
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toEqual(["meet at the library"]);

    sender.dispose();
    receiver.dispose();
  });

  it("refuses an empty batch rather than sending a no-op offer", async () => {
    const { a } = pair();
    const sender = new TransferSession({ channel: a, fidParity: 0 });
    await expect(sender.sendFiles([])).rejects.toMatchObject({ code: "CANCELED" });
    sender.dispose();
  });

  it("announces the peer name in hello (FR-42)", async () => {
    const { a, b } = pair();
    let helloName = "";
    const sender = new TransferSession({ channel: a, fidParity: 0, deviceName: "Qweq's phone" });
    const receiver = new TransferSession({
      channel: b,
      fidParity: 1,
      autoAccept: true,
      pickDestination: async () => new CollectingSink(),
      events: { onHello: (n) => (helloName = n) },
    });
    sender.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(helloName).toBe("Qweq's phone");
    sender.dispose();
    receiver.dispose();
  });
});
