import { describe, expect, it, vi } from "vitest";
import { FsaSink, isFsaSupported, mapWriteError } from "../../src/core/storage/fsa-sink";
import { OpfsSink, isOpfsSupported } from "../../src/core/storage/opfs-sink";
import { MemorySink } from "../../src/core/storage/memory-sink";
import { chooseSink, createSinkFor } from "../../src/core/storage/select-sink";
import { SinkError, type SinkMeta } from "../../src/core/storage/sink";

const META: SinkMeta = { name: "report.pdf", size: 6, type: "application/pdf" };
const PAYLOAD = new Uint8Array([1, 2, 3, 4, 5, 6]);

/** Records every chunk written, so we can assert the byte stream is intact. */
function fakeWritable() {
  const written: Uint8Array[] = [];
  return {
    written,
    closed: false,
    aborted: false,
    handle: {
      createWritable: async () => ({
        write: async (chunk: BufferSource) => {
          written.push(new Uint8Array(chunk as ArrayBuffer));
        },
        close: async () => {
          state.closed = true;
        },
        abort: async () => {
          state.aborted = true;
        },
      }),
    },
  };
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
    expect(fake.written.map((c) => [...c])).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
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

  function stubOpfs() {
    const staged: number[] = [];
    let removed = false;
    const dir = {
      getFileHandle: async () => ({
        createWritable: async () => ({
          write: async (c: BufferSource) => void staged.push(...new Uint8Array(c as ArrayBuffer)),
          close: async () => {},
        }),
        getFile: async () => new Blob([new Uint8Array(staged)]),
        remove: async () => {
          removed = true;
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
