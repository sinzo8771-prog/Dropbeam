import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { TransferSession, type FileProgress } from "../core/transfer/transfer-session";
import type { IncomingOffer, IncomingText } from "../core/transfer/receiver";
import type { ChannelLike } from "../core/transfer/channel";
import type { SaveResult } from "../core/storage/sink";
import type { ErrorCode } from "../core/errors";

/**
 * Owns one `TransferSession` for the life of an open channel (PRD 8.4/8.5).
 *
 * The session is created when the channel opens and disposed when it closes, so
 * a screen can never leak a listener onto a dead channel or keep two sessions
 * bound to the same one. Everything the transfer UI renders comes back through
 * `TransferSessionEvents`, and every action goes back through the session, so
 * the component never touches the protocol directly.
 */

export type TransferView = {
  /** Every file this side has seen, sending or receiving, in arrival order. */
  files: FileProgress[];
  /** Files that finished writing, newest last. */
  saved: SaveResult[];
  /** Notes received from the peer (FR-12). */
  notes: IncomingText[];
  /** The offer awaiting the user's decision, or null (FR-13). */
  offer: IncomingOffer | null;
  error: ErrorCode | null;
};

export type UseTransfer = TransferView & {
  /** FR-10: offer files. Files are read by the caller, so `File` is enough. */
  sendFiles(files: File[]): Promise<void>;
  /** FR-12: send a note. Returns false when there was nothing to send. */
  sendText(body: string): boolean;
  acceptOffer(): Promise<void>;
  declineOffer(): void;
  cancel(fid: number): void;
  /** Dismiss a received note once it has been read. */
  dismissNote(id: string): void;
  /** True once there is a channel to transfer over. */
  ready: boolean;
};

export type UseTransferOptions = {
  /** The open data channel, or null before the session connects. */
  channel: ChannelLike | null;
  deviceName?: string;
  autoAccept?: boolean;
  /** Odd fids for the offerer, even for the answerer, so they never collide. */
  fidParity?: 0 | 1;
};

/** Merge an event's snapshot into the list, keyed by fid, preserving order. */
function upsert(prev: FileProgress[], next: FileProgress): FileProgress[] {
  const at = prev.findIndex((f) => f.fid === next.fid);
  if (at === -1) return [...prev, next];
  const copy = [...prev];
  copy[at] = next;
  return copy;
}

export function useTransfer(opts: UseTransferOptions): UseTransfer {
  const { channel, deviceName, autoAccept, fidParity } = opts;
  const [files, setFiles] = useState<FileProgress[]>([]);
  const [saved, setSaved] = useState<SaveResult[]>([]);
  const [notes, setNotes] = useState<IncomingText[]>([]);
  const [offer, setOffer] = useState<IncomingOffer | null>(null);
  const [error, setError] = useState<ErrorCode | null>(null);
  const sessionRef = useRef<TransferSession | null>(null);

  useEffect(() => {
    // No channel yet, or the previous one went away: start from a clean slate
    // so a finished session's rows cannot be mistaken for the next one's.
    setFiles([]);
    setSaved([]);
    setNotes([]);
    setOffer(null);
    setError(null);
    sessionRef.current = null;
    if (!channel) return;

    const session = new TransferSession({
      channel,
      deviceName,
      autoAccept,
      fidParity,
      events: {
        onPhase: (file) => setFiles((prev) => upsert(prev, file)),
        onProgress: (file) => setFiles((prev) => upsert(prev, file)),
        onSaved: (result) => setSaved((prev) => [...prev, result]),
        onOffer: (incoming) => setOffer(incoming),
        onText: (text) => setNotes((prev) => [...prev, text]),
        onError: (code) => setError(code),
      },
    });
    sessionRef.current = session;
    // PRD 8.4 `hello`: announce ourselves as soon as the channel is usable.
    session.start();
    return () => {
      session.dispose();
      sessionRef.current = null;
    };
  }, [channel, deviceName, autoAccept, fidParity]);

  const sendFiles = useCallback(async (picked: File[]): Promise<void> => {
    const session = sessionRef.current;
    if (!session || picked.length === 0) return;
    await session.sendFiles(
      picked.map((file) => ({ blob: file, name: file.name, type: file.type })),
    );
  }, []);

  const sendText = useCallback((body: string): boolean => {
    const session = sessionRef.current;
    if (!session || body.trim() === "") return false;
    session.sendText(body);
    return true;
  }, []);

  const acceptOffer = useCallback(async (): Promise<void> => {
    const session = sessionRef.current;
    const current = offer;
    if (!session || !current) return;
    // Clear first: the prompt must not be able to re-fire for the same offer.
    setOffer(null);
    await session.acceptOffer(current.id);
  }, [offer]);

  const declineOffer = useCallback((): void => {
    const session = sessionRef.current;
    const current = offer;
    if (!session || !current) return;
    setOffer(null);
    session.declineOffer(current.id);
  }, [offer]);

  const cancel = useCallback((fid: number): void => {
    sessionRef.current?.cancel(fid);
  }, []);

  const dismissNote = useCallback((id: string): void => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
  }, []);

  return {
    files,
    saved,
    notes,
    offer,
    error,
    ready: channel !== null,
    sendFiles,
    sendText,
    acceptOffer,
    declineOffer,
    cancel,
    dismissNote,
  };
}
