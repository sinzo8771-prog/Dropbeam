import { OpfsSink } from "../storage/opfs-sink";
import { resumeStore } from "./resume-store";

/**
 * Discard a parked partial (the user pressed Discard on the resume hint):
 * forget it, and remove the staged bytes so a resumed transfer never
 * continues from a file the user already decided against.
 */
export async function discardResumable(name: string, size: number): Promise<void> {
  const partial = resumeStore.takeInbound(name, size);
  if (!partial || partial.sink !== "opfs") return;
  try {
    const sink = await OpfsSink.create(partial.name);
    await sink.abort();
  } catch {
    // Best effort: a staging file left behind is cleaned by the next
    // successful save in the same slot, and never resurfaces in the UI.
  }
}
