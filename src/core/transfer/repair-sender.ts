import { createHasher, type Hasher } from "./hash";
import { CHUNK_SIZE, chunkCount, chunkOffset } from "./protocol";

/**
 * Sender half of per-chunk repair (roadmap: chunk bitmap / per-chunk hash
 * repair). Loaded only when the receiver reports a whole-file mismatch, so
 * none of this ships in the initial bundle.
 *
 * Two jobs, both single-pass:
 *  - `hashSourceChunks`: the SHA-256 of every 16 KiB chunk of the source
 *    blob, sent as the `plan` so the receiver can name only the bad indices.
 *  - `readChunk`: re-read one chunk of the source blob so it can be re-sent
 *    as a DATA frame at its original sequence number.
 */

/** One source chunk's digest, in file order. */
export async function hashSourceChunks(blob: Blob): Promise<string[]> {
  const hashes: string[] = [];
  const chunks = chunkCount(blob.size);
  for (let i = 0; i < chunks; i++) {
    const offset = chunkOffset(i);
    const length = Math.min(CHUNK_SIZE, blob.size - offset);
    const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    const hasher: Hasher = await createHasher();
    hasher.update(bytes);
    hashes.push(await hasher.digest());
    hasher.dispose();
  }
  return hashes;
}

/** Re-read one source chunk by index, for re-sending during repair. */
export async function readChunk(blob: Blob, index: number): Promise<Uint8Array> {
  const offset = chunkOffset(index);
  const length = Math.min(CHUNK_SIZE, blob.size - offset);
  return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
}
