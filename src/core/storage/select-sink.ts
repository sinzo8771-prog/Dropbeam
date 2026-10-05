import { FsaSink, isFsaSupported } from "./fsa-sink";
import { MemorySink } from "./memory-sink";
import { OpfsSink, isOpfsSupported } from "./opfs-sink";
import { SinkError, type Sink, type SinkKind } from "./sink";

/**
 * Sink selection (PRD 8.5): File System Access → OPFS → memory, by feature
 * detection, never by user-agent sniffing. The chosen kind is surfaced so the
 * debug panel can log it and the UI can warn where a limit applies.
 *
 * Memory is a last resort and is bounded, so a file that cannot be staged on
 * disk fails fast with SINK_UNAVAILABLE instead of exhausting the heap.
 */

export type SinkChoice = {
  kind: SinkKind;
  /** True when this path buffers the file in RAM (PRD 8.5 limits apply). */
  inMemory: boolean;
  /** Soft warning threshold in bytes, or null when unbounded on disk. */
  warnAboveBytes: number | null;
};

/** PRD 8.5: warn in Firefox above 1 GB, Safari above ~500 MB, memory anywhere. */
export function chooseSink(): SinkChoice {
  if (isFsaSupported()) return { kind: "fsa", inMemory: false, warnAboveBytes: null };
  if (isOpfsSupported()) {
    // Firefox and Safari stage to OPFS but still end in a download.
    return { kind: "opfs", inMemory: false, warnAboveBytes: 1024 * 1024 * 1024 };
  }
  return { kind: "memory", inMemory: true, warnAboveBytes: 500 * 1024 * 1024 };
}

/**
 * Create a sink for an incoming file. `pickDestination` is supplied by the UI
 * so the File System Access picker stays tied to a user gesture.
 */
export async function createSinkFor(
  name: string,
  pickDestination?: (name: string) => Promise<Sink>,
): Promise<Sink> {
  // An explicitly supplied destination wins: it is how the UI binds the File
  // System Access picker to a user gesture, and it must not be discarded just
  // because feature detection ran in an environment that lacks the API.
  if (pickDestination) {
    try {
      return await pickDestination(name);
    } catch (err) {
      // The user cancelling is a real outcome, not a reason to downgrade.
      if (err instanceof SinkError && err.code === "CANCELED") throw err;
    }
  }
  if (isFsaSupported()) return FsaSink.pick(name);
  if (isOpfsSupported()) return OpfsSink.create(name);
  return new MemorySink();
}
