import { test, expect } from "bun:test";
import {
  initialTranscript,
  reduceTranscript,
  groupTurns,
  groupIntoTurns,
  collapsedHint,
  dropSettledPerms,
  firstLine,
  toolDurationLabel,
  truncate,
  type TranscriptState,
  type TranscriptAction,
  type Block,
  type PendingPerm,
} from "./reducer.ts";

/** Fold a sequence of actions over the initial state. */
function run(
  actions: TranscriptAction[],
  from: TranscriptState = initialTranscript(),
): TranscriptState {
  return actions.reduce(reduceTranscript, from);
}

const tool = (b: Block) => b as Extract<Block, { kind: "tool" }>;

test("streaming deltas coalesce into one assistant block; finalize flips streaming off", () => {
  let s = run([
    { type: "delta", text: "Hel" },
    { type: "delta", text: "lo" },
  ]);
  expect(s.blocks).toHaveLength(1);
  expect(s.blocks[0]).toMatchObject({
    kind: "assistant",
    text: "Hello",
    streaming: true,
    gap: true,
  });
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
  let s = run([
    { type: "tool-start", toolCallId: "c1", toolName: "read", input: { path: "a.ts" } },
  ]);
  const t0 = tool(s.blocks[0]!);
  expect(t0.kind).toBe("tool");
  expect(t0.label).toContain("read");
  expect(t0.collapsed).toBe(true); // non-subagent tools start collapsed
  s = reduceTranscript(s, {
    type: "tool-finish",
    toolCallId: "c1",
    output: "line1\nline2",
    isError: false,
  });
  expect(tool(s.blocks[0]!).output).toEqual(["line1", "line2"]);
  expect(s.toolByCallId).toEqual({}); // call id consumed
});

test("a subagent tool is markdown but starts collapsed (panel owns fan-out)", () => {
  const s = run([{ type: "tool-start", toolCallId: "c1", toolName: "spawn_subagent", input: {} }]);
  const t = tool(s.blocks[0]!);
  expect(t.collapsed).toBe(true);
  expect(t.isMarkdown).toBe(true);
  expect(t.toolName).toBe("spawn_subagent");
});

test("a spawn_tasks fan-out is markdown and starts collapsed", () => {
  const s = run([
    { type: "tool-start", toolCallId: "c1", toolName: "spawn_tasks", input: { tasks: [] } },
  ]);
  const t = tool(s.blocks[0]!);
  expect(t.collapsed).toBe(true);
  expect(t.isMarkdown).toBe(true);
});

test("long successful bash stays collapsed with line-count meta", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  let s = run([
    { type: "tool-start", toolCallId: "c1", toolName: "bash", input: { command: "bun test" } },
  ]);
  s = reduceTranscript(s, { type: "tool-finish", toolCallId: "c1", output: lines, isError: false });
  const t = tool(s.blocks[0]!);
  expect(t.collapsed).toBe(true);
  expect(t.output).toHaveLength(20);
  expect(collapsedHint(t)).toBe("20 lines");
});

test("failed tools expand and collapsedHint carries fail meta", () => {
  let s = run([
    { type: "tool-start", toolCallId: "c1", toolName: "bash", input: { command: "false" } },
  ]);
  s = reduceTranscript(s, {
    type: "tool-finish",
    toolCallId: "c1",
    output: "Command failed with exit code 1\nmore",
    isError: true,
  });
  const t = tool(s.blocks[0]!);
  expect(t.collapsed).toBe(false);
  expect(collapsedHint({ ...t, collapsed: true })).toBe("fail · exit 1");
});

test("tool-finish output objects are JSON-stringified", () => {
  let s = run([{ type: "tool-start", toolCallId: "c1", toolName: "read", input: {} }]);
  s = reduceTranscript(s, {
    type: "tool-finish",
    toolCallId: "c1",
    output: { ok: true },
    isError: false,
  });
  expect(tool(s.blocks[0]!).output.join("\n")).toContain('"ok": true');
});

test("file-changed folds the diff into the producing tool block and suppresses its echo", () => {
  let s = run([
    { type: "tool-start", toolCallId: "c1", toolName: "edit", input: { path: "a.ts" }, at: 1000 },
    { type: "tool-progress", toolCallId: "c1", chunk: "rewriting file..." },
    {
      type: "file-changed",
      toolCallId: "c1",
      path: "a.ts",
      action: "edit",
      added: 3,
      removed: 1,
      diff: "+a\n-b",
      at: 4500,
    },
  ]);
  // Only one block (the tool block became the diff), not a separate diff row.
  expect(s.blocks).toHaveLength(1);
  const t = tool(s.blocks[0]!);
  expect(t.isDiff).toBe(true);
  expect(t.collapsed).toBe(false); // diffs are expanded by default
  expect(t.label).toContain("edited a.ts");
  expect(t.output).toEqual(["+a", "-b"]);
  expect(t.startedAt).toBe(1000);
  expect(t.elapsedMs).toBe(3500);
  expect(t.tail).toContain("rewriting file");
  // The suppressed finish echo is dropped (no output overwrite, no new block).
  s = reduceTranscript(s, { type: "tool-finish", toolCallId: "c1", output: "ok", isError: false });
  expect(s.blocks).toHaveLength(1);
  expect(tool(s.blocks[0]!).isDiff).toBe(true);
});

test("a NO-OP file-changed (±0, empty diff) leaves the tool block + its output alone", () => {
  // A write that produced the identical file used to convert the block into an
  // expanded EMPTY diff and suppress the tool's real result — the row showed
  // nothing where "no changes" should have been.
  let s = run([
    { type: "tool-start", toolCallId: "c1", toolName: "write", input: { path: "a.ts" } },
    { type: "file-changed", toolCallId: "c1", path: "a.ts", action: "write", added: 0, removed: 0 },
  ]);
  const t = tool(s.blocks[0]!);
  expect(t.isDiff).toBe(false);
  expect(t.label).toContain("write a.ts"); // original label, not "wrote a.ts +0 -0"
  // The finish echo is NOT suppressed — the tool's own text lands normally.
  s = reduceTranscript(s, {
    type: "tool-finish",
    toolCallId: "c1",
    output: "no changes",
    isError: false,
  });
  expect(tool(s.blocks[0]!).output).toEqual(["no changes"]);
  // …and the footer doesn't count an untouched file as changed.
  expect(s.changedFiles).toEqual([]);
});

test("tool-progress streams a live tail on the RUNNING row, dropped once it finishes", () => {
  let s = run([
    { type: "tool-start", toolCallId: "c1", toolName: "bash", input: { command: "bun test" } },
    { type: "tool-progress", toolCallId: "c1", chunk: "src/a.test.ts:\n" },
    { type: "tool-progress", toolCallId: "c1", chunk: "(pass) first case\n" },
  ]);
  let t = tool(s.blocks[0]!);
  expect(t.done).toBe(false);
  expect(t.tail).toContain("(pass) first case");
  // The result lands: done, tail gone, output is the real capture.
  s = reduceTranscript(s, {
    type: "tool-finish",
    toolCallId: "c1",
    output: "exit 0\nall pass",
    isError: false,
  });
  t = tool(s.blocks[0]!);
  expect(t.done).toBe(true);
  expect(t.tail).toBeUndefined();
  // A stray late chunk can't resurrect a dead preview.
  s = reduceTranscript(s, { type: "tool-progress", toolCallId: "c1", chunk: "late" });
  expect(tool(s.blocks[0]!).tail).toBeUndefined();
});

test("the live tail is bounded — a chatty build can't grow the block", () => {
  let s = run([{ type: "tool-start", toolCallId: "c1", toolName: "bash", input: {} }]);
  for (let i = 0; i < 50; i++) {
    s = reduceTranscript(s, {
      type: "tool-progress",
      toolCallId: "c1",
      chunk: `line ${i} ${"x".repeat(80)}\n`,
    });
  }
  expect(tool(s.blocks[0]!).tail!.length).toBeLessThanOrEqual(600);
  expect(tool(s.blocks[0]!).tail).toContain("line 49"); // keeps the NEWEST output
});

test("a FAILED call opens expanded — the error text is what the user needs next", () => {
  let s = run([{ type: "tool-start", toolCallId: "c1", toolName: "bash", input: {} }]);
  s = reduceTranscript(s, {
    type: "tool-finish",
    toolCallId: "c1",
    output: "exit 1\nboom",
    isError: true,
  });
  const t = tool(s.blocks[0]!);
  expect(t.isError).toBe(true);
  expect(t.collapsed).toBe(false);
  // A successful call stays condensed until clicked.
  let ok = run([{ type: "tool-start", toolCallId: "c2", toolName: "read", input: {} }]);
  ok = reduceTranscript(ok, {
    type: "tool-finish",
    toolCallId: "c2",
    output: "text",
    isError: false,
  });
  expect(tool(ok.blocks[0]!).collapsed).toBe(true);
});

test("tool duration is derived from the action stamps (shown as meta when slow)", () => {
  let s = run([{ type: "tool-start", toolCallId: "c1", toolName: "bash", input: {}, at: 1000 }]);
  s = reduceTranscript(s, {
    type: "tool-finish",
    toolCallId: "c1",
    output: "ok",
    isError: false,
    at: 4500,
  });
  expect(tool(s.blocks[0]!).elapsedMs).toBe(3500);
});

test("tool-start records startedAt and leaves the row RUNNING so it can tick a live elapsed", () => {
  // The running-row live elapsed reads `startedAt` (a tool with no streamed tail
  // must still look alive), so the reducer has to stamp it and keep the row open.
  const s = run([
    {
      type: "tool-start",
      toolCallId: "c1",
      toolName: "web_search",
      input: { query: "x" },
      at: 5000,
    },
  ]);
  const t = tool(s.blocks[0]!);
  expect(t.startedAt).toBe(5000);
  expect(t.done).toBe(false);
  expect(t.elapsedMs).toBeUndefined();
});

test("toolDurationLabel: no dead spinner — a running row past 2s shows a live ticking elapsed", () => {
  const running = run([
    { type: "tool-start", toolCallId: "c1", toolName: "crawl_docs", input: {}, at: 1000 },
  ]);
  const t = tool(running.blocks[0]!);
  // Under 2s: nothing (quick calls stay clean). At/over 2s: whole-second live count.
  expect(toolDurationLabel(t, 1000)).toBe("");
  expect(toolDurationLabel(t, 2900)).toBe("");
  expect(toolDurationLabel(t, 3000)).toBe("2s");
  expect(toolDurationLabel(t, 8400)).toBe("7s");
  // Finished: the final wall-clock, one decimal, only when it was slow (≥2s).
  const done = reduceTranscript(running, {
    type: "tool-finish",
    toolCallId: "c1",
    output: "ok",
    isError: false,
    at: 4500,
  });
  expect(toolDurationLabel(tool(done.blocks[0]!), 9_999_999)).toBe("3.5s");
  // A fast finished call shows nothing regardless of `now`.
  let quick = run([{ type: "tool-start", toolCallId: "c2", toolName: "read", input: {}, at: 0 }]);
  quick = reduceTranscript(quick, {
    type: "tool-finish",
    toolCallId: "c2",
    output: "ok",
    isError: false,
    at: 300,
  });
  expect(toolDurationLabel(tool(quick.blocks[0]!), 9_999_999)).toBe("");
  // A settled row with no stamp (interrupted turn) shows nothing, never NaN.
  const settled = reduceTranscript(
    run([{ type: "tool-start", toolCallId: "c3", toolName: "read", input: {} }]),
    {
      type: "clear-turn",
    },
  );
  expect(toolDurationLabel(tool(settled.blocks[0]!), 9_999_999)).toBe("");
});

test("a thinking burst lands as a collapsed row; toggle expands it; empty is dropped", () => {
  let s = run([
    { type: "thinking", text: "the loader owns the cache\nso patch there", seconds: 8 },
  ]);
  const t = s.blocks[0]!;
  expect(t.kind).toBe("thinking");
  expect(t.kind === "thinking" && t.collapsed).toBe(true);
  expect(t.kind === "thinking" && t.seconds).toBe(8);
  s = reduceTranscript(s, { type: "toggle", id: t.id });
  expect(
    s.blocks[0]!.kind === "thinking" && (s.blocks[0] as { collapsed: boolean }).collapsed,
  ).toBe(false);
  // Whitespace-only reasoning never lands a row.
  expect(run([{ type: "thinking", text: "   \n  " }]).blocks).toHaveLength(0);
});

test("toggle-thinking-all expands every thinking row, then folds them all back", () => {
  const collapsed = (b: unknown) => (b as { collapsed: boolean }).collapsed;
  let s = run([
    { type: "thinking", text: "first burst", seconds: 2 },
    { type: "tool-start", toolCallId: "c1", toolName: "read", input: {} },
    { type: "thinking", text: "second burst", seconds: 3 },
  ]);
  // Mixed state (one row manually opened) still means "expand the rest".
  s = reduceTranscript(s, { type: "toggle", id: s.blocks[0]!.id });
  s = reduceTranscript(s, { type: "toggle-thinking-all" });
  expect(s.blocks.filter((b) => b.kind === "thinking").every((b) => !collapsed(b))).toBe(true);
  // All open → collapse all.
  s = reduceTranscript(s, { type: "toggle-thinking-all" });
  expect(s.blocks.filter((b) => b.kind === "thinking").every((b) => collapsed(b))).toBe(true);
  // Tool rows are untouched, and a transcript with no thinking is a no-op.
  expect(s.blocks[1]!.kind).toBe("tool");
  const none = run([{ type: "user", text: "hi" }]);
  expect(reduceTranscript(none, { type: "toggle-thinking-all" })).toBe(none);
});

test("clear-turn settles still-running rows so an aborted call doesn't spin forever", () => {
  let s = run([
    { type: "tool-start", toolCallId: "c1", toolName: "bash", input: {} },
    { type: "tool-progress", toolCallId: "c1", chunk: "partial output" },
  ]);
  s = reduceTranscript(s, { type: "clear-turn" });
  const t = tool(s.blocks[0]!);
  expect(t.done).toBe(true);
  expect(t.tail).toBeUndefined();
});

test("changedFiles accumulates line deltas per path across multiple edits", () => {
  const s = run([
    { type: "tool-start", toolCallId: "c1", toolName: "edit", input: { path: "a.ts" } },
    { type: "file-changed", toolCallId: "c1", path: "a.ts", action: "edit", added: 3, removed: 1 },
    { type: "tool-start", toolCallId: "c2", toolName: "edit", input: { path: "a.ts" } },
    { type: "file-changed", toolCallId: "c2", path: "a.ts", action: "edit", added: 2, removed: 4 },
    { type: "tool-start", toolCallId: "c3", toolName: "write", input: { path: "b.ts" } },
    {
      type: "file-changed",
      toolCallId: "c3",
      path: "b.ts",
      action: "write",
      added: 10,
      removed: 0,
    },
  ]);
  expect(s.changedFiles).toEqual([
    { path: "a.ts", added: 5, removed: 5 },
    { path: "b.ts", added: 10, removed: 0 },
  ]);
});

test("a second file-changed for one call appends a standalone diff row", () => {
  const s = run([
    { type: "tool-start", toolCallId: "c1", toolName: "apply_patch", input: {} },
    {
      type: "file-changed",
      toolCallId: "c1",
      path: "a.ts",
      action: "edit",
      added: 1,
      removed: 0,
      diff: "+a",
    },
    {
      type: "file-changed",
      toolCallId: "c1",
      path: "b.ts",
      action: "edit",
      added: 1,
      removed: 0,
      diff: "+b",
    },
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
  let s = run([
    { type: "delta", text: "hi" },
    { type: "notice", text: "saved" },
  ]);
  expect(s.blocks.at(-1)).toMatchObject({ kind: "notice", text: "saved" });
  expect(s.blocks[0]).toMatchObject({ streaming: false });
  s = run([{ type: "delta", text: "again" }, { type: "clear-turn" }], s);
  expect(s.blocks.find((b) => b.kind === "assistant" && b.streaming)).toBeUndefined();
  expect(s.toolByCallId).toEqual({});
});

test("notice level: defaults to info, carries error/warn through so the UI can color them", () => {
  const s = run([
    { type: "notice", text: "compacted" }, // no level → info
    { type: "notice", text: "boom", level: "error" },
    { type: "notice", text: "heads up", level: "warn" },
  ]);
  const notices = s.blocks.filter(
    (b): b is Extract<Block, { kind: "notice" }> => b.kind === "notice",
  );
  expect(notices.map((n) => n.level)).toEqual(["info", "error", "warn"]);
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

test("groupIntoTurns groups each user message with its following blocks", () => {
  const s = run([
    { type: "user", text: "q1" },
    { type: "delta", text: "a1" },
    { type: "finalize" },
    { type: "tool-start", toolCallId: "c1", toolName: "read", input: {} },
    { type: "user", text: "q2" },
    { type: "delta", text: "a2" },
  ]);
  const turns = groupIntoTurns(s.blocks);
  expect(turns.length).toBe(2);
  expect(turns[0]!.user?.text).toBe("q1");
  expect(turns[0]!.items.map((b) => b.kind)).toEqual(["assistant", "tool"]);
  expect(turns[0]!.key).toBe(turns[0]!.user!.id); // keyed by the user id
  expect(turns[1]!.user?.text).toBe("q2");
  expect(turns[1]!.items.map((b) => b.kind)).toEqual(["assistant"]);
});

test("groupIntoTurns puts a leading (pre-user) block in a node-less preamble turn", () => {
  const s = run([
    { type: "notice", text: "session restored", level: "info" },
    { type: "user", text: "q1" },
    { type: "delta", text: "a1" },
  ]);
  const turns = groupIntoTurns(s.blocks);
  expect(turns.length).toBe(2);
  expect(turns[0]!.user).toBeUndefined(); // preamble → no node
  expect(turns[0]!.items.map((b) => b.kind)).toEqual(["notice"]);
  expect(turns[0]!.key).toBeLessThan(0); // synthetic stable key
  expect(turns[1]!.user?.text).toBe("q1");
});

test("collapsedHint reads errors, diffs, search results, and line counts", () => {
  expect(
    collapsedHint({
      kind: "tool",
      id: 0,
      label: "$ bun test",
      output: ["fail"],
      collapsed: true,
      isDiff: false,
      isError: true,
      done: true,
    }),
  ).toBe("fail · fail");
  expect(
    collapsedHint({
      kind: "tool",
      id: 0,
      label: "$ x",
      output: [],
      collapsed: true,
      isDiff: false,
      isError: true,
      done: true,
    }),
  ).toBe("error");
  expect(
    collapsedHint({
      kind: "tool",
      id: 0,
      label: "x",
      output: [],
      collapsed: true,
      isDiff: true,
      isError: false,
      done: true,
    }),
  ).toBe("diff");
  const search: Extract<Block, { kind: "tool" }> = {
    kind: "tool",
    id: 1,
    label: "◈ search foo",
    output: ["1. a", "2. b", "notes"],
    collapsed: true,
    isDiff: false,
    isError: false,
    done: true,
  };
  expect(collapsedHint(search)).toBe("2 results");
  expect(
    collapsedHint({
      kind: "tool",
      id: 2,
      label: "→ read x",
      output: ["only one"],
      collapsed: true,
      isDiff: false,
      isError: false,
      done: true,
    }),
  ).toBe("1 line");
});

test("dropSettledPerms removes the engine-settled cards; unknown/empty ids are benign", () => {
  const perms: PendingPerm[] = [
    { id: "perm_a", toolName: "bash", input: {} },
    { id: "perm_b", toolName: "edit", input: {} },
    { id: "perm_c", toolName: "write", input: {} },
  ];
  // Only the matching card(s) drop; the rest keep their order.
  expect(dropSettledPerms(perms, ["perm_b"]).map((p) => p.id)).toEqual(["perm_a", "perm_c"]);
  // An abort settles every pending prompt at once → the queue empties.
  expect(dropSettledPerms(perms, ["perm_a", "perm_b", "perm_c"])).toEqual([]);
  // An unknown id (a card already answered + removed) is a no-op, not a throw.
  expect(dropSettledPerms(perms, ["perm_gone"]).map((p) => p.id)).toEqual([
    "perm_a",
    "perm_b",
    "perm_c",
  ]);
  // An empty settle list returns the SAME array reference (nothing to do).
  expect(dropSettledPerms(perms, [])).toBe(perms);
});

test("firstLine and truncate helpers", () => {
  expect(firstLine("\n\n  hello \nworld")).toBe("hello");
  expect(firstLine("   \n  ")).toBeUndefined();
  expect(truncate("abcdef", 4)).toBe("abc…");
  expect(truncate("ab", 4)).toBe("ab");
});

test("truncate counts display cells and never splits a surrogate pair", () => {
  // CJK glyphs are 2 cells wide — the cut lands INSIDE the budget (日本 = 4
  // cells + …), where the old char count kept 4 glyphs (9 cells) past the edge.
  expect(truncate("日本語テスト", 5)).toBe("日本…");
  // Emoji (non-BMP, 2 cells): two fit under 5 cells with the ellipsis.
  expect(truncate("😀😀😀😀", 5)).toBe("😀😀…");
  // Non-BMP 1-cell chars: the old `.slice(0, n - 1)` cut UTF-16 units and left
  // a lone surrogate half at the boundary.
  expect(truncate("𝕒𝕓𝕔𝕕𝕖", 4)).toBe("𝕒𝕓𝕔…");
  expect(truncate("𝕒𝕓𝕔𝕕𝕖", 4).isWellFormed()).toBe(true);
});
