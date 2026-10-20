import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";

/**
 * Modal prompt (PRD 5.1 / FR-13): the incoming-transfer decision and any
 * blocking confirmation. Native-first: a real <dialog> so focus trapping,
 * Escape and the top layer come from the platform.
 */

export type PromptProps = {
  open: boolean;
  title: string;
  body?: ComponentChildren;
  acceptLabel: string;
  declineLabel: string;
  onAccept: () => void;
  onDecline: () => void;
};

export function Prompt({
  open,
  title,
  body,
  acceptLabel,
  declineLabel,
  onAccept,
  onDecline,
}: PromptProps) {
  const ref = useRef<HTMLDialogElement>(null);
  /**
   * The heading's id, unique to this prompt.
   *
   * The app mounts three of these at once, and a shared id would make every
   * one of them answer `aria-labelledby` with the first heading in the
   * document: the approval dialog would be announced as "Scan reply", because
   * that is the title of the prompt rendered before it.
   */
  const titleId = `prompt-title-${useId()}`;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof el.showModal === "function") {
      // Real browsers: the top layer, focus trap and Escape come free.
      if (open && !el.open) el.showModal();
      if (!open && el.open) el.close();
      return;
    }
    // Environments without showModal (jsdom) would otherwise render a dialog
    // that silently never opens, making the prompt impossible to exercise.
    // Keep the attribute in sync instead; browsers never take this path.
    el.open = open;
  }, [open]);

  return (
    <dialog class="prompt" ref={ref} aria-labelledby={titleId} onCancel={onDecline}>
      <h2 id={titleId} class="prompt-title">
        {title}
      </h2>
      {body ? <div class="prompt-body">{body}</div> : null}
      <div class="prompt-actions">
        <button type="button" class="btn btn-ghost" onClick={onDecline}>
          {declineLabel}
        </button>
        <button type="button" class="btn btn-primary" onClick={onAccept}>
          {acceptLabel}
        </button>
      </div>
    </dialog>
  );
}
