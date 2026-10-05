// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/preact";
import { afterEach } from "vitest";
import { QrTile } from "../../src/ui/components/QrTile";
import { CodeBox, groupCode } from "../../src/ui/components/CodeBox";
import { ProgressRow, formatBytes } from "../../src/ui/components/ProgressRow";
import { Prompt } from "../../src/ui/components/Prompt";
import { Beam } from "../../src/ui/components/Beam";
import { VerifyCard } from "../../src/ui/components/VerifyCard";
import { App } from "../../src/ui/App";
import { SettingsStore, type KeyValueStore } from "../../src/core/platform/storage";
import { SessionController, type PeerTransport } from "../../src/core/peer/session-controller";
import { buildSdp } from "../../src/core/handshake/sdp-template";
import type { Handshake } from "../../src/core/handshake/codec-db1";
import { toBase64Url } from "../../src/core/handshake/encoding";
import { MemoryChannel } from "../helpers/memory-channel";
import type { ChannelLike } from "../../src/core/transfer/channel";

afterEach(cleanup);

/**
 * Minimal data-channel-only SDP (PRD 8.2.1 template) used to drive the host
 * flow without a real WebRTC stack. The fingerprint must be sha-256 (32 bytes,
 * colon-hex) or handshake validation rejects the description.
 *
 * Built from parts rather than pasted, because an answer must differ from the
 * offer in DTLS role, ICE credentials, fingerprint and candidate address — a
 * stub that echoes the offer back produces a handshake that cannot be decoded.
 */
const CRLF = String.fromCharCode(13, 10);

function sdpFor(role: "offer" | "answer", identity: number): string {
  const fp = Array.from(new Uint8Array(32).fill(identity), (b) =>
    b.toString(16).padStart(2, "0").toUpperCase(),
  ).join(":");
  return [
    "v=0",
    `o=- 1 ${identity} IN IP4 127.0.0.1`,
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    "a=mid:0",
    "a=sctp-port:5000",
    "a=max-message-size:262144",
    `a=ice-ufrag:Ufrag${identity}`,
    `a=ice-pwd:P4ssw0rdBASE64abcDEF12${identity}`,
    `a=fingerprint:sha-256 ${fp}`,
    // The offerer may be either role; the answerer must be active.
    role === "offer" ? "a=setup:actpass" : "a=setup:active",
    `a=candidate:1 1 udp 2122260223 192.168.1.${identity} ${54320 + identity} typ host`,
    "a=end-of-candidates",
  ].join(CRLF);
}

const OFFER_SDP = sdpFor("offer", 7);
const ANSWER_SDP = sdpFor("answer", 9);

/**
 * Isolated settings per test: the real store persists to localStorage, so a
 * shared one would leak the `hi` language into later tests.
 */
function freshSettings(): SettingsStore {
  const map = new Map<string, string>();
  const backing: KeyValueStore = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
  return new SettingsStore(backing);
}

describe("QrTile (PRD 10.2)", () => {
  it("renders a scannable QR with an accessible label", () => {
    const { container } = render(<QrTile content="DB1.abc" label="Offer code" />);
    const frame = container.querySelector(".qr-tile-frame");
    expect(frame).not.toBeNull();
    // Accessible name for assistive tech.
    expect(frame?.getAttribute("role")).toBe("img");
    expect(frame?.getAttribute("aria-label")).toBe("Offer code");
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    // Quiet zone: 4 modules on each side (border option).
    expect(container.querySelector(".qr-tile-frame")?.innerHTML).toContain("<svg");
  });

  it("renders nothing for empty content", () => {
    const { container } = render(<QrTile content="" label="x" />);
    expect(container.querySelector(".qr-tile")).toBeNull();
  });
});

describe("CodeBox (PRD 8.2.3)", () => {
  it("groups the code in blocks of five for manual reading", () => {
    expect(groupCode("ABCDEFGHIJ")).toBe("ABCDE FGHIJ");
    expect(groupCode("ABC")).toBe("ABC");
    expect(groupCode("")).toBe("");
  });

  it("copies the ungrouped code and confirms", async () => {
    const onCopy = vi.fn();
    render(
      <CodeBox
        code="ABCDEFGHIJ"
        label="Code"
        copyLabel="Copy"
        copiedLabel="Copied"
        onCopy={onCopy}
      />,
    );
    fireEvent.click(screen.getByText("Copy"));
    expect(onCopy).toHaveBeenCalledWith("ABCDEFGHIJ");
    await Promise.resolve();
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("never breaks when the clipboard is unavailable", () => {
    const onCopy = () => Promise.reject(new Error("blocked"));
    render(
      <CodeBox code="ABC" label="Code" copyLabel="Copy" copiedLabel="Copied" onCopy={onCopy} />,
    );
    fireEvent.click(screen.getByText("Copy"));
    // No unhandled rejection; the code stays visible for manual copy.
    expect(screen.getByTestId("code-text").textContent).toBe("ABC");
  });
});

describe("ProgressRow (PRD 10.1 #6)", () => {
  it("exposes transfer progress accessibly", () => {
    const { container } = render(
      <ProgressRow
        name="holiday.mp4"
        size={1048576}
        phase="TRANSFERRING"
        sent={524288}
        total={1048576}
        cancelLabel="Cancel"
        onCancel={() => {}}
      />,
    );
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByText("Cancel")).toBeTruthy();
    // The fill animates via transform (no layout thrash), not width.
    const fill = container.querySelector<HTMLElement>(".row-bar-fill");
    expect(fill?.style.transform).toBe("scaleX(0.5)");
    expect(fill?.style.width).toBe("");
  });

  it("hides cancel for terminal phases", () => {
    render(
      <ProgressRow
        name="a.txt"
        size={10}
        phase="DONE"
        sent={10}
        total={10}
        cancelLabel="Cancel"
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByText("Cancel")).toBeNull();
  });

  it("formats sizes with the mono-scale precision", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(-1)).toBe("—");
  });
});

describe("Prompt (PRD FR-13)", () => {
  it("renders as a native dialog with accept and decline", () => {
    const { container } = render(
      <Prompt
        open
        title="Send 2 files?"
        acceptLabel="Accept"
        declineLabel="Decline"
        onAccept={() => {}}
        onDecline={() => {}}
      />,
    );
    const dialog = container.querySelector("dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-labelledby")).toBe("prompt-title");
    expect(screen.getByText("Send 2 files?")).toBeTruthy();
    expect(screen.getByText("Accept")).toBeTruthy();
    // `open` must actually be set, or the prompt is invisible and unusable.
    expect((dialog as HTMLDialogElement).open).toBe(true);
    // Its buttons are reachable, which is what the incoming-transfer gate needs.
    expect(within(dialog as HTMLElement).getByRole("button", { name: "Accept" })).toBeTruthy();
  });

  it("closes when `open` goes back to false", () => {
    const { container, rerender } = render(
      <Prompt
        open
        title="Send 2 files?"
        acceptLabel="Accept"
        declineLabel="Decline"
        onAccept={() => {}}
        onDecline={() => {}}
      />,
    );
    rerender(
      <Prompt
        open={false}
        title="Send 2 files?"
        acceptLabel="Accept"
        declineLabel="Decline"
        onAccept={() => {}}
        onDecline={() => {}}
      />,
    );
    expect((container.querySelector("dialog") as HTMLDialogElement).open).toBe(false);
  });
});

describe("Beam (PRD 10.2)", () => {
  it("is decorative and respects reduced motion", () => {
    const { container } = render(<Beam active />);
    const beam = container.querySelector('[data-testid="beam"]');
    // Decorative: hidden from assistive tech.
    expect(beam?.getAttribute("aria-hidden")).toBe("true");
    const animated = container.querySelector(".beam.is-active");
    expect(animated).not.toBeNull();

    const reduced = render(<Beam active reduceMotion />);
    // With reduceMotion the dash pattern (the animated part) is omitted.
    expect(reduced.container.querySelector("line")?.getAttribute("stroke-dasharray")).toBeNull();
  });
});

describe("VerifyCard (PRD 9.3)", () => {
  it("shows the words and the read-aloud digits from the phrase", () => {
    const { container } = render(
      <VerifyCard
        phrase={{ words: ["maple", "harbor", "quartz"], digits: "042718" }}
        label="Verification words"
        help="Check that both devices show the same words."
        digitsLabel="Read aloud"
      />,
    );
    expect(container.querySelector(".verify-card-words")?.textContent).toBe("maple harbor quartz");
    expect(screen.getByText("042718")).toBeTruthy();
    // Labelled for assistive tech, since it is the MITM check.
    expect(container.querySelector(".verify-card")?.getAttribute("aria-label")).toBe(
      "Verification words",
    );
  });
});

describe("App (PRD 10.1 screens)", () => {
  it("shows the home screen with Start and Join", () => {
    render(<App settings={freshSettings()} baseUrl="https://dropbeam.example" />);
    expect(screen.getByText("Start")).toBeTruthy();
    expect(screen.getByText("Join")).toBeTruthy();
  });

  it("renders in Hindi when the language setting is hi", () => {
    const settings = freshSettings();
    settings.update({ language: "hi" });
    render(<App settings={settings} baseUrl="https://dropbeam.example" />);
    expect(screen.getByText("शुरू करें")).toBeTruthy();
    expect(screen.getByText("जुड़ें")).toBeTruthy();
  });

  it("reports UNSUPPORTED when WebRTC is unavailable", () => {
    render(<App settings={freshSettings()} baseUrl="https://dropbeam.example" />);
    fireEvent.click(screen.getByText("Start"));
    // jsdom has no RTCPeerConnection, so the user must see the reason code.
    expect(screen.getByRole("alert").textContent).toContain(
      "This browser can't do direct transfers.",
    );
  });

  it("surfaces an error message and a Try again action", () => {
    render(<App settings={freshSettings()} baseUrl="https://dropbeam.example" />);
    fireEvent.click(screen.getByText("Start"));
    expect(screen.getByText("Try again")).toBeTruthy();
    fireEvent.click(screen.getByText("Try again"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  /**
   * Regression guard: with WebRTC present the machine reaches SHOWING_OFFER
   * before WAITING_FOR_REPLY. If only the latter renders, the screen blanks
   * out in a real browser (caught by manual preview, invisible in jsdom where
   * RTCPeerConnection is always missing and the run stops at UNSUPPORTED).
   */
  it("renders the pairing screen for SHOWING_OFFER as well as WAITING_FOR_REPLY", async () => {
    vi.stubGlobal(
      "RTCPeerConnection",
      class {
        iceGatheringState = "complete";
        localDescription: RTCSessionDescriptionInit | null = null;
        connectionState = "new";
        addEventListener() {}
        removeEventListener() {}
        async createOffer() {
          return { type: "offer", sdp: OFFER_SDP };
        }
        async setLocalDescription() {
          this.localDescription = { type: "offer", sdp: OFFER_SDP };
        }
        createDataChannel() {
          return { binaryType: "", readyState: "connecting", addEventListener() {}, close() {} };
        }
        close() {}
      },
    );
    try {
      render(<App settings={freshSettings()} baseUrl="https://dropbeam.example" />);
      fireEvent.click(screen.getByText("Start"));
      // The pairing screen must appear immediately (not a blank main region),
      // showing a preparing state while ICE gathering is still in flight.
      const preparing = await screen.findByText("Preparing a code…");
      expect(preparing).toBeTruthy();
      expect(screen.queryByTestId("code-text")).toBeNull();

      // Once gathering finishes the offer is rendered as a real DB1 code.
      await waitFor(() => expect(screen.getByTestId("code-text")).toBeTruthy());
      const code = screen.getByTestId("code-text").textContent ?? "";
      expect(code.replace(/ /g, "")).toMatch(/^DB1\./);
      // (Match the button, since the prompt dialog reuses the same label.)
      expect(screen.getByRole("button", { name: "Scan reply" })).toBeTruthy();
      expect(
        screen.getByText("Waiting for the other device to scan or paste its reply…"),
      ).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/** Start a real host session, then unmount it, and return its offer code. */
async function makeOfferCode(): Promise<string> {
  render(<App settings={freshSettings()} baseUrl="https://dropbeam.example" />);
  fireEvent.click(screen.getByText("Start"));
  await waitFor(() => expect(screen.getByTestId("code-text")).toBeTruthy());
  const code = (screen.getByTestId("code-text").textContent ?? "").replace(/ /g, "");
  cleanup();
  return code;
}

/**
 * A second real device, used to answer the host's offer with a genuine DB1
 * code (PRD 5.1). Only its transport is faked, so the host really decodes
 * the peer's label and DTLS fingerprint — which is what the connected-screen
 * security UI is built on.
 */
async function guestAnswering(offerCode: string, name = "Phone"): Promise<string> {
  const hs = (type: "o" | "a"): Handshake => ({
    v: 1,
    t: type,
    ts: Math.floor(Date.now() / 1000),
    u: "Zx9+Qk",
    p: "p4ssw0rdBASE64abcDEF123",
    f: toBase64Url(new Uint8Array(32).fill(type === "o" ? 0xab : 0x3c)),
    s: type === "o" ? "actpass" : "active",
    c: ["1|2122260223|udp|192.168.1.9|54322|host"],
    m: { sp: 5000, mms: 1048576 },
    n: type === "o" ? undefined : name,
  });
  const transport: PeerTransport = {
    async createOffer() {
      const h = hs("o");
      return { sdp: buildSdp(h), handshake: h };
    },
    async createAnswer() {
      const h = hs("a");
      return { sdp: buildSdp(h), handshake: h };
    },
    async applyAnswer() {
      return new MemoryChannel({}) as unknown as ChannelLike;
    },
    close() {
      /* nothing to release */
    },
  };
  const snap = await new SessionController({
    side: "guest",
    baseUrl: "https://dropbeam.example",
    transport,
    // `publish()` sets `n` from deviceName, so the label has to come from here.
    deviceName: name,
  }).joinWithCode(offerCode);
  return snap.code;
}

/**
 * A data-channel-only stub whose channel opens right after the remote
 * description is applied, so the host really reaches CONNECTED. jsdom has no
 * RTCPeerConnection, so the whole host flow has to be stubbed to exercise the
 * connected screen (PRD 9.3/9.5 wiring).
 */
function stubWebRtc(): { sent: string[]; restore: () => void } {
  // Everything the app writes on the channel, so a test can assert on the
  // real protocol traffic (e.g. the PRD 8.4 `hello`) rather than just on paint.
  const sent: string[] = [];

  class FakeDataChannel {
    label = "dropbeam";
    binaryType: BinaryType = "arraybuffer";
    readyState = "connecting";
    bufferedAmount = 0;
    bufferedAmountLowThreshold = 0;
    private handlers = new Map<string, () => void>();
    send(data: string | ArrayBuffer | ArrayBufferView) {
      sent.push(typeof data === "string" ? data : "[binary]");
    }
    addEventListener(type: string, fn: () => void) {
      this.handlers.set(type, fn);
    }
    removeEventListener(type: string) {
      this.handlers.delete(type);
    }
    close() {
      this.readyState = "closed";
      this.handlers.get("close")?.();
    }
    open() {
      this.readyState = "open";
      this.handlers.get("open")?.();
    }
  }

  vi.stubGlobal(
    "RTCPeerConnection",
    class {
      iceGatheringState = "complete";
      connectionState = "new";
      localDescription: RTCSessionDescriptionInit | null = null;
      private handlers = new Map<string, () => void>();
      private channel = new FakeDataChannel();
      addEventListener(type: string, fn: () => void) {
        this.handlers.set(type, fn);
      }
      removeEventListener(type: string) {
        this.handlers.delete(type);
      }
      async createOffer() {
        return { type: "offer", sdp: OFFER_SDP };
      }
      async createAnswer() {
        return { type: "answer", sdp: ANSWER_SDP };
      }
      async setLocalDescription(description: RTCSessionDescriptionInit) {
        // Keep whatever was negotiated; echoing the offer back would make the
        // guest build an undecodable answer.
        this.localDescription = description;
      }
      async setRemoteDescription() {
        // The answer is in place; the channel opens on the next tick, as it
        // would once DTLS finished.
        setTimeout(() => this.channel.open(), 0);
      }
      createDataChannel() {
        return this.channel;
      }
      close() {
        this.connectionState = "closed";
        this.handlers.get("connectionstatechange")?.();
      }
    },
  );

  return {
    sent,
    restore: () => {
      vi.unstubAllGlobals();
    },
  };
}

/** jsdom has no clipboard; the paste routes read from it (FR-6). */
function stubClipboard(text: () => string | Promise<string>): void {
  Object.defineProperty(navigator, "clipboard", {
    value: { readText: async () => text(), writeText: async () => {} },
    configurable: true,
  });
}

describe("App shared offer link (FR-6)", () => {
  /**
   * Regression guard: the `#j=` route used to park the offer in state and only
   * send the machine to SCANNING_OFFER, so a guest who opened a shared link
   * stared at an empty camera screen forever. It must answer the offer.
   */
  it("answers the offer carried in the link fragment", async () => {
    const rtc = stubWebRtc();
    const restore = location.hash;
    try {
      const offerCode = await makeOfferCode();
      location.hash = `#j=${offerCode}`;
      render(<App settings={freshSettings()} baseUrl="https://dropbeam.example" />);

      // Until the answer code is encoded the screen shows the preparing state,
      // never a blank main region.
      await waitFor(() => expect(screen.queryByTestId("code-text")).toBeTruthy());
      expect(document.querySelector("main")?.getAttribute("data-screen")).toBe("SHOWING_ANSWER");
      const answer = (screen.getByTestId("code-text").textContent ?? "").replace(/ /g, "");
      expect(answer).toMatch(/^DB1\./);
      // The peer label from the host's code is carried across (FR-42).
      expect(answer).not.toBe(offerCode);
    } finally {
      location.hash = restore;
      rtc.restore();
    }
  });

  it("ignores an unrelated fragment instead of treating it as an offer", () => {
    const restore = location.hash;
    try {
      location.hash = "#help";
      render(<App settings={freshSettings()} baseUrl="https://dropbeam.example" />);
      // A non-Dropbeam anchor must not drag the app into the guest flow.
      expect(document.querySelector("main")?.getAttribute("data-screen")).toBe("IDLE");
    } finally {
      location.hash = restore;
    }
  });
});

describe("App connected screen (PRD 9.3, 9.5)", () => {
  it("shows the host approval prompt and the verification phrase once connected", async () => {
    const rtc = stubWebRtc();
    try {
      render(<App settings={freshSettings()} baseUrl="https://dropbeam.example" />);
      fireEvent.click(screen.getByText("Start"));
      await waitFor(() => expect(screen.getByTestId("code-text")).toBeTruthy());
      const offerCode = (screen.getByTestId("code-text").textContent ?? "").replace(/ /g, "");

      // The second device answers, and the host pastes the reply.
      let answerCode = "";
      stubClipboard(async () => {
        answerCode = answerCode || (await guestAnswering(offerCode));
        return answerCode;
      });
      fireEvent.click(screen.getByRole("button", { name: "Paste reply" }));

      // PRD 9.5: the host is asked before anything may move.
      const prompt = await screen.findByText("Allow connection from Phone?");
      expect(prompt).toBeTruthy();
      const dialog = prompt.closest("dialog") as HTMLDialogElement;
      // It must be a real, open modal — not just text sitting in the page.
      // Preact flushes effects after commit, so the open lands a tick later.
      await waitFor(() => expect(dialog.open).toBe(true));
      const connected = document.querySelector(".screen-connected") as HTMLElement;
      expect(connected.dataset.approval).toBe("pending");

      // PRD 9.3: the phrase from both fingerprints, shown on the connected screen.
      // It is derived asynchronously (SHA-256), so wait for the words to land.
      await waitFor(() =>
        expect(document.querySelector(".verify-card-words")?.textContent?.split(" ").length).toBe(
          3,
        ),
      );
      expect(document.querySelector(".verify-card-digits")?.textContent).toMatch(/\d{6}/);

      // Allowing is what lifts the block.
      fireEvent.click(within(dialog).getByRole("button", { name: "Allow" }));
      await waitFor(() =>
        expect(document.querySelector(".screen-connected")?.getAttribute("data-approval")).toBe(
          "allowed",
        ),
      );
      expect(dialog.open).toBe(false);
    } finally {
      rtc.restore();
    }
  });

  it("hides the transfer controls until the host allows the peer (PRD 9.5)", async () => {
    const rtc = stubWebRtc();
    try {
      render(<App settings={freshSettings()} baseUrl="https://dropbeam.example" />);
      fireEvent.click(screen.getByText("Start"));
      await waitFor(() => expect(screen.getByTestId("code-text")).toBeTruthy());
      const offerCode = (screen.getByTestId("code-text").textContent ?? "").replace(/ /g, "");

      let answerCode = "";
      stubClipboard(async () => {
        answerCode = answerCode || (await guestAnswering(offerCode));
        return answerCode;
      });
      fireEvent.click(screen.getByRole("button", { name: "Paste reply" }));
      const prompt = await screen.findByText("Allow connection from Phone?");
      const dialog = prompt.closest("dialog") as HTMLDialogElement;
      await waitFor(() => expect(dialog.open).toBe(true));

      // Connected, but not allowed yet: nothing may be sent or received.
      expect(document.querySelector(".transfer")).toBeNull();
      expect(screen.queryByRole("button", { name: "Choose files" })).toBeNull();

      fireEvent.click(within(dialog).getByRole("button", { name: "Allow" }));
      // Allowing is what mounts the transfer screen.
      await waitFor(() => expect(document.querySelector(".transfer")).not.toBeNull());
      expect(screen.getByRole("button", { name: "Choose files" })).toBeTruthy();
      // The engine is live on the channel, not just painted (PRD 8.4 hello).
      expect(rtc.sent.some((m) => m.includes('"hello"'))).toBe(true);
    } finally {
      rtc.restore();
    }
  });

  it("declining tears the session down instead of leaving it half-open", async () => {
    const rtc = stubWebRtc();
    try {
      render(<App settings={freshSettings()} baseUrl="https://dropbeam.example" />);
      fireEvent.click(screen.getByText("Start"));
      await waitFor(() => expect(screen.getByTestId("code-text")).toBeTruthy());
      const offerCode = (screen.getByTestId("code-text").textContent ?? "").replace(/ /g, "");

      let answerCode = "";
      stubClipboard(async () => {
        answerCode = answerCode || (await guestAnswering(offerCode));
        return answerCode;
      });
      fireEvent.click(screen.getByRole("button", { name: "Paste reply" }));
      const prompt = await screen.findByText("Allow connection from Phone?");
      const dialog = prompt.closest("dialog") as HTMLDialogElement;
      await waitFor(() => expect(dialog.open).toBe(true));

      fireEvent.click(within(dialog).getByRole("button", { name: "Decline" }));
      // A denial surfaces the PRD reason code rather than a live-looking screen.
      expect(screen.getByRole("alert").textContent).toContain("The other device declined.");
      expect(document.querySelector(".verify-card")).toBeNull();
    } finally {
      rtc.restore();
    }
  });
});
