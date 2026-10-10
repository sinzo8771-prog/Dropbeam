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

type StagedEntry = { i: number; name: string; type: string };

/** Pull and clear files staged by the service worker's share handler. */
export async function readStagedShare(storage?: CacheStorage): Promise<File[]> {
  const cacheStorage =
    storage ?? (typeof caches !== "undefined" ? caches : (undefined as CacheStorage | undefined));
  if (!cacheStorage) return [];

  let cache: Cache;
  let index: StagedEntry[];
  try {
    cache = await cacheStorage.open(SHARE_CACHE);
    const response = await cache.match(INDEX);
    if (!response) return [];
    index = (await response.json()) as StagedEntry[];
    if (!Array.isArray(index) || index.length === 0) return [];
  } catch {
    return [];
  }

  const files: File[] = [];
  for (const entry of index) {
    try {
      const staged = await cache.match(`./__share/${entry.i}`);
      if (!staged) continue;
      const blob = await staged.blob();
      files.push(new File([blob], entry.name, { type: entry.type }));
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
  return files;
}
