/**
 * Web Share Target staging (PRD FR-51).
 *
 * The service worker receives the share-target POST (it cannot be
 * answered by the page), stores each file in a dedicated cache and
 * lands the app on `#shared`. The page then calls `readStagedShare()`
 * once to pull the files in and empty the staging cache. Everything is
 * session-only (FR-40): nothing is written to IndexedDB or disk, so an
 * abandoned share disappears with the tab.
 *
 * Missing staging, an unsupported browser (no CacheStorage) and an
 * unreadable entry all resolve to an empty list — the share target is
 * explicitly best-effort (FR-51), and the caller shows the normal Send
 * screen either way.
 */

const SHARE_CACHE = "dropbeam-share";
const INDEX = "./__share/index";
/** Sentinel index entry: shared text or a URL, staged for the note field. */
const TEXT_ENTRY = "text";

type StagedEntry = { i: number | typeof TEXT_ENTRY; name: string; type: string };

export type StagedShare = {
  /** Files handed over by the share sheet. */
  files: File[];
  /** Shared text (or URL) waiting for a note, or "" when none was shared. */
  text: string;
};

/** Pull and clear files staged by the service worker's share handler. */
export async function readStagedShare(storage?: CacheStorage): Promise<StagedShare> {
  const cacheStorage =
    storage ?? (typeof caches !== "undefined" ? caches : (undefined as CacheStorage | undefined));
  if (!cacheStorage) return { files: [], text: "" };

  let cache: Cache;
  let index: StagedEntry[];
  try {
    cache = await cacheStorage.open(SHARE_CACHE);
    const response = await cache.match(INDEX);
    if (!response) return { files: [], text: "" };
    index = (await response.json()) as StagedEntry[];
    if (!Array.isArray(index) || index.length === 0) return { files: [], text: "" };
  } catch {
    return { files: [], text: "" };
  }

  const files: File[] = [];
  let text = "";
  for (const entry of index) {
    try {
      const staged = await cache.match(`./__share/${entry.i}`);
      if (!staged) continue;
      if (entry.i === TEXT_ENTRY) {
        text = (await staged.text()).trim();
        continue;
      }
      // Read as bytes, not as a Blob: a Blob built in another realm (the
      // worker that staged it, or a test's fake CacheStorage) is not
      // guaranteed to be unwrapped when passed as a File part, and ends up
      // stringified instead. Bytes are a BufferSource everywhere.
      const bytes = await staged.arrayBuffer();
      files.push(new File([bytes], entry.name, { type: entry.type }));
    } catch {
      // One unreadable entry must not strand the rest of the share.
      continue;
    }
  }

  // Empty the staging area so a reload (or a second `#shared` visit)
  // never resurfaces files the user already saw.
  await cache.delete(INDEX).catch(() => undefined);
  await Promise.all(
    index.map((entry) => cache.delete(`./__share/${entry.i}`).catch(() => undefined)),
  );
  return { files, text };
}
