import type { Translate } from "../core/platform/i18n";

/**
 * Help (PRD FR-60: "How it works" in 4 steps with a diagram) and
 * Troubleshooting (FR-61). Native elements only — headings, an ordered
 * list and a real table (PRD 10.6) — so structure survives with CSS
 * off and reads correctly in the a11y tree. Colors come from tokens
 * via `currentColor`; the diagram carries no text, only the
 * aria-label, so nothing inside it needs translation.
 */

type HelpProps = {
  t: Translate;
  onBack: () => void;
  onTroubleshoot: () => void;
};

type TroubleProps = {
  t: Translate;
  onBack: () => void;
};

/**
 * Two devices joined by a beam: QR on the first, a file arriving on
 * the second. Static and monochrome with an accent beam — motion is
 * reserved for connect/transfer states by PRD 10.2 rule 8.
 */
export function HowItWorksDiagram({ label }: { label: string }) {
  return (
    <svg class="help-diagram" viewBox="0 0 320 120" role="img" aria-label={label} focusable="false">
      {/* First device, showing the QR tile. */}
      <rect class="hd-device" x="16" y="14" width="58" height="92" rx="8" />
      <rect class="hd-qr" x="27" y="34" width="36" height="36" rx="3" />
      {/* QR eyes: recognisable as a code without pretending to be one. */}
      <rect class="hd-qr-eye" x="31" y="38" width="10" height="10" rx="1" />
      <rect class="hd-qr-eye" x="49" y="38" width="10" height="10" rx="1" />
      <rect class="hd-qr-eye" x="31" y="56" width="10" height="10" rx="1" />
      <rect class="hd-qr-dot" x="49" y="56" width="4" height="4" />
      <rect class="hd-qr-dot" x="55" y="62" width="4" height="4" />
      {/* The beam: pairing then transfer, left to right. */}
      <line class="hd-beam" x1="82" y1="60" x2="230" y2="60" />
      <path class="hd-beam" d="M230 53 L243 60 L230 67 Z" />
      {/* Second device, receiving a file. */}
      <rect class="hd-device" x="246" y="14" width="58" height="92" rx="8" />
      <path class="hd-file" d="M264 44 h14 l7 7 v21 h-21 z" />
      <path class="hd-file" d="M278 44 v7 h7" />
      <line class="hd-file" x1="268" y1="62" x2="281" y2="62" />
      <line class="hd-file" x1="268" y1="68" x2="281" y2="68" />
    </svg>
  );
}

const STEP_KEYS = {
  1: { title: "help.step1.title", body: "help.step1.body" },
  2: { title: "help.step2.title", body: "help.step2.body" },
  3: { title: "help.step3.title", body: "help.step3.body" },
  4: { title: "help.step4.title", body: "help.step4.body" },
} as const;

export function HelpScreen({ t, onBack, onTroubleshoot }: HelpProps) {
  const steps = [1, 2, 3, 4] as const;
  return (
    <section class="screen screen-help">
      <h1>{t("help.title")}</h1>
      <HowItWorksDiagram label={t("help.diagram")} />
      <ol class="help-steps">
        {steps.map((n) => (
          <li key={n}>
            <h2>{t(STEP_KEYS[n].title)}</h2>
            <p class="measure">{t(STEP_KEYS[n].body)}</p>
          </li>
        ))}
      </ol>
      <div class="row-actions">
        <button type="button" class="btn btn-secondary" onClick={onTroubleshoot}>
          {t("help.troubleLink")}
        </button>
        <button type="button" class="btn btn-primary" onClick={onBack}>
          {t("action.back")}
        </button>
      </div>
    </section>
  );
}

/** FR-61 sections, in the order the PRD lists them. */
const TROUBLE_KEYS = {
  sameWifi: { title: "ts.sameWifi.title", body: "ts.sameWifi.body" },
  isolation: { title: "ts.isolation.title", body: "ts.isolation.body" },
  vpn: { title: "ts.vpn.title", body: "ts.vpn.body" },
  hotspot: { title: "ts.hotspot.title", body: "ts.hotspot.body" },
  stun: { title: "ts.stun.title", body: "ts.stun.body" },
} as const;

export function TroubleshootScreen({ t, onBack }: TroubleProps) {
  // Browser names are brand names: identical in every locale, so they
  // stay literal. Cell values are catalog keys: transfer, install, share sheet.
  const rows = [
    ["Chrome / Edge (desktop)", "ts.v.yes", "ts.v.yes", "ts.v.no"],
    ["Chrome (Android)", "ts.v.yes", "ts.v.yes", "ts.v.yes"],
    ["Firefox (desktop)", "ts.v.yes", "ts.v.no", "ts.v.no"],
    ["Safari (macOS)", "ts.v.yes", "ts.v.dock", "ts.v.no"],
    ["Safari (iOS)", "ts.v.yes", "ts.v.home", "ts.v.no"],
  ] as const;
  const sections = Object.values(TROUBLE_KEYS);

  return (
    <section class="screen screen-help">
      <h1>{t("ts.title")}</h1>
      {sections.map((keys) => (
        <div class="ts-section" key={keys.title}>
          <h2>{t(keys.title)}</h2>
          <p class="measure">{t(keys.body)}</p>
        </div>
      ))}
      <div class="ts-section">
        <h2>{t("ts.browsers.title")}</h2>
        <div class="table-wrap">
          <table class="support-table">
            <thead>
              <tr>
                <th scope="col">{t("ts.col.browser")}</th>
                <th scope="col">{t("ts.col.transfer")}</th>
                <th scope="col">{t("ts.col.install")}</th>
                <th scope="col">{t("ts.col.share")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([browser, transfer, install, share]) => (
                <tr key={browser}>
                  <th scope="row">{browser}</th>
                  <td>{t(transfer)}</td>
                  <td>{t(install)}</td>
                  <td>{t(share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div class="row-actions">
        <button type="button" class="btn btn-primary" onClick={onBack}>
          {t("action.back")}
        </button>
      </div>
    </section>
  );
}
