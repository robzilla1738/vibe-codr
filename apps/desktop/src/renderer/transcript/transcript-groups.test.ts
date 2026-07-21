import { describe, expect, it } from "vitest";
import type { Block } from "../../shared/reducer";
import { groupTranscriptItems } from "./transcript-groups";

const assistant = (id: number, text: string, phase?: "commentary" | "final"): Block => ({
  kind: "assistant", id, text, streaming: false, gap: false, timestamp: id, phase,
});
const thinking = (id: number): Block => ({ kind: "thinking", id, text: `thought ${id}`, collapsed: true });
const tool = (id: number): Block => ({
  kind: "tool", id, toolName: "read", label: `read ${id}`, output: [], collapsed: true,
  isDiff: false, isError: false, done: true,
});

describe("groupTranscriptItems", () => {
  it("keeps commentary, reasoning, tools, and final text first-class while live", () => {
    const result = groupTranscriptItems([
      thinking(1), tool(2), assistant(3, "Checking the remaining files."),
      thinking(4), tool(5), assistant(6, "Everything is ready."),
    ]);
    expect(result.map((item) => item.kind === "block" ? item.block.id : -1)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("compacts completed process while leaving the final answer visible", () => {
    const result = groupTranscriptItems([
      assistant(1, "Checking the remaining files.", "commentary"),
      tool(2),
      thinking(3),
      assistant(4, "Everything is ready.", "final"),
    ], 0, true);

    expect(result[0]).toMatchObject({ kind: "process", summary: { tools: 1 } });
    expect(result[0]?.kind === "process" ? result[0].blocks.map((block) => block.id) : []).toEqual([1, 2, 3]);
    expect(result[1]).toEqual({ kind: "block", block: assistant(4, "Everything is ready.", "final") });
  });

  it("leaves a turn without model activity unchanged", () => {
    const result = groupTranscriptItems([assistant(1, "Answer")]);
    expect(result).toEqual([{ kind: "block", block: assistant(1, "Answer") }]);
  });

  it("preserves event order when the visible window starts on commentary", () => {
    const items = [thinking(1), tool(2), assistant(3, "Still checking."), thinking(4), tool(5), assistant(6, "Done.")];
    expect(groupTranscriptItems(items, 2).map((item) => item.kind === "block" ? item.block.id : -1)).toEqual([3, 4, 5, 6]);
  });

  it("does not hide narration emitted before the first model action", () => {
    const result = groupTranscriptItems([assistant(1, "I’ll inspect the project first."), thinking(2), tool(3), assistant(4, "Here is the result.")]);
    expect(result.map((item) => item.kind === "block" ? item.block.id : -1)).toEqual([1, 2, 3, 4]);
  });

  it("keeps notices and surrounding work standalone", () => {
    const notice: Block = { kind: "notice", id: 3, text: "Memory recalled", level: "info" };
    const result = groupTranscriptItems([assistant(1, "Starting."), thinking(2), notice, assistant(4, "Continuing."), tool(5), assistant(6, "Finished.")]);
    expect(result.map((item) => item.kind)).toEqual(["block", "block", "block", "block", "block", "block"]);
  });
});
