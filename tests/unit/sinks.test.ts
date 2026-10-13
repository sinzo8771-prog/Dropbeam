import { describe, expect, it, vi } from "vitest";
import { FsaSink, isFsaSupported, mapWriteError } from "../../src/core/storage/fsa-sink";
import { OpfsSink, isOpfsSupported } from "../../src/core/storage/opfs-sink";
import { MemorySink } from "../../src/core/storage/memory-sink";
import { chooseSink, createSinkFor } from "../../src/core/storage/select-sink";
import { SinkError, type SinkMeta } from "../../src/core/storage/sink";

const META: SinkMeta = { name: "report.pdf", size: 6, type: "application/pdf" };
const PAYLOAD = new Uint8Array([1, 2, 3, 4, 5, 6]);

/** Whatever a `FileSystemWritableFileStream.write` call carries, as bytes. */
function toBytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array();
}

/**
 * A FileSystemWritableFileStream stand-in that models the real API: writes
 * are positioned (`{type:"write", position, data}`) or plain, and
 * `createWritable({keepExistingData})` decides whether the previous content
 * survives — which is what the OPFS resume path depends on.
 */
function fakeWritable() {
  const bytes: number[] = [];
  let cursor = 0;
  const writable = {
    write: async (write: unknown) => {
      const positioned =
        typeof write === "object" &&
        write !== null &&
        (write as { type?: string }).type === "write" &&
        typeof (write as { position?: number }).position === "number";
      const position = positioned ? (write as { position: number }).position : cursor;
      const raw = positioned ? (write as { data: unknown }).data : write;
      const data = toBytes(raw);
      while (bytes.length < position) bytes.push(0);
      for (let i = 0; i < data.byteLength; i++) bytes[position + i] = data[i]!;
      cursor = Math.max(cursor, position + data.byteLength);
    },
    close: async () => {
      state.closed = true;
    },
    abort: async () => {
      state.aborted = true;
    },
  };
  const handle = {
    createWritable: async (opts?: { keepExistingData?: boolean }) => {
      // A resumed stream continues from the end of the staged data.
      cursor = opts?.keepExistingData ? bytes.length : 0;
      if (!opts?.keepExistingData) bytes.length = 0;
      return writable;
    },
    getFile: async () => new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
    remove: async () => {
      bytes.length = 0;
    },
  };
  return { bytes, handle };
}

const state = { closed: false, aborted: false };

describe("FsaSink (PRD 8.5)", () => {
  it("streams chunks to disk and reports the saved size", async () => {
    const fake = fakeWritable();
    const sink = new FsaSink(fake.handle);
    await sink.open(META);
    await sink.write(PAYLOAD.subarray(0, 3));
    await sink.write(PAYLOAD.subarray(3));
    const result = await sink.close();
    expect(result).toEqual({ name: "report.pdf", size: 6, sink: "fsa" });
    // The byte stream on disk, not the chunk boundaries the sink was fed.
    expect(fake.bytes).toEqual([1, 2, 3, 4, 5, 6]);
    expect(state.closed).toBe(true);
  });

  it("aborts a partial file without throwing", async () => {
    const fake = fakeWritable();
    const sink = new FsaSink(fake.handle);
    await sink.open(META);
    await sink.write(PAYLOAD);
    await sink.abort();
    expect(state.aborted).toBe(true);
  });

  it("maps quota failures to DISK_FULL (PRD 12)", () => {
    expect(mapWriteError({ name: "QuotaExceededError" }).code).toBe("DISK_FULL");
    expect(mapWriteError({ name: "NS_ERROR_DOM_QUOTA_REACHED" }).code).toBe("DISK_FULL");
    expect(mapWriteError({ name: "AbortError" }).code).toBe("CANCELED");
  });

  it("reports DISK_FULL when a write fails mid-stream", async () => {
    const sink = new FsaSink({
      createWritable: async () => ({
        write: async () => {
          throw { name: "QuotaExceededError" };
        },
        close: async () => {},
      }),
      getFile: async () => new Blob([]),
    });
    await sink.open(META);
    await expect(sink.write(PAYLOAD)).rejects.toMatchObject({ code: "DISK_FULL" });
  });

  it("refuses to build without the picker and honours user cancellation", async () => {
    const host = globalThis as Record<string, unknown>;
    delete host.showSaveFilePicker;
    expect(isFsaSupported()).toBe(false);
    await expect(FsaSink.pick("a.pdf")).rejects.toMatchObject({ code: "SINK_UNAVAILABLE" });

    host.showSaveFilePicker = async () => {
      throw { name: "AbortError" };
    };
    expect(isFsaSupported()).toBe(true);
    await expect(FsaSink.pick("a.pdf")).rejects.toMatchObject({ code: "CANCELED" });
    delete host.showSaveFilePicker;
  });

  it("sanitizes the suggested filename before prompting (FR-32)", async () => {
    const host = globalThis as Record<string, unknown>;
    const pick = vi.fn(async () => fakeWritable().handle);
    host.showSaveFilePicker = pick;
    await FsaSink.pick("../../evil\u0000.exe");
    // Path separators become `_` and control characters are dropped, so the
    // name can no longer escape the chosen directory.
    const suggested = (pick.mock.calls[0] as unknown as [{ suggestedName: string }])[0]
      .suggestedName;
    expect(suggested).not.toContain("/");
    expect(suggested).not.toContain("\\");
    expect(suggested).not.toContain("\u0000");
    expect(suggested).toBe("_.._evil.exe");
    delete host.showSaveFilePicker;
  });

  it("reads staged bytes back for the repair diff (FR-17)", async () => {
    const fake = fakeWritable();
    const sink = new FsaSink(fake.handle);
    await sink.open(META);
    await sink.write(PAYLOAD);
    const back = (await sink.readRange!(2, 3))!;
    expect([...back]).toEqual([3, 4, 5]);
  });

  it("rewrites a corrupted chunk in place (FR-17)", async () => {
    const fake = fakeWritable();
    const sink = new FsaSink(fake.handle);
    await sink.open(META);
    await sink.write(PAYLOAD);
    await sink.writeAt!(2, new Uint8Array([9, 9]));
    // The rewrite lands at its offset and the rest of the file is untouched.
    const back = (await sink.readRange!(0, 6))!;
    expect([...back]).toEqual([1, 2, 9, 9, 5, 6]);
    expect(fake.bytes).toEqual([1, 2, 9, 9, 5, 6]);
  });
});

describe("OpfsSink (PRD 8.5)", () => {
  /** Node's `navigator` is getter-only, so it must be redefined, not assigned. */
  function setNavigatorStorage(storage: unknown): void {
    Object.defineProperty(globalThis, "navigator", {
      value: { ...(globalThis.navigator as object), storage },
      configurable: true,
      writable: true,
    });
  }

  /**
   * OPFS stand-in that models the positioned-write API and keeps the staged
   * bytes across `createWritable` calls — the resume path re-opens the same
   * `.part` in a brand-new sink object, so persistence is the whole point.
   */
  function stubOpfs() {
    const staged: number[] = [];
    let removed = false;
    let cursor = 0;
    const writable = {
      write: async (write: unknown) => {
        const positioned =
          typeof write === "object" &&
          write !== null &&
          (write as { type?: string }).type === "write" &&
          typeof (write as { position?: number }).position === "number";
        const position = positioned ? (write as { position: number }).position : cursor;
        const raw = positioned ? (write as { data: unknown }).data : write;
        const data = toBytes(raw);
        while (staged.length < position) staged.push(0);
        for (let i = 0; i < data.byteLength; i++) staged[position + i] = data[i]!;
        cursor = Math.max(cursor, position + data.byteLength);
      },
      close: async () => {},
      abort: async () => {},
    };
    const dir = {
      getFileHandle: async () => ({
        createWritable: async (opts?: { keepExistingData?: boolean }) => {
          cursor = opts?.keepExistingData ? staged.length : 0;
          if (!opts?.keepExistingData) staged.length = 0;
          return writable;
        },
        getFile: async () => new Blob([new Uint8Array(staged)]),
        remove: async () => {
          removed = true;
          staged.length = 0;
        },
      }),
    };
    setNavigatorStorage({
      getDirectory: async () => ({ getDirectoryHandle: async () => dir }),
    });
    return { staged, wasRemoved: () => removed };
  }

  it("stages chunks in OPFS and hands back an object URL", async () => {
    const stub = stubOpfs();
    expect(isOpfsSupported()).toBe(true);
    const sink = await OpfsSink.create("photo.jpg");
    await sink.open({ ...META, name: "photo.jpg" });
    await sink.write(PAYLOAD.subarray(0, 3));
    await sink.write(PAYLOAD.subarray(3));
    const result = await sink.close();
    expect(result.sink).toBe("opfs");
    expect(result.size).toBe(6);
    expect(stub.staged).toEqual([1, 2, 3, 4, 5, 6]);
    expect(sink.stagingPath).toContain("dropbeam/");
  });

  it("resumes a staged file at a chunk boundary (roadmap: resumable transfers)", async () => {
    const stub = stubOpfs();
    // First attempt gets three bytes in before the connection drops.
    const first = await OpfsSink.create("photo.jpg");
    await first.open({ ...META, name: "photo.jpg" });
    await first.write(PAYLOAD.subarray(0, 3));

    // A new session re-opens the same staged file at byte 3 and continues.
    const resumed = await OpfsSink.resume("photo.jpg", 3);
    await resumed.open({ ...META, name: "photo.jpg" });
    await resumed.write(PAYLOAD.subarray(3));
    const result = await resumed.close();
    expect(result.size).toBe(6);
    // The earlier bytes survived the re-open; the tail landed at its offset.
    expect(stub.staged).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("re-hashes a resumed prefix from the staged file", async () => {
    stubOpfs();
    const first = await OpfsSink.create("photo.jpg");
    await first.open({ ...META, name: "photo.jpg" });
    await first.write(PAYLOAD.subarray(0, 3));

    const resumed = await OpfsSink.resume("photo.jpg", 3);
    await resumed.open({ ...META, name: "photo.jpg" });
    expect([...(await resumed.readPrefix(3))]).toEqual([1, 2, 3]);
  });

  it("reads staged bytes back for the repair diff (FR-17)", async () => {
    stubOpfs();
    const sink = await OpfsSink.create("photo.jpg");
    await sink.open({ ...META, name: "photo.jpg" });
    await sink.write(PAYLOAD);
    const back = (await sink.readRange!(1, 3))!;
    expect([...back]).toEqual([2, 3, 4]);
  });

  it("rewrites a corrupted chunk in place (FR-17)", async () => {
    const stub = stubOpfs();
    const sink = await OpfsSink.create("photo.jpg");
    await sink.open({ ...META, name: "photo.jpg" });
    await sink.write(PAYLOAD);
    await sink.writeAt!(3, new Uint8Array([9, 9]));
    // The rewrite lands at its offset; the surrounding bytes survive, both in
    // the staged file and when read back for the final re-verify.
    expect(stub.staged).toEqual([1, 2, 3, 9, 9, 6]);
    const back = (await sink.readRange!(0, 6))!;
    expect([...back]).toEqual([1, 2, 3, 9, 9, 6]);
  });

  it("refuses to read or rewrite once the staged file is gone", async () => {
    stubOpfs();
    const sink = await OpfsSink.create("photo.jpg");
    await sink.open({ ...META, name: "photo.jpg" });
    await sink.write(PAYLOAD);
    await sink.abort();
    await expect(sink.readRange!(0, 3)).rejects.toMatchObject({ code: "SINK_UNAVAILABLE" });
    await expect(sink.writeAt!(0, PAYLOAD)).rejects.toMatchObject({ code: "SINK_UNAVAILABLE" });
    await expect(sink.readPrefix(3)).rejects.toMatchObject({ code: "SINK_UNAVAILABLE" });
  });

  it("removes the staged part file on abort", async () => {
    const stub = stubOpfs();
    const sink = await OpfsSink.create("photo.jpg");
    await sink.open(META);
    await sink.write(PAYLOAD);
    await sink.abort();
    expect(stub.wasRemoved()).toBe(true);
  });

  it("reports SINK_UNAVAILABLE without OPFS support", async () => {
    setNavigatorStorage(undefined);
    expect(isOpfsSupported()).toBe(false);
    await expect(OpfsSink.create("a.txt")).rejects.toMatchObject({
      code: "SINK_UNAVAILABLE",
    });
  });
});

describe("sink selection (PRD 8.5)", () => {
  /** Replace navigator's storage for the duration of `run`, then restore it. */
  async function withStorage(storage: unknown, run: () => void | Promise<void>): Promise<void> {
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      value: { ...(globalThis.navigator as object), storage },
      configurable: true,
      writable: true,
    });
    try {
      await run();
    } finally {
      if (original) Object.defineProperty(globalThis, "navigator", original);
    }
  }

  it("prefers File System Access, then OPFS, then memory", async () => {
    const host = globalThis as Record<string, unknown>;
    delete host.showSaveFilePicker;
    await withStorage(undefined, () => {
      expect(chooseSink().kind).toBe("memory");
    });
    await withStorage({ getDirectory: () => {} }, () => {
      expect(chooseSink().kind).toBe("opfs");
    });
    host.showSaveFilePicker = () => {};
    expect(chooseSink()).toEqual({ kind: "fsa", inMemory: false, warnAboveBytes: null });
    delete host.showSaveFilePicker;
  });

  it("flags the memory fallback so the UI can warn about limits", async () => {
    const host = globalThis as Record<string, unknown>;
    delete host.showSaveFilePicker;
    await withStorage(undefined, () => {
      const choice = chooseSink();
      expect(choice.inMemory).toBe(true);
      expect(choice.warnAboveBytes).toBeGreaterThan(0);
    });
  });

  it("builds a memory sink when nothing else is available", async () => {
    const host = globalThis as Record<string, unknown>;
    delete host.showSaveFilePicker;
    await withStorage(undefined, async () => {
      const sink = await createSinkFor("a.txt");
      expect(sink).toBeInstanceOf(MemorySink);
      expect(sink.kind).toBe("memory");
    });
  });

  it("propagates a user cancellation instead of silently downgrading", async () => {
    const host = globalThis as Record<string, unknown>;
    host.showSaveFilePicker = () => {};
    await expect(
      createSinkFor("a.txt", async () => {
        throw new SinkError("CANCELED");
      }),
    ).rejects.toMatchObject({ code: "CANCELED" });
    delete host.showSaveFilePicker;
  });
});
