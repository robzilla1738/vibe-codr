import { test, expect } from "bun:test";
import { compactElapsed, SPINNER_FRAMES, spinnerFrame, workingLabel } from "./spinner.ts";

test("spinnerFrame cycles through every frame in order", () => {
  const frames: readonly string[] = SPINNER_FRAMES;
  for (let i = 0; i < frames.length; i++) {
    expect(spinnerFrame(i)).toBe(frames[i] as string);
  }
});

test("spinnerFrame wraps past the end and below zero", () => {
  const frames: readonly string[] = SPINNER_FRAMES;
  expect(spinnerFrame(frames.length)).toBe(frames[0] as string);
  expect(spinnerFrame(frames.length + 3)).toBe(frames[3] as string);
  expect(spinnerFrame(-1)).toBe(frames[frames.length - 1] as string);
});

test("workingLabel shows seconds once elapsed is meaningful", () => {
  expect(workingLabel(0)).toBe("Working…");
  expect(workingLabel(50)).toBe("Working…");
  expect(workingLabel(3200)).toBe("Working… 3.2s");
});

test("compactElapsed hides sub-second noise", () => {
  expect(compactElapsed(0)).toBe("");
  expect(compactElapsed(999)).toBe("");
  expect(compactElapsed(1500)).toBe("1.5s");
  expect(compactElapsed(12_000)).toBe("12s");
});
