/** Error codes from PRD section 12, plus two transfer-level codes. */

export const ERROR_CODES = [
  "CAMERA_DENIED",
  "CODE_INVALID",
  "CODE_EXPIRED",
  "ICE_GATHER_TIMEOUT",
  "CONNECT_TIMEOUT",
  "PEER_LOST",
  "HASH_MISMATCH",
  "SEQ_GAP",
  "SINK_UNAVAILABLE",
  "DISK_FULL",
  "UNSUPPORTED",
  "PEER_DECLINED",
  "CANCELED",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

/** i18n key for a code: `err.<CODE>` (see src/ui/i18n/en.json). */
export function errorKey(code: ErrorCode): string {
  return `err.${code}`;
}

export class DropbeamError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message?: string) {
    super(message ?? code);
    this.name = "DropbeamError";
    this.code = code;
  }
}

/** Map an unknown thrown value (sink failures, DOM exceptions) to a code. */
export function toErrorCode(err: unknown): ErrorCode {
  if (err instanceof DropbeamError) return err.code;
  const name = err instanceof Error ? err.name : "";
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") return "DISK_FULL";
  if (name === "AbortError") return "CANCELED";
  return "INTERNAL";
}
