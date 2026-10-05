/**
 * Minimal view of the `dropbeam` data channel so the transfer engine can be
 * tested without a browser (PRD 8.4). `RTCDataChannel` satisfies this shape.
 */
export type ChannelState = "connecting" | "open" | "closing" | "closed";

export interface ChannelLike {
  readonly label: string;
  readonly readyState: ChannelState;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: BinaryType;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(): void;
  addEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
  addEventListener(
    type: "open" | "close" | "error" | "bufferedamountlow",
    listener: (ev: Event) => void,
  ): void;
  removeEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
  removeEventListener(
    type: "open" | "close" | "error" | "bufferedamountlow",
    listener: (ev: Event) => void,
  ): void;
}
