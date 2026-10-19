import { afterEach, describe, expect, it } from "vitest";
import { Receiver } from "../../src/core/transfer/receiver";
import { Sender } from "../../src/core/transfer/sender";
import { CHUNK_SIZE, FRAME_HEADER_SIZE } from "../../src/core/transfer/protocol";
import type { ChannelLike, ChannelState } from "../../src/core/transfer/channel";
import type { SaveResult, Sink, SinkMeta } from "../../src/core/storage/sink";

/**
 * NFR-4: "streaming sinks keep heap under 150 MB regardless of file size".
 *
 * The requirement is about the *transfer*, not about the file: a 2 GB file must
 * not need 2 GB of memory to cross the wire, so the sender has to read the
 * blob in chunks and the receiver has to hand each chunk to a sink and forget
 * it. Two things are checked, because either could break on its own:
 *
 * 1. **Structurally** - every frame on the wire carries at most one chunk's
 *    worth of payload, so the file is streamed rather than buffered. This is
 *    exact, and it is the property that actually matters.
 * 2. **Measured** - the heap does not grow with the file. Four times the file
 *    must not cost four times the memory, and the PRD's ceiling is 150 MB
 *    whatever the file's size.
 *
 * The channel here deliberately does *not* keep the frames it delivers, and the
 * sink deliberately throws the bytes away. The stock test channel keeps every
 * frame in an inbox, which would make the heap grow with the file for reasons
 * that have nothing to do with the app.
 */

/** A channel that hands each frame straight over and keeps nothing. */
class DrainChannel {
  readonly label = "dropbeam";
  readyState: ChannelState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = "arraybuffer";
  peer!: DrainChannel;
  /** The sizes of the binary frames that went over the wire. */
  readonly frameSizes: number[] = [];

  private readonly listeners = new Map<string, Set<(ev: Event) => void>>();

  addEventListener(type: string, listener: (ev: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (ev: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = "closed";
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof data === "string") {
      queueMicrotask(() => this.peer.deliver(data));
      return;
    }
    const view =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.frameSizes.push(view.byteLength);
    const copy = view.slice();
    queueMicrotask(() => this.peer.deliver(copy.buffer));
  }

  private deliver(payload: string | ArrayBuffer): void {
    const ev = { data: payload } as unknown as MessageEvent;
    for (const listener of [...(this.listeners.get("message") ?? [])]) {
      (listener as (e: unknown) => void)(ev);
    }
  }
}

/** A sink that counts the bytes and forgets them: the streaming case. */
function discardingSink(): (meta: SinkMeta) => Promise<Sink> {
  return async () => {
    let written = 0;
    return {
      kind: "memory" as const,
      open: async () => {},
      write: async (chunk: Uint8Array) => {
        written += chunk.byteLength;
      },
      close: async (): Promise<SaveResult> => ({ name: "file.bin", size: written, sink: "memory" }),
      abort: async () => {},
    };
  };
}

const open: { sender: Sender; receiver: Receiver }[] = [];

afterEach(() => {
  for (const h of open.splice(0)) {
    h.sender.dispose();
    h.receiver.dispose();
  }
});

/** A sender and a receiver joined by a channel that keeps nothing. */
function harness(): {
  sender: Sender;
  receiver: Receiver;
  channel: DrainChannel;
} {
  const a = new DrainChannel();
  const b = new DrainChannel();
  a.peer = b;
  b.peer = a;
  const receiver = new Receiver(
    b as unknown as ChannelLike,
    {
      onSaved: () => {},
      onError: () => {},
    },
    { autoAccept: true, createSink: discardingSink() },
  );
  const sender = new Sender(a as unknown as ChannelLike, { onPhase: () => {}, onError: () => {} }, 0);
  open.push({ sender, receiver });
  return { sender, receiver, channel: a };
}

/** A file of `size` bytes, built from one block so the heap never holds it all. */
function bigBlob(size: number): Blob {
  const block = new Uint8Array(1024 * 1024);
  for (let i = 0; i < block.length; i++) block[i] = (i * 31 + 7) & 0xff;
  const parts: BlobPart[] = [];
  for (let done = 0; done < size; done += block.length) {
    parts.push(block.slice());
  }
  return new Blob(parts, { type: "application/octet-stream" });
}

/** Send a file and wait for the whole transfer to finish. */
async function transfer(h: ReturnType<typeof harness>, blob: Blob): Promise<void> {
  // The receiver auto-accepts, so the offer is handled inside it; the promise
  // resolves once every file has been sent and verified.
  await h.sender.sendFiles([{ blob, name: "big.bin" }]);
}

describe("the transfer's memory (NFR-4)", () => {
  it("puts one chunk at a time on the wire, whatever the file's size", async () => {
    const size = 4 * 1024 * 1024;
    const h = harness();
    await transfer(h, bigBlob(size));

    const dataFrames = h.channel.frameSizes.filter((frame) => frame > 0);
    // The file really crossed the wire, in as many frames as it has chunks -
    // otherwise the assertions below would be about nothing.
    expect(dataFrames.length).toBe(Math.ceil(size / CHUNK_SIZE));
    for (const frame of dataFrames) {
      // A frame is a chunk of payload plus its nine-byte header. A frame that
      // carried the whole file would be the bug this test is here to catch.
      expect(frame).toBeLessThanOrEqual(CHUNK_SIZE + FRAME_HEADER_SIZE);
    }
  });

  it("does not grow the heap with the file", async () => {
    const measure = async (size: number): Promise<number> => {
      const h = harness();
      const blob = bigBlob(size);
      // Let the garbage from building the blob settle before the baseline.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const before = process.memoryUsage().heapUsed;
      let peak = before;
      const sampler = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().heapUsed);
      }, 5);
      try {
        await transfer(h, blob);
      } finally {
        clearInterval(sampler);
        peak = Math.max(peak, process.memoryUsage().heapUsed);
      }
      return peak - before;
    };

    const small = await measure(8 * 1024 * 1024);
    const large = await measure(32 * 1024 * 1024);

    // The PRD's ceiling, whatever the file's size.
    expect(large, `the heap grew by ${large} bytes for a 32 MB file`).toBeLessThan(
      150 * 1024 * 1024,
    );
    // And the size of the file must not be what decides the memory: four times
    // the file, not four times the memory.
    expect(
      large - small,
      `8 MB grew the heap by ${small} bytes, 32 MB by ${large}`,
    ).toBeLessThan(16 * 1024 * 1024);
  }, 120_000);
});
