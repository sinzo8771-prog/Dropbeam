/**
 * Sizes, rates and durations, in one place.
 *
 * The transfer screen shows all three (PRD 10.1 screen 6), and the rule for
 * the rate is PRD FR-15's: a *rolling two-second average*, not the last
 * tick's worth of bytes. A rate measured over one tick jumps with every
 * packet, and a number that jumps is worse than no number.
 */

/** A transfer's rate, averaged over the last two seconds. */
export const RATE_WINDOW_MS = 2_000;

/**
 * Keeps the samples a rate is measured from.
 *
 * The samples are the ones the UI has already seen, so a meter has to be fed
 * each time a progress tick arrives; it keeps what it needs and drops what has
 * fallen out of the window.
 */
export class RateMeter {
  private readonly samples: { at: number; sent: number }[] = [];

  /**
   * Records a sample and returns the current rate in bytes per second, or 0
   * when there is not enough history for one yet.
   */
  update(now: number, sent: number): number {
    const last = this.samples[this.samples.length - 1];
    if (!last || last.sent !== sent) this.samples.push({ at: now, sent });
    const cutoff = now - RATE_WINDOW_MS;
    while (this.samples.length > 1 && (this.samples[0] as { at: number }).at < cutoff) {
      this.samples.shift();
    }
    const first = this.samples[0] as { at: number; sent: number };
    const elapsed = (now - first.at) / 1000;
    if (elapsed <= 0) return 0;
    return Math.max(0, (sent - first.sent) / elapsed);
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** A rate, in bytes per second, shown the way a size is. */
export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "—";
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** A duration, in the largest unit that still reads well. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} m`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} m`;
}