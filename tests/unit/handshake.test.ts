import { describe, expect, it } from "vitest";
import { DropbeamError } from "../../src/core/errors";
import {
  formatCompactCandidate,
  isLinkLocalAddress,
  parseCompactCandidate,
  parseSdpCandidateLine,
  selectCandidates,
} from "../../src/core/handshake/candidates";
import { DB0_PREFIX, decodeDb0, encodeDb0 } from "../../src/core/handshake/codec-db0";
import {
  DB1_PREFIX,
  HANDSHAKE_TTL_SECONDS,
  decodeDb1,
  encodeDb1,
  validateHandshake,
  type Handshake,
} from "../../src/core/handshake/codec-db1";
import { decodeHandshake } from "../../src/core/handshake/decode";
import { buildSdp, handshakeFromSdp } from "../../src/core/handshake/sdp-template";
import { fromBase64Url, toBase64Url } from "../../src/core/handshake/encoding";

const NOW = 1_760_000_000;

function sampleHandshake(overrides: Partial<Handshake> = {}): Handshake {
  return {
    v: 1,
    t: "o",
    ts: NOW,
    u: "Zx9+Qk",
    p: "p4ssw0rdBASE64abcDEF123",
    f: toBase64Url(new Uint8Array(32).fill(0xab)),
    s: "actpass",
    c: ["1|2122260223|udp|192.168.1.7|54321|host"],
    m: { sp: 5000, mms: 1048576 },
    n: "Arya's laptop",
    ...overrides,
  };
}

async function expectCodeError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("base64url helpers", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const encoded = toBase64Url(bytes);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect([...fromBase64Url(encoded)]).toEqual([...bytes]);
  });

  it("round-trips every remainder length", () => {
    for (let len = 0; len <= 9; len++) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 5) & 0xff);
      expect([...fromBase64Url(toBase64Url(bytes))]).toEqual([...bytes]);
    }
  });

  it("rejects non-base64url text", () => {
    expect(() => fromBase64Url("abc$def")).toThrowError(DropbeamError);
    expect(() => fromBase64Url("abcde")).toThrowError(DropbeamError);
  });
});

describe("candidate handling (PRD 8.2.2)", () => {
  it("detects IPv6 link-local addresses including zone ids", () => {
    expect(isLinkLocalAddress("fe80::1")).toBe(true);
    expect(isLinkLocalAddress("FE80::abcd")).toBe(true);
    expect(isLinkLocalAddress("fe80::1%eth0")).toBe(true);
    expect(isLinkLocalAddress("2001:db8::1")).toBe(false);
    expect(isLinkLocalAddress("192.168.1.7")).toBe(false);
    expect(isLinkLocalAddress("abc-def.local")).toBe(false);
  });

  it("parses compact candidates and rejects malformed ones", () => {
    expect(parseCompactCandidate("1|2122260223|udp|192.168.1.7|54321|host")).toMatchObject({
      address: "192.168.1.7",
      port: 54321,
      type: "host",
    });
    expect(parseCompactCandidate("1|2122260223|udp|10.0.0.1|70000|host")).toBeNull();
    expect(parseCompactCandidate("1|2122260223|udp|10.0.0.1|54321|host|extra")).toBeNull();
    expect(parseCompactCandidate("1|abc|udp|10.0.0.1|54321|host")).toBeNull();
    expect(parseCompactCandidate("1|99|udp|bad addr|54321|host")).toBeNull();
    expect(parseCompactCandidate("")).toBeNull();
  });

  it("filters TCP, relay, prflx and link-local candidates; caps at 6", () => {
    const lines = [
      "a=candidate:0 1 udp 2122260223 192.168.1.7 54321 typ host",
      "a=candidate:1 1 tcp 1518280447 192.168.1.7 9 typ host tcptype passive",
      "a=candidate:2 1 udp 1686052607 203.0.113.9 3478 typ srflx raddr 192.168.1.7 rport 54321",
      "a=candidate:3 1 udp 4194303 198.51.100.7 3478 typ relay",
      "a=candidate:4 1 udp 2122260222 fe80::1 54322 typ host",
      "a=candidate:5 1 udp 2122260221 2001:db8::5 54323 typ host",
      "a=candidate:6 1 udp 2122260220 abc-def.local 54324 typ host",
      "a=candidate:7 1 udp 2122260219 10.0.0.3 54325 typ host",
      "a=candidate:8 1 udp 2122260218 10.0.0.4 54326 typ host",
      "a=candidate:9 1 udp 2122260217 10.0.0.5 54327 typ host",
      "a=candidate:10 2 udp 2122260216 10.0.0.6 54328 typ host",
    ];
    const parsed = lines.map(parseSdpCandidateLine);
    expect(parsed.every((c) => c !== null)).toBe(true);
    const usable = selectCandidates(parsed.filter((c) => c !== null));
    // tcp/relay/link-local/component-2 dropped → 7 remain → capped to 6
    expect(usable).toHaveLength(6);
    expect(usable.map((c) => c.address)).toEqual([
      "192.168.1.7",
      "203.0.113.9",
      "2001:db8::5",
      "abc-def.local",
      "10.0.0.3",
      "10.0.0.4",
    ]);
  });

  it("formats candidates back into compact form", () => {
    const parsed = parseSdpCandidateLine("a=candidate:0 1 UDP 2122260223 10.0.0.2 54321 typ HOST");
    expect(parsed).not.toBeNull();
    expect(formatCompactCandidate(parsed!)).toBe("0|2122260223|udp|10.0.0.2|54321|host");
  });
});

describe("DB1 codec round-trip (PRD 8.2.1)", () => {
  it("round-trips a handshake", async () => {
    const hs = sampleHandshake();
    const code = await encodeDb1(hs, { nowSeconds: NOW });
    expect(code.startsWith(DB1_PREFIX)).toBe(true);
    const decoded = await decodeDb1(code, { nowSeconds: NOW });
    expect(decoded).toEqual(hs);
  });

  it("round-trips with every compression implementation", async () => {
    for (const impl of ["native", "fflate"] as const) {
      const code = await encodeDb1(sampleHandshake(), { nowSeconds: NOW, impl });
      const decoded = await decodeDb1(code, { nowSeconds: NOW, impl });
      expect(decoded.u).toBe("Zx9+Qk");
      // Cross-impl: native-encoded codes must decode via fflate and back.
      const other = impl === "native" ? "fflate" : "native";
      const cross = await decodeDb1(code, { nowSeconds: NOW, impl: other });
      expect(cross).toEqual(decoded);
    }
  });

  it("stays inside the single-QR budget (PRD 8.2.4 target ~1,000 bytes)", async () => {
    const wide = sampleHandshake({
      c: [
        "1|2122260223|udp|192.168.1.7|54321|host",
        "2|2122260222|udp|10.1.2.3|54322|host",
        "3|1686052607|udp|203.0.113.9|3478|srflx",
        "4|2122260221|udp|2001:db8::5|54323|host",
        "5|2122260220|udp|averylongmDNSname-0123456789.local|54324|host",
        "6|2122260219|udp|10.0.0.3|54325|host",
      ],
      n: "Arya's laptop (Pixel 8)",
    });
    const code = await encodeDb1(wide, { nowSeconds: NOW });
    expect(code.length).toBeLessThan(1000);
  });

  it("ignores whitespace and line breaks in pasted codes", async () => {
    const code = await encodeDb1(sampleHandshake(), { nowSeconds: NOW });
    const grouped = code.match(/.{1,5}/g)!.join(" ");
    const decoded = await decodeDb1(grouped, { nowSeconds: NOW });
    expect(decoded.u).toBe("Zx9+Qk");
  });
});

describe("DB1 validation of untrusted input (PRD 9.4)", () => {
  const valid = sampleHandshake();

  async function mutate(mut: (hs: Record<string, unknown>) => void): Promise<void> {
    const clone = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    mut(clone);
    await expectCodeError(decodeDb1(await encodeRaw(clone), { nowSeconds: NOW }), "CODE_INVALID");
  }

  async function encodeRaw(obj: unknown): Promise<string> {
    // Build a DB1 code from an arbitrary object, bypassing encodeDb1's own
    // validation, exactly like a hostile peer would.
    const { deflateRaw } = await import("../../src/core/handshake/encoding");
    const deflated = await deflateRaw(new TextEncoder().encode(JSON.stringify(obj)));
    const { toBase64Url: b64 } = await import("../../src/core/handshake/encoding");
    return "DB1." + b64(deflated);
  }

  it("rejects wrong versions and types", async () => {
    await mutate((h) => (h.v = 2));
    await mutate((h) => (h.t = "x"));
  });

  it("rejects malformed timestamps (PRD FR-7 expiry)", async () => {
    await mutate((h) => (h.ts = 0));
    await mutate((h) => (h.ts = "soon"));
    await expectCodeError(
      decodeDb1(await encodeDb1(valid, { nowSeconds: NOW }), {
        nowSeconds: NOW + HANDSHAKE_TTL_SECONDS + 61,
      }),
      "CODE_EXPIRED",
    );
    // Just inside TTL + skew still decodes.
    const fresh = await decodeDb1(await encodeDb1(valid, { nowSeconds: NOW }), {
      nowSeconds: NOW + HANDSHAKE_TTL_SECONDS + 59,
    });
    expect(fresh.ts).toBe(NOW);
    // Far-future timestamps are invalid, not expired.
    await expectCodeError(
      decodeDb1(await encodeDb1(valid, { nowSeconds: NOW }), { nowSeconds: NOW - 10_000 }),
      "CODE_INVALID",
    );
  });

  it("rejects ICE credential and fingerprint injection attempts", async () => {
    await mutate((h) => (h.u = "abc\ndef"));
    await mutate((h) => (h.p = "p".repeat(600)));
    await mutate((h) => (h.f = "not-base64url!"));
    await mutate((h) => (h.f = toBase64Url(new Uint8Array(16))));
  });

  it("rejects malformed candidate arrays", async () => {
    await mutate((h) => (h.c = []));
    await mutate((h) => (h.c = ["not|enough"]));
    await mutate((h) => (h.c = ["1|2|udp|10.0.0.1|0|host"]));
    await mutate((h) => (h.c = "oops"));
    // All candidates filtered out (TCP + relay only) → unusable.
    await mutate((h) => (h.c = ["1|100|tcp|10.0.0.1|9|host", "1|100|udp|fe80::1|9|host"]));
  });

  it("rejects malformed optional fields", async () => {
    await mutate((h) => (h.m = { sp: 0, mms: 1 }));
    await mutate((h) => (h.m = { sp: 5000, mms: -1 }));
    await mutate((h) => (h.n = 42));
  });

  it("sanitizes the device label instead of rejecting", async () => {
    const hs = sampleHandshake({ n: `phone\u0000\u0007 ${"x".repeat(200)}` });
    const decoded = await decodeDb1(await encodeDb1(hs, { nowSeconds: NOW }), {
      nowSeconds: NOW,
    });
    expect(decoded.n).toBe(`phone ${"x".repeat(64 - 6)}`.trimEnd());
    expect(decoded.n!.length).toBeLessThanOrEqual(64);
  });

  it("rejects garbage codes before any parsing", async () => {
    await expectCodeError(decodeDb1("hello", { nowSeconds: NOW }), "CODE_INVALID");
    await expectCodeError(decodeDb1("DB0.abcd", { nowSeconds: NOW }), "CODE_INVALID");
    await expectCodeError(decodeDb1(DB1_PREFIX, { nowSeconds: NOW }), "CODE_INVALID");
    await expectCodeError(decodeDb1(DB1_PREFIX + "!!!!", { nowSeconds: NOW }), "CODE_INVALID");
    await expectCodeError(
      decodeDb1(DB1_PREFIX + "a".repeat(99_999), { nowSeconds: NOW }),
      "CODE_INVALID",
    );
    // Valid base64url of non-JSON bytes.
    await expectCodeError(decodeDb1(DB1_PREFIX + "AAAA", { nowSeconds: NOW }), "CODE_INVALID");
  });

  it("drops candidates when re-validating a partially bad handshake", () => {
    const hs = validateHandshake(
      {
        ...valid,
        c: [
          "1|2122260223|udp|192.168.1.7|54321|host",
          "1|100|tcp|10.0.0.1|9|host",
          "1|100|udp|fe80::1|9|host",
        ],
      },
      { nowSeconds: NOW },
    );
    expect(hs.c).toEqual(["1|2122260223|udp|192.168.1.7|54321|host"]);
  });
});

describe("SDP template (PRD 8.2.1)", () => {
  const LOCAL_OFFER = [
    "v=0",
    "o=- 1234 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "a=msid-semantic: WMS",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    "a=ice-ufrag:Zx9+Qk",
    "a=ice-pwd:p4ssw0rdBASE64abcDEF123",
    "a=ice-options:trickle",
    "a=fingerprint:sha-256 " + "AB:".repeat(31) + "AB",
    "a=setup:actpass",
    "a=mid:0",
    "a=sctp-port:5000",
    "a=max-message-size:1048576",
    "a=candidate:0 1 udp 2122260223 192.168.1.7 54321 typ host",
    "a=candidate:1 1 tcp 1518280447 192.168.1.7 9 typ host",
    "a=end-of-candidates",
    "",
  ].join("\r\n");

  it("extracts a handshake from a local offer", () => {
    const hs = handshakeFromSdp(LOCAL_OFFER, "o", NOW, "Arya's laptop");
    expect(hs.v).toBe(1);
    expect(hs.t).toBe("o");
    expect(hs.u).toBe("Zx9+Qk");
    expect(hs.s).toBe("actpass");
    expect(hs.c).toEqual(["0|2122260223|udp|192.168.1.7|54321|host"]);
    expect(hs.m).toEqual({ sp: 5000, mms: 1048576 });
    expect(hs.n).toBe("Arya's laptop");
    // fingerprint hex "AB:AB:..." → base64url of bytes 0xAB × 32
    expect(hs.f).toBe(toBase64Url(new Uint8Array(32).fill(0xab)));
  });

  it("marks answers as active regardless of the local setup line", () => {
    const answer = LOCAL_OFFER.replace("a=setup:actpass", "a=setup:active");
    expect(handshakeFromSdp(answer, "a", NOW).s).toBe("active");
  });

  it("rejects SDP without candidates or with foreign media lines", () => {
    expect(() => handshakeFromSdp("v=0\r\nm=audio 9 RTP/AVP 0\r\n", "o", NOW)).toThrowError(
      DropbeamError,
    );
    const noCands = LOCAL_OFFER.replace(/^a=candidate:.*\r?\n/gm, "");
    expect(() => handshakeFromSdp(noCands, "o", NOW)).toThrowError(
      expect.objectContaining({ code: "ICE_GATHER_TIMEOUT" }),
    );
  });

  it("rebuilds a complete SDP from a handshake", async () => {
    const hs = await decodeDb1(await encodeDb1(sampleHandshake(), { nowSeconds: NOW }), {
      nowSeconds: NOW,
    });
    const sdp = buildSdp(hs);
    expect(sdp.startsWith("v=0\r\n")).toBe(true);
    expect(sdp).toContain("m=application 9 UDP/DTLS/SCTP webrtc-datachannel");
    expect(sdp).toContain("a=group:BUNDLE 0");
    expect(sdp).toContain("a=mid:0");
    expect(sdp).toContain("a=sctp-port:5000");
    expect(sdp).toContain("a=max-message-size:1048576");
    expect(sdp).toContain("a=setup:actpass");
    expect(sdp).toContain("a=candidate:1 1 udp 2122260223 192.168.1.7 54321 typ host");
    expect(sdp.trimEnd().endsWith("a=end-of-candidates")).toBe(true);
    expect(sdp).not.toContain("a=ice-options"); // non-trickle: all candidates inline
  });

  it("fingerprints survive the hex ↔ base64url round trip", async () => {
    const hs = sampleHandshake();
    const sdp = buildSdp(hs);
    const line = sdp.split(/\r?\n/).find((l) => l.startsWith("a=fingerprint:"))!;
    expect(line).toBe(`a=fingerprint:sha-256 ${"AB:".repeat(31)}AB`);
    const reExtracted = handshakeFromSdp(sdp, "o", NOW);
    expect(reExtracted.f).toBe(hs.f);
    expect(reExtracted.c).toEqual(hs.c);
    expect(reExtracted.u).toBe(hs.u);
    expect(reExtracted.m).toEqual(hs.m);
  });
});

describe("DB0 fallback codec (PRD 8.2.1)", () => {
  const SDP =
    "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";

  it("round-trips a full SDP", async () => {
    const code = await encodeDb0(SDP);
    expect(code.startsWith(DB0_PREFIX)).toBe(true);
    expect(await decodeDb0(code)).toBe(SDP);
  });

  it("decodes DB0 with whitespace in the code", async () => {
    const code = (await encodeDb0(SDP)).replace(/.{5}/g, "$& ");
    expect(await decodeDb0(code)).toBe(SDP);
  });

  it("rejects SDP-shaped garbage and oversized input", async () => {
    await expectCodeError(decodeDb0("nope"), "CODE_INVALID");
    await expectCodeError(decodeDb0(DB0_PREFIX + "!!!!"), "CODE_INVALID");
    await expectCodeError(encodeDb0("not sdp at all"), "CODE_INVALID");
    await expectCodeError(encodeDb0("v=0\r\n"), "CODE_INVALID");
    await expectCodeError(encodeDb0("x".repeat(70_000)), "CODE_INVALID");
  });

  it("works across both compression implementations", async () => {
    const code = await encodeDb0(SDP, { impl: "fflate" });
    expect(await decodeDb0(code, { impl: "native" })).toBe(SDP);
    const nativeCode = await encodeDb0(SDP, { impl: "native" });
    expect(await decodeDb0(nativeCode, { impl: "fflate" })).toBe(SDP);
  });
});

describe("unified decode dispatch (PRD 8.2.1)", () => {
  it("decodes either codec and returns ready SDP", async () => {
    const db1 = await decodeHandshake(await encodeDb1(sampleHandshake(), { nowSeconds: NOW }), {
      nowSeconds: NOW,
    });
    expect(db1.codec).toBe("DB1");
    expect(db1.handshake?.u).toBe("Zx9+Qk");
    expect(db1.sdp).toContain("m=application");

    const sdp = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";
    const db0 = await decodeHandshake(await encodeDb0(sdp));
    expect(db0.codec).toBe("DB0");
    expect(db0.handshake).toBeNull();
    expect(db0.sdp).toBe(sdp);
  });

  it("rejects unknown prefixes and non-text input", async () => {
    await expectCodeError(decodeHandshake("XYZ.abc"), "CODE_INVALID");
    await expectCodeError(decodeHandshake(123 as unknown as string), "CODE_INVALID");
  });
});
