import { createHasher, type Hasher } from "./hash";
import { CHUNK_SIZE, chunkOffset } from "./protocol";

/**
 * Per-chunk repair (roadmap: chunk bitmap / per-chunk hash repair).
 *
 * Loaded only after a whole-file hash mismatch, so none of this ships in the
 * initial bundle. The handshake is strictly single-pass: the receiver asks for
 * the bad indices exactly once, rewrites them in place, and re-verifies the
 * whole file one final time. A second mismatch is terminal — there is no retry
 * loop, no backoff, no second request.
 *
 * The receiver owns the handshake state (it already holds `active`, the
 * channel, and `dispatch`); this module is a set of pure helpers it calls.
 */

/** A staged file's sink, narrowed to what repair actually touches. */
export type RepairSink = {
  readRange?(offset: number, length: number): Promise<Uint8Array | null>;
  writeAt?(offset: number, bytes: Uint8Array): Promise<void>;
};

/** The staged-file facts repair needs, independent of the receiver's RxState. */
export type RepairFile = {
  sink: RepairSink;
  size: number;
};

/**
 * Hash every chunk of a staged file. Returns one lowercase hex digest per
 * chunk, in file order, so index `i` lines up with chunk `i`.
 * Returns null if the sink cannot read a chunk back.
 */
export async function hashStagedChunks(file: RepairFile): Promise<string[] | null> {
  if (typeof file.sink.readRange !== "function") return null;
  const chunks = Math.ceil(file.size / CHUNK_SIZE);
  const hashes: string[] = [];
  for (let i = 0; i < chunks; i++) {
    const offset = chunkOffset(i);
    const length = Math.min(CHUNK_SIZE, file.size - offset);
    const bytes = await file.sink.readRange(offset, length);
    if (!bytes) return null;
    const hasher: Hasher = await createHasher();
    hasher.update(bytes);
    hashes.push(await hasher.digest());
    hasher.dispose();
  }
  return hashes;
}

/**
 * Chunk indices whose staged digest disagrees with the sender's plan.
 * A plan shorter than the staged file is treated as a mismatch on the tail.
 */
export function diffChunks(staged: string[], plan: string[]): number[] {
  const bad: number[] = [];
  const n = Math.max(staged.length, plan.length);
  for (let i = 0; i < n; i++) if (staged[i] !== plan[i]) bad.push(i);
  return bad;
}

/**
 * Hash the whole staged file in one pass and compare against the sender's
 * original whole-file digest. This is the single final verification — it is
 * never retried.
 */
export async function reverifyWholeFile(
  file: RepairFile,
  expectedSha256: string,
): Promise<boolean> {
  if (typeof file.sink.readRange !== "function") return false;
  const chunks = Math.ceil(file.size / CHUNK_SIZE);
  const hasher: Hasher = await createHasher();
  for (let i = 0; i < chunks; i++) {
    const offset = chunkOffset(i);
    const length = Math.min(CHUNK_SIZE, file.size - offset);
    const bytes = await file.sink.readRange(offset, length);
    if (!bytes) {
      hasher.dispose();
      return false;
    }
    hasher.update(bytes);
  }
  const hex = await hasher.digest();
  hasher.dispose();
  return hex === expectedSha256;
}
