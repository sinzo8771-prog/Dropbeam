// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { FileIcon, fileKind } from "../../src/ui/components/FileIcon";
import { TransferPanel } from "../../src/ui/components/TransferPanel";
import { translatorFor } from "../../src/core/platform/i18n";
import type { SaveResult } from "../../src/core/storage/sink";

/**
 * The per-file icon and the "Send back" action (PRD 10.1 screen 6, FR-20).
 *
 * The icon is decorative - the name is right beside it - so it is hidden from
 * assistive technology rather than read out as a second label. "Send back" is
 * offered when the sink can still read its own output, and it reads the bytes
 * back from there rather than from the app's memory.
 */

const t = translatorFor("en");

afterEach(cleanup);

describe("the file-type icon (PRD 10.1 #6)", () => {
  it("picks a kind from the media type", () => {
    expect(fileKind("image/png")).toBe("image");
    expect(fileKind("video/mp4")).toBe("video");
    expect(fileKind("audio/mpeg")).toBe("audio");
    expect(fileKind("text/plain")).toBe("document");
    expect(fileKind("application/pdf")).toBe("document");
    expect(fileKind("application/zip")).toBe("archive");
    expect(fileKind("application/json")).toBe("code");
    expect(fileKind("application/octet-stream")).toBe("file");
  });

  it("falls back to the extension when the platform names no type", () => {
    expect(fileKind("", "holiday.mp4")).toBe("video");
    expect(fileKind("", "notes.txt")).toBe("document");
    expect(fileKind("", "bundle.zip")).toBe("archive");
    expect(fileKind("", "script.sh")).toBe("code");
    expect(fileKind("", "mystery")).toBe("file");
  });

  it("is decorative: the name beside it is what a screen reader reads", () => {
    render(<FileIcon kind="image" />);
    const icon = screen.getByTestId("file-icon");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.getAttribute("role")).toBe("presentation");
  });

  it("draws in the row's colour, with no fill and no emoji", () => {
    render(<FileIcon kind="archive" />);
    const icon = screen.getByTestId("file-icon");
    expect(icon.getAttribute("stroke")).toBe("currentColor");
    expect(icon.getAttribute("fill")).toBe("none");
    expect(icon.getAttribute("data-kind")).toBe("archive");
  });
});

describe("Send back (FR-20)", () => {
  const noop = {
    onSendFiles: () => {},
    onSendText: () => {},
    onCancel: () => {},
    onDismissNote: () => {},
  };

  it("sends the received file back to the peer, read from where it was saved", async () => {
    const onSendFiles = vi.fn();
    const bytes = new Uint8Array([1, 2, 3]);
    const saved: SaveResult[] = [
      {
        name: "receipt.pdf",
        size: 3,
        sink: "opfs",
        read: async () => new Blob([bytes]),
      },
    ];
    render(<TransferPanel t={t} files={[]} saved={saved} notes={[]} {...noop} onSendFiles={onSendFiles} />);

    fireEvent.click(screen.getByTestId("saved-send-back"));
    await vi.waitFor(() => expect(onSendFiles).toHaveBeenCalledTimes(1));
    const sent = onSendFiles.mock.calls[0]?.[0] as File[];
    expect(sent[0]?.name).toBe("receipt.pdf");
    expect(new Uint8Array(await sent[0]!.arrayBuffer())).toEqual(bytes);
  });

  it("is not offered when the sink cannot read its own output back", () => {
    const saved: SaveResult[] = [{ name: "receipt.pdf", size: 3, sink: "fsa" }];
    render(<TransferPanel t={t} files={[]} saved={saved} notes={[]} {...noop} />);
    expect(screen.queryByTestId("saved-send-back")).toBeNull();
  });
});
