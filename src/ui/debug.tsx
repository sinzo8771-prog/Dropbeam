import { useEffect, useState } from "preact/hooks";
import { isWebRtcSupported } from "../core/peer/peer-session";
import type { ConnectionState } from "../core/peer/state-machine";
import type { StringKey } from "../core/platform/i18n";
import { isFsaSupported } from "../core/storage/fsa-sink";
import { isOpfsSupported, probeOpfsWrite } from "../core/storage/opfs-sink";
import { chooseSink } from "../core/storage/select-sink";
import type { SinkKind } from "../core/storage/sink";

/**
 * Developer debug panel (M7 / FR-50). Hidden by default: the only
 * way to see it is the deliberate gesture in `DebugGesture`, so it
 * can never be mistaken for a product affordance. Everything it
 * shows is a raw machine value — no interpolation, no copy to
 * localize beyond the labels.
 */

/** Session metrics the app shell already knows (PRD 7.1 state,
    channel phase, transfer load, MITM check). The PWA-side health
    — build id, service worker, cache — is gathered here instead,
    because only the browser exposes those APIs. */
export type DebugSessionMetrics = {
  /** Connection state machine snapshot (PRD 7.1). */
  readonly state: ConnectionState;
  /** Wire protocol version of the live peer session, if any. */
  readonly protocol: number | null;
  /** Data channel `readyState`, or "none" before a session exists. */
  readonly channel: string;
  /** Files currently sending or receiving (terminal phases excluded). */
  readonly filesInFlight: number;
  /** True once the verification phrase is available on both sides. */
  readonly verified: boolean;
};

export type DebugPanelProps = {
  readonly session: DebugSessionMetrics;
  readonly t: (key: StringKey) => string;
  readonly onClose: () => void;
};

export type DebugGestureProps = {
  readonly onOpen: () => void;
}; /** `navigator.caches` is the standard path, but some browser builds
    expose only the global `caches` — fall back so the panel never
    reports "missing" on a page that actually has a cache. */
function cacheStorage(): CacheStorage | undefined {
  const fromNavigator = (
    navigator as Navigator & {
      caches?: CacheStorage;
    }
  ).caches;
  if (fromNavigator) return fromNavigator;
  return (globalThis as typeof globalThis & { caches?: CacheStorage }).caches;
}

/** The build id is stamped into the service worker's cache name
    (`dropbeam-<build-id>`) by `scripts/postbuild.mjs`, so the
    cache registry is the runtime source of truth (FR-50). */
function useBuildId(): string | undefined {
  const [id, setId] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const storage = cacheStorage();
    if (!storage) {
      // No cache API (private mode, or the dev server): say so
      // instead of pretending to know the build.
      if (import.meta.env.DEV) setId("dev");
      return;
    }
    storage
      .keys()
      .then((names) => {
        if (cancelled) return;
        const match = names.find((name) => name.startsWith("dropbeam-"));
        if (match) setId(match.slice("dropbeam-".length));
        else if (import.meta.env.DEV) setId("dev");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return id;
}

export type PwaHealth = {
  /** True once a service worker controls this page. */
  readonly swControlled: boolean;
  /** The Dropbeam cache: "ok" (shell cached), "empty", or "missing". */
  readonly cache: "ok" | "empty" | "missing";
};

/** SW control + cache contents, re-read while the panel is open so
    the panel reflects the activate step of a pending update. */
function usePwaHealth(): PwaHealth {
  const [health, setHealth] = useState<PwaHealth>({
    swControlled: false,
    cache: "missing",
  });
  useEffect(() => {
    let cancelled = false;
    const storage = cacheStorage();
    const read = async () => {
      const controlled = navigator.serviceWorker?.controller != null;
      let cache: PwaHealth["cache"] = "missing";
      if (storage) {
        const name = (await storage.keys()).find((n) => n.startsWith("dropbeam-"));
        if (name) {
          const entries = await storage
            .open(name)
            .then((c) => c.keys())
            .catch(() => [] as unknown[]);
          cache = entries.length > 0 ? "ok" : "empty";
        }
      }
      if (!cancelled) setHealth({ swControlled: controlled, cache });
    };
    void read();
    const timer = setInterval(() => void read(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return health;
}

/**
 * What this browser can do, as the app itself detects it (FR-50).
 *
 * Every value comes from the function the real code path runs on — the same
 * `isWebRtcSupported`, `isFsaSupported`, `isOpfsSupported` and `chooseSink` that
 * pairing and the storage layer call — so a field report shows the decision this
 * device actually makes rather than a second opinion about it. The one addition
 * is `opfsWrite`: reachability and writability are different facts, and the sinks
 * only test the first.
 */
export type Capabilities = {
  /** `RTCPeerConnection` exists — without it the app cannot transfer at all. */
  readonly webrtc: boolean;
  /** File System Access: the native save picker (PRD 8.5). */
  readonly fsa: boolean;
  /** The OPFS namespace, which is what `isOpfsSupported` reports. */
  readonly opfs: boolean;
  /** Whether that namespace accepted a write; null until the probe answers. */
  readonly opfsWrite: boolean | null;
  /** The sink `chooseSink()` would take (PRD 8.5). */
  readonly sink: SinkKind;
};

/**
 * The capabilities, read once per panel mount. The three detections and the sink
 * choice are synchronous, so they are taken during the first render and stay put;
 * the write probe is asynchronous and reported as null until it lands, because a
 * panel that guessed "ok" while probing would be reporting a fact it does not
 * have.
 */
function useCapabilities(): Capabilities {
  const [detected] = useState(() => ({
    webrtc: isWebRtcSupported(),
    fsa: isFsaSupported(),
    opfs: isOpfsSupported(),
    sink: chooseSink().kind,
  }));
  const [opfsWrite, setOpfsWrite] = useState<boolean | null>(null);
  useEffect(() => {
    if (!detected.opfs) return;
    let cancelled = false;
    void probeOpfsWrite().then((ok) => {
      if (!cancelled) setOpfsWrite(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [detected.opfs]);
  return { ...detected, opfsWrite };
}

/** Gap between taps that keeps the reveal count accumulating:
    a next tap inside the window continues the count, a tap at or
    past it decays the count to 1. Both boundaries are asserted in
    tests/unit/debug.test.tsx (699 continues, 700 decays). */
export const TAP_WINDOW_MS = 700;

// The hidden reveal gesture: 8 taps, each within TAP_WINDOW_MS of
// the last, on the right 52 px of the screen. Taps inside the panel
// itself are ignored so closing it can never re-open it. Module
// state, because the count must survive the panel mounting and
// unmounting.
let taps = 0;
let lastTapAt = 0;

export function DebugGesture({ onOpen }: DebugGestureProps) {
  useEffect(() => {
    const handle = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".debug-panel")) return;
      if (window.innerWidth - event.clientX > 52) return;
      const now = Date.now();
      taps = now - lastTapAt < TAP_WINDOW_MS ? taps + 1 : 1;
      lastTapAt = now;
      if (taps >= 8) {
        taps = 0;
        onOpen();
      }
    };
    window.addEventListener("pointerdown", handle);
    return () => window.removeEventListener("pointerdown", handle);
  }, [onOpen]);

  // The gesture renders nothing visible: a hidden control must not
  // leave a trace in the layout or the a11y tree.
  return null;
}

type RowProps = {
  readonly label: string;
  readonly value: string;
  readonly health?: "good" | "warn";
};

/** One label/value line. `dl` > `div` > `dt`/`dd` keeps the
    label–value pairing in the a11y tree (PRD 11.4). */
function Row({ label, value, health }: RowProps) {
  return (
    <div class="debug-panel-row" data-health={health}>
      <dt class="label">{label}</dt>
      <dd class="value">{value}</dd>
    </div>
  );
}

export function DebugPanel({ session, t, onClose }: DebugPanelProps) {
  const buildId = useBuildId();
  const health = usePwaHealth();
  const caps = useCapabilities();

  return (
    <div class="debug-panel" role="region" aria-label={t("debug.title")}>
      <div class="debug-panel-head">
        <span class="debug-panel-title">{t("debug.title")}</span>
        <button type="button" class="btn" onClick={onClose}>
          {t("action.close")}
        </button>
      </div>

      <dl>
        <Row label={t("debug.buildId")} value={buildId ?? "—"} />
        <Row
          label={t("debug.sw")}
          value={health.swControlled ? "controlled" : "uncontrolled"}
          health={health.swControlled ? "good" : "warn"}
        />
        <Row
          label={t("debug.cache")}
          value={health.cache}
          health={health.cache === "ok" ? "good" : "warn"}
        />
        {/* Capabilities: the environment the app decided on, in the same order
            the sink falls back through. "—" on the write row means the probe has
            not answered yet; "n/a" means there is no OPFS to write to, which the
            row above already flags. */}
        <Row
          label={t("debug.webrtc")}
          value={caps.webrtc ? "yes" : "no"}
          health={caps.webrtc ? "good" : "warn"}
        />
        <Row
          label={t("debug.fsa")}
          value={caps.fsa ? "yes" : "no"}
          health={caps.fsa ? "good" : "warn"}
        />
        <Row
          label={t("debug.opfs")}
          value={caps.opfs ? "yes" : "no"}
          health={caps.opfs ? "good" : "warn"}
        />
        <Row
          label={t("debug.opfsWrite")}
          value={
            !caps.opfs ? "n/a" : caps.opfsWrite === null ? "—" : caps.opfsWrite ? "ok" : "fails"
          }
          health={caps.opfsWrite === null ? undefined : caps.opfsWrite ? "good" : "warn"}
        />
        <Row
          label={t("debug.sink")}
          value={caps.sink}
          health={caps.sink === "memory" ? "warn" : "good"}
        />
        <Row label={t("debug.state")} value={session.state} />
        <Row
          label={t("debug.protocol")}
          value={session.protocol != null ? `v${session.protocol}` : "—"}
        />
        <Row
          label={t("debug.channel")}
          value={session.channel}
          health={session.channel === "open" ? "good" : "warn"}
        />
        <Row label={t("debug.files")} value={String(session.filesInFlight)} />
        <Row label={t("debug.verified")} value={session.verified ? "yes" : "no"} />
      </dl>

      <p class="debug-panel-note">{t("debug.hint")}</p>
    </div>
  );
}
