import { DropbeamError } from "../errors";

/**
 * Camera QR scanning (PRD 8.1). Native `BarcodeDetector` when the browser
 * ships it; otherwise a polling loop that draws video frames to a canvas and
 * decodes them with lazily-imported jsQR. Per docs/ARCHITECTURE.md this is
 * one of the core/platform modules allowed to touch camera/canvas APIs.
 */

type DetectedQr = { rawValue: string };
type BarcodeDetectorLike = {
  detect(source: HTMLVideoElement): Promise<DetectedQr[]>;
};
type BarcodeDetectorCtor = new (options: { formats: string[] }) => BarcodeDetectorLike;

/** Supported in Chromium/Android; absent in Firefox and Node's globals. */
export function getBarcodeDetector(): BarcodeDetectorCtor | null {
  const host = globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor };
  return typeof host.BarcodeDetector === "function" ? host.BarcodeDetector : null;
}

/**
 * Pure fallback decode: RGBA pixels → QR text. jsQR is lazy-loaded (PRD 8.1
 * keeps scanner libs out of the initial bundle).
 */
export async function decodeQrPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<string | null> {
  const mod = await import("jsqr");
  const found = mod.default(pixels, width, height);
  return found && found.data.length > 0 ? found.data : null;
}

export type ScannerOptions = {
  video: HTMLVideoElement;
  /** Drawing surface for the jsQR fallback; created on demand if omitted. */
  canvas?: HTMLCanvasElement;
  facingMode?: "environment" | "user";
  /** Polling period; defaults to the 4 fps frame animation period. */
  intervalMs?: number;
  onCode: (text: string) => void;
};

export type ScannerHandle = { stop(): void };

const DEFAULT_INTERVAL_MS = 250;
/** Keep the fallback's getImageData cost bounded on high-res cameras. */
const FALLBACK_MAX_WIDTH = 640;
/** Static QRs re-detect every tick; re-emit the same text only this often. */
const REEMIT_SAME_TEXT_MS = 3_000;

function cameraError(err: unknown): DropbeamError {
  const name = typeof err === "object" && err !== null && "name" in err ? String(err.name) : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return new DropbeamError("CAMERA_DENIED", "camera permission was denied");
  }
  return new DropbeamError("UNSUPPORTED", "no usable camera");
}

async function detectWithDetector(
  detector: BarcodeDetectorLike,
  video: HTMLVideoElement,
): Promise<string | null> {
  const results = await detector.detect(video);
  const first = results[0];
  return first ? first.rawValue : null;
}

async function detectWithJsQr(
  video: HTMLVideoElement,
  getCanvas: () => HTMLCanvasElement,
): Promise<string | null> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (width === 0 || height === 0) return null;
  const canvas = getCanvas();
  const scale = Math.min(1, FALLBACK_MAX_WIDTH / width);
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return decodeQrPixels(image.data, image.width, image.height);
}

/**
 * Open the camera and poll for QR codes, emitting each distinct scan text
 * through `onCode` (consecutive duplicates are suppressed; a static code is
 * re-emitted every REEMIT_SAME_TEXT_MS so an initially-busy consumer can
 * still pick it up).
 */
export async function startScanner(opts: ScannerOptions): Promise<ScannerHandle> {
  const media = navigator.mediaDevices;
  if (!media?.getUserMedia) {
    throw new DropbeamError("UNSUPPORTED", "camera capture is unavailable in this context");
  }
  let stream: MediaStream;
  try {
    stream = await media.getUserMedia({
      video: { facingMode: opts.facingMode ?? "environment" },
      audio: false,
    });
  } catch (err) {
    throw cameraError(err);
  }

  const video = opts.video;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
    throw new DropbeamError("UNSUPPORTED", "camera video could not start");
  }

  const Detector = getBarcodeDetector();
  const detector = Detector ? new Detector({ formats: ["qr_code"] }) : null;
  let canvas: HTMLCanvasElement | null = opts.canvas ?? null;
  const getCanvas = (): HTMLCanvasElement => (canvas ??= document.createElement("canvas"));

  let stopped = false;
  let busy = false;
  let lastText = "";
  let lastEmitAt = 0;
  const emit = (text: string): void => {
    const now = Date.now();
    if (text !== lastText || now - lastEmitAt >= REEMIT_SAME_TEXT_MS) {
      lastText = text;
      lastEmitAt = now;
      opts.onCode(text);
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped || busy || video.readyState < 2) return;
    busy = true;
    try {
      const text = detector
        ? await detectWithDetector(detector, video)
        : await detectWithJsQr(video, getCanvas);
      if (!stopped && text !== null) emit(text);
    } catch {
      // A bad frame or transient detector error must not kill the loop.
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), opts.intervalMs ?? DEFAULT_INTERVAL_MS);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      for (const track of stream.getTracks()) track.stop();
      video.pause();
      video.srcObject = null;
    },
  };
}
