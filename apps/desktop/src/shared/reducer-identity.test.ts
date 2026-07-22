import { describe, expect, it } from "vitest";
import { initialTranscript, reduceTranscript } from "./reducer";

describe("transcript protocol identity", () => {
  it("keeps identity on the first assistant delta so finalization can find the part", () => {
    const state = reduceTranscript(initialTranscript(), {
      type: "delta",
      text: "Hello",
      phase: "commentary",
      turnId: "turn-1",
      messageId: "message-1",
      partId: "part-1",
      revision: 1,
      timestamp: 10,
    });
    expect(state.blocks[0]).toMatchObject({
      kind: "assistant",
      wireId: "part-1",
      turnId: "turn-1",
      messageId: "message-1",
      revision: 1,
    });
  });
});
