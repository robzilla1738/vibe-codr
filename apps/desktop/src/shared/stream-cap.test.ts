import { describe, expect, it } from "vitest";
import { appendCapture, appendRollingText, captureOverflowError, createCaptureBuffers } from "./stream-cap";

describe("stream capture cap", () => {
  it("appends under the cap without truncating", () => {
    const buf = createCaptureBuffers(100);
    appendCapture(buf, "stdout", "hello");
    appendCapture(buf, "stderr", "warn");
    expect(buf.stdout).toBe("hello");
    expect(buf.stderr).toBe("warn");
    expect(buf.capturedBytes).toBe(9);
    expect(buf.truncated).toBe(false);
  });

  it("marks truncated and stops growing past maxBytes", () => {
    const buf = createCaptureBuffers(10);
    appendCapture(buf, "stdout", "1234567890EXTRA");
    expect(buf.truncated).toBe(true);
    expect(buf.stdout.length).toBe(10);
    appendCapture(buf, "stdout", "more");
    expect(buf.stdout.length).toBe(10);
  });

  it("enforces one aggregate UTF-8 byte ceiling across both streams", () => {
    const buf = createCaptureBuffers(7);
    appendCapture(buf, "stdout", "abc");
    appendCapture(buf, "stderr", "😀more");
    expect(buf.stdout).toBe("abc");
    expect(buf.stderr).toBe("😀");
    expect(buf.capturedBytes).toBe(7);
    expect(buf.truncated).toBe(true);
  });

  it("overflow error prefers stderr then a clear message", () => {
    const empty = createCaptureBuffers(8);
    empty.truncated = true;
    expect(captureOverflowError(empty, "gh output")).toMatch(/exceeded 8 bytes/);
    const withErr = createCaptureBuffers(8);
    withErr.stderr = "boom";
    withErr.truncated = true;
    expect(captureOverflowError(withErr)).toBe("boom");
  });

  it("keeps a single marked tail for long-lived rolling text", () => {
    const first = appendRollingText("", "1".repeat(80), 40);
    const second = appendRollingText(first, "abcdefghij", 40);
    expect(second).toHaveLength(40);
    expect(second.match(/omitted/g)).toHaveLength(1);
    expect(second.endsWith("abcdefghij")).toBe(true);
  });
});
