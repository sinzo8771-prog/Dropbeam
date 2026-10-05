import { describe, expect, it, vi } from "vitest";
import { ConnectionApproval, approvalError } from "../../src/core/peer/approval";

describe("connection approval (PRD 9.5)", () => {
  it("blocks transfers until the host allows the peer", () => {
    const gate = new ConnectionApproval("Phone");
    expect(() => gate.requireAllowed()).toThrow();
    gate.approve();
    expect(() => gate.requireAllowed()).not.toThrow();
    expect(gate.isAllowed).toBe(true);
  });

  it("prompts once with the peer label and reports state changes", () => {
    const onPrompt = vi.fn();
    const onStateChange = vi.fn();
    const gate = new ConnectionApproval("Qweq's phone", { onPrompt, onStateChange });
    gate.request();
    expect(onPrompt).toHaveBeenCalledWith("Qweq's phone");
    // A peer-supplied label is rendered as text only; nothing is interpreted.
    expect(gate.peer).toBe("Qweq's phone");

    gate.request();
    expect(onPrompt).toHaveBeenCalledTimes(1);
    gate.approve();
    expect(onStateChange).toHaveBeenCalledWith("allowed", "Qweq's phone");
  });

  it("refuses transfers permanently after a denial", () => {
    const gate = new ConnectionApproval("Phone");
    gate.deny();
    expect(gate.current).toBe("denied");
    expect(() => gate.requireAllowed()).toThrow();
    // A later approve() must not silently re-open a denied session.
    gate.approve();
    expect(gate.current).toBe("denied");
    expect(gate.isAllowed).toBe(false);
  });

  it("ignores a second decision", () => {
    const onStateChange = vi.fn();
    const gate = new ConnectionApproval("Phone", { onStateChange });
    gate.approve();
    gate.deny();
    expect(gate.current).toBe("allowed");
    expect(onStateChange).toHaveBeenCalledTimes(1);
  });

  it("maps states to the PRD 12 reason codes", () => {
    expect(approvalError("denied")).toBe("PEER_DECLINED");
    expect(approvalError("pending")).toBe("PEER_LOST");
  });
});
