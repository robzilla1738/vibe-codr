import { describe, expect, it } from "vitest";
import { Trail, turnWindowStart, windowStartIndex } from "./trail";

describe("Trail", () => {
  it("reset clears closed lines and the open stream for a new turn", () => {
    const trail = new Trail();
    trail.append("old thought\n");
    trail.append("still open");
    expect(trail.snapshot().join("\n")).toContain("old thought");
    trail.reset();
    expect(trail.snapshot()).toEqual([]);
    trail.append("new turn");
    expect(trail.snapshot()).toEqual(["new turn"]);
  });

  it("caps an unbounded open line without newlines", () => {
    const trail = new Trail();
    trail.append("x".repeat(Trail.MAX_OPEN_CHARS + 4_000));
    const snap = trail.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.length).toBe(Trail.MAX_OPEN_CHARS);
  });

  it("window helpers stay stable for progressive reveal", () => {
    expect(windowStartIndex(100, 40, 0)).toBe(60);
    expect(turnWindowStart(200, 120, 24, 0)).toBe(96);
  });
});
