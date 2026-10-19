import { useRef } from "preact/hooks";
import type { FilePhase } from "../../core/transfer/phase";
import type { StringKey, Translate } from "../../core/platform/i18n";

/**
 * Per-file transfer row (PRD 10.1 screen 6): name, size, progress bar, speed,
 * ETA and cancel. Sizes and speeds use the mono face so digits don't jitter.
 *
 * The speed and the ETA are measured here rather than carried in the session's
 * progress report, because both are *rates*: they only mean anything over an
 * interval, and the row is the thing that sees every sample. The rate is a
 * smoothed one - a single tick's worth of bytes divided by a single tick's
 * worth of time is noisy enough to make the number jump, and a number that
 * jumps is worse than no number.
 */

export type ProgressRowProps = {
  t: Translate;
  name: string;
  size: number;
  phase: FilePhase;
  sent: number;
  total: number;
  cancelLabel: string;
  onCancel?: () => void;
};

const PHASE_LABEL_KEY: Record<FilePhase, StringKey> = {
  QUEUED: "transfer.phase.queued",
  OFFERED: "transfer.phase.offered",
  ACCEPTED: "transfer.phase.accepted",
  DECLINED: "transfer.phase.declined",
  TRANSFERRING: "transfer.phase.transferring",
  VERIFYING: "transfer.phase.verifying",
  DONE: "transfer.phase.done",
  FAILED: "transfer.phase.failed",
  CANCELED: "transfer.phase.canceled",
};

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

export function ProgressRow({
  t,
  name,
  size,
  phase,
  sent,
  total,
  cancelLabel,
  onCancel,
}: ProgressRowProps) {
  // The last sample, and the smoothed rate so far. A ref, because a sample is
  // not state: the row re-renders on every progress tick, and the rate is
  // derived from the ticks it has already seen.
  const last = useRef<{ at: number; sent: number } | null>(null);
  const rate = useRef(0);

  const now = Date.now();
  const previous = last.current;
  if (previous && sent > previous.sent) {
    const elapsed = (now - previous.at) / 1000;
    if (elapsed > 0) {
      const instant = (sent - previous.sent) / elapsed;
      // Smooth towards the new sample rather than replacing it: one slow tick
      // should not reset the number, and one fast tick should not spike it.
      rate.current = rate.current === 0 ? instant : rate.current * 0.6 + instant * 0.4;
    }
  }
  last.current = { at: now, sent };

  const pct = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0;
  const running = phase === "TRANSFERRING";
  // Scale, not width: animating width forces layout on every progress tick.
  const ratio = total > 0 ? Math.min(1, sent / total) : 0;
  const remaining = Math.max(0, total - sent);
  const showRate = running && rate.current > 0;
  const showEta = showRate && remaining > 0;

  return (
    <li class="row" data-testid="progress-row">
      <div class="row-head">
        <span class="row-name" title={name}>
          {name}
        </span>
        <span class="row-size">{formatBytes(size)}</span>
      </div>
      <div
        class="row-bar"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={name}
      >
        <div class="row-bar-fill" style={{ transform: `scaleX(${ratio})` }} />
      </div>
      <div class="row-foot">
        <span class="row-phase">{t(PHASE_LABEL_KEY[phase])}</span>
        {running ? <span class="row-pct">{pct}%</span> : null}
        {showRate ? (
          <span class="row-rate" data-testid="row-rate">
            {t("transfer.speed", { value: formatRate(rate.current) })}
          </span>
        ) : null}
        {showEta ? (
          <span class="row-eta" data-testid="row-eta">
            {t("transfer.eta", { value: formatDuration(remaining / rate.current) })}
          </span>
        ) : null}
        {onCancel && phase !== "DONE" && phase !== "FAILED" ? (
          <button type="button" class="btn btn-quiet" onClick={onCancel}>
            {cancelLabel}
          </button>
        ) : null}
      </div>
    </li>
  );
}
