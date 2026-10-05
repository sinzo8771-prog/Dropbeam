import { useRef, useState } from "preact/hooks";
import { ProgressRow } from "./ProgressRow";
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
  onSendFiles,
  onSendText,
  onCancel,
  onDismissNote,
}: TransferPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState("");
  const [dragging, setDragging] = useState(false);

  const send = (picked: FileList | null): void => {
    if (!picked || picked.length === 0) return;
    onSendFiles([...picked]);
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

      {files.length > 0 ? (
        <ul class="rows">
          {files.map((file) => (
            <ProgressRow
              key={file.fid}
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
    </section>
  );
}
