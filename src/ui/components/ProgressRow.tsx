import type { FilePhase } from "../../core/transfer/phase";

/**
 * Per-file transfer row (PRD 10.1 screen 6): name, size, progress bar, speed,
 * ETA and cancel. Sizes and speeds use the mono face so digits don't jitter.
 */

export type ProgressRowProps = {
  name: string;
  size: number;
  phase: FilePhase;
  sent: number;
  total: number;
  cancelLabel: string;
  onCancel?: () => void;
};

const PHASE_LABEL_KEY: Record<FilePhase, string> = {
  QUEUED: "Queued",
  OFFERED: "Waiting for approval",
  ACCEPTED: "Accepted",
  DECLINED: "Declined",
  TRANSFERRING: "Transferring",
  VERIFYING: "Checking",
  DONE: "Saved",
  FAILED: "Failed",
  CANCELED: "Canceled",
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

export function ProgressRow({
  name,
  size,
  phase,
  sent,
  total,
  cancelLabel,
  onCancel,
}: ProgressRowProps) {
  const pct = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0;
  const running = phase === "TRANSFERRING";
  // Scale, not width: animating width forces layout on every progress tick.
  const ratio = total > 0 ? Math.min(1, sent / total) : 0;
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
        <span class="row-phase">{PHASE_LABEL_KEY[phase]}</span>
        {running ? <span class="row-pct">{pct}%</span> : null}
        {onCancel && phase !== "DONE" && phase !== "FAILED" ? (
          <button type="button" class="btn btn-quiet" onClick={onCancel}>
            {cancelLabel}
          </button>
        ) : null}
      </div>
    </li>
  );
}
