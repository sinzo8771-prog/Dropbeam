import { afterEach, describe, expect, it } from "vitest";
import { MemoryChannel, waitFor, type MemoryChannelOptions } from "../helpers/memory-channel";
import { TransferSession, type FileProgress } from "../../src/core/transfer/transfer-session";
import { ResumeStore } from "../../src/core/transfer/resume-store";
import { CHUNK_SIZE, decodeControl, encodeControl } from "../../src/core/transfer/protocol";
import type { SaveResult, Sink, SinkKind, SinkMeta } from "../../src/core/storage/sink";

/**
 * Resumable transfers (roadmap): the channel dies mid-transfer and the
 * next session continues from where it stopped.
 *
 * The pairing itself is redone by the user — Dropbeam has no server, so
 * there is nothing to auto-reconnect *through*. What this proves is the
 * part that does not need one: both sides park what they had, the receiver
 * re-announces its partial, the sender re-offers the same file from that
 * offset, and only the missing chunks cross the wire.
 *
 * jsdom has no OPFS, so the receiver's sink is a staging disk that behaves
 * like one: bytes persist across sink instances (the whole point) and the
 * writes are positioned.
 */

const opened: { dispose(): void }[] = [];

afterEach(() => {
  for (const item of opened.splice(0)) item.dispose();
});

/** An OPFS-like staging disk: bytes survive the sink that wrote them. */
function fakeDisk(kind: SinkKind = "opfs") {
  const bytes: number[] = [];
  const makeSink = (startOffset = 0): Sink => {
    let position = startOffset;
    return {
      kind,
      async open(_meta: SinkMeta) {
        position = startOffset;
      },
      async write(chunk: Uint8Array) {
        while (bytes.length < position) bytes.push(0);
        for (let i = 0; i < chunk.byteLength; i++) bytes[position + i] = chunk[i]!;
        position += chunk.byteLength;
      },
      async close(): Promise<SaveResult> {
        return {
          name: "part",
          size: position,
          sink: kind,
          blob: new Blob([new Uint8Array(bytes) as BlobPart]),
        };
      },
      async abort() {
        // Staging bytes are dropped, like `OpfsSink.abort`.
        bytes.length = 0;
      },
      async readPrefix(count: number) {
        return new Uint8Array(bytes.slice(0, count));
      },
    };
  };
  return {
    bytes,
    kind,
    create: (_meta: SinkMeta) => makeSink(0),
    resume: (_meta: SinkMeta, offset: number) => makeSink(offset),
  };
}

function blobOf(size: number, seed = 7): Blob {
  const out = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return new Blob([out as BlobPart], { type: "application/octet-stream" });
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Side = {
  session: TransferSession;
  channel: MemoryChannel;
  saved: SaveResult[];
  offers: { id: string; files: { fid: number; name: string; chunks?: number }[] }[];
  progress: FileProgress[];
};

/** One store per side: sender and receiver live in different tabs. */
function newStores(): { host: ResumeStore; guest: ResumeStore } {
  return { host: new ResumeStore(), guest: new ResumeStore() };
}

/**
 * A host (sender) and guest (receiver) over one in-memory channel pair,
 * each with its own resume store and a shared staging disk. `guestAutoAccept`
 * mirrors the app's prompt: turn it off to prove a resumed file never
 * re-prompts.
 */
function makePair(
  stores: { host: ResumeStore; guest: ResumeStore },
  disk: ReturnType<typeof fakeDisk>,
  channelOpts: MemoryChannelOptions = {},
  guestAutoAccept = true,
) {
  const [hostCh, guestCh] = MemoryChannel.pair(channelOpts);
  const sides: Record<"host" | "guest", Side> = {
    host: {
      session: null as unknown as TransferSession,
      channel: hostCh,
      saved: [],
      offers: [],
      progress: [],
    },
    guest: {
      session: null as unknown as TransferSession,
      channel: guestCh,
      saved: [],
      offers: [],
      progress: [],
    },
  };
  for (const [role, side] of Object.entries(sides) as ["host" | "guest", Side][]) {
    side.session = new TransferSession({
      channel: side.channel,
      // Opposite fid parities, so {fid} control messages never collide.
      fidParity: role === "host" ? 1 : 0,
      autoAccept: role === "guest" ? guestAutoAccept : false,
      store: stores[role],
      createSink: (meta) => disk.create(meta),
      resumeSink: (meta, offset) => disk.resume(meta, offset),
      events: {
        onSaved: (result) => side.saved.push(result),
        onOffer: (offer) => side.offers.push(offer),
        onProgress: (file) => side.progress.push(file),
      },
    });
  }
  sides.host.session.start();
  sides.guest.session.start();
  opened.push(sides.host.session, sides.guest.session, sides.host.channel, sides.guest.channel);
  return sides;
}

function teardown(sides: ReturnType<typeof makePair>): void {
  sides.host.session.dispose();
  sides.guest.session.dispose();
  sides.host.channel.dispose();
  sides.guest.channel.dispose();
}

/** A three-chunk file minus a few bytes, so a resume has somewhere to stop. */
const NAME = "movie.bin";
const SIZE = CHUNK_SIZE * 3 - 5;

describe("resumable transfers (roadmap: chunk offset + re-park)", () => {
  it("continues a dropped transfer from the parked offset, re-sending only the tail", async () => {
    const stores = newStores();
    const disk = fakeDisk();
    const blob = blobOf(SIZE);
    const original = new Uint8Array(await blob.arrayBuffer());

    // Attempt 1: the network forwards two chunks and then stops.
    const first = makePair(stores, disk, { stallDataFramesAfter: 2 });
    first.host.session
      .sendFiles([{ blob, name: NAME, type: "application/octet-stream" }])
      .catch(() => undefined); // the dropped channel never confirms the send
    await waitFor(() => disk.bytes.length >= CHUNK_SIZE * 2, { label: "two chunks staged" });
    first.host.channel.close();
    teardown(first);

    // Each side parked what it had, keyed by name and size.
    expect(stores.guest.inboundCount).toBe(1);
    expect(stores.host.outboundCount).toBe(1);
    expect(stores.guest.inboundFor(NAME, SIZE)?.chunks).toBe(2);
    expect(disk.bytes.length).toBe(CHUNK_SIZE * 2);

    // Attempt 2: the guest re-announces its partial, the host re-offers it.
    // The prompt stays *on* here — a resumed file must not ask again.
    let framesSent = 0;
    const second = makePair(
      stores,
      disk,
      {
        interceptOutgoing: (data) => {
          if (typeof data !== "string") framesSent += 1;
        },
      },
      false,
    );

    // No prompt: the receiver approved this file once, before the drop.
    expect(second.guest.offers).toEqual([]);

    await waitFor(() => second.guest.saved.length === 1, {
      label: "resumed save",
      timeoutMs: 15_000,
    });

    // The file is whole and byte-identical — including the prefix that
    // never crossed the wire on attempt 2.
    const saved = new Uint8Array(await second.guest.saved[0]!.blob!.arrayBuffer());
    expect(saved.byteLength).toBe(SIZE);
    expect(await sha256Hex(saved)).toBe(await sha256Hex(original));
    // Hash verification passing at all proves both sides hashed the same
    // bytes: the sender seeded its hasher with the prefix it skipped.
    expect(second.guest.saved[0]!.sink).toBe("opfs");

    // Exactly the missing tail was re-sent (one chunk), not the whole file.
    expect(framesSent).toBe(1);

    // The receiver's row continued rather than restarting from zero.
    const last = second.guest.progress[second.guest.progress.length - 1]!;
    expect(last.done).toBe(SIZE);

    // Parked state is consumed: a third attempt would not resume.
    expect(stores.guest.inboundCount).toBe(0);
    expect(stores.host.outboundCount).toBe(0);
    teardown(second);
  }, 30_000);

  it("does not resume into a memory sink: the receiver prompts and the file starts over", async () => {
    const stores = newStores();
    // A memory sink's bytes die with the page, so nothing may be parked.
    const disk = fakeDisk("memory");
    const blob = blobOf(SIZE);
    const original = new Uint8Array(await blob.arrayBuffer());

    const first = makePair(stores, disk, { stallDataFramesAfter: 2 });
    first.host.session.sendFiles([{ blob, name: NAME }]).catch(() => undefined);
    await waitFor(() => disk.bytes.length >= CHUNK_SIZE * 2, { label: "two chunks staged" });
    first.host.channel.close();
    teardown(first);

    // Only the sender parks: the receiver's staged bytes are not resumable.
    expect(stores.guest.inboundCount).toBe(0);
    expect(stores.host.outboundCount).toBe(1);

    // Re-paired with the prompt on: nothing is announced, so this is a new
    // file as far as FR-13 is concerned — the user must approve it.
    const second = makePair(stores, disk, {}, false);
    second.host.session.sendFiles([{ blob, name: NAME }]).catch(() => undefined);
    await waitFor(() => second.guest.offers.length === 1, { label: "fresh prompt" });
    expect(second.guest.saved).toEqual([]);
    expect(second.guest.offers[0]!.files[0]!.chunks).toBeUndefined();

    await second.guest.session.acceptOffer(second.guest.offers[0]!.id);
    await waitFor(() => second.guest.saved.length === 1, { label: "whole re-send" });

    const saved = new Uint8Array(await second.guest.saved[0]!.blob!.arrayBuffer());
    expect(saved.byteLength).toBe(SIZE);
    expect(await sha256Hex(saved)).toBe(await sha256Hex(original));
    teardown(second);
  }, 30_000);

  it("leaves nothing parked after a transfer completes cleanly", async () => {
    const stores = newStores();
    const disk = fakeDisk();
    const sides = makePair(stores, disk);
    const done = sides.host.session.sendFiles([{ blob: blobOf(CHUNK_SIZE), name: "done.bin" }]);
    await waitFor(() => sides.guest.saved.length === 1, { label: "saved" });
    await done;
    teardown(sides);
    expect(stores.host.hasPending).toBe(false);
    expect(stores.guest.hasPending).toBe(false);
  }, 30_000);
});

describe("resume protocol messages", () => {
  const parked = { fid: 3, name: "a.bin", size: CHUNK_SIZE * 2, chunks: 1 };

  it("round-trips a resume announcement", () => {
    const msg = decodeControl(encodeControl({ k: "resume", files: [parked] }));
    expect(msg).toEqual({ k: "resume", files: [parked] });
  });

  it("drops an announcement whose chunks lie past the end of the file", () => {
    const msg = decodeControl(
      encodeControl({ k: "resume", files: [parked, { ...parked, chunks: 99 }] }),
    );
    expect(msg).toEqual({ k: "resume", files: [parked] });
  });

  it("drops a resume announcement that is not a list", () => {
    expect(decodeControl('{"k":"resume","files":{"chunks":1}}')).toBeNull();
  });

  it("bounds an offer's resume point by the file size", () => {
    const file = {
      fid: 1,
      name: "a.bin",
      size: CHUNK_SIZE * 2,
      type: "application/octet-stream",
    };
    const ok = decodeControl(
      encodeControl({
        k: "offer",
        id: "x",
        totalSize: CHUNK_SIZE * 2,
        files: [{ ...file, chunks: 1 }],
      }),
    );
    expect(ok && ok.k === "offer" && ok.files[0]?.chunks).toBe(1);
    // One chunk past the end would place the sink's first write beyond EOF.
    const bad = decodeControl(
      encodeControl({
        k: "offer",
        id: "x",
        totalSize: CHUNK_SIZE * 2,
        files: [{ ...file, chunks: 5 }],
      }),
    );
    expect(bad).toBeNull();
  });
});

describe("ResumeStore", () => {
  it("keys partials by name and size, and only keeps disk-backed ones", () => {
    const store = new ResumeStore();
    store.parkInbound({
      fid: 3,
      name: "a.bin",
      size: 10,
      chunks: 1,
      sink: "opfs",
    });
    store.parkInbound({
      fid: 4,
      name: "b.bin",
      size: 10,
      chunks: 1,
      sink: "memory",
    });
    expect(store.inboundCount).toBe(1);
    expect(store.inboundFor("a.bin", 10)?.chunks).toBe(1);
    expect(store.inboundFor("b.bin", 10)).toBeUndefined();
    // Same name at a different size is a different file.
    expect(store.inboundFor("a.bin", 11)).toBeUndefined();
  });

  it("ignores a partial with no whole chunk yet", () => {
    const store = new ResumeStore();
    store.parkInbound({
      fid: 1,
      name: "a.bin",
      size: 10,
      chunks: 0,
      sink: "opfs",
    });
    expect(store.inboundCount).toBe(0);
    expect(store.hasPending).toBe(false);
  });

  it("returns entries on take so the staged bytes can be deleted", () => {
    const store = new ResumeStore();
    store.parkInbound({
      fid: 1,
      name: "a.bin",
      size: 4,
      chunks: 1,
      sink: "opfs",
    });
    expect(store.takeInbound("a.bin", 4)?.fid).toBe(1);
    expect(store.takeInbound("a.bin", 4)).toBeUndefined();
    expect(store.hasPending).toBe(false);
  });

  it("parks and releases outbound blobs independently of inbound", () => {
    const store = new ResumeStore();
    store.parkOutbound({
      name: "a.bin",
      size: 9,
      type: "application/octet-stream",
      blob: blobOf(9),
    });
    expect(store.outboundCount).toBe(1);
    expect(store.outboundFor("a.bin", 9)?.blob.size).toBe(9);
    expect(store.takeOutbound("a.bin", 9)?.size).toBe(9);
    expect(store.outboundCount).toBe(0);
  });
});
