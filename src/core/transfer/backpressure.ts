import type { ChannelLike } from "./channel";

/** PRD 8.4: pause when bufferedAmount > 1 MiB, resume at 256 KiB. */
export const HIGH_WATER = 1024 * 1024;
export const LOW_WATER = 256 * 1024;

/**
 * Gates `channel.send` on the channel's buffered amount.
 * Resolves immediately while the buffer is under the high-water mark, otherwise
 * waits for `bufferedamountlow` (with a short poll fallback for engines that
 * miss the event).
 */
export class BackpressureController {
  private waiters: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onLow = (): void => this.check();
  private disposed = false;

  constructor(
    private readonly channel: ChannelLike,
    private readonly high: number = HIGH_WATER,
    private readonly low: number = LOW_WATER,
  ) {
    this.channel.bufferedAmountLowThreshold = this.low;
    this.channel.addEventListener("bufferedamountlow", this.onLow);
  }

  private check(): void {
    if (this.waiters.length === 0) return;
    if (this.channel.bufferedAmount > this.low) return;
    const pending = this.waiters;
    this.waiters = [];
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const done of pending) done();
  }

  /** Resolves when it is safe to send more data. */
  drain(): Promise<void> {
    if (this.disposed || this.channel.bufferedAmount <= this.high) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      if (this.timer === null) this.timer = setInterval(() => this.check(), 50);
    });
  }

  get bufferedAmount(): number {
    return this.channel.bufferedAmount;
  }

  dispose(): void {
    this.disposed = true;
    this.channel.removeEventListener("bufferedamountlow", this.onLow);
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const pending = this.waiters;
    this.waiters = [];
    for (const done of pending) done();
  }
}
