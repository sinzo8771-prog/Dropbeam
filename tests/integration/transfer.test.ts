import { afterEach, describe, expect, it } from "vitest";
import { DropbeamError } from "../../src/core/errors";
import { MemorySink } from "../../src/core/storage/memory-sink";
import { MEMORY_SINK_CAP } from "../../src/core/storage/limits";
import { OpfsSink } from "../../src/core/storage/opfs-sink";
import { SinkError, type SaveResult, type Sink, type SinkMeta } from "../../src/core/storage/sink";
import { MemoryChannel, waitFor, type MemoryChannelOptions } from "../helpers/memory-channel";
import { Sender } from "../../src/core/transfer/sender";
import { Receiver, type IncomingOffer } from "../../src/core/transfer/receiver";
import { encodeControl } from "../../src/core/transfer/protocol";
import { ResumeStore } from "../../src/core/transfer/resume-store";
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
    pcState?: () => RTCPeerConnectionState | undefined;
    createSink?: (meta: SinkMeta) => Sink | Promise<Sink>;
    resumeSink?: (meta: SinkMeta, resumeFromBytes: number) => Sink | Promise<Sink>;
    store?: ResumeStore;
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
      ...(opts.pcState !== undefined ? { pcState: opts.pcState } : {}),
      ...(opts.createSink !== undefined ? { createSink: opts.createSink } : {}),
      ...(opts.resumeSink !== undefined ? { resumeSink: opts.resumeSink } : {}),
      ...(opts.store !== undefined ? { store: opts.store } : {}),
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

/**
 * A sink that stages bytes but cannot read them back or rewrite them — the
 * exact capability gap per-chunk repair (PRD 19) checks for before it starts
 * the handshake.
 */
function nonRandomAccessSink(): (meta: SinkMeta) => Promise<Sink> {
  return async () => {
    const inner = new MemorySink();
    return {
      kind: "memory" as const,
      open: (m: SinkMeta) => inner.open(m),
      write: (chunk: Uint8Array) => inner.write(chunk),
      close: () => inner.close(),
      abort: () => inner.abort(),
    };
  };
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
  it("repairs every corrupted chunk instead of discarding the file (PRD 19)", async () => {
    // Every original chunk is tampered with in flight. PRD 19 rewrites all
    // of them and saves the file, so the FR-17 "discard the partial" outcome
    // is no longer what a corrupt-but-repairable transfer produces.
    let resending = false;
    const h = makeHarness({
      channel: {
        interceptOutgoing: (data) => {
          if (typeof data === "string") {
            // The receiver's `repair` request marks the switch from the
            // original send to re-sent chunks, which arrive untampered.
            if (data.includes('"k":"repair"')) resending = true;
            return;
          }
          if (resending) return;
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
          }
        },
      },
    });

    const blob = blobOf(64 * 1024);
    const original = new Uint8Array(await blob.arrayBuffer());

    const done = h.sender.sendFiles([{ blob, name: "tampered.bin" }]);
    await waitFor(() => h.saved.length === 1, { label: "repaired save" });
    await done;

    const received = new Uint8Array(await h.saved[0]!.result.blob!.arrayBuffer());
    expect(await sha256Hex(received)).toBe(await sha256Hex(original));
    expect(h.errors.length).toBe(0);
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

  it("holds off PEER_LOST while the connection is only 'disconnected' (recovering)", async () => {
    const h = makeHarness({
      heartbeat: true,
      pingIntervalMs: 10,
      // Grace is 2× the pong timeout while recovering; 200 ms covers the 150 ms
      // we wait below, so silence is expected mid-recovery.
      pongTimeoutMs: 100,
      pcState: () => "disconnected",
    });
    // Sit well past the pong timeout: silence is expected mid-recovery, so
    // the heartbeat must keep the session alive rather than drop it.
    await new Promise((r) => setTimeout(r, 150));
    expect(h.errors.some((e) => e.code === "PEER_LOST")).toBe(false);
  });

  it("gives up once the recovery grace elapses even while still 'disconnected'", async () => {
    const h = makeHarness({
      heartbeat: true,
      pingIntervalMs: 10,
      // 2× grace = 40 ms; past that the link is treated as lost regardless.
      pongTimeoutMs: 20,
      pcState: () => "disconnected",
    });
    await waitFor(() => h.errors.some((e) => e.code === "PEER_LOST"), {
      label: "grace-capped peer lost",
      timeoutMs: 2000,
    });
  });

  it.each(["failed", "closed"] as const)(
    "declares PEER_LOST at the pong timeout when the connection is '%s' (no grace)",
    async (state) => {
      const h = makeHarness({
        heartbeat: true,
        pingIntervalMs: 10,
        // No grace for failed/closed: only the plain pong timeout applies, so a
        // 2× window would keep the session alive past our wait if it were
        // wrongly granted — proving it is not.
        pongTimeoutMs: 30,
        pcState: () => state,
      });
      await waitFor(() => h.errors.some((e) => e.code === "PEER_LOST"), {
        label: `${state} peer lost`,
        timeoutMs: 2000,
      });
    },
  );
});

describe("per-chunk repair (PRD 19)", () => {
  /** Counts every `repair` request the receiver sends for a fid. */
  function countingCorruption(channel: MemoryChannelOptions): {
    opts: MemoryChannelOptions;
    repairs: number[];
  } {
    const repairs: number[] = [];
    const opts: MemoryChannelOptions = {
      ...channel,
      interceptOutgoing: (data, from) => {
        channel.interceptOutgoing?.(data, from);
        if (typeof data !== "string") return;
        let msg: { k?: string; fid?: number; indices?: number[] };
        try {
          msg = JSON.parse(data) as typeof msg;
        } catch {
          return;
        }
        if (msg.k === "repair" && typeof msg.fid === "number") repairs.push(msg.fid);
      },
    };
    return { opts, repairs };
  }

  it("repairs a corrupted chunk and saves the intact file", async () => {
    let corrupted = false;
    const { opts, repairs } = countingCorruption({
      interceptOutgoing: (data) => {
        if (corrupted || typeof data === "string") return;
        const view =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(
                (data as Uint8Array).buffer,
                (data as Uint8Array).byteOffset,
                (data as Uint8Array).byteLength,
              );
        if (view[0] === 0x01 && view.byteLength > 20) {
          view[20] = (view[20]! ^ 0xff) & 0xff;
          corrupted = true;
        }
      },
    });
    const h = makeHarness({ channel: opts });
    const blob = blobOf(64 * 1024);
    const original = new Uint8Array(await blob.arrayBuffer());

    const done = h.sender.sendFiles([{ blob, name: "repairable.bin" }]);
    await waitFor(() => h.saved.length === 1, { label: "repaired save" });
    await done;

    const received = new Uint8Array(await h.saved[0]!.result.blob!.arrayBuffer());
    expect(await sha256Hex(received)).toBe(await sha256Hex(original));
    expect(h.txPhases.get(1)).toBe("DONE");
    // Single pass: exactly one `repair` request for the file.
    expect(repairs).toEqual([1]);
  });

  it("repairs a memory-staged file too (capability gate, not sink kind)", async () => {
    let corrupted = false;
    const { opts, repairs } = countingCorruption({
      interceptOutgoing: (data) => {
        if (corrupted || typeof data === "string") return;
        const view =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(
                (data as Uint8Array).buffer,
                (data as Uint8Array).byteOffset,
                (data as Uint8Array).byteLength,
              );
        if (view[0] === 0x01 && view.byteLength > 20) {
          view[20] = (view[20]! ^ 0xff) & 0xff;
          corrupted = true;
        }
      },
    });
    // PRD FR-17 gates repair on the sink's methods, not its kind, and
    // MemorySink implements both — so a memory-staged file is repaired.
    const h = makeHarness({ channel: opts, createSink: async () => new MemorySink() });
    const blob = blobOf(64 * 1024);
    const original = new Uint8Array(await blob.arrayBuffer());

    const done = h.sender.sendFiles([{ blob, name: "memory-repair.bin" }]);
    await waitFor(() => h.saved.length === 1, { label: "memory repaired save" });
    await done;

    const received = new Uint8Array(await h.saved[0]!.result.blob!.arrayBuffer());
    expect(await sha256Hex(received)).toBe(await sha256Hex(original));
    expect(repairs).toEqual([1]);
  });

  it("requests the bad indices exactly once", async () => {
    let corrupted = false;
    const { opts, repairs } = countingCorruption({
      interceptOutgoing: (data) => {
        if (corrupted || typeof data === "string") return;
        const view =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(
                (data as Uint8Array).buffer,
                (data as Uint8Array).byteOffset,
                (data as Uint8Array).byteLength,
              );
        if (view[0] === 0x01 && view.byteLength > 20) {
          view[20] = (view[20]! ^ 0xff) & 0xff;
          corrupted = true;
        }
      },
    });
    const h = makeHarness({ channel: opts });
    await h.sender
      .sendFiles([{ blob: blobOf(64 * 1024), name: "once.bin" }])
      .catch(() => undefined);
    await waitFor(() => h.saved.length === 1 || h.errors.length > 0, {
      label: "settled",
    });
    expect(repairs.length).toBeLessThanOrEqual(1);
  });

  it("fails hard when the re-sent chunks are still corrupt (no retry loop)", async () => {
    let pass = 0;
    const h = makeHarness({
      channel: {
        interceptOutgoing: (data) => {
          if (typeof data === "string") return;
          const view =
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : new Uint8Array(
                  (data as Uint8Array).buffer,
                  (data as Uint8Array).byteOffset,
                  (data as Uint8Array).byteLength,
                );
          if (view[0] === 0x01 && view.byteLength > 20) {
            view[20] = (view[20]! ^ 0xff) & 0xff;
            pass += 1;
          }
        },
      },
    });

    const done = h.sender.sendFiles([{ blob: blobOf(64 * 1024), name: "hopeless.bin" }]);
    await expect(done).rejects.toBeInstanceOf(DropbeamError);
    await waitFor(() => h.rxPhases.get(1) === "FAILED", { label: "terminal fail" });
    expect(h.errors.some((e) => e.code === "HASH_MISMATCH")).toBe(true);
    expect(h.saved.length).toBe(0);
    // Every DATA frame is tampered with — the 4 original chunks and the 4
    // re-sent ones — so the second whole-file hash still disagrees.
    expect(pass).toBe(8);
  });

  it("stays terminal when the sink cannot read staged bytes back", async () => {
    let corrupted = false;
    const { opts, repairs } = countingCorruption({
      interceptOutgoing: (data) => {
        if (corrupted || typeof data === "string") return;
        const view =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(
                (data as Uint8Array).buffer,
                (data as Uint8Array).byteOffset,
                (data as Uint8Array).byteLength,
              );
        if (view[0] === 0x01 && view.byteLength > 20) {
          view[20] = (view[20]! ^ 0xff) & 0xff;
          corrupted = true;
        }
      },
    });
    const h = makeHarness({ channel: opts, createSink: nonRandomAccessSink() });
    const done = h.sender.sendFiles([{ blob: blobOf(64 * 1024), name: "noread.bin" }]);

    await expect(done).rejects.toBeInstanceOf(DropbeamError);
    await waitFor(() => h.rxPhases.get(1) === "FAILED", { label: "failed" });
    expect(h.errors.some((e) => e.code === "HASH_MISMATCH")).toBe(true);
    // A read-back-incapable sink never even asks for a plan.
    expect(repairs.length).toBe(0);
  });
});

describe("a sink that refuses the file (PRD 8.5, FR-31)", () => {
  /**
   * A sink that cannot be opened — the measured WebKit shape, where the OPFS
   * namespace exists so the sink is *selected*, and every `createWritable`
   * throws (docs/INTEROP.md). Reachability and writability are different
   * questions, and this is the second one failing.
   */
  function unwritableSink(code: "SINK_UNAVAILABLE" | "DISK_FULL") {
    const state = { aborted: false, writes: 0 };
    const sink: Sink = {
      kind: "opfs",
      open: async () => {
        throw new SinkError(code);
      },
      write: async () => {
        state.writes += 1;
        throw new SinkError(code);
      },
      close: async () => {
        throw new SinkError(code);
      },
      abort: async () => {
        state.aborted = true;
      },
    };
    return { sink, state };
  }

  /** An offer straight onto the wire, so a case needs no matching sender. */
  function sendOffer(
    h: Harness,
    file: { fid: number; name: string; size: number; chunks?: number },
  ): void {
    h.txChannel.send(
      encodeControl({
        k: "offer",
        id: "raw-offer",
        files: [{ type: "application/octet-stream", ...file }],
        totalSize: file.size,
      }),
    );
  }

  it("falls back to memory when the chosen sink cannot be opened", async () => {
    const refused = unwritableSink("DISK_FULL");
    const h = makeHarness({ createSink: () => refused.sink });
    const blob = blobOf(64 * 1024);
    const original = new Uint8Array(await blob.arrayBuffer());

    const done = h.sender.sendFiles([{ blob, name: "rescue.bin" }]);
    await waitFor(() => h.saved.length === 1, { label: "saved" });
    await done;

    // The file arrived whole, and the result says where it actually went.
    const saved = h.saved[0]!;
    expect(saved.result.sink).toBe("memory");
    expect(saved.result.size).toBe(original.byteLength);
    const received = new Uint8Array(await saved.result.blob!.arrayBuffer());
    expect(await sha256Hex(received)).toBe(await sha256Hex(original));
    expect(h.rxPhases.get(1)).toBe("DONE");
    expect(h.txPhases.get(1)).toBe("DONE");
    // A fallback is not a failure: nothing is reported on either side.
    expect(h.errors).toEqual([]);
    // The refused sink wrote nothing, and its staging file is gone.
    expect(refused.state.writes).toBe(0);
    expect(refused.state.aborted).toBe(true);
  });

  it("reports the sink's own reason when memory cannot take the file either", async () => {
    const refused = unwritableSink("DISK_FULL");
    const h = makeHarness({ createSink: () => refused.sink });

    // A file past the in-memory cap, declared in the offer: nothing has to be
    // sent for the receiver to refuse it, because MemorySink.open checks the
    // announced size (FR-31).
    sendOffer(h, { fid: 1, name: "huge.bin", size: MEMORY_SINK_CAP + 1 });

    await waitFor(() => h.errors.length === 1, { label: "reported" });
    // The disk's reason, not memory's: it is the informative one.
    expect(h.errors[0]).toMatchObject({ fid: 1, code: "DISK_FULL" });
    expect(h.rxPhases.get(1)).toBe("FAILED");
    expect(h.saved).toEqual([]);
  });

  it("survives the real OPFS sink refusing to write (the measured WebKit shape)", async () => {
    // The whole chain, with no double in place of the sink: the namespace
    // answers, `createWritable` throws `UnknownError` exactly as Playwright's
    // WebKit build does (docs/INTEROP.md), the sink's own mapping turns that
    // into DISK_FULL, and the file still arrives — in memory.
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      value: {
        ...(globalThis.navigator as object),
        storage: {
          getDirectory: async () => ({
            getDirectoryHandle: async () => ({
              getFileHandle: async () => ({
                createWritable: async () => {
                  throw new DOMException(
                    "the operation failed for an unknown reason",
                    "UnknownError",
                  );
                },
                remove: async () => {},
              }),
              removeEntry: async () => {},
            }),
          }),
        },
      },
      configurable: true,
      writable: true,
    });
    try {
      const h = makeHarness({ createSink: (meta) => OpfsSink.create(meta.name) });
      const blob = blobOf(48 * 1024);
      const original = new Uint8Array(await blob.arrayBuffer());

      const done = h.sender.sendFiles([{ blob, name: "webkit-shape.bin" }]);
      await waitFor(() => h.saved.length === 1, { label: "saved" });
      await done;

      const saved = h.saved[0]!;
      expect(saved.result.sink).toBe("memory");
      const received = new Uint8Array(await saved.result.blob!.arrayBuffer());
      expect(await sha256Hex(received)).toBe(await sha256Hex(original));
      expect(h.errors).toEqual([]);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("never restarts a resumed transfer into memory", async () => {
    const store = new ResumeStore();
    // A parked partial, whose prefix lives in the sink about to refuse again.
    store.parkInbound({ fid: 3, name: "half.bin", size: 16384, chunks: 1, sink: "opfs" });
    const h = makeHarness({
      store,
      resumeSink: async () => {
        throw new SinkError("SINK_UNAVAILABLE");
      },
    });

    // The peer re-offers the same file from chunk 1.
    sendOffer(h, { fid: 1, name: "half.bin", size: 16384, chunks: 1 });

    await waitFor(() => h.errors.length === 1, { label: "reported" });
    expect(h.errors[0]).toMatchObject({ fid: 1, code: "SINK_UNAVAILABLE" });
    expect(h.rxPhases.get(1)).toBe("FAILED");
    // Restarting the tail in RAM would have produced a file missing its head,
    // so memory is never a fallback here — and the partial is still parked for
    // a later session to resume properly.
    expect(h.saved).toEqual([]);
    expect(store.inboundFor("half.bin", 16384)).toBeTruthy();
  });

  it("does not quietly stage a cancelled pick in memory", async () => {
    // A dismissed save picker is the user's decision, not a storage failure,
    // so it is reported as cancelled rather than absorbed into RAM behind them.
    const h = makeHarness({
      createSink: async () => {
        throw new DropbeamError("CANCELED", "picker dismissed");
      },
    });

    sendOffer(h, { fid: 1, name: "chosen.bin", size: 4096 });

    await waitFor(() => h.errors.length === 1, { label: "reported" });
    expect(h.errors[0]).toMatchObject({ fid: 1, code: "CANCELED" });
    expect(h.rxPhases.get(1)).toBe("FAILED");
    expect(h.saved).toEqual([]);
  });
});
