import { describe, expect, it } from "vitest";
import type { Block } from "../../shared/reducer";
import { groupTranscriptItems } from "./transcript-groups";

const assistant = (id: number, text: string): Block => ({
  kind: "assistant",
  id,
  text,
  streaming: false,
  gap: false,
  timestamp: id,
});

const thinking = (id: number): Block => ({
  kind: "thinking",
  id,
  text: `thought ${id}`,
  collapsed: true,
});

const tool = (id: number): Block => ({
  kind: "tool",
  id,
  toolName: "read",
  label: `read ${id}`,
  output: [],
  collapsed: true,
  isDiff: false,
  isError: false,
  done: true,
});

describe("groupTranscriptItems", () => {
  it("consolidates interleaved progress notes and activity into one work phase", () => {
    const result = groupTranscriptItems([
      thinking(1),
      tool(2),
      assistant(3, "Checking the remaining files."),
      thinking(4),
      tool(5),
      assistant(6, "Everything is ready."),
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ kind: "activity" });
    expect(result[0]?.kind === "activity" ? result[0].blocks.map((block) => block.id) : []).toEqual([1, 2, 3, 4, 5]);
    expect(result[1]).toMatchObject({ kind: "block", block: { id: 6 } });
  });

  it("leaves a turn without model activity unchanged", () => {
    const result = groupTranscriptItems([assistant(1, "Answer")]);
    expect(result).toEqual([{ kind: "block", block: assistant(1, "Answer") }]);
  });

  it("preserves work membership when the visible window starts on progress narration", () => {
    const items = [thinking(1), tool(2), assistant(3, "Still checking."), thinking(4), tool(5), assistant(6, "Done.")];
    const result = groupTranscriptItems(items, 2);
    expect(result).toHaveLength(2);
    expect(result[0]?.kind === "activity" ? result[0].blocks.map((block) => block.id) : []).toEqual([3, 4, 5]);
    expect(result[1]).toMatchObject({ kind: "block", block: { id: 6 } });
  });

  it("folds progress narration emitted before the first model action into Work", () => {
    const result = groupTranscriptItems([
      assistant(1, "I’ll inspect the project first."),
      thinking(2),
      tool(3),
      assistant(4, "Here is the result."),
    ]);
    expect(result[0]?.kind === "activity" ? result[0].blocks.map((block) => block.id) : []).toEqual([1, 2, 3]);
    expect(result[1]).toMatchObject({ kind: "block", block: { id: 4 } });
  });

  it("keeps notices standalone while grouping surrounding work", () => {
    const notice: Block = { kind: "notice", id: 3, text: "Memory recalled", level: "info" };
    const result = groupTranscriptItems([
      assistant(1, "Starting."),
      thinking(2),
      notice,
      assistant(4, "Continuing."),
      tool(5),
      assistant(6, "Finished."),
    ]);
    expect(result.map((item) => item.kind)).toEqual(["activity", "block"]);
    expect(result[0]?.kind === "activity" ? result[0].blocks.map((block) => block.id) : []).toEqual([1, 2, 3, 4, 5]);
  });
});
