import type { VerificationPhrase } from "../../core/peer/verify-phrase";

/**
 * Verification panel (PRD 9.3). Always shown once connected: both devices
 * display the same words, and a mismatch means someone is in the middle. The
 * words are derived locally from the DTLS fingerprints, never peer-supplied
 * markup, so they render as text nodes.
 */

export type VerifyCardProps = {
  phrase: VerificationPhrase;
  /** Localized label for the phrase. */
  label: string;
  /** Localized help text under the words. */
  help: string;
  /** Localized digits prefix, e.g. "Read aloud". */
  digitsLabel: string;
};

export function VerifyCard({ phrase, label, help, digitsLabel }: VerifyCardProps) {
  return (
    <section class="verify-card" aria-label={label}>
      <p class="verify-card-label">{label}</p>
      {/* Words are the primary check; the digits are for reading aloud. */}
      <p class="verify-card-words">{phrase.words.join(" ")}</p>
      <p class="verify-card-digits">
        <span class="verify-card-digits-label">{digitsLabel}</span> {phrase.digits}
      </p>
      <p class="hint">{help}</p>
    </section>
  );
}
