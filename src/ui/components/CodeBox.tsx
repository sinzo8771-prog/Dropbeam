import { useState } from "preact/hooks";

/**
 * Copyable code display (PRD 8.2.3): the raw code, grouped in blocks of five
 * characters for manual reading, with a one-tap Copy. The grouping is visual
 * only — the copy button always yields the ungrouped code.
 */

export function groupCode(code: string, block = 5): string {
  return (code.match(new RegExp(`.{1,${block}}`, "g")) ?? []).join(" ");
}

export type CodeBoxProps = {
  code: string;
  label: string;
  copyLabel: string;
  copiedLabel: string;
  /** Injected in tests; defaults to the async clipboard API. */
  onCopy?: (code: string) => void | Promise<void>;
};

export function CodeBox({ code, label, copyLabel, copiedLabel, onCopy }: CodeBoxProps) {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      if (onCopy) {
        await onCopy(code);
      } else if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(code);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the code stays visible and selectable for manual copy.
      setCopied(false);
    }
  };

  return (
    <div class="code-box">
      <span class="code-box-label">{label}</span>
      <code class="code-box-code" data-testid="code-text">
        {groupCode(code)}
      </code>
      <button type="button" class="btn btn-ghost" onClick={() => void copy()}>
        {copied ? copiedLabel : copyLabel}
      </button>
    </div>
  );
}
