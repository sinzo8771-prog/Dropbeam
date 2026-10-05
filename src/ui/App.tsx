import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Beam } from "./components/Beam";
import { CodeBox } from "./components/CodeBox";
import { Prompt } from "./components/Prompt";
import { QrTile } from "./components/QrTile";
import { messageForError, translatorFor, type Language } from "../core/platform/i18n";
import { SettingsStore } from "../core/platform/storage";
import { buildPairLink, extractCode, parsePairLink } from "../core/handshake/link";
import { planQrContent, type QrPlan } from "../core/handshake/qr-render";
import { FRAME_INTERVAL_MS, FrameAssembler } from "../core/handshake/qr-frames";
import { isWebRtcSupported, PeerSession } from "../core/peer/peer-session";
import { SessionController } from "../core/peer/session-controller";
import { ConnectionStateMachine, type ConnectionState } from "../core/peer/state-machine";
import type { ErrorCode } from "../core/errors";

/**
 * Application shell (PRD 10.1). Renders whichever screen the connection state
 * machine reports; UI never flips connection state directly (ARCHITECTURE
 * rule 2). Peer-supplied text is rendered as text nodes only.
 */

export type AppProps = {
  /** Injected in tests; defaults to a fresh settings store. */
  settings?: SettingsStore;
  /** Base URL for pairing links; injected so tests get deterministic output. */
  baseUrl?: string;
};

/**
 * Single QR when it fits; otherwise animate the `DBF` frames at 4 fps (FR-4).
 * The animation is the only timed motion allowed beyond connect/progress.
 */
function MultiOrSingleQr({ plan, label }: { plan: QrPlan; label: string }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (plan.mode !== "frames") return;
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % plan.frames.length);
    }, FRAME_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [plan]);

  if (plan.mode === "single") return <QrTile content={plan.content} label={label} />;
  const content = plan.frames[index % plan.frames.length] ?? "";
  return <QrTile content={content} label={`${label} (${index + 1}/${plan.frames.length})`} />;
}

export function App({ settings, baseUrl }: AppProps = {}) {
  const store = useMemo(() => settings ?? new SettingsStore(), [settings]);
  const [pref, setPref] = useState(store.current);
  const [screen, setScreen] = useState<ConnectionState>("IDLE");
  const [offerCode, setOfferCode] = useState("");
  const [answerCode, setAnswerCode] = useState("");
  const [peerName, setPeerName] = useState("");
  const [error, setError] = useState<ErrorCode | null>(null);
  const [toast, setToast] = useState("");
  const [copied, setCopied] = useState("");
  const [scanOpen, setScanOpen] = useState(false);
  const assembler = useRef(new FrameAssembler());
  const videoRef = useRef<HTMLVideoElement>(null);
  const peerSessionRef = useRef<PeerSession | null>(null);

  const lang: Language = pref.language;
  const t = useMemo(() => translatorFor(lang), [lang]);
  const base =
    baseUrl ?? (typeof location !== "undefined" ? location.origin : "https://dropbeam.example");

  // The SessionController owns the connection state machine, so the UI and the
  // core can never disagree about where the session is (ARCHITECTURE rule 2).
  // It is rebuilt when the side flips (Start → host, Join → guest).
  const [side, setSide] = useState<"host" | "guest">("host");
  const machine = useMemo(() => new ConnectionStateMachine({ side }), [side]);

  useEffect(() => store.subscribe(setPref), [store]);
  useEffect(
    () => () => {
      // Never leave a peer connection or camera running on unmount.
      peerSessionRef.current?.close();
      machine.dispose();
    },
    [machine],
  );
  useEffect(() => {
    setScreen(machine.state);
    return machine.subscribe((snap) => setScreen(snap.state));
  }, [machine]);

  const fail = useCallback(
    (code: ErrorCode) => {
      setError(code);
      machine.failWith(code);
    },
    [machine],
  );

  // FR-3 / FR-6: the offer or answer arrives in the URL fragment, so a shared
  // link opens the app preloaded (PRD 5.1 step 2).
  useEffect(() => {
    const link = typeof location === "undefined" ? null : parsePairLink(location.hash);
    if (!link) return;
    if (link.kind === "j") {
      setSide("guest");
      setOfferCode(link.code);
      machine.send("join");
    }
  }, [machine]);

  /** "Try again" (PRD 7.1): clear the reason code, codes and assembly too. */
  const tryAgain = (): void => {
    setError(null);
    setToast("");
    setOfferCode("");
    setAnswerCode("");
    setPeerName("");
    assembler.current.reset();
    // PRD 7.1: cleanup closes the peer connection and stops the camera.
    peerSessionRef.current?.close();
    peerSessionRef.current = null;
    machine.reset();
  };

  /** Build the transport + controller pair that drives one side (PRD 5.1). */
  const makeController = (role: "host" | "guest", session: PeerSession): SessionController =>
    new SessionController({
      side: role,
      baseUrl: base,
      transport: session,
      deviceName: pref.deviceName,
      // Share the UI's machine so screen and session never disagree.
      machineInstance: machine,
    });

  const start = async (): Promise<void> => {
    setError(null);
    setSide("host");
    if (!isWebRtcSupported()) {
      fail("UNSUPPORTED");
      return;
    }
    const session = new PeerSession({}, { ice: pref.ice, deviceName: pref.deviceName });
    peerSessionRef.current = session;
    // Gathering + encoding the offer into a QR/link/paste code (FR-3).
    const snap = await makeController("host", session).startHosting();
    setScreen(snap.state as ConnectionState);
    setOfferCode(snap.code);
    setPeerName(snap.peerName);
    setError(snap.error);
  };

  /**
   * One scanned/pasted string drives whichever side we are (PRD 5.1):
   * - host in WAITING_FOR_REPLY → the guest's answer, then CONNECTED;
   * - guest in SCANNING_OFFER → the host's offer, then show our answer.
   */
  const acceptScanned = useCallback(
    async (text: string) => {
      const event = assembler.current.feed(text);
      if (event.kind === "ignored") {
        fail("CODE_INVALID");
        return;
      }
      if (event.kind === "progress") {
        setToast(t("pair.assemblingProgress", { received: event.received, total: event.total }));
        return;
      }
      setToast("");

      if (side === "guest") {
        const session = new PeerSession({}, { ice: pref.ice, deviceName: pref.deviceName });
        peerSessionRef.current = session;
        const snap = await makeController("guest", session).joinWithCode(event.code);
        setScreen(snap.state as ConnectionState);
        setAnswerCode(snap.code);
        setPeerName(snap.peerName);
        setError(snap.error);
        return;
      }

      const session = peerSessionRef.current;
      if (!session) {
        fail("INTERNAL");
        return;
      }
      const snap = await makeController("host", session).applyReplyCode(event.code);
      setScreen(snap.state as ConnectionState);
      setPeerName(snap.peerName);
      setError(snap.error);
    },
    [fail, pref.deviceName, pref.ice, side, t],
  );

  /** Join flow (PRD 5.1 step 2): enter the guest state and wait for a code. */
  const join = (): void => {
    setError(null);
    setSide("guest");
    const session = new PeerSession({}, { ice: pref.ice, deviceName: pref.deviceName });
    peerSessionRef.current = session;
    makeController("guest", session).beginJoin();
  };

  // The offer/answer QR shows the link (so any camera app opens the app); the
  // code itself is offered as text and for multi-frame fallback (FR-3, FR-4).
  const offerLink = offerCode ? buildPairLink(base, "j", offerCode) : "";
  const answerLink = answerCode ? buildPairLink(base, "a", answerCode) : "";
  const offerPlan = offerCode ? planQrContent(offerLink, offerCode) : null;
  const answerPlan = answerCode ? planQrContent(answerLink, answerCode) : null;

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(t("action.copied"));
      setTimeout(() => setCopied(""), 2000);
    } catch {
      setCopied("");
    }
  };

  const pasteReply = async (): Promise<void> => {
    const code = await readClipboardCode();
    if (code) await acceptScanned(code);
  };

  /** Join side: paste the host's offer code. */
  const pasteOffer = async (): Promise<void> => {
    const code = await readClipboardCode();
    if (!code) return;
    setOfferCode(code);
    join();
  };

  const readClipboardCode = async (): Promise<string | null> => {
    try {
      const text = await navigator.clipboard.readText();
      return extractCode(text);
    } catch {
      setError("CODE_INVALID");
      return null;
    }
  };

  return (
    <div class="app">
      <header class="app-header">
        <strong>{t("app.title")}</strong>
        {copied ? (
          <span class="toast" role="status">
            {copied}
          </span>
        ) : null}
        {toast ? (
          <span class="toast" role="status">
            {toast}
          </span>
        ) : null}
      </header>

      <main class="stack" data-screen={screen}>
        {screen === "IDLE" ? (
          <section class="screen screen-home">
            <h1>{t("idle.title")}</h1>
            <p class="measure">{t("idle.lead")}</p>
            <div class="home-actions">
              <button type="button" class="btn btn-primary btn-lg" onClick={start}>
                {t("action.start")}
              </button>
              <button
                type="button"
                class="btn btn-secondary btn-lg"
                onClick={() => machine.send("join")}
              >
                {t("action.join")}
              </button>
            </div>
          </section>
        ) : null}

        {/* The host shows its offer while waiting; both map to the pairing screen. */}
        {screen === "WAITING_FOR_REPLY" || screen === "SHOWING_OFFER" ? (
          <section class="screen screen-pair">
            <h1>{t("pair.title")}</h1>
            {offerPlan ? (
              <>
                <MultiOrSingleQr plan={offerPlan} label={t("pair.title")} />
                <CodeBox
                  code={offerCode}
                  label={t("action.copy")}
                  copyLabel={t("action.copy")}
                  copiedLabel={t("action.copied")}
                  onCopy={copy}
                />
              </>
            ) : (
              // Still gathering ICE (GATHERING): never show an empty code box.
              <p class="measure" role="status">
                {t("pair.preparing")}
              </p>
            )}
            <p class="measure">{t("pair.waitingReply")}</p>
            <p class="hint">{t("pair.noWebcam")}</p>
            <div class="row-actions">
              <button type="button" class="btn btn-secondary" onClick={() => setScanOpen(true)}>
                {t("pair.scanReply")}
              </button>
              <button type="button" class="btn btn-secondary" onClick={() => void pasteReply()}>
                {t("pair.pasteReply")}
              </button>
            </div>
          </section>
        ) : null}

        {screen === "SCANNING_OFFER" ? (
          <section class="screen screen-join">
            <h1>{t("pair.scanOffer")}</h1>
            {/* Camera view with frame guide; the scanner is started lazily so
                the camera permission prompt waits for an explicit action. */}
            <div class="scanner-frame">
              <video ref={videoRef} class="scanner-video" playsInline muted />
            </div>
            <div class="row-actions">
              <button type="button" class="btn btn-primary" onClick={() => setScanOpen(true)}>
                {t("action.scan")}
              </button>
              <button type="button" class="btn btn-secondary" onClick={() => void pasteOffer()}>
                {t("action.paste")}
              </button>
            </div>
          </section>
        ) : null}

        {screen === "CONNECTING" || screen === "CONNECTED" ? (
          <section class="screen screen-connected">
            <Beam active={screen === "CONNECTED"} />
            <h1>{t("connect.title")}</h1>
            {/* FR-42: the peer's label is shown as text, never markup. */}
            {peerName ? <p class="peer-name">{peerName}</p> : null}
            {screen === "CONNECTING" ? <p class="measure">{t("connect.working")}</p> : null}
          </section>
        ) : null}

        {screen === "SHOWING_ANSWER" && answerPlan ? (
          <section class="screen screen-reply">
            <Beam active />
            <h1>{t("connect.title")}</h1>
            <MultiOrSingleQr plan={answerPlan} label={t("pair.title")} />
            <CodeBox
              code={answerCode}
              label={t("action.copy")}
              copyLabel={t("action.copy")}
              copiedLabel={t("action.copied")}
              onCopy={copy}
            />
          </section>
        ) : null}

        {error ? (
          <div class="alert" role="alert">
            <p>{messageForError(error, lang)}</p>
            <button type="button" class="btn btn-primary" onClick={tryAgain}>
              {t("action.tryAgain")}
            </button>
          </div>
        ) : null}
      </main>

      <Prompt
        open={scanOpen}
        title={t("pair.scanReply")}
        acceptLabel={t("action.accept")}
        declineLabel={t("action.decline")}
        onAccept={() => setScanOpen(false)}
        onDecline={() => setScanOpen(false)}
      />
    </div>
  );
}
