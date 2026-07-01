import { test, expect } from "bun:test";
import {
  initialTranscript,
  reduceTranscript,
  groupTurns,
  collapsedHint,
  firstLine,
  truncate,
  type TranscriptState,
  type TranscriptAction,
  type Block,
} from "./reducer.ts";

/** Fold a sequence of actions over the initial state. */
function run(actions: TranscriptAction[], from: TranscriptState = initialTranscript()): TranscriptState {
  return actions.reduce(reduceTranscript, from);
}

const tool = (b: Block) => b as Extract<Block, { kind: "tool" }>;

test("streaming deltas coalesce into one assistant block; finalize flips streaming off", () => {
  let s = run([
    { type: "delta", text: "Hel" },
    { type: "delta", text: "lo" },
  ]);
  expect(s.blocks).toHaveLength(1);
  expect(s.blocks[0]).toMatchObject({ kind: "assistant", text: "Hello", streaming: true, gap: true });
  s = reduceTranscript(s, { type: "finalize" });
  expect(s.blocks[0]).toMatchObject({ streaming: false });
  expect(s.activeAssistant).toBe(-1);
  // A delta after finalize opens a NEW block, not appends to the old one.
  s = reduceTranscript(s, { type: "delta", text: "next" });
  expect(s.blocks).toHaveLength(2);
});

test("user message finalizes the reply, appends a user block, and clears call maps", () => {
  const s = run([
    { type: "delta", text: "answer" },
    { type: "tool-start", toolCallId: "c1", toolName: "read", input: { path: "x" } },
    { type: "user", text: "hello" },
  ]);
  // reply finalized, user block appended
  const last = s.blocks.at(-1)!;
  expect(last).toMatchObject({ kind: "user", text: "hello" });
  expect(s.blocks.find((b) => b.kind === "assistant")).toMatchObject({ streaming: false });
  // per-turn maps cleared
  expect(s.toolByCallId).toEqual({});
});

test("tool-start creates a block; tool-finish fills its output by call id", () => {
  let s = run([{ type: "tool-start", toolCallId: "c1", toolName: "read", input: { path: "a.ts" } }]);
  const t0 = tool(s.blocks[0]!);
  expect(t0.kind).toBe("tool");
  expect(t0.label).toContain("read");
  expect(t0.collapsed).toBe(true); // non-subagent tools start collapsed
  s = reduceTranscript(s, { type: "tool-finish", toolCallId: "c1", output: "line1\nline2", isError: false });
  expect(tool(s.blocks[0]!).output).toEqual(["line1", "line2"]);
  expect(s.toolByCallId).toEqual({}); // call id consumed
});

test("a subagent tool opens expanded and renders as markdown", () => {
  const s = run([{ type: "tool-start", toolCallId: "c1", toolName: "spawn_subagent", input: {} }]);
  const t = tool(s.blocks[0]!);
  expect(t.collapsed).toBe(false);
  expect(t.isMarkdown).toBe(true);
});

test("tool-finish output objects are JSON-stringified", () => {
  let s = run([{ type: "tool-start", toolCallId: "c1", toolName: "read", input: {} }]);
  s = reduceTranscript(s, { type: "tool-finish", toolCallId: "c1", output: { ok: true }, isError: false });
  expect(tool(s.blocks[0]!).output.join("\n")).toContain('"ok": true');
});

test("file-changed folds the diff into the producing tool block and suppresses its echo", () => {
  let s = run([
    { type: "tool-start", toolCallId: "c1", toolName: "edit", input: { path: "a.ts" } },
    { type: "file-changed", toolCallId: "c1", path: "a.ts", action: "edit", added: 3, removed: 1, diff: "+a\n-b" },
  ]);
  // Only one block (the tool block became the diff), not a separate diff row.
  expect(s.blocks).toHaveLength(1);
  const t = tool(s.blocks[0]!);
  expect(t.isDiff).toBe(true);
  expect(t.collapsed).toBe(false); // diffs are expanded by default
  expect(t.label).toContain("edited a.ts");
  expect(t.output).toEqual(["+a", "-b"]);
  // The suppressed finish echo is dropped (no output overwrite, no new block).
  s = reduceTranscript(s, { type: "tool-finish", toolCallId: "c1", output: "ok", isError: false });
  expect(s.blocks).toHaveLength(1);
  expect(tool(s.blocks[0]!).isDiff).toBe(true);
});

test("changedFiles accumulates line deltas per path across multiple edits", () => {
  const s = run([
    { type: "tool-start", toolCallId: "c1", toolName: "edit", input: { path: "a.ts" } },
    { type: "file-changed", toolCallId: "c1", path: "a.ts", action: "edit", added: 3, removed: 1 },
    { type: "tool-start", toolCallId: "c2", toolName: "edit", input: { path: "a.ts" } },
    { type: "file-changed", toolCallId: "c2", path: "a.ts", action: "edit", added: 2, removed: 4 },
    { type: "tool-start", toolCallId: "c3", toolName: "write", input: { path: "b.ts" } },
    { type: "file-changed", toolCallId: "c3", path: "b.ts", action: "write", added: 10, removed: 0 },
  ]);
  expect(s.changedFiles).toEqual([
    { path: "a.ts", added: 5, removed: 5 },
    { path: "b.ts", added: 10, removed: 0 },
  ]);
});

test("a second file-changed for one call appends a standalone diff row", () => {
  const s = run([
    { type: "tool-start", toolCallId: "c1", toolName: "apply_patch", input: {} },
    { type: "file-changed", toolCallId: "c1", path: "a.ts", action: "edit", added: 1, removed: 0, diff: "+a" },
    { type: "file-changed", toolCallId: "c1", path: "b.ts", action: "edit", added: 1, removed: 0, diff: "+b" },
  ]);
  // First folds into the tool block; second can't (already a diff) → new row.
  const diffs = s.blocks.filter((b) => b.kind === "tool" && b.isDiff);
  expect(diffs).toHaveLength(2);
});

test("toggle flips a tool block's collapsed state by id", () => {
  let s = run([{ type: "tool-start", toolCallId: "c1", toolName: "read", input: {} }]);
  const id = s.blocks[0]!.id;
  expect(tool(s.blocks[0]!).collapsed).toBe(true);
  s = reduceTranscript(s, { type: "toggle", id });
  expect(tool(s.blocks[0]!).collapsed).toBe(false);
});

test("notice and clear-turn finalize the reply", () => {
  let s = run([{ type: "delta", text: "hi" }, { type: "notice", text: "saved" }]);
  expect(s.blocks.at(-1)).toMatchObject({ kind: "notice", text: "saved" });
  expect(s.blocks[0]).toMatchObject({ streaming: false });
  s = run([{ type: "delta", text: "again" }, { type: "clear-turn" }], s);
  expect(s.blocks.find((b) => b.kind === "assistant" && b.streaming)).toBeUndefined();
  expect(s.toolByCallId).toEqual({});
});

test("block ids are unique and monotonic", () => {
  const s = run([
    { type: "user", text: "a" },
    { type: "delta", text: "b" },
    { type: "finalize" },
    { type: "tool-start", toolCallId: "c1", toolName: "read", input: {} },
    { type: "notice", text: "n" },
  ]);
  const ids = s.blocks.map((b) => b.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual([...ids].sort((x, y) => x - y));
});

test("groupTurns maps blocks to their turn and counts non-user blocks", () => {
  const s = run([
    { type: "user", text: "q1" },
    { type: "delta", text: "a1" },
    { type: "finalize" },
    { type: "tool-start", toolCallId: "c1", toolName: "read", input: {} },
    { type: "user", text: "q2" },
    { type: "delta", text: "a2" },
  ]);
  const { turnKey, counts } = groupTurns(s.blocks);
  const users = s.blocks.filter((b) => b.kind === "user");
  const u1 = users[0]!.id;
  expect(counts.get(u1)).toBe(2); // assistant + tool in turn 1
  // every non-user block maps to some user turn
  for (const b of s.blocks) if (b.kind !== "user") expect(turnKey.get(b.id)).toBeDefined();
});

test("collapsedHint reads diffs, search results, and line counts", () => {
  expect(collapsedHint({ kind: "tool", id: 0, label: "x", output: [], collapsed: true, isDiff: true, isError: false })).toBe("diff");
  const search: Extract<Block, { kind: "tool" }> = {
    kind: "tool", id: 1, label: "◈ search foo", output: ["1. a", "2. b", "notes"], collapsed: true, isDiff: false, isError: false,
  };
  expect(collapsedHint(search)).toBe("2 results");
  expect(
    collapsedHint({ kind: "tool", id: 2, label: "→ read x", output: ["only one"], collapsed: true, isDiff: false, isError: false }),
  ).toBe("1 line");
});

test("firstLine and truncate helpers", () => {
  expect(firstLine("\n\n  hello \nworld")).toBe("hello");
  expect(firstLine("   \n  ")).toBeUndefined();
  expect(truncate("abcdef", 4)).toBe("abc…");
  expect(truncate("ab", 4)).toBe("ab");
});
