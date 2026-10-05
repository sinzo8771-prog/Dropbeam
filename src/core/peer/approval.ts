import { DropbeamError, type ErrorCode } from "../errors";

/**
 * Connection approval (PRD 9.5). Even after the channel opens, the host sees
 * "Allow connection from <label>?" and **no transfer is possible** until the
 * approval is granted. This is enforced here rather than in the UI, so a
 * mis-wired screen cannot accidentally enable transfers.
 */

export type ApprovalState = "pending" | "allowed" | "denied";

export type ApprovalEvents = {
  /** Show the prompt; `approve()`/`deny()` must be called in response. */
  onPrompt?(peerName: string): void;
  onStateChange?(state: ApprovalState, peerName: string): void;
};

export class ConnectionApproval {
  private state: ApprovalState = "pending";
  private prompted = false;
  private readonly peerName: string;

  constructor(
    peerName: string,
    private readonly events: ApprovalEvents = {},
  ) {
    this.peerName = peerName;
  }

  get current(): ApprovalState {
    return this.state;
  }

  get peer(): string {
    return this.peerName;
  }

  /**
   * Raise the prompt. Safe to call repeatedly (the UI may re-render or the
   * channel may re-signal), but the prompt is only ever shown once.
   */
  request(): void {
    if (this.state !== "pending" || this.prompted) return;
    this.prompted = true;
    this.events.onPrompt?.(this.peerName);
    this.events.onStateChange?.(this.state, this.peerName);
  }

  approve(): void {
    if (this.state !== "pending") return;
    this.state = "allowed";
    this.events.onStateChange?.(this.state, this.peerName);
  }

  deny(): void {
    if (this.state !== "pending") return;
    this.state = "denied";
    this.events.onStateChange?.(this.state, this.peerName);
  }

  /** Gate used by the transfer layer before any file may move. */
  requireAllowed(): void {
    if (this.state === "allowed") return;
    if (this.state === "denied") {
      throw new DropbeamError("PEER_DECLINED", "the host declined the connection");
    }
    throw new DropbeamError("PEER_LOST", "connection not approved yet");
  }

  get isAllowed(): boolean {
    return this.state === "allowed";
  }
}

/** PRD 12 reason code for a blocked transfer, surfaced by the UI. */
export function approvalError(state: ApprovalState): ErrorCode {
  return state === "denied" ? "PEER_DECLINED" : "PEER_LOST";
}
