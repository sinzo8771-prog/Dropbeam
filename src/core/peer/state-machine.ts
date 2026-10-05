import { DropbeamError, type ErrorCode } from "../errors";

/**
 * Connection state machine (PRD 7.1) — the single source of truth for every
 * connection transition (docs/ARCHITECTURE.md rule 2). UI code renders the
 * current state; it never flips state directly.
 *
 *   IDLE
 *    ├─ Start ─▶ CREATING_OFFER ─▶ GATHERING ─▶ SHOWING_OFFER ─▶ WAITING_FOR_REPLY
 *    │                                                    │ reply provided
 *    │                                                    ▼
 *    └─ Join ─▶ SCANNING_OFFER ─▶ CREATING_ANSWER ─▶ GATHERING ─▶ SHOWING_ANSWER ─▶ CONNECTING
 *                                                                                 │
 *   WAITING_FOR_REPLY ───────────── reply applied ───────────────────────────────▶ CONNECTING
 *   CONNECTING ─▶ CONNECTED ─▶ (DISCONNECTED | FAILED) ─▶ IDLE
 *
 * Timeouts (PRD 7.1): GATHERING 10 s hard cap, CONNECTING 20 s,
 * WAITING_FOR_REPLY 10 min (matches code expiry).
 */

export type ConnectionState =
  | "IDLE"
  | "CREATING_OFFER"
  | "SCANNING_OFFER"
  | "CREATING_ANSWER"
  | "GATHERING"
  | "SHOWING_OFFER"
  | "WAITING_FOR_REPLY"
  | "SHOWING_ANSWER"
  | "CONNECTING"
  | "CONNECTED"
  | "DISCONNECTED"
  | "FAILED";

/** Internal pseudo-state: "the side's own SHOWING_* state", resolved on send. */
type RawState = ConnectionState | "SHOWING";

export type ConnectionEvent =
  | "start"
  | "join"
  | "offer-created"
  | "answer-created"
  | "gather-complete"
  | "offer-received"
  | "reply-applied"
  | "connected"
  | "disconnected"
  | "fail";

/** Which side of the handshake this machine is driving. */
export type Side = "host" | "guest";

export type ConnectionTimeouts = {
  /** PRD 7.1: GATHERING hard cap. */
  gathering: number;
  /** PRD 7.1 / §12 CONNECT_TIMEOUT. */
  connecting: number;
  /** PRD 7.1: bounded by code expiry. */
  waitingForReply: number;
};

export const DEFAULT_TIMEOUTS: ConnectionTimeouts = {
  gathering: 10_000,
  connecting: 20_000,
  waitingForReply: 10 * 60_000,
};

export type MachineOptions = {
  side?: Side;
  timeouts?: Partial<ConnectionTimeouts>;
  /**
   * Cleanup hook: close the peer connection, stop the camera, release the
   * wake lock. PRD 7.1 requires every failure/"Try again" to clean up.
   */
  onCleanup?: () => void;
  /** Injection seam for tests; defaults to wall-clock timers. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export type MachineSnapshot = {
  state: ConnectionState;
  side: Side;
  /** Populated when the machine is in FAILED. */
  error: ErrorCode | null;
};

type Listener = (snapshot: MachineSnapshot) => void;

const TIMEOUT_STATE: Partial<Record<ConnectionState, keyof ConnectionTimeouts>> = {
  GATHERING: "gathering",
  CONNECTING: "connecting",
  WAITING_FOR_REPLY: "waitingForReply",
};

/** PRD 12 reason code implied by each state's timeout. */
const TIMEOUT_CODES: Record<keyof ConnectionTimeouts, ErrorCode> = {
  gathering: "ICE_GATHER_TIMEOUT",
  connecting: "CONNECT_TIMEOUT",
  waitingForReply: "CODE_EXPIRED",
};

/** Legal transitions per PRD 7.1. Anything else is a programming error. */
const TRANSITIONS: Record<RawState, Partial<Record<ConnectionEvent, RawState>>> = {
  IDLE: { start: "CREATING_OFFER", join: "SCANNING_OFFER" },
  CREATING_OFFER: { "offer-created": "GATHERING", fail: "FAILED" },
  SCANNING_OFFER: { "offer-received": "CREATING_ANSWER", fail: "FAILED" },
  CREATING_ANSWER: { "answer-created": "GATHERING", fail: "FAILED" },
  GATHERING: { "gather-complete": "SHOWING", fail: "FAILED" },
  SHOWING_OFFER: { "reply-applied": "WAITING_FOR_REPLY", fail: "FAILED" },
  WAITING_FOR_REPLY: { "reply-applied": "CONNECTING", fail: "FAILED" },
  SHOWING_ANSWER: { connected: "CONNECTING", fail: "FAILED" },
  /**
   * Side-agnostic marker resolved to SHOWING_OFFER (host) or SHOWING_ANSWER
   * (guest) by `send`. It is never observable as a snapshot state.
   */
  SHOWING: { "reply-applied": "WAITING_FOR_REPLY", connected: "CONNECTING", fail: "FAILED" },
  CONNECTING: { connected: "CONNECTED", fail: "FAILED" },
  CONNECTED: { disconnected: "DISCONNECTED", fail: "FAILED" },
  DISCONNECTED: { start: "CREATING_OFFER", join: "SCANNING_OFFER" },
  FAILED: { start: "CREATING_OFFER", join: "SCANNING_OFFER" },
};

export function canTransition(from: RawState, event: ConnectionEvent): boolean {
  return TRANSITIONS[from]?.[event] !== undefined;
}

/** Terminal states: nothing further happens until the user retries. */
export function isTerminal(state: ConnectionState): boolean {
  return state === "FAILED" || state === "DISCONNECTED" || state === "IDLE";
}

export class ConnectionStateMachine {
  private raw: RawState = "IDLE";
  private readonly hostSide: Side;
  private readonly timeouts: ConnectionTimeouts;
  private readonly listeners = new Set<Listener>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onCleanup?: () => void;
  private timer: unknown = null;
  private failure: ErrorCode | null = null;

  constructor(opts: MachineOptions = {}) {
    this.hostSide = opts.side ?? "host";
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      opts.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    if (opts.onCleanup) this.onCleanup = opts.onCleanup;
  }

  get state(): ConnectionState {
    return this.resolve(this.raw);
  }

  /** SHOWING is side-agnostic internally; expose the concrete PRD state. */
  private resolve(state: RawState): ConnectionState {
    if (state !== "SHOWING") return state;
    return this.hostSide === "host" ? "SHOWING_OFFER" : "SHOWING_ANSWER";
  }

  get error(): ErrorCode | null {
    return this.failure;
  }

  snapshot(): MachineSnapshot {
    return { state: this.resolve(this.raw), side: this.hostSide, error: this.failure };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Drive a transition. Returns false (without changing anything) when the
   * event is not legal in the current state, so UI code can attach handlers
   * unconditionally without guarding.
   */
  send(event: ConnectionEvent): boolean {
    const next = TRANSITIONS[this.raw][event];
    if (!next) return false;
    this.clearPendingTimer();

    if (event === "fail") {
      this.failure = "INTERNAL";
      this.enter(next);
      return true;
    }
    // PRD 5.1: only the host waits for a reply; the guest connects straight
    // after showing its answer.
    if (next === "WAITING_FOR_REPLY" && this.hostSide !== "host") return false;
    this.enter(next);
    return true;
  }

  /** Fail with a specific PRD reason code (PRD 12). */
  failWith(code: ErrorCode): void {
    if (!TRANSITIONS[this.raw].fail) return;
    this.clearPendingTimer();
    this.failure = code;
    this.enter("FAILED");
  }

  /** "Try again" (PRD 7.1): back to IDLE after cleanup. */
  reset(): void {
    this.clearPendingTimer();
    this.failure = null;
    this.enter("IDLE");
    this.onCleanup?.();
  }

  private enter(state: RawState): void {
    this.raw = state;
    const resolved = this.resolve(state);
    if (resolved === "FAILED" || resolved === "DISCONNECTED") this.onCleanup?.();
    this.armTimeout(resolved);
    const snap = this.snapshot();
    for (const listener of this.listeners) listener(snap);
  }

  private armTimeout(state: ConnectionState): void {
    const key = TIMEOUT_STATE[state];
    if (!key) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.failWith(TIMEOUT_CODES[key]);
    }, this.timeouts[key]);
  }

  private clearPendingTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.clearPendingTimer();
    this.listeners.clear();
  }
}

/** Throw if the caller was handed a state the machine cannot be in. */
export function assertState(actual: ConnectionState, expected: ConnectionState): void {
  if (actual !== expected) {
    throw new DropbeamError("INTERNAL", `expected state ${expected}, got ${actual}`);
  }
}
