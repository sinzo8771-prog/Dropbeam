import { useRef } from "preact/hooks";
import type { FilePhase } from "../../core/transfer/phase";
import type { StringKey, Translate } from "../../core/platform/i18n";
import { formatBytes, formatDuration, formatRate, RateMeter } from "../format";
import { FileIcon, fileKind } from "./FileIcon";

/**
 * Per-file transfer row (PRD 10.1 screen 6): name, size, progress bar, speed,
 * ETA and cancel. Sizes and speeds use the mono face so digits don't jitter.
 *
 * The speed and the ETA are measured here rather than carried in the session's
 * progress report, because both are *rates*: they only mean anything over an
 * interval, and the row is the thing that sees every sample. The rate is the
 * rolling two-second average FR-15 asks for, so one slow packet cannot reset
 * the number and one fast one cannot spike it.
 */

export type ProgressRowProps = {
  t: Translate;
  name: string;
  size: number;
  /** The file's media type, so the row can pick an icon for it (PRD 10.1 #6). */
  type?: string;
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

export { formatBytes, formatDuration, formatRate };

export function ProgressRow({
  t,
  name,
  size,
  type,
  phase,
  sent,
  total,
  cancelLabel,
  onCancel,
}: ProgressRowProps) {
  // The samples the rate is measured from. A ref, because a sample is not
  // state: the row re-renders on every progress tick.
  const meter = useRef(new RateMeter());
  const rate = meter.current.update(Date.now(), sent);

  const pct = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0;
  const running = phase === "TRANSFERRING";
  // Scale, not width: animating width forces layout on every progress tick.
  const ratio = total > 0 ? Math.min(1, sent / total) : 0;
  const remaining = Math.max(0, total - sent);
  const showRate = running && rate > 0;
  const showEta = showRate && remaining > 0;

  return (
    <li class="row" data-testid="progress-row">
      <div class="row-head">
        <FileIcon kind={fileKind(type ?? "", name)} />
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
            {t("transfer.speed", { value: formatRate(rate) })}
          </span>
        ) : null}
        {showEta ? (
          <span class="row-eta" data-testid="row-eta">
            {t("transfer.eta", { value: formatDuration(remaining / rate) })}
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
