import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Beam } from "./components/Beam";
import { CodeBox } from "./components/CodeBox";
import { Prompt } from "./components/Prompt";
import { QrTile } from "./components/QrTile";
import { VerifyCard } from "./components/VerifyCard";
import { messageForError, translatorFor, type Language } from "../core/platform/i18n";
import { SettingsStore } from "../core/platform/storage";
import { buildPairLink, extractCode, parsePairLink } from "../core/handshake/link";
import { planQrContent, type QrPlan } from "../core/handshake/qr-render";
import { FRAME_INTERVAL_MS, FrameAssembler } from "../core/handshake/qr-frames";
import { isWebRtcSupported, PeerSession } from "../core/peer/peer-session";
import { SessionController } from "../core/peer/session-controller";
import { ConnectionApproval } from "../core/peer/approval";
import type { VerificationPhrase } from "../core/peer/verify-phrase";
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
  const [phrase, setPhrase] = useState<VerificationPhrase | null>(null);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approved, setApproved] = useState(false);
  const assembler = useRef(new FrameAssembler());
  const videoRef = useRef<HTMLVideoElement>(null);
  const peerSessionRef = useRef<PeerSession | null>(null);
  /**
   * One controller per attempt. It is created together with the transport and
   * reused for every later step, because the verification phrase needs the
   * fingerprints collected across both halves of the handshake (PRD 9.3).
   */
  const controllerRef = useRef<SessionController | null>(null);
  const approvalRef = useRef<ConnectionApproval | null>(null);

  const lang: Language = pref.language;
  const t = useMemo(() => translatorFor(lang), [lang]);
  const base =
    baseUrl ?? (typeof location !== "undefined" ? location.origin : "https://dropbeam.example");

  // The SessionController owns the connection state machine, so the UI and the
  // core can never disagree about where the session is (ARCHITECTURE rule 2).
  // One machine lives for the whole app; the side for an attempt is chosen on
  // it (Start → host, Join → guest) rather than by rebuilding it.
  const [side, setSide] = useState<"host" | "guest">("host");
  const machine = useMemo(() => new ConnectionStateMachine({ side: "host" }), []);

  /** Choose the side for the next attempt before driving any transition. */
  const chooseSide = useCallback(
    (next: "host" | "guest"): void => {
      setSide(next);
      machine.setSide(next);
    },
    [machine],
  );

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

  // PRD 9.3: the man-in-the-middle check. Derived from the two DTLS
  // fingerprints once the channel is open, so it is available on both sides.
  useEffect(() => {
    if (screen !== "CONNECTED") {
      setPhrase(null);
      return;
    }
    let live = true;
    void controllerRef.current?.verificationPhrase().then((p) => {
      if (live) setPhrase(p);
    });
    return () => {
      live = false;
    };
  }, [screen]);

  // PRD 9.5: the host must explicitly allow the peer. Transfers stay blocked
  // until then; the gate lives in core so the UI cannot enable them by mistake.
  useEffect(() => {
    if (screen !== "CONNECTED" || side !== "host") return;
    let gate = approvalRef.current;
    if (!gate) {
      gate = new ConnectionApproval(peerName || t("connect.unknownPeer"), {
        onPrompt: () => setApprovalOpen(true),
        onStateChange: (state) => {
          if (state === "allowed") setApproved(true);
        },
      });
      approvalRef.current = gate;
    }
    // `request()` is one-shot, so re-renders never re-prompt.
    gate.request();
  }, [screen, side, peerName, t]);

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
      chooseSide("guest");
      setOfferCode(link.code);
      machine.send("join");
    }
  }, [machine, chooseSide]);

  /** "Try again" (PRD 7.1): clear the reason code, codes and assembly too. */
  const tryAgain = (): void => {
    setError(null);
    setToast("");
    setOfferCode("");
    setAnswerCode("");
    setPeerName("");
    setPhrase(null);
    setApproved(false);
    setApprovalOpen(false);
    assembler.current.reset();
    // PRD 7.1: cleanup closes the peer connection and stops the camera.
    peerSessionRef.current?.close();
    peerSessionRef.current = null;
    controllerRef.current = null;
    approvalRef.current = null;
    machine.reset();
  };

  /**
   * Build the transport + controller pair that drives one side (PRD 5.1).
   * The controller is kept in a ref and reused for every later step of the
   * same attempt, so the DTLS fingerprints it collects stay available.
   */
  const beginSession = (role: "host" | "guest"): SessionController => {
    // A fresh attempt needs a fresh gate: PRD 9.5 approval never carries over.
    approvalRef.current = null;
    setApproved(false);
    setApprovalOpen(false);
    setPhrase(null);

    const session = new PeerSession(
      {
        // The answerer only learns the channel opened via this event, so this
        // is what drives the guest to CONNECTED (PRD 7.1).
        onChannel: (channel) => {
          const snap = controllerRef.current?.markConnected(channel);
          if (snap) {
            setScreen(snap.state as ConnectionState);
            setPeerName(snap.peerName);
          }
        },
        onClosed: () => fail("PEER_LOST"),
      },
      { ice: pref.ice, deviceName: pref.deviceName },
    );
    peerSessionRef.current = session;
    const controller = new SessionController({
      side: role,
      baseUrl: base,
      transport: session,
      deviceName: pref.deviceName,
      // Share the UI's machine so screen and session never disagree.
      machineInstance: machine,
    });
    controllerRef.current = controller;
    return controller;
  };

  const start = async (): Promise<void> => {
    setError(null);
    chooseSide("host");
    if (!isWebRtcSupported()) {
      fail("UNSUPPORTED");
      return;
    }
    // Gathering + encoding the offer into a QR/link/paste code (FR-3).
    const snap = await beginSession("host").startHosting();
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
        chooseSide("guest");
        const snap = await beginSession("guest").joinWithCode(event.code);
        setScreen(snap.state as ConnectionState);
        setAnswerCode(snap.code);
        setPeerName(snap.peerName);
        setError(snap.error);
        return;
      }

      const controller = controllerRef.current;
      if (!controller) {
        fail("INTERNAL");
        return;
      }
      const snap = await controller.applyReplyCode(event.code);
      setScreen(snap.state as ConnectionState);
      setPeerName(snap.peerName);
      setError(snap.error);
    },
    [fail, side, t],
  );

  /** Join flow (PRD 5.1 step 2): enter the guest state and wait for a code. */
  const join = (): void => {
    setError(null);
    chooseSide("guest");
    beginSession("guest").beginJoin();
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

  /**
   * Join side: paste the host's offer code. This has to actually answer the
   * offer — parking the code in state left the screen parked on the camera
   * view forever, so "Paste" silently did nothing.
   */
  const pasteOffer = async (): Promise<void> => {
    const code = await readClipboardCode();
    if (!code) return;
    setError(null);
    chooseSide("guest");
    const snap = await beginSession("guest").joinWithCode(code);
    setScreen(snap.state as ConnectionState);
    setAnswerCode(snap.code);
    setPeerName(snap.peerName);
    setError(snap.error);
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
              <button type="button" class="btn btn-secondary btn-lg" onClick={join}>
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
          <section
            class="screen screen-connected"
            // The transfer UI reads this to stay blocked until the host allows.
            data-approval={side === "guest" ? "granted" : approved ? "allowed" : "pending"}
          >
            <Beam active={screen === "CONNECTED"} />
            <h1>{t("connect.title")}</h1>
            {/* FR-42: the peer's label is shown as text, never markup. */}
            {peerName ? <p class="peer-name">{peerName}</p> : null}
            {screen === "CONNECTING" ? <p class="measure">{t("connect.working")}</p> : null}
            {screen === "CONNECTED" && phrase ? (
              <VerifyCard
                phrase={phrase}
                label={t("transfer.verification")}
                help={t("transfer.verificationHelp")}
                digitsLabel={t("transfer.verificationDigits")}
              />
            ) : null}
            {screen === "CONNECTED" && side === "host" ? (
              <p class="measure" role="status">
                {approved ? t("connect.allowed") : t("connect.pendingApproval")}
              </p>
            ) : null}
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

      {/* PRD 9.5: the host's approval gate. Declining tears the session down
          rather than leaving a half-open channel that looks connected. */}
      <Prompt
        open={approvalOpen && !approved}
        title={t("connect.approveTitle", { name: peerName || t("connect.unknownPeer") })}
        body={<p>{t("connect.approveBody")}</p>}
        acceptLabel={t("connect.allow")}
        declineLabel={t("action.decline")}
        onAccept={() => {
          approvalRef.current?.approve();
          setApprovalOpen(false);
        }}
        onDecline={() => {
          approvalRef.current?.deny();
          setApprovalOpen(false);
          fail("PEER_DECLINED");
        }}
      />
    </div>
  );
}
