import { describe, expect, it } from "vitest";
import {
  bufferToolProgress,
  TOOL_PROGRESS_BUFFER_MAX_CALLS,
  TOOL_PROGRESS_TAIL_MAX_CHARS,
} from "./tool-progress-buffer";

describe("tool progress coalescing bounds", () => {
  it("caps a large chunk before it reaches renderer state", () => {
    const buffer = new Map<string, string>();
    bufferToolProgress(buffer, "call-1", "x".repeat(20_000));

    const retained = buffer.get("call-1") ?? "";
    expect(retained.length).toBe(TOOL_PROGRESS_TAIL_MAX_CHARS);
    expect(retained).toContain("earlier content omitted");
    expect(retained.endsWith("x".repeat(100))).toBe(true);
  });

  it("bounds call cardinality and retains the most recently updated calls", () => {
    const buffer = new Map<string, string>();
    for (let index = 0; index < TOOL_PROGRESS_BUFFER_MAX_CALLS; index += 1) {
      bufferToolProgress(buffer, `call-${index}`, `${index}`);
    }
    bufferToolProgress(buffer, "call-0", " updated");
    bufferToolProgress(buffer, "newest", "tail");

    expect(buffer).toHaveLength(TOOL_PROGRESS_BUFFER_MAX_CALLS);
    expect(buffer.has("call-0")).toBe(true);
    expect(buffer.has("call-1")).toBe(false);
    expect(buffer.get("newest")).toBe("tail");
  });

  it("does not retain progress when a configured ceiling is zero", () => {
    const buffer = new Map<string, string>();
    bufferToolProgress(buffer, "call-1", "chunk", { maxCalls: 0 });
    expect(buffer).toHaveLength(0);
  });
});
