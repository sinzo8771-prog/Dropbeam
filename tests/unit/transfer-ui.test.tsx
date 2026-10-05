// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/preact";
import { TransferPanel } from "../../src/ui/components/TransferPanel";
import { useTransfer } from "../../src/ui/use-transfer";
import { TransferSession } from "../../src/core/transfer/transfer-session";
import { translatorFor } from "../../src/core/platform/i18n";
import { MemoryChannel, waitFor as waitUntil } from "../helpers/memory-channel";
import type { ChannelLike } from "../../src/core/transfer/channel";
import type { FileProgress } from "../../src/core/transfer/transfer-session";
import type { IncomingText } from "../../src/core/transfer/receiver";
import type { SaveResult } from "../../src/core/storage/sink";

afterEach(cleanup);

const t = translatorFor("en");

function file(name: string, size: number): File {
  return new File([new Uint8Array(size).fill(7)], name, { type: "application/octet-stream" });
}

describe("TransferPanel (PRD 10.1 screen 6)", () => {
  const noop = {
    onSendFiles: () => {},
    onSendText: () => {},
    onCancel: () => {},
    onDismissNote: () => {},
  };

  it("shows the empty state and a reachable file picker", () => {
    render(<TransferPanel t={t} files={[]} saved={[]} notes={[]} {...noop} />);
    expect(screen.getByText("No files yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose files" })).toBeTruthy();
    // The input is the accessible route; the drop zone is only an accelerator.
    const input = screen.getByTestId("file-input");
    expect(input).toBeTruthy();
    // It must not be announced as a second control: the visible button drives it.
    expect(input.getAttribute("aria-hidden")).toBe("true");
    expect(input.getAttribute("tabindex")).toBe("-1");
  });

  it("renders a progress row per file and lets the user cancel", () => {
    const onCancel = vi.fn();
    const files: FileProgress[] = [
      { fid: 1, name: "holiday.mp4", size: 2048, phase: "TRANSFERRING", done: 1024 },
      { fid: 3, name: "notes.txt", size: 10, phase: "DONE", done: 10 },
    ];
    render(
      <TransferPanel t={t} files={files} saved={[]} notes={[]} {...noop} onCancel={onCancel} />,
    );
    const rows = screen.getAllByTestId("progress-row");
    expect(rows).toHaveLength(2);
    // Only the in-flight file offers a cancel; a finished one does not.
    fireEvent.click(within(rows[0] as HTMLElement).getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledWith(1);
    expect(within(rows[1] as HTMLElement).queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("sends a picked file list through the callback", () => {
    const onSendFiles = vi.fn();
    render(
      <TransferPanel t={t} files={[]} saved={[]} notes={[]} {...noop} onSendFiles={onSendFiles} />,
    );
    const input = screen.getByTestId("file-input") as HTMLInputElement;
    const a = file("a.txt", 3);
    const b = file("b.txt", 4);
    Object.defineProperty(input, "files", { value: [a, b], configurable: true });
    fireEvent.change(input);
    expect(onSendFiles).toHaveBeenCalledWith([a, b]);
  });

  it("keeps Send disabled until there is something to send", () => {
    const onSendText = vi.fn();
    render(
      <TransferPanel t={t} files={[]} saved={[]} notes={[]} {...noop} onSendText={onSendText} />,
    );
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    const area = screen.getByLabelText("Send a note");
    fireEvent.input(area, { target: { value: "meet me at 6" } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onSendText).toHaveBeenCalledWith("meet me at 6");
  });

  it("renders a received note as text, never as markup", () => {
    const notes: IncomingText[] = [{ id: "n1", body: "<img src=x onerror=alert(1)> meet me at 6" }];
    const { container } = render(
      <TransferPanel t={t} files={[]} saved={[]} notes={notes} {...noop} />,
    );
    const row = screen.getByTestId("note-row");
    // The angle brackets are visible characters, not a parsed element.
    expect(row.querySelector("img")).toBeNull();
    expect(row.textContent).toContain("<img src=x onerror=alert(1)> meet me at 6");
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it("dismisses a note once it has been read", () => {
    const onDismissNote = vi.fn();
    render(
      <TransferPanel
        t={t}
        files={[]}
        saved={[]}
        notes={[{ id: "n1", body: "hi" }]}
        {...noop}
        onDismissNote={onDismissNote}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onDismissNote).toHaveBeenCalledWith("n1");
  });

  it("lists what was saved and where", () => {
    const saved: SaveResult[] = [{ name: "receipt.pdf", size: 12, sink: "opfs" }];
    render(<TransferPanel t={t} files={[]} saved={saved} notes={[]} {...noop} />);
    const row = screen.getByTestId("saved-row");
    expect(row.textContent).toContain("receipt.pdf");
    expect(row.textContent).toContain("Saved");
  });
});

/** A tiny host component so the hook can be exercised the way the app uses it. */
function Harness(props: {
  channel: ChannelLike | null;
  fidParity?: 0 | 1;
  onReady?: (api: ReturnType<typeof useTransfer>) => void;
}) {
  const api = useTransfer({
    channel: props.channel,
    deviceName: "Laptop",
    fidParity: props.fidParity ?? 1,
  });
  props.onReady?.(api);
  return (
    <TransferPanel
      t={t}
      files={api.files}
      saved={api.saved}
      notes={api.notes}
      onSendFiles={(picked) => void api.sendFiles(picked)}
      onSendText={(body) => api.sendText(body)}
      onCancel={api.cancel}
      onDismissNote={api.dismissNote}
    />
  );
}

describe("useTransfer (PRD 8.4/8.5)", () => {
  it("announces itself with hello as soon as the channel opens", async () => {
    const [here, there] = MemoryChannel.pair();
    const received: string[] = [];
    there.addEventListener("message", ((ev: MessageEvent) =>
      received.push(String(ev.data))) as never);
    render(<Harness channel={here} />);
    // PRD 8.4 `hello` carries the protocol version and the device label.
    // Preact flushes effects after commit, so this lands a tick later. The
    // Receiver's constructor ping goes out first, so look for the hello rather
    // than assuming it is the first frame on the wire.
    await waitUntil(() => received.length > 0, { label: "first frame sent" });
    await waitUntil(() => received.some((m) => JSON.parse(m).k === "hello"), {
      label: "hello sent",
    });
    const hello = received.map((m) => JSON.parse(m)).find((m) => m.k === "hello");
    expect(hello).toMatchObject({ name: "Laptop" });
    expect(typeof hello!.v).toBe("number");
  });

  it("moves a real file to the peer and reports progress on both sides", async () => {
    const [senderSide, peerSide] = MemoryChannel.pair();
    let api: ReturnType<typeof useTransfer> | null = null;
    render(<Harness channel={senderSide} onReady={(a) => (api = a)} />);

    // The peer is a plain TransferSession, so this exercises the real protocol.
    const received: string[] = [];
    const peer = new TransferSession({
      channel: peerSide,
      deviceName: "Phone",
      fidParity: 0,
      autoAccept: true,
      events: {
        onSaved: (result) => received.push(`${result.name}:${result.size}`),
      },
    });
    peer.start();

    await api!.sendFiles([file("holiday.mp4", 64 * 1024)]);
    await waitUntil(() => received.length > 0, { label: "peer saved the file" });

    expect(received[0]).toBe(`holiday.mp4:${64 * 1024}`);
    // The row the user watches must reach DONE with the bytes accounted for.
    await waitFor(() => {
      const row = screen.getByTestId("progress-row");
      expect(row.textContent).toContain("holiday.mp4");
      expect(row.textContent).toContain("Saved");
    });
    peer.dispose();
  });

  it("delivers a note to the peer", async () => {
    const [senderSide, peerSide] = MemoryChannel.pair();
    const bodies: string[] = [];
    const peer = new TransferSession({
      channel: peerSide,
      fidParity: 0,
      autoAccept: true,
      events: { onText: (text) => bodies.push(text.body) },
    });
    peer.start();

    let api: ReturnType<typeof useTransfer> | null = null;
    render(<Harness channel={senderSide} onReady={(a) => (api = a)} />);
    expect(api!.sendText("meet me at 6")).toBe(true);

    await waitUntil(() => bodies.length > 0, { label: "note delivered" });
    expect(bodies[0]).toBe("meet me at 6");
    // An empty note is not worth a message on the wire.
    expect(api!.sendText("   ")).toBe(false);
    peer.dispose();
  });

  it("surfaces an incoming offer and accepts it, clearing the prompt", async () => {
    const [receiverSide, senderSide] = MemoryChannel.pair();
    const sender = new TransferSession({
      channel: senderSide,
      fidParity: 0,
      autoAccept: true,
    });
    sender.start();

    let api: ReturnType<typeof useTransfer> | null = null;
    render(<Harness channel={receiverSide} fidParity={1} onReady={(a) => (api = a)} />);

    // Not awaited: Sender blocks until the offer is accepted, which is exactly
    // the decision this test is about to make.
    void sender.sendFiles([{ blob: file("invoice.pdf", 2048), name: "invoice.pdf" }]);
    // FR-13: the offer is held until the user decides, never auto-accepted here.
    await waitUntil(() => api!.offer !== null, { label: "offer received" });
    expect(api!.offer!.files.map((f) => f.name)).toEqual(["invoice.pdf"]);

    await api!.acceptOffer();
    expect(api!.offer).toBeNull();
    sender.dispose();
  });

  it("starts clean when the channel goes away", async () => {
    const [here] = MemoryChannel.pair();
    let api: ReturnType<typeof useTransfer> | null = null;
    const view = render(<Harness channel={here} onReady={(a) => (api = a)} />);
    // Rows are tracked before a single byte moves, so this does not await the
    // send — nothing on the far end would ever accept this offer.
    void api!.sendFiles([file("a.txt", 8)]);
    await waitFor(() => expect(screen.getAllByTestId("progress-row").length).toBeGreaterThan(0));

    view.rerender(<Harness channel={null} onReady={(a) => (api = a)} />);
    await waitFor(() => expect(screen.queryAllByTestId("progress-row")).toHaveLength(0));
    expect(api!.ready).toBe(false);
  });
});
