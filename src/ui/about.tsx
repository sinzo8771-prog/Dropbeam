import type { Translate } from "../core/platform/i18n";

/**
 * About and privacy (PRD 10.1 screen 7, PRD 15).
 *
 * The PRD asks for an "About/Privacy" screen next to Settings, Help and
 * Troubleshooting, and §15 asks for four statements to be made exactly: no
 * data collected, no cookies, the optional STUN disclosure, and the hosting
 * provider's logs being outside our control. Those four are the screen's
 * substance - a legal page that says less than the privacy policy would be
 * worse than none, because a reader would take it as the whole account.
 *
 * The licence and the third-party notices are named here so the notices are
 * reachable by a user rather than only by whoever cloned the repository.
 *
 * Native elements only, like the help pages: headings, paragraphs and a
 * definition list, so the structure survives with CSS off and reads correctly
 * in the a11y tree. Colours come from tokens via `currentColor`.
 */

export type AboutProps = {
  t: Translate;
  onBack: () => void;
};

export function AboutScreen({ t, onBack }: AboutProps) {
  return (
    <section class="screen screen-help">
      <h1>{t("about.title")}</h1>
      <p class="measure">{t("about.intro")}</p>

      <div class="ts-section">
        <h2>{t("about.privacy.title")}</h2>
        <ul class="about-list">
          <li>{t("about.privacy.noData")}</li>
          <li>{t("about.privacy.noCookies")}</li>
          <li>{t("about.privacy.stun")}</li>
          <li>{t("about.privacy.hostLogs")}</li>
        </ul>
      </div>

      <div class="ts-section">
        <h2>{t("about.licence.title")}</h2>
        <p class="measure">{t("about.licence.body")}</p>
      </div>

      <div class="ts-section">
        <h2>{t("about.name.title")}</h2>
        <p class="measure">{t("about.name.body")}</p>
      </div>

      <div class="row-actions">
        <button type="button" class="btn btn-primary" onClick={onBack}>
          {t("action.back")}
        </button>
      </div>
    </section>
  );
}
