// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/preact";
import { afterEach } from "vitest";
import { QrTile } from "../../src/ui/components/QrTile";
import { CodeBox, groupCode } from "../../src/ui/components/CodeBox";
import { ProgressRow, formatBytes } from "../../src/ui/components/ProgressRow";
import { Prompt } from "../../src/ui/components/Prompt";
import { Beam } from "../../src/ui/components/Beam";
import { App } from "../../src/ui/App";
import { SettingsStore, type KeyValueStore } from "../../src/core/platform/storage";

afterEach(cleanup);

/**
 * Minimal data-channel-only SDP (PRD 8.2.1 template) used to drive the host
 * flow without a real WebRTC stack. The fingerprint must be sha-256 (32 bytes,
 * colon-hex) or handshake validation rejects the description.
 */
const SHA256_FINGERPRINT_HEX = Array.from(new Uint8Array(32).fill(0xab), (b) =>
  b.toString(16).padStart(2, "0").toUpperCase(),
).join(":");

const OFFER_SDP = [
  "v=0",
  "o=- 1 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=mid:0",
  "a=sctp-port:5000",
  "a=max-message-size:262144",
  "a=ice-ufrag:Zx9Qk",
  "a=ice-pwd:p4ssw0rdBASE64abcDEF123",
  `a=fingerprint:sha-256 ${SHA256_FINGERPRINT_HEX}`,
  "a=setup:actpass",
  "a=candidate:1 1 udp 2122260223 192.168.1.7 54321 typ host",
  "a=end-of-candidates",
].join("\r\n");

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
