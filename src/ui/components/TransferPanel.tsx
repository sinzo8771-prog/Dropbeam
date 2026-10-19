import { useRef, useState } from "preact/hooks";
import { ProgressRow } from "./ProgressRow";
import { formatBytes, formatDuration, formatRate, RateMeter } from "../format";
import type { FileProgress } from "../../core/transfer/transfer-session";
import type { IncomingText } from "../../core/transfer/receiver";
import type { SaveResult } from "../../core/storage/sink";
import type { Translate } from "../../core/platform/i18n";

/**
 * Transfer screen (PRD 10.1 screen 6). Picks or drops files, sends a note, and
 * lists everything moving in either direction. The panel is presentational: it
 * calls back for actions and never touches the channel or a `TransferSession`.
 */

export type TransferPanelProps = {
  t: Translate;
  files: FileProgress[];
  saved: SaveResult[];
  notes: IncomingText[];
  /** Text prepared before the connection (e.g. a shared URL), pre-filled into the note. */
  initialNote?: string;
  onSendFiles: (files: File[]) => void;
  onSendText: (body: string) => void;
  onCancel: (fid: number) => void;
  onDismissNote: (id: string) => void;
};

export function TransferPanel({
  t,
  files,
  saved,
  notes,
  initialNote,
  onSendFiles,
  onSendText,
  onCancel,
  onDismissNote,
}: TransferPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // A note staged while pairing (share target) starts in the field, ready
  // to send — the user still presses Send, since text is never auto-sent.
  const [note, setNote] = useState(initialNote ?? "");
  const [dragging, setDragging] = useState(false);
  // The totals' rate, measured the same way as each row's (FR-15: a rolling
  // two-second average over the bytes sent so far).
  const meter = useRef(new RateMeter());

  // PRD 10.1 screen 6: progress "per file and total". The total is over the
  // files that are moving, in both directions.
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const totalDone = files.reduce((sum, file) => sum + file.done, 0);
  const totalPct = totalSize > 0 ? Math.min(100, Math.round((totalDone / totalSize) * 100)) : 0;
  const totalRate = meter.current.update(Date.now(), totalDone);
  const totalRemaining = Math.max(0, totalSize - totalDone);
  const showTotals = files.length > 0 && totalSize > 0;
  const showTotalEta = totalRate > 0 && totalRemaining > 0;

  const send = (picked: FileList | null): void => {
    if (!picked || picked.length === 0) return;
    onSendFiles([...picked]);
  };

  /**
   * FR-20: send a received file back to the peer.
   *
   * The bytes are read back from where the sink put them rather than from the
   * app's memory - the app never keeps a received file's bytes - so this is
   * available whenever the sink can still reach its own output. A sink that
   * cannot does not offer the action at all.
   */
  const sendBack = async (result: SaveResult): Promise<void> => {
    const blob = result.blob ?? (await result.read?.());
    if (!blob) return;
    onSendFiles([new File([blob], result.name)]);
  };

  const submitNote = (): void => {
    if (note.trim() === "") return;
    onSendText(note);
    setNote("");
  };

  return (
    <section class="transfer" aria-label={t("transfer.title")}>
      <div
        class={`dropzone${dragging ? " is-dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          send(e.dataTransfer?.files ?? null);
        }}
      >
        <p class="dropzone-label">{t("transfer.dropHere")}</p>
        {/* A real file input keeps the picker keyboard- and screen-reader-reachable;
            the drop zone is an accelerator on top of it, not the only route. It is
            hidden from assistive tech because the visible "Choose files" button
            drives it — otherwise screen readers announce the picker twice. */}
        <input
          ref={inputRef}
          type="file"
          multiple
          class="sr-only"
          aria-hidden="true"
          tabIndex={-1}
          data-testid="file-input"
          onChange={(e) => {
            const input = e.currentTarget as HTMLInputElement;
            send(input.files);
            // Reset so re-picking the same file fires another change event.
            input.value = "";
          }}
        />
        <button type="button" class="btn btn-secondary" onClick={() => inputRef.current?.click()}>
          {t("transfer.pickFiles")}
        </button>
      </div>

      {showTotals ? (
        <div class="rows-total" data-testid="rows-total">
          <span class="row-phase">{t("transfer.total")}</span>
          <span class="row-size">
            {formatBytes(totalDone)} / {formatBytes(totalSize)}
          </span>
          <span class="row-pct">{totalPct}%</span>
          {totalRate > 0 ? (
            <span class="row-rate">{t("transfer.speed", { value: formatRate(totalRate) })}</span>
          ) : null}
          {showTotalEta ? (
            <span class="row-eta">
              {t("transfer.eta", { value: formatDuration(totalRemaining / totalRate) })}
            </span>
          ) : null}
        </div>
      ) : null}

      {files.length > 0 ? (
        <ul class="rows">
          {files.map((file) => (
            <ProgressRow
              key={file.fid}
              t={t}
              name={file.name}
              size={file.size}
              phase={file.phase}
              sent={file.done}
              total={file.size}
              cancelLabel={t("action.cancel")}
              onCancel={() => onCancel(file.fid)}
            />
          ))}
        </ul>
      ) : (
        <p class="hint">{t("transfer.empty")}</p>
      )}

      {saved.length > 0 ? (
        <ul class="rows" aria-label={t("transfer.saved")}>
          {saved.map((result, index) => (
            <li class="row" key={`${result.name}-${index}`} data-testid="saved-row">
              <div class="row-head">
                <span class="row-name">{result.name}</span>
                <span class="row-size">{t("transfer.saved")}</span>
              </div>
              {/* FR-20: after a file is saved, the obvious next things are to
                  open it or to send it back. "Open" needs a URL, which only
                  the sinks that kept the bytes can give; "Send back" needs
                  the sink to still be able to read its own output, which the
                  File System Access sink can and the others can too. Either
                  way the action is not offered rather than offered and
                  broken. */}
              {result.url || result.read || result.blob ? (
                <div class="row-foot">
                  {result.url ? (
                    <a
                      class="btn btn-quiet"
                      href={result.url}
                      download={result.name}
                      data-testid="saved-open"
                    >
                      {t("action.open")}
                    </a>
                  ) : null}
                  {result.read || result.blob ? (
                    <button
                      type="button"
                      class="btn btn-quiet"
                      data-testid="saved-send-back"
                      onClick={() => void sendBack(result)}
                    >
                      {t("action.sendBack")}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div class="note">
        <label class="note-label" for="note-body">
          {t("transfer.textTitle")}
        </label>
        <textarea
          id="note-body"
          class="note-body"
          rows={3}
          placeholder={t("transfer.textPlaceholder")}
          value={note}
          onInput={(e) => setNote((e.currentTarget as HTMLTextAreaElement).value)}
        />
        <button
          type="button"
          class="btn btn-primary"
          disabled={note.trim() === ""}
          onClick={submitNote}
        >
          {t("action.send")}
        </button>
      </div>

      {notes.length > 0 ? (
        <ul class="rows" aria-label={t("transfer.textTitle")}>
          {notes.map((incoming) => (
            <li class="row row-note" key={incoming.id} data-testid="note-row">
              <div class="row-head">
                <span class="row-name">{t("transfer.textTitle")}</span>
                <button
                  type="button"
                  class="btn btn-quiet"
                  onClick={() => onDismissNote(incoming.id)}
                >
                  {t("action.close")}
                </button>
              </div>
              {/* Peer-supplied text: rendered as a text node, never as markup. */}
              <p class="note-body-text">{incoming.body}</p>
            </li>
          ))}
        </ul>
      ) : null}

      {/* FR-19: a phone that locks its screen may pause the transfer, and the
          user is the one who can prevent it. The warning is here rather than
          in the settings sheet because this is where the transfer is. */}
      {files.length > 0 ? <p class="hint">{t("transfer.lockWarning")}</p> : null}
    </section>
  );
}
