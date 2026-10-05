import { describe, expect, it } from "vitest";
import {
  ConnectionStateMachine,
  DEFAULT_TIMEOUTS,
  canTransition,
  isTerminal,
  type ConnectionEvent,
  type ConnectionState,
} from "../../src/core/peer/state-machine";

/** Deterministic timer harness so timeouts are tested without real waits. */
function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  return {
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer: (handle: unknown): void => {
      pending.delete(handle as number);
    },
    /** Fire every timer whose delay matches. */
    fire(ms: number): void {
      for (const [id, entry] of [...pending]) {
        if (entry.ms === ms) {
          pending.delete(id);
          entry.fn();
        }
      }
    },
    get count(): number {
      return pending.size;
    },
    delays(): number[] {
      return [...pending.values()].map((e) => e.ms);
    },
  };
}

const HOST_PATH: [ConnectionEvent, ConnectionState][] = [
  ["start", "CREATING_OFFER"],
  ["offer-created", "GATHERING"],
  ["gather-complete", "SHOWING_OFFER"],
  ["reply-applied", "WAITING_FOR_REPLY"],
];

const GUEST_PATH: [ConnectionEvent, ConnectionState][] = [
  ["join", "SCANNING_OFFER"],
  ["offer-received", "CREATING_ANSWER"],
  ["answer-created", "GATHERING"],
  // A guest shows its *answer*, never its offer (PRD 5.1 step 3).
  ["gather-complete", "SHOWING_ANSWER"],
];

describe("connection state machine (PRD 7.1)", () => {
  it("walks the host path from IDLE to CONNECTING", () => {
    const sm = new ConnectionStateMachine({ side: "host" });
    expect(sm.state).toBe("IDLE");
    for (const [event, expected] of HOST_PATH) {
      expect(sm.send(event)).toBe(true);
      expect(sm.state).toBe(expected);
    }
    expect(sm.send("reply-applied")).toBe(true);
    expect(sm.state).toBe("CONNECTING");
    expect(sm.send("connected")).toBe(true);
    expect(sm.state).toBe("CONNECTED");
    expect(sm.send("disconnected")).toBe(true);
    expect(sm.state).toBe("DISCONNECTED");
  });

  it("walks the guest path from IDLE to CONNECTING", () => {
    const sm = new ConnectionStateMachine({ side: "guest" });
    for (const [event, expected] of GUEST_PATH) {
      expect(sm.send(event)).toBe(true);
      expect(sm.state).toBe(expected);
    }
    // A guest never shows its offer or waits for a reply.
    expect(sm.send("reply-applied")).toBe(false);
    expect(sm.send("connected")).toBe(true);
    expect(sm.state).toBe("CONNECTING");
  });

  it("keeps the two sides on their own SHOWING state", () => {
    const host = new ConnectionStateMachine({ side: "host" });
    host.send("start");
    host.send("offer-created");
    host.send("gather-complete");
    expect(host.state).toBe("SHOWING_OFFER");

    const guest = new ConnectionStateMachine({ side: "guest" });
    guest.send("join");
    guest.send("offer-received");
    guest.send("answer-created");
    guest.send("gather-complete");
    // PRD 5.1: the guest shows its *answer*, not its offer.
    expect(guest.state).toBe("SHOWING_ANSWER");
  });

  it("rejects illegal transitions without changing state", () => {
    const sm = new ConnectionStateMachine();
    expect(sm.send("connected")).toBe(false);
    expect(sm.send("gather-complete")).toBe(false);
    expect(sm.state).toBe("IDLE");
    expect(sm.send("start")).toBe(true);
    expect(sm.send("offer-received")).toBe(false);
    expect(sm.state).toBe("CREATING_OFFER");
  });

  it("exposes the transition table for every state", () => {
    for (const event of [
      "start",
      "join",
      "offer-created",
      "answer-created",
      "gather-complete",
      "offer-received",
      "reply-applied",
      "connected",
      "disconnected",
    ] as ConnectionEvent[]) {
      expect(canTransition("IDLE", event)).toBe(event === "start" || event === "join");
    }
    // Every non-terminal state can fail.
    expect(canTransition("GATHERING", "fail")).toBe(true);
    expect(canTransition("CONNECTING", "fail")).toBe(true);
  });

  it("marks IDLE, FAILED and DISCONNECTED as terminal", () => {
    expect(isTerminal("IDLE")).toBe(true);
    expect(isTerminal("FAILED")).toBe(true);
    expect(isTerminal("DISCONNECTED")).toBe(true);
    expect(isTerminal("CONNECTED")).toBe(false);
    expect(isTerminal("GATHERING")).toBe(false);
  });

  it("times out GATHERING into FAILED with ICE_GATHER_TIMEOUT", () => {
    const timers = fakeTimers();
    const sm = new ConnectionStateMachine({ side: "host", ...timers });
    sm.send("start");
    sm.send("offer-created");
    expect(timers.count).toBe(1);
    expect(timers.delays()).toContain(DEFAULT_TIMEOUTS.gathering);
    timers.fire(DEFAULT_TIMEOUTS.gathering);
    expect(sm.state).toBe("FAILED");
    expect(sm.error).toBe("ICE_GATHER_TIMEOUT");
  });

  it("times out CONNECTING with CONNECT_TIMEOUT", () => {
    const timers = fakeTimers();
    const sm = new ConnectionStateMachine({ side: "host", ...timers });
    for (const [event] of HOST_PATH) sm.send(event);
    sm.send("reply-applied");
    timers.fire(DEFAULT_TIMEOUTS.connecting);
    expect(sm.state).toBe("FAILED");
    expect(sm.error).toBe("CONNECT_TIMEOUT");
  });

  it("expires WAITING_FOR_REPLY after the code TTL", () => {
    const timers = fakeTimers();
    const sm = new ConnectionStateMachine({ side: "host", ...timers });
    for (const [event] of HOST_PATH) sm.send(event);
    expect(sm.state).toBe("WAITING_FOR_REPLY");
    timers.fire(DEFAULT_TIMEOUTS.waitingForReply);
    expect(sm.state).toBe("FAILED");
    expect(sm.error).toBe("CODE_EXPIRED");
  });

  it("cancels a pending timeout when the state advances", () => {
    const timers = fakeTimers();
    const sm = new ConnectionStateMachine({ side: "host", ...timers });
    sm.send("start");
    sm.send("offer-created");
    expect(timers.count).toBe(1);
    sm.send("gather-complete");
    // SHOWING_OFFER has no timeout, so the GATHERING timer must be cleared.
    expect(timers.count).toBe(0);
    timers.fire(DEFAULT_TIMEOUTS.gathering);
    expect(sm.state).toBe("SHOWING_OFFER");
  });

  it("honours custom timeout overrides", () => {
    const timers = fakeTimers();
    const sm = new ConnectionStateMachine({
      side: "host",
      timeouts: { gathering: 50 },
      ...timers,
    });
    sm.send("start");
    sm.send("offer-created");
    expect(timers.delays()).toEqual([50]);
  });

  it("runs cleanup on failure and on reset", () => {
    let cleanups = 0;
    const sm = new ConnectionStateMachine({ onCleanup: () => cleanups++ });
    sm.send("start");
    sm.send("fail");
    expect(sm.state).toBe("FAILED");
    expect(cleanups).toBe(1);
    // "Try again" returns to IDLE and cleans up again (PRD 7.1).
    sm.reset();
    expect(sm.state).toBe("IDLE");
    expect(sm.error).toBeNull();
    expect(cleanups).toBe(2);
    expect(sm.send("start")).toBe(true);
  });

  it("fails with an explicit PRD reason code", () => {
    const sm = new ConnectionStateMachine();
    sm.send("start");
    sm.send("offer-created");
    sm.failWith("PEER_LOST");
    expect(sm.state).toBe("FAILED");
    expect(sm.error).toBe("PEER_LOST");
  });

  it("notifies subscribers on every transition", () => {
    const sm = new ConnectionStateMachine({ side: "host" });
    const seen: ConnectionState[] = [];
    const unsubscribe = sm.subscribe((snap) => seen.push(snap.state));
    sm.send("start");
    sm.send("offer-created");
    unsubscribe();
    sm.send("gather-complete");
    expect(seen).toEqual(["CREATING_OFFER", "GATHERING"]);
  });

  it("dispose stops timers and listeners", () => {
    const timers = fakeTimers();
    const sm = new ConnectionStateMachine({ side: "host", ...timers });
    const seen: ConnectionState[] = [];
    sm.subscribe((snap) => seen.push(snap.state));
    sm.send("start");
    sm.send("offer-created");
    sm.dispose();
    expect(timers.count).toBe(0);
    timers.fire(DEFAULT_TIMEOUTS.gathering);
    expect(sm.state).toBe("GATHERING");
    expect(seen).toEqual(["CREATING_OFFER", "GATHERING"]);
  });
});

describe("side selection (PRD 7.1)", () => {
  /**
   * The UI holds one machine for its whole lifetime and picks the side per
   * attempt, so that a rebuild can never leave a screen rendering a state from
   * a machine the controller is no longer driving.
   */
  it("resolves SHOWING per side and only accepts the change from IDLE", () => {
    const machine = new ConnectionStateMachine();
    machine.send("start");
    machine.send("offer-created");
    machine.send("gather-complete");
    expect(machine.state).toBe("SHOWING_OFFER");

    machine.reset();
    machine.setSide("guest");
    machine.send("join");
    machine.send("offer-received");
    machine.send("answer-created");
    machine.send("gather-complete");
    expect(machine.state).toBe("SHOWING_ANSWER");

    // Mid-attempt the side is already implied; changing it is ignored.
    machine.setSide("host");
    expect(machine.state).toBe("SHOWING_ANSWER");
  });

  it("still refuses WAITING_FOR_REPLY for the guest", () => {
    const machine = new ConnectionStateMachine({ side: "guest" });
    machine.send("join");
    machine.send("offer-received");
    machine.send("answer-created");
    machine.send("gather-complete");
    expect(machine.send("reply-applied")).toBe(false);
  });
});
