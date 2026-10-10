import { useEffect, useState } from "preact/hooks";
import { runSelfTest, type SelfTestResult } from "../core/peer/self-test";
import type { Translate } from "../core/platform/i18n";

/**
 * "Test my connection" (PRD FR-62): runs the loopback self-test as
 * soon as the screen opens and reports pass/fail with the stage that
 * failed, reusing the PRD 7.1 wording. The result lives in a
 * `data-result` attribute so tests (and the debug gesture's e2e) can
 * assert the outcome without parsing prose.
 */

type Props = {
  t: Translate;
  onBack: () => void;
  onTroubleshoot: () => void;
  /** Injected in tests; defaults to the real loopback run. */
  run?: () => Promise<SelfTestResult>;
};

const FAIL_KEYS = {
  unsupported: "selftest.err.unsupported",
  gathering: "selftest.err.gathering",
  connecting: "selftest.err.connecting",
} as const;

export function SelfTestScreen({ t, onBack, onTroubleshoot, run = runSelfTest }: Props) {
  const [attempt, setAttempt] = useState(0);
  const [running, setRunning] = useState(true);
  const [result, setResult] = useState<SelfTestResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRunning(true);
    setResult(null);
    void run().then((r) => {
      if (cancelled) return;
      setRunning(false);
      setResult(r);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt, run]);

  const outcome = running ? "running" : result === null ? "idle" : result.ok ? "pass" : "fail";
  return (
    <section class="screen screen-selftest" data-result={outcome}>
      <h1>{t("selftest.title")}</h1>
      <p class="measure">{t("selftest.lead")}</p>
      <p class="selftest-status" role="status">
        {running
          ? t("selftest.running")
          : result === null
            ? ""
            : result.ok
              ? t("selftest.pass", { ms: result.ms })
              : `${t("selftest.fail")} ${t(FAIL_KEYS[result.stage])}`}
      </p>
      <div class="row-actions">
        <button
          type="button"
          class="btn btn-secondary"
          disabled={running}
          onClick={() => setAttempt((n) => n + 1)}
        >
          {t("selftest.run")}
        </button>
        {result !== null && !result.ok ? (
          <button type="button" class="btn btn-secondary" onClick={onTroubleshoot}>
            {t("selftest.troubleLink")}
          </button>
        ) : null}
        <button type="button" class="btn btn-primary" onClick={onBack}>
          {t("action.back")}
        </button>
      </div>
    </section>
  );
}
