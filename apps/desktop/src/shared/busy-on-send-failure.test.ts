import { describe, expect, it } from "vitest";
import { shouldClearBusyOnSendFailure } from "./busy-on-send-failure";

describe("shouldClearBusyOnSendFailure", () => {
  it("clears when an optimistic turn-start fails", () => {
    expect(
      shouldClearBusyOnSendFailure([{ type: "submit-prompt", text: "hi" }], false),
    ).toBe(true);
  });

  it("does not clear mid-turn when an incidental command fails", () => {
    expect(
      shouldClearBusyOnSendFailure([{ type: "run-slash", name: "details", args: "quiet" }], true),
    ).toBe(false);
    expect(
      shouldClearBusyOnSendFailure([{ type: "abort" }], true),
    ).toBe(false);
    expect(
      shouldClearBusyOnSendFailure(
        [{ type: "resolve-permission", id: "1", decision: "once" }],
        true,
      ),
    ).toBe(false);
  });

  it("clears when turn-start fails even if already busy (recovery)", () => {
    // Rare: double-submit while busy still optimistically expects busy.
    expect(
      shouldClearBusyOnSendFailure([{ type: "submit-prompt", text: "again" }], true),
    ).toBe(true);
  });

  it("does not clear when idle and command is not a turn-start", () => {
    expect(
      shouldClearBusyOnSendFailure([{ type: "run-slash", name: "theme", args: "default" }], false),
    ).toBe(false);
  });
});
