import { describe, expect, it } from "vitest";
import { encode } from "uqr";
import { DropbeamError } from "../../src/core/errors";
import { encodeDb0 } from "../../src/core/handshake/codec-db0";
import { encodeDb1, type Handshake } from "../../src/core/handshake/codec-db1";
import { decodeHandshake } from "../../src/core/handshake/decode";
import { MAX_CODE_LENGTH, toBase64Url } from "../../src/core/handshake/encoding";
import { buildPairLink, extractCode, parsePairLink } from "../../src/core/handshake/link";
import {
  FRAME_INTERVAL_MS,
  FrameAssembler,
  MAX_FRAME_BYTES,
  MAX_FRAMES,
  newFrameId,
  parseFrame,
  splitIntoFrames,
  type ScanEvent,
} from "../../src/core/handshake/qr-frames";
import { fitsSingleQr, planQrContent, renderQrSvg } from "../../src/core/handshake/qr-render";
import { buildSdp } from "../../src/core/handshake/sdp-template";
import { decodeQrPixels, getBarcodeDetector } from "../../src/core/platform/scanner";

const NOW = 1_760_000_000;
const BASE = "https://dropbeam.example";

const CANDIDATES = [
  "0|2122260223|udp|192.168.1.7|54321|host",
  "1|2122260222|udp|10.0.0.4|51820|host",
  "2|1686052607|udp|203.0.113.9|3478|srflx",
  "3|2122260221|udp|2001:db8::5|54323|host",
  "4|2122260220|udp|abc-def.local|54324|host",
  "5|2122260219|udp|10.0.0.3|54325|host",
];

function sampleHandshake(overrides: Partial<Handshake> = {}): Handshake {
  return {
    v: 1,
    t: "o",
    ts: NOW,
    u: "Zx9+Qk",
    p: "p4ssw0rdBASE64abcDEF123",
    f: toBase64Url(new Uint8Array(32).fill(0xab)),
    s: "actpass",
    c: CANDIDATES,
    m: { sp: 5000, mms: 1048576 },
    n: "Arya's laptop",
    ...overrides,
  };
}

/** Deterministic reordering (odds first, then evens) so failures reproduce. */
function oddEven<T>(items: T[]): T[] {
  return [...items.filter((_, i) => i % 2 === 1), ...items.filter((_, i) => i % 2 === 0)];
}

/**
 * Deterministic incompressible filler. xorshift32 (not an LCG: its low bits
 * have a period of 64 and deflate squeezes the pattern) so "oversized" test
 * inputs really are oversized after compression.
 */
function randomish(length: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let x = 0x9e37_79b9;
  while (out.length < length) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out += alphabet[(x >>> 8) % 64];
  }
  return out.slice(0, length);
}

/** Rasterize QR text into an RGBA buffer, like the scanner sees it. */
function rasterize(
  text: string,
  scale = 4,
): {
  data: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const qr = encode(text, { ecc: "M", border: 4 });
  const width = qr.size * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.data[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((y * scale + dy) * width + (x * scale + dx)) * 4;
          data[px] = 0;
          data[px + 1] = 0;
          data[px + 2] = 0;
        }
      }
    }
  }
  return { data, width, height: width };
}

describe("link routes (PRD 8.2.3, FR-3, FR-6)", () => {
  it("builds and parses offer (#j) and answer (#a) links", () => {
    const offer = buildPairLink(BASE, "j", "DB1.cGF5bG9hZA");
    expect(offer).toBe("https://dropbeam.example/#j=DB1.cGF5bG9hZA");
    expect(parsePairLink(offer)).toEqual({ kind: "j", code: "DB1.cGF5bG9hZA" });

    const answer = buildPairLink(BASE, "a", "DB0.cGF5bG9hZA");
    expect(answer).toBe("https://dropbeam.example/#a=DB0.cGF5bG9hZA");
    expect(parsePairLink(answer)).toEqual({ kind: "a", code: "DB0.cGF5bG9hZA" });
  });

  it("strips trailing slashes and stale fragments from the base", () => {
    expect(buildPairLink("https://x.dev/", "j", "DB1.abc")).toBe("https://x.dev/#j=DB1.abc");
    expect(buildPairLink("https://x.dev/#old", "j", "DB1.abc")).toBe("https://x.dev/#j=DB1.abc");
  });

  it("parses fragments with or without # and tolerates percent-encoding", () => {
    expect(parsePairLink("#j=DB1.abc")).toEqual({ kind: "j", code: "DB1.abc" });
    expect(parsePairLink("j=DB1.abc")).toEqual({ kind: "j", code: "DB1.abc" });
    expect(parsePairLink("https://x.dev/#a=DB1.AA%3D%3D")).toEqual({
      kind: "a",
      code: "DB1.AA==",
    });
  });

  it("rejects non-pairing fragments and unknown codecs", () => {
    expect(parsePairLink("#help")).toBeNull();
    expect(parsePairLink("#j=")).toBeNull();
    expect(parsePairLink("#a=notacode")).toBeNull();
    expect(parsePairLink("hello")).toBeNull();
    expect(parsePairLink("")).toBeNull();
    expect(parsePairLink(42 as unknown as string)).toBeNull();
  });

  it("refuses to build a link around an invalid code", () => {
    expect(() => buildPairLink(BASE, "j", "")).toThrowError(DropbeamError);
    expect(() => buildPairLink(BASE, "j", "nope")).toThrowError(DropbeamError);
    expect(() => buildPairLink(BASE, "j", "A".repeat(MAX_CODE_LENGTH + 1))).toThrowError(
      DropbeamError,
    );
  });

  it("extracts codes from raw, block-wrapped and linked text", () => {
    expect(extractCode("DB1.abc")).toBe("DB1.abc");
    expect(extractCode("DB1.ABCDE FGHIJ")).toBe("DB1.ABCDEFGHIJ");
    expect(extractCode(`${BASE}/#j=DB1.abc`)).toBe("DB1.abc");
    expect(extractCode("DBF|abcdef|0|1|DB1.abc")).toBeNull();
    expect(extractCode("just some chat text")).toBeNull();
  });
});

describe("multi-frame QR (PRD 8.2.4, FR-4)", () => {
  it("animates at 4 fps and keeps every frame within 400 bytes", () => {
    expect(FRAME_INTERVAL_MS).toBe(250);
    const frames = splitIntoFrames("DB1." + "A".repeat(3000), { id: "abc123" });
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      expect(frame.length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
      expect(frame).toMatch(/^DBF\|abc123\|\d+\|\d+\|/);
    }
  });

  it("reassembles frames in order, shuffled and with duplicates", () => {
    const code = "DB0." + randomish(5000);
    const frames = splitIntoFrames(code, { id: "zz99aa" });

    const ordered = new FrameAssembler();
    let last: ScanEvent = ordered.feed("");
    for (const frame of frames) last = ordered.feed(frame);
    expect(last).toEqual({ kind: "code", code });

    const shuffled = new FrameAssembler();
    last = shuffled.feed("");
    for (const frame of oddEven(frames)) {
      last = shuffled.feed(frame);
      // A repeated frame must not count twice nor complete the assembly.
      expect(shuffled.feed(frame).kind).not.toBe("code");
    }
    expect(last).toEqual({ kind: "code", code });
  });

  it("reports progress while frames are still missing", () => {
    const frames = splitIntoFrames("DB1." + "C".repeat(2000), { id: "prog01" });
    const asm = new FrameAssembler();
    expect(asm.feed(frames[0]!)).toEqual({
      kind: "progress",
      received: 1,
      total: frames.length,
    });
    expect(asm.feed(frames[0]!)).toEqual({
      kind: "progress",
      received: 1,
      total: frames.length,
    });
  });

  it("restarts on a new frame id and drops corrupt same-id frames", () => {
    const firstCode = "DB1." + "A".repeat(2000);
    const first = splitIntoFrames(firstCode, { id: "aaaaaa" });
    const secondCode = "DB1." + "B".repeat(2000);
    const second = splitIntoFrames(secondCode, { id: "bbbbbb" });
    const asm = new FrameAssembler();
    asm.feed(first[0]!);
    asm.feed(first[1]!);
    // Same id, different total — structurally fine but internally inconsistent.
    expect(asm.feed("DBF|aaaaaa|0|7|zzz")).toEqual({ kind: "ignored" });
    // New id restarts assembly from the incoming frame.
    expect(asm.feed(second[0]!)).toEqual({
      kind: "progress",
      received: 1,
      total: second.length,
    });
    let last: ScanEvent = asm.feed("");
    for (const frame of second.slice(1)) last = asm.feed(frame);
    expect(last).toEqual({ kind: "code", code: secondCode });
  });

  it("parses valid frames and rejects malformed ones", () => {
    expect(parseFrame("DBF|abc123|0|2|DB1.x")).toEqual({
      id: "abc123",
      index: 0,
      total: 2,
      payload: "DB1.x",
    });
    expect(parseFrame("DBF|x|5|3|p")).toBeNull(); // index >= total
    expect(parseFrame("DBF|x|0|0|p")).toBeNull(); // total < 1
    expect(parseFrame("DBF|x|a|3|p")).toBeNull(); // non-numeric index
    expect(parseFrame(`DBF|x|0|${MAX_FRAMES + 1}|p`)).toBeNull(); // too many frames
    expect(parseFrame("DBF|x|0|1|")).toBeNull(); // empty payload
    expect(parseFrame("DBF|x|0|1")).toBeNull(); // too few fields
    expect(parseFrame("DBF|x|0|1|a|b")).toBeNull(); // too many fields
    expect(parseFrame("hello")).toBeNull();
    expect(parseFrame("")).toBeNull();
  });

  it("rejects codes that cannot be framed", () => {
    expect(() => splitIntoFrames("")).toThrowError(DropbeamError);
    expect(() => splitIntoFrames("x".repeat(MAX_CODE_LENGTH + 1))).toThrowError(DropbeamError);
  });

  it("completes immediately on a direct code and clears partial frames", () => {
    const asm = new FrameAssembler();
    asm.feed(splitIntoFrames("DB1." + "A".repeat(2000), { id: "aaaaaa" })[0]!);
    expect(asm.feed("DB1.abc")).toEqual({ kind: "code", code: "DB1.abc" });
    expect(asm.feed("nonsense")).toEqual({ kind: "ignored" });
  });

  it("generates short random frame ids", () => {
    const id = newFrameId();
    expect(id).toMatch(/^[a-z0-9]{6}$/);
    expect(newFrameId()).not.toBe(id);
  });
});

describe("single-QR size budget (PRD 8.2.4)", () => {
  it("fits a realistic offer and its link into one QR", async () => {
    const code = await encodeDb1(sampleHandshake(), { nowSeconds: NOW });
    const link = buildPairLink(BASE, "j", code);
    expect(fitsSingleQr(code)).toBe(true);
    expect(fitsSingleQr(link)).toBe(true);
    // The link QR is preferred so any camera app opens the app (PRD 8.2.3).
    expect(planQrContent(link, code)).toEqual({ mode: "single", content: link });
  });

  it("falls back to the raw-code QR when only the link is oversized", () => {
    const code = "DB1." + "A".repeat(400);
    const link = buildPairLink(`${BASE}/${"a".repeat(900)}`, "j", code);
    expect(fitsSingleQr(code)).toBe(true);
    expect(fitsSingleQr(link)).toBe(false);
    expect(planQrContent(link, code)).toEqual({ mode: "single", content: code });
  });

  it("falls back to multi-frame when even the code is oversized", () => {
    const code = "DB0." + randomish(4000);
    const link = buildPairLink(BASE, "j", code);
    expect(fitsSingleQr(code)).toBe(false);
    const plan = planQrContent(link, code);
    expect(plan.mode).toBe("frames");
    if (plan.mode === "frames") {
      expect(plan.frames.length).toBeGreaterThan(1);
      for (const frame of plan.frames) expect(fitsSingleQr(frame)).toBe(true);
      const asm = new FrameAssembler();
      let last: ScanEvent = asm.feed("");
      for (const frame of oddEven(plan.frames)) last = asm.feed(frame);
      expect(last).toEqual({ kind: "code", code });
    }
  });
});

describe("QR rendering", () => {
  it("renders a standalone SVG", () => {
    const svg = renderQrSvg(`${BASE}/#j=DB1.abc`, { pixelSize: 6 });
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain("<path fill=");
    expect(() => renderQrSvg("")).toThrowError(DropbeamError);
  });
});

describe("scanning round trip (uqr → jsQR)", () => {
  it("decodes a rendered pairing link back to the link", async () => {
    const code = await encodeDb1(sampleHandshake(), { nowSeconds: NOW });
    const link = buildPairLink(BASE, "j", code);
    const { data, width, height } = rasterize(link);
    await expect(decodeQrPixels(data, width, height)).resolves.toBe(link);
  });

  it("decodes a rendered multi-frame QR back to the frame", async () => {
    const frame = splitIntoFrames("DB1." + "A".repeat(1500), { id: "qwerty" })[1]!;
    const { data, width, height } = rasterize(frame);
    await expect(decodeQrPixels(data, width, height)).resolves.toBe(frame);
  });

  it("returns null for pixels that hold no QR code", async () => {
    const { data, width, height } = rasterize("nothing to see");
    await expect(decodeQrPixels(data, width, height)).resolves.not.toBe(null);
    const blank = new Uint8ClampedArray(64 * 64 * 4).fill(255);
    await expect(decodeQrPixels(blank, 64, 64)).resolves.toBeNull();
  });

  it("reports BarcodeDetector support from the global scope", () => {
    const host = globalThis as { BarcodeDetector?: unknown };
    expect(getBarcodeDetector()).toBeNull();
    host.BarcodeDetector = class {};
    try {
      expect(getBarcodeDetector()).not.toBeNull();
    } finally {
      delete host.BarcodeDetector;
    }
  });
});

describe("pairing pipelines (FR-3 + FR-4)", () => {
  it("decodes an offer that arrived as a link", async () => {
    const code = await encodeDb1(sampleHandshake(), { nowSeconds: NOW });
    const link = buildPairLink(BASE, "j", code);
    const scanned = extractCode(link);
    expect(scanned).toBe(code);
    const decoded = await decodeHandshake(scanned!, { nowSeconds: NOW });
    expect(decoded.codec).toBe("DB1");
    expect(decoded.handshake?.n).toBe("Arya's laptop");
    expect(decoded.sdp).toContain("m=application");
  });

  it("decodes a DB0 code that arrived as shuffled frames", async () => {
    const baseSdp = buildSdp(sampleHandshake());
    const sdp = `${baseSdp}${baseSdp.endsWith("\n") ? "" : "\n"}x-pad:${randomish(5000)}\n`;
    const code = await encodeDb0(sdp);
    expect(code.length).toBeGreaterThan(1000);
    const frames = splitIntoFrames(code, { id: "frameid" });
    expect(frames.length).toBeGreaterThan(1);

    const asm = new FrameAssembler();
    let last: ScanEvent = asm.feed("");
    for (const frame of oddEven(frames)) last = asm.feed(frame);
    expect(last).toEqual({ kind: "code", code });

    const decoded = await decodeHandshake(code);
    expect(decoded.codec).toBe("DB0");
    expect(decoded.sdp).toBe(sdp);
  });
});
