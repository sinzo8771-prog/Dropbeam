// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startScanner } from "../../src/core/platform/scanner";

/**
 * The camera path, with a fake video stream (PRD 13.3).
 *
 * §13.3 asks for the scanner to be tested "with a fake video stream feeding a
 * generated QR image". The pixels half of that is covered elsewhere - the
 * round trip in `qr.test.ts` rasterises a rendered QR and decodes it back with
 * the real jsQR - so what is left here is the half that only a camera can
 * reach: the stream is opened with the right constraints, the frame loop asks
 * the detector for the current frame, the code that comes back is emitted, the
 * same code is not emitted twice in a row, and stopping releases the camera.
 *
 * A real camera is not needed and would not be allowed in a test: the stream
 * here is a stub whose frames carry a fixed code, and the detector is a stub
 * that reads it - so the test is about the wiring, not about vision.
 */

type FakeTrack = { stop: ReturnType<typeof vi.fn> };
type FakeStream = { getTracks: () => FakeTrack[] };

/** The code the fake camera is pointed at. */
const SEEN = "DB1.fake.camera.code";

/** A `<video>` that behaves like one with a live stream attached. */
function fakeVideo(): HTMLVideoElement {
  const video = document.createElement("video");
  // jsdom's media element has no playback, and `readyState` stays 0, which
  // would make the scanner's frame loop give up before it started.
  Object.defineProperty(video, "readyState", { get: () => 4 });
  video.play = vi.fn(async () => {});
  video.pause = vi.fn();
  return video;
}

/** A detector that reports the code the fake camera is pointed at. */
function installDetector(): void {
  (globalThis as unknown as { BarcodeDetector?: unknown }).BarcodeDetector = class {
    async detect(): Promise<{ rawValue: string }[]> {
      return [{ rawValue: SEEN }];
    }
  };
}

describe("the camera scanner (PRD 13.3, FR-3)", () => {
  let track: FakeTrack;
  let getUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    track = { stop: vi.fn() };
    const stream: FakeStream = { getTracks: () => [track] };
    getUserMedia = vi.fn(async () => stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    installDetector();
  });

  afterEach(() => {
    delete (globalThis as unknown as { BarcodeDetector?: unknown }).BarcodeDetector;
    vi.useRealTimers();
  });

  it("opens the camera with the environment camera and no audio", async () => {
    const video = fakeVideo();
    const handle = await startScanner({ video, onCode: () => {} });

    expect(getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: "environment" },
      audio: false,
    });
    // The facing mode is the caller's to choose, and the app asks for the
    // back camera by default but can be told otherwise.
    expect(video.muted).toBe(true);
    expect(video.playsInline).toBe(true);
    handle.stop();
  });

  it("asks for the user camera when the caller wants it", async () => {
    const video = fakeVideo();
    const handle = await startScanner({ video, facingMode: "user", onCode: () => {} });

    expect(getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: "user" },
      audio: false,
    });
    handle.stop();
  });

  it("emits the code the camera sees", async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const video = fakeVideo();
    const handle = await startScanner({ video, intervalMs: 10, onCode: (t) => seen.push(t) });

    await vi.advanceTimersByTimeAsync(50);

    expect(seen).toContain(SEEN);
    handle.stop();
  });

  it("does not emit the same code twice in a row", async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const video = fakeVideo();
    const handle = await startScanner({ video, intervalMs: 10, onCode: (t) => seen.push(t) });

    await vi.advanceTimersByTimeAsync(200);

    // The camera is pointed at one code, so every tick sees the same text: it
    // must be reported once, not once per frame.
    expect(seen).toEqual([SEEN]);
    handle.stop();
  });

  it("stops cleanly: the camera is released and the video is detached", async () => {
    vi.useFakeTimers();
    const video = fakeVideo();
    const handle = await startScanner({ video, intervalMs: 10, onCode: () => {} });

    handle.stop();

    expect(track.stop).toHaveBeenCalled();
    expect(video.pause).toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
  });

  it("reports a camera that cannot be opened, without a crash", async () => {
    getUserMedia.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { name: "NotAllowedError" }),
    );
    const video = fakeVideo();

    await expect(startScanner({ video, onCode: () => {} })).rejects.toThrow(/camera permission/i);
  });

  it("reports a context with no camera at all", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    const video = fakeVideo();

    await expect(startScanner({ video, onCode: () => {} })).rejects.toThrow(/camera capture/i);
  });
});
