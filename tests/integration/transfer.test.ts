import { afterEach, describe, expect, it } from "vitest";
import { DropbeamError } from "../../src/core/errors";
import type { SaveResult } from "../../src/core/storage/sink";
import { MemoryChannel, waitFor, type MemoryChannelOptions } from "../helpers/memory-channel";
import { Sender } from "../../src/core/transfer/sender";
import { Receiver, type IncomingOffer } from "../../src/core/transfer/receiver";
import type { FilePhase } from "../../src/core/transfer/phase";

type Harness = {
  txChannel: MemoryChannel;
  rxChannel: MemoryChannel;
  sender: Sender;
  receiver: Receiver;
  saved: { fid: number; result: SaveResult }[];
  offers: IncomingOffer[];
  errors: { fid: number | null; code: string }[];
  rxPhases: Map<number, FilePhase>;
  txPhases: Map<number, FilePhase>;
  texts: string[];
};

const openHarnesses: Harness[] = [];

function makeHarness(
  opts: {
    channel?: MemoryChannelOptions;
    autoAccept?: boolean;
    heartbeat?: boolean;
    pingIntervalMs?: number;
    pongTimeoutMs?: number;
  } = {},
): Harness {
  const [txChannel, rxChannel] = MemoryChannel.pair(opts.channel ?? {});
  const h: Harness = {
    txChannel,
    rxChannel,
    sender: null as unknown as Sender,
    receiver: null as unknown as Receiver,
    saved: [],
    offers: [],
    errors: [],
    rxPhases: new Map(),
    txPhases: new Map(),
    texts: [],
  };
  h.receiver = new Receiver(
    rxChannel,
    {
      onOffer: (offer) => h.offers.push(offer),
      onSaved: (fid, result) => h.saved.push({ fid, result }),
      onError: (fid, code) => h.errors.push({ fid, code }),
      onPhase: (fid, phase) => h.rxPhases.set(fid, phase),
      onText: (t) => h.texts.push(t.body),
    },
    {
      autoAccept: opts.autoAccept ?? true,
      heartbeat: opts.heartbeat ?? false,
      ...(opts.pingIntervalMs !== undefined ? { pingIntervalMs: opts.pingIntervalMs } : {}),
      ...(opts.pongTimeoutMs !== undefined ? { pongTimeoutMs: opts.pongTimeoutMs } : {}),
    },
  );
  h.sender = new Sender(
    txChannel,
    {
      onPhase: (fid, phase) => h.txPhases.set(fid, phase),
      onError: (fid, code) => h.errors.push({ fid, code }),
    },
    0,
  );
  openHarnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of openHarnesses.splice(0)) {
    h.sender.dispose();
    h.receiver.dispose();
    h.txChannel.dispose();
    h.rxChannel.dispose();
  }
});

function blobOf(size: number, seed = 7): Blob {
  const bytes = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = x & 0xff;
  }
  return new Blob([bytes as BlobPart], { type: "application/octet-stream" });
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function expectRoundTrip(size: number): Promise<void> {
  const h = makeHarness();
  const blob = blobOf(size);
  const original = new Uint8Array(await blob.arrayBuffer());

  const done = h.sender.sendFiles([{ blob, name: `file-${size}.bin` }]);
  await waitFor(() => h.saved.length === 1, { label: "saved" });
  await done;

  const saved = h.saved[0]!;
  expect(saved.result.name).toBe(`file-${size}.bin`);
  expect(saved.result.size).toBe(size);
  const received = new Uint8Array(await saved.result.blob!.arrayBuffer());
  expect(received.byteLength).toBe(original.byteLength);
  // Independent check: hash of what arrived vs hash of what was sent.
  expect(await sha256Hex(received)).toBe(await sha256Hex(original));
  expect(h.txPhases.get(1)).toBe("DONE");
}

describe("loopback transfer (PRD 13.2 sizes)", () => {
  for (const size of [0, 1, 16383, 16384, 16385, 1024 * 1024 + 7, 5 * 1024 * 1024]) {
    it(`round-trips ${size} bytes with hash verification (FR-14, FR-17)`, async () => {
      await expectRoundTrip(size);
    });
  }

  it("round-trips a 50 MB file (NFR-2/NFR-3 smoke)", async () => {
    await expectRoundTrip(50 * 1024 * 1024);
  }, 180_000);
});

describe("multi-file and text", () => {
  it("sends several files in one action with per-file state (FR-10)", async () => {
    const h = makeHarness();
    const files = [blobOf(10), blobOf(16384), blobOf(0)];
    const done = h.sender.sendFiles([
      { blob: files[0]!, name: "a.txt", type: "text/plain" },
      { blob: files[1]!, name: "b.bin" },
      { blob: files[2]!, name: "empty.bin" },
    ]);
    await waitFor(() => h.saved.length === 3, { label: "3 saved" });
    const offer = await done;
    expect(offer.files.map((f) => f.name)).toEqual(["a.txt", "b.bin", "empty.bin"]);
    expect(h.saved.map((s) => s.result.size).sort((a, b) => a - b)).toEqual([0, 10, 16384]);
  });

  it("preserves relative paths for folder sends (FR-18)", async () => {
    const h = makeHarness({ autoAccept: false });
    const done = h.sender.sendFiles([
      { blob: blobOf(4), name: "notes.txt", path: "week1/notes.txt" },
      { blob: blobOf(4), name: "photo.jpg", path: "photos/photo.jpg" },
    ]);
    await waitFor(() => h.offers.length === 1, { label: "offer" });
    const offer = h.offers[0]!;
    expect(offer.files.map((f) => f.path)).toEqual(["week1/notes.txt", "photos/photo.jpg"]);
    await h.receiver.accept(offer.id);
    await waitFor(() => h.saved.length === 2, { label: "2 saved" });
    await done;
  });

  it("sends text to the receiver card (FR-12)", async () => {
    const h = makeHarness();
    h.sender.sendText("https://example.com/hello");
    await waitFor(() => h.texts.length === 1, { label: "text" });
    expect(h.texts[0]).toBe("https://example.com/hello");
  });
});

describe("prompt, decline and cancel (FR-13, FR-16)", () => {
  it("shows the incoming prompt and declines it", async () => {
    const h = makeHarness({ autoAccept: false });
    const done = h.sender.sendFiles([{ blob: blobOf(1024), name: "secret.pdf" }]);
    await waitFor(() => h.offers.length === 1, { label: "offer" });
    expect(h.offers[0]!.files[0]!.name).toBe("secret.pdf");
    expect(h.rxPhases.get(1)).toBeUndefined();

    h.receiver.decline(h.offers[0]!.id);
    await done;
    await waitFor(() => h.txPhases.get(1) === "DECLINED", { label: "declined" });
    expect(h.saved.length).toBe(0);
  });

  it("accepts only the chosen files (FR-13)", async () => {
    const h = makeHarness({ autoAccept: false });
    const done = h.sender.sendFiles([
      { blob: blobOf(64), name: "keep.txt" },
      { blob: blobOf(64), name: "skip.txt" },
    ]);
    await waitFor(() => h.offers.length === 1, { label: "offer" });
    const offer = h.offers[0]!;
    const keepFid = offer.files[0]!.fid;
    const skipFid = offer.files[1]!.fid;
    await h.receiver.accept(offer.id, [keepFid]);
    await waitFor(() => h.saved.length === 1, { label: "one saved" });
    await done;
    expect(h.saved[0]!.fid).toBe(keepFid);
    expect(h.txPhases.get(skipFid)).toBe("DECLINED");
  });

  it("receiver cancels mid-transfer (FR-16)", async () => {
    const h = makeHarness({ channel: { drainPerTick: 16 * 1024, tickMs: 5 } });
    const done = h.sender.sendFiles([{ blob: blobOf(4 * 1024 * 1024), name: "big.bin" }]);
    await waitFor(() => h.rxPhases.get(1) === "TRANSFERRING", { label: "transferring" });
    await new Promise((r) => setTimeout(r, 30));
    h.receiver.cancel(1);
    await waitFor(() => h.rxPhases.get(1) === "CANCELED", { label: "canceled" });
    await done.catch(() => undefined);
    expect(h.saved.length).toBe(0);
  });

  it("sender cancels mid-transfer (FR-16)", async () => {
    const h = makeHarness({ channel: { drainPerTick: 16 * 1024, tickMs: 5 } });
    const done = h.sender.sendFiles([{ blob: blobOf(4 * 1024 * 1024), name: "big.bin" }]);
    await waitFor(() => h.rxPhases.get(1) === "TRANSFERRING", { label: "transferring" });
    await new Promise((r) => setTimeout(r, 30));
    h.sender.cancel(1);
    await waitFor(() => h.txPhases.get(1) === "CANCELED", { label: "tx canceled" });
    await done.catch(() => undefined);
    expect(h.saved.length).toBe(0);
  });
});

describe("integrity failures (FR-17, PRD 12)", () => {
  it("detects a corrupted chunk and discards the partial file", async () => {
    let corrupted = false;
    const h = makeHarness({
      channel: {
        interceptOutgoing: (data) => {
          if (corrupted || typeof data === "string") return;
          const bytes =
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : new Uint8Array(
                  (data as Uint8Array).buffer,
                  (data as Uint8Array).byteOffset,
                  (data as Uint8Array).byteLength,
                );
          if (bytes[0] === 0x01 && bytes.byteLength > 20) {
            bytes[20] = (bytes[20]! ^ 0xff) & 0xff;
            corrupted = true;
          }
        },
      },
    });

    const done = h.sender.sendFiles([{ blob: blobOf(64 * 1024), name: "tampered.bin" }]);
    await expect(done).rejects.toBeInstanceOf(DropbeamError);
    await waitFor(() => h.rxPhases.get(1) === "FAILED", { label: "failed" });
    expect(h.errors.some((e) => e.code === "HASH_MISMATCH")).toBe(true);
    expect(h.saved.length).toBe(0);
  });

  it("aborts with SEQ_GAP when a frame goes missing", async () => {
    let dropped = false;
    const h = makeHarness({
      channel: {
        dropOutgoing: (data) => {
          if (dropped || typeof data === "string") return false;
          if (data instanceof ArrayBuffer && new Uint8Array(data)[0] === 0x01) {
            dropped = true;
            return true;
          }
          return false;
        },
      },
    });

    const done = h.sender.sendFiles([{ blob: blobOf(128 * 1024), name: "gap.bin" }]);
    await waitFor(() => h.rxPhases.get(1) === "FAILED", { label: "seq gap" });
    expect(h.errors.some((e) => e.code === "SEQ_GAP")).toBe(true);
    expect(h.saved.length).toBe(0);
    await done.catch(() => undefined);
  });
});

describe("heartbeat (PRD 8.4)", () => {
  it("reports PEER_LOST after the pong timeout", async () => {
    const h = makeHarness({ heartbeat: true, pingIntervalMs: 10, pongTimeoutMs: 40 });
    await waitFor(() => h.errors.some((e) => e.code === "PEER_LOST"), {
      label: "peer lost",
      timeoutMs: 2000,
    });
  });
});
