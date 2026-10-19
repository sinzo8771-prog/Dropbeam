import { describe, expect, it, vi } from "vitest";
import { BackpressureController, HIGH_WATER, LOW_WATER } from "../../src/core/transfer/backpressure";
import type { ChannelLike } from "../../src/core/transfer/channel";

/**
 * The backpressure gate (PRD 8.4, PRD 13.1).
 *
 * The controller is the only thing standing between a fast sender and a
 * browser's memory: a data channel buffers what it is given, and a 2 GB file
 * would sit in that buffer if nothing waited for it to drain. The rule is the
 * PRD's - pause above 1 MiB, resume at 256 KiB - and the two ways it can
 * learn that the buffer has drained are both worth pinning: the channel's
 * `bufferedamountlow` event, and the poll that covers engines which never fire
 * it.
 *
 * The channel here is a stub whose `bufferedAmount` the test moves, which is
 * what "simulated bufferedAmount" in the PRD's test plan asks for.
 */

/** A data channel whose buffer the test controls. */
type FakeChannel = ChannelLike & { buffered: number; setBuffered(next: number, fire?: boolean): void };

function fakeChannel(initial = 0): FakeChannel {
  const listeners = new Map<string, Set<(ev: Event) => void>>();
  const channel = {
    label: "dropbeam",
    readyState: "open" as const,
    buffered: initial,
    bufferedAmountLowThreshold: 0,
    binaryType: "arraybuffer" as BinaryType,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: (type: string, listener: (ev: Event) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: (ev: Event) => void) => {
      listeners.get(type)?.delete(listener);
    },
    get bufferedAmount() {
      return channel.buffered;
    },
    /** Move the buffer and fire the event an engine would fire. */
    setBuffered(next: number, fire = true): void {
      channel.buffered = next;
      if (!fire) return;
      for (const listener of listeners.get("bufferedamountlow") ?? []) {
        listener(new Event("bufferedamountlow"));
      }
    },
  };
  return channel as unknown as FakeChannel;
}

describe("the backpressure controller (PRD 8.4, 13.1)", () => {
  it("sets the channel's low-water threshold, so the engine can signal a drain", () => {
    const channel = fakeChannel();
    new BackpressureController(channel);
    expect(channel.bufferedAmountLowThreshold).toBe(LOW_WATER);
  });

  it("resolves immediately while the buffer is under the high-water mark", async () => {
    const channel = fakeChannel(HIGH_WATER - 1);
    const controller = new BackpressureController(channel);

    await expect(controller.drain()).resolves.toBeUndefined();
    controller.dispose();
  });

  it("waits above the high-water mark, and resumes when the buffer drains", async () => {
    const channel = fakeChannel(HIGH_WATER + 1);
    const controller = new BackpressureController(channel);

    let resumed = false;
    const pending = controller.drain().then(() => {
      resumed = true;
    });

    // Still above the low-water mark: the send stays paused.
    channel.setBuffered(LOW_WATER + 1, true);
    await Promise.resolve();
    expect(resumed).toBe(false);

    // Below it: the event releases the waiters.
    channel.setBuffered(LOW_WATER, true);
    await pending;
    expect(resumed).toBe(true);
    controller.dispose();
  });

  it("polls as well, for an engine that never fires the event", async () => {
    vi.useFakeTimers();
    try {
      const channel = fakeChannel(HIGH_WATER + 1);
      const controller = new BackpressureController(channel);

      let resumed = false;
      const pending = controller.drain().then(() => {
        resumed = true;
      });

      channel.setBuffered(LOW_WATER, false);
      await vi.advanceTimersByTimeAsync(60);
      await pending;
      expect(resumed).toBe(true);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the waiters until the buffer is actually low", async () => {
    vi.useFakeTimers();
    try {
      const channel = fakeChannel(HIGH_WATER + 1);
      const controller = new BackpressureController(channel);

      let resumed = false;
      const pending = controller.drain().then(() => {
        resumed = true;
      });

      channel.setBuffered(LOW_WATER + 1, true);
      await vi.advanceTimersByTimeAsync(0);
      expect(resumed).toBe(false);

      channel.setBuffered(LOW_WATER, true);
      await pending;
      expect(resumed).toBe(true);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases everyone waiting when it is disposed", async () => {
    const channel = fakeChannel(HIGH_WATER + 1);
    const controller = new BackpressureController(channel);

    const first = controller.drain();
    const second = controller.drain();
    controller.dispose();

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    // And a later drain is a no-op rather than a wait that never ends.
    await expect(controller.drain()).resolves.toBeUndefined();
  });

  it("stops listening to the channel once disposed", () => {
    const channel = fakeChannel(HIGH_WATER + 1);
    const controller = new BackpressureController(channel);

    controller.dispose();
    // The event would release the waiters if it were still listening.
    channel.setBuffered(LOW_WATER, true);
    expect(() => controller.dispose()).not.toThrow();
  });

  it("reports the channel's own buffered amount", () => {
    const channel = fakeChannel(1234);
    const controller = new BackpressureController(channel);
    expect(controller.bufferedAmount).toBe(1234);
    controller.dispose();
  });
});
