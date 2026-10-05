import { encode, renderSVG } from "uqr";
import { DropbeamError } from "../errors";
import { splitIntoFrames } from "./qr-frames";

/**
 * QR rendering and the single-QR size budget (PRD 8.2.3, 8.2.4, FR-4).
 *
 * The budget is not a byte-count guess: `fitsSingleQr` asks the encoder
 * itself whether the content fits version ≤ 25 at error correction M — the
 * scan-reliability target from PRD 8.2.4 — so the decision stays correct if
 * the character set or ECC policy ever changes.
 */

export const SINGLE_QR_ECC = "M";
export const SINGLE_QR_MAX_VERSION = 25;

export function fitsSingleQr(content: string): boolean {
  if (typeof content !== "string" || content.length === 0) return false;
  try {
    encode(content, { ecc: SINGLE_QR_ECC, maxVersion: SINGLE_QR_MAX_VERSION, border: 0 });
    return true;
  } catch (err) {
    // uqr signals over-capacity with RangeError("Data too long").
    if (err instanceof RangeError) return false;
    throw err;
  }
}

/**
 * Delivery plan for FR-4: the link QR is preferred so any camera app opens
 * it (PRD 8.2.3); fall back to the raw-code QR, then to multi-frame.
 */
export type QrPlan = { mode: "single"; content: string } | { mode: "frames"; frames: string[] };

export function planQrContent(link: string, code: string): QrPlan {
  if (fitsSingleQr(link)) return { mode: "single", content: link };
  if (fitsSingleQr(code)) return { mode: "single", content: code };
  return { mode: "frames", frames: splitIntoFrames(code) };
}

export type QrSvgOptions = {
  /** Device pixels per module. */
  pixelSize?: number;
  /** Quiet-zone width in modules; 4 is the QR spec minimum. */
  border?: number;
  blackColor?: string;
  whiteColor?: string;
};

/**
 * Render QR content as a self-contained SVG string. The content is always a
 * code or link this app produced (never peer-supplied markup).
 */
export function renderQrSvg(content: string, opts: QrSvgOptions = {}): string {
  if (typeof content !== "string" || content.length === 0) {
    throw new DropbeamError("CODE_INVALID", "QR content is empty");
  }
  return renderSVG(content, {
    ecc: SINGLE_QR_ECC,
    border: opts.border ?? 4,
    pixelSize: opts.pixelSize ?? 8,
    blackColor: opts.blackColor ?? "black",
    whiteColor: opts.whiteColor ?? "white",
  });
}
