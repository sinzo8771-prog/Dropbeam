import type { Translate } from "../core/platform/i18n";
import { formatBytes } from "./components/ProgressRow";

/**
 * Send screen (PRD FR-51): files handed to the PWA through the Web
 * Share Target wait here until a device is paired. Pairing uses the
 * normal Start/Join flows; once the connection opens and the approval
 * gate allows transfers, the shell sends the staged files (one attempt
 * per connection, with a toast if it fails).
 */

type Props = {
  t: Translate;
  staged: File[];
  onRemove: (file: File) => void;
  onStart: () => void;
  onJoin: () => void;
  onBack: () => void;
};

export function SendScreen({ t, staged, onRemove, onStart, onJoin, onBack }: Props) {
  return (
    <section class="screen screen-send" data-staged={staged.length}>
      <h1>{t("share.title")}</h1>
      {staged.length === 1 ? (
        <p class="measure">{t("share.leadOne")}</p>
      ) : staged.length > 1 ? (
        <p class="measure">{t("share.leadMany", { count: staged.length })}</p>
      ) : null}
      {staged.length > 0 ? (
        <ul class="staged-list">
          {staged.map((file, index) => (
            // Session-only files: name + position is a stable-enough key.
            <li class="staged-row" key={`${file.name}-${index}`}>
              <span class="staged-name">{file.name}</span>
              <span class="staged-size">{formatBytes(file.size)}</span>
              <button type="button" class="btn btn-ghost" onClick={() => onRemove(file)}>
                {t("share.remove")}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p class="hint">{t("share.hint")}</p>
      <div class="home-actions">
        <button type="button" class="btn btn-primary btn-lg" onClick={onStart}>
          {t("action.start")}
        </button>
        <button type="button" class="btn btn-secondary btn-lg" onClick={onJoin}>
          {t("action.join")}
        </button>
      </div>
      <div class="row-actions">
        <button type="button" class="btn btn-ghost" onClick={onBack}>
          {t("action.back")}
        </button>
      </div>
    </section>
  );
}
