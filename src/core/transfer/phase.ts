/** PRD 7.2: per-file transfer states. */
export type FilePhase =
  | "QUEUED"
  | "OFFERED"
  | "ACCEPTED"
  | "DECLINED"
  | "TRANSFERRING"
  | "VERIFYING"
  | "DONE"
  | "FAILED"
  | "CANCELED";

export function isTerminalPhase(phase: FilePhase): boolean {
  return phase === "DONE" || phase === "FAILED" || phase === "CANCELED" || phase === "DECLINED";
}
