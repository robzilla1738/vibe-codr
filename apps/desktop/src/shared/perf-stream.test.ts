import { describe, expect, it } from "vitest";
import {
  ASSISTANT_OUTPUT_MAX_CHARS,
  initialTranscript,
  reduceTranscript,
} from "./reducer";

describe("long-session memory bounds", () => {
  it("caps retained tool output lines in the reducer", () => {
    let state = initialTranscript();
    state = reduceTranscript(state, {
      type: "tool-start",
      toolCallId: "t1",
      toolName: "bash",
      input: { command: "yes" },
    });
    const huge = Array.from({ length: 8_000 }, (_, i) => `line ${i}`).join("\n");
    state = reduceTranscript(state, {
      type: "tool-finish",
      toolCallId: "t1",
      output: huge,
      isError: false,
    });
    const tool = state.blocks.find((b) => b.kind === "tool");
    expect(tool?.kind).toBe("tool");
    if (tool?.kind !== "tool") throw new Error("expected tool block");
    expect(tool.output.length).toBeLessThanOrEqual(4_001);
    expect(tool.output[0]).toMatch(/omitted/);
  });

  it("caps a single assistant stream while retaining its newest tail", () => {
    let state = initialTranscript();
    state = reduceTranscript(state, {
      type: "delta",
      text: `old${"x".repeat(ASSISTANT_OUTPUT_MAX_CHARS)}new`,
    });
    const assistant = state.blocks[0];
    expect(assistant?.kind).toBe("assistant");
    if (assistant?.kind !== "assistant") throw new Error("expected assistant block");
    expect(assistant.text).toHaveLength(ASSISTANT_OUTPUT_MAX_CHARS);
    expect(assistant.text).toContain("earlier content omitted");
    expect(assistant.text.endsWith("new")).toBe(true);
    expect(assistant.text.startsWith("old")).toBe(false);
  });
});
