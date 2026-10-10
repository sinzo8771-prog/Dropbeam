import { useEffect } from "preact/hooks";

/**
 * Screen wake lock for long transfers (PRD FR-41, M5). A multi-gigabyte
 * transfer can outlast the screen timeout on a phone, and a locked
 * screen can suspend the tab mid-transfer, so keep the screen awake
 * while files are moving.
 *
 * Best-effort by design: the API is feature-detected, a denied or
 * failed request is swallowed (a wake lock must never break a
 * transfer), and the platform releasing the lock when the tab hides
 * is handled by re-requesting on visibility.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (typeof navigator === "undefined" || !navigator.wakeLock) return;

    let released = false;
    let sentinel: WakeLockSentinel | null = null;

    const acquire = (): void => {
      if (released) return;
      navigator.wakeLock
        .request("screen")
        .then((lock) => {
          if (released) {
            // Deactivated while the request was in flight.
            void lock.release().catch(() => {});
            return;
          }
          sentinel = lock;
        })
        .catch(() => {
          // Hidden tab, denied permission or an unsupported document: the
          // transfer continues either way.
        });
    };

    acquire();
    // The platform drops the lock when the page is hidden; take it back.
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") acquire();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (sentinel) void sentinel.release().catch(() => {});
    };
  }, [active]);
}
