import { describe, expect, it } from "vitest";
import { RequestGate } from "./request-gate";

describe("RequestGate", () => {
  it("allows only the latest overlapping request to commit", () => {
    const gate = new RequestGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
    gate.invalidate();
    expect(gate.isCurrent(second)).toBe(false);
  });
});
