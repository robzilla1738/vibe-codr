/**
 * The transcript reducer: a pure `UIEvent → Block[]` state machine, lifted out of
 * app.tsx so the transcript-building logic (streaming coalescing, tool-block
 * creation, diff folding, cumulative file deltas) is unit-tested rather than
 * living untypechecked inside the `.tsx`. app.tsx owns the Solid signals + the
 * per-frame flush timer; it delegates every state transition here.
 */

import { GLYPH } from "./glyphs.ts";
import { toolLabel } from "./tool-icons.ts";

/**
 * One block in the transcript. The transcript is append-only: positions never
 * move, so app.tsx renders it with <Index> (stable per-position rows) and only
 * the block currently being mutated re-renders. `id` is a stable click handle.
 */
export type Block =
  | { kind: "user"; id: number; text: string }
  | { kind: "assistant"; id: number; text: string; streaming: boolean; gap: boolean }
  | {
      kind: "tool";
      id: number;
      /** Header label ("→ read x" or, after a file change, "✎ edited x +n -m"). */
      label: string;
      /** Full captured output / diff hunk, shown only when expanded. */
      output: string[];
      collapsed: boolean;
      /** Output is a unified diff → color +/- lines when expanded. */
      isDiff: boolean;
      /** Output is markdown prose (a subagent's reply) → render via <markdown>. */
      isMarkdown?: boolean;
      /** Output is a web-search result list → render as clean source cards. */
      isSources?: boolean;
      isError: boolean;
    }
  | { kind: "notice"; id: number; text: string; level: "info" | "warn" | "error" };

/** A subagent shown in the Subagents panel while it runs and after it finishes. */
export interface Subagent {
  id: string;
  prompt: string;
  status: "running" | "done";
  /** Live one-line "what it's doing right now" ("$ bun test", "edit app.ts"),
   *  set from `subagent-activity` while RUNNING and cleared on finish. */
  activity?: string;
  /** One-line result summary, surfaced once the subagent finishes. */
  result?: string;
}

/** A file edited this session, with its cumulative line delta (footer summary). */
export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
}

export interface PendingPerm {
  id: string;
  toolName: string;
  input: unknown;
}

/**
 * The reducer's state. `blocks`/`changedFiles` are what app.tsx renders; the rest
 * are cursors kept so we can mutate the streaming reply and each tool call by
 * index rather than searching the array on every event.
 */
export interface TranscriptState {
  blocks: Block[];
  changedFiles: ChangedFile[];
  /** Monotonic block-id source (stable click handles / <Index> keys). */
  nextId: number;
  /** Index of the in-flight assistant block, or -1. */
  activeAssistant: number;
  /** callId → index of the tool block it started. */
  toolByCallId: Record<string, number>;
  /** callIds whose finished-echo to skip (we already folded their diff). */
  suppressCallIds: Record<string, true>;
}

export function initialTranscript(): TranscriptState {
  return { blocks: [], changedFiles: [], nextId: 0, activeAssistant: -1, toolByCallId: {}, suppressCallIds: {} };
}

/** Transcript-affecting actions. app.tsx maps engine UIEvents (and its own
 * coalesced deltas + click toggles) onto these. */
export type TranscriptAction =
  | { type: "user"; text: string }
  /** A coalesced batch of streamed assistant text (app.tsx buffers per frame). */
  | { type: "delta"; text: string }
  /** Land the streaming reply: flip `streaming` off so <markdown> closes fences. */
  | { type: "finalize" }
  | { type: "tool-start"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-finish"; toolCallId: string; output: unknown; isError: boolean }
  | {
      type: "file-changed";
      toolCallId: string;
      path: string;
      action: "write" | "edit";
      added: number;
      removed: number;
      diff?: string;
    }
  | { type: "notice"; text: string; level?: "info" | "warn" | "error" }
  | { type: "toggle"; id: number }
  /** Turn boundary: finalize the reply and drop per-turn call maps. */
  | { type: "clear-turn" };

/** Finalize the streaming reply: land it (flip `streaming` off) and clear the cursor. */
function finalizeActive(s: TranscriptState): TranscriptState {
  if (s.activeAssistant < 0) return s;
  const b = s.blocks[s.activeAssistant];
  if (b?.kind !== "assistant" || !b.streaming) return { ...s, activeAssistant: -1 };
  const blocks = s.blocks.slice();
  blocks[s.activeAssistant] = { ...b, streaming: false };
  return { ...s, blocks, activeAssistant: -1 };
}

/** Apply one action, returning the next immutable state. Pure — no signals, no timers. */
export function reduceTranscript(s: TranscriptState, a: TranscriptAction): TranscriptState {
  switch (a.type) {
    case "user": {
      const f = finalizeActive(s);
      return {
        ...f,
        blocks: [...f.blocks, { kind: "user", id: f.nextId, text: a.text }],
        nextId: f.nextId + 1,
        // A new turn starts with clean per-turn call maps.
        toolByCallId: {},
        suppressCallIds: {},
      };
    }
    case "delta": {
      const cur = s.blocks[s.activeAssistant];
      if (s.activeAssistant >= 0 && cur && cur.kind === "assistant") {
        const blocks = s.blocks.slice();
        blocks[s.activeAssistant] = { ...cur, text: cur.text + a.text };
        return { ...s, blocks };
      }
      // The first flushed delta opens a new block with a blank line above it.
      const blocks = [
        ...s.blocks,
        { kind: "assistant" as const, id: s.nextId, text: a.text, streaming: true, gap: true },
      ];
      return { ...s, blocks, nextId: s.nextId + 1, activeAssistant: blocks.length - 1 };
    }
    case "finalize":
      return finalizeActive(s);
    case "tool-start": {
      const f = finalizeActive(s);
      const label = toolLabel(a.toolName, a.input);
      // A subagent reply / task-DAG report is markdown prose; a web-search result
      // list renders as clean source cards — both instead of raw dumped lines.
      const isMarkdown = a.toolName === "spawn_subagent" || a.toolName === "spawn_tasks";
      const isSources = a.toolName === "web_search";
      const blocks = [
        ...f.blocks,
        {
          kind: "tool" as const,
          id: f.nextId,
          label,
          output: [] as string[],
          // A subagent's reply (or a fan-out's consolidated report) opens expanded
          // — it IS the answer; other tools stay condensed until clicked.
          collapsed: !isMarkdown,
          isDiff: false,
          isMarkdown,
          isSources,
          isError: false,
        },
      ];
      return {
        ...f,
        blocks,
        nextId: f.nextId + 1,
        toolByCallId: { ...f.toolByCallId, [a.toolCallId]: blocks.length - 1 },
      };
    }
    case "tool-finish": {
      // Skip only the echo for the exact call whose diff we already folded.
      if (s.suppressCallIds[a.toolCallId]) {
        const suppressCallIds = { ...s.suppressCallIds };
        delete suppressCallIds[a.toolCallId];
        return { ...s, suppressCallIds };
      }
      const idx = s.toolByCallId[a.toolCallId];
      const toolByCallId = { ...s.toolByCallId };
      delete toolByCallId[a.toolCallId]; // call ids are single-use
      const out = typeof a.output === "string" ? a.output : JSON.stringify(a.output, null, 2);
      const lines = out.split("\n").filter((l, i, arr) => l.length || i < arr.length - 1);
      if (idx == null) return { ...s, toolByCallId };
      const b = s.blocks[idx];
      if (b?.kind !== "tool") return { ...s, toolByCallId };
      const blocks = s.blocks.slice();
      blocks[idx] = { ...b, output: lines, isError: a.isError };
      return { ...s, blocks, toolByCallId };
    }
    case "file-changed": {
      const suppressCallIds = { ...s.suppressCallIds, [a.toolCallId]: true as const };
      const verb = a.action === "write" ? "wrote" : "edited";
      const header = `${GLYPH.file} ${verb} ${a.path}  +${a.added} -${a.removed}`;
      const lines = a.diff ? a.diff.split("\n") : [];
      // Cumulative per-file delta for the footer summary.
      const ci = s.changedFiles.findIndex((f) => f.path === a.path);
      let changedFiles: ChangedFile[];
      if (ci >= 0) {
        changedFiles = s.changedFiles.slice();
        const f = changedFiles[ci]!;
        changedFiles[ci] = { path: f.path, added: f.added + a.added, removed: f.removed + a.removed };
      } else {
        changedFiles = [...s.changedFiles, { path: a.path, added: a.added, removed: a.removed }];
      }
      const fin = finalizeActive({ ...s, suppressCallIds, changedFiles });
      const idx = fin.toolByCallId[a.toolCallId];
      const target = idx == null ? undefined : fin.blocks[idx];
      const canFold = !!target && target.kind === "tool" && !target.isDiff;
      const folded: Block = {
        kind: "tool",
        id: canFold ? (target as { id: number }).id : fin.nextId,
        label: header,
        output: lines,
        collapsed: false,
        isDiff: true,
        isError: false,
      };
      if (canFold && idx != null) {
        const blocks = fin.blocks.slice();
        blocks[idx] = folded;
        return { ...fin, blocks };
      }
      // No matching block, or this call already produced a diff → append standalone.
      return { ...fin, blocks: [...fin.blocks, folded], nextId: fin.nextId + 1 };
    }
    case "notice": {
      const f = finalizeActive(s);
      return {
        ...f,
        blocks: [...f.blocks, { kind: "notice", id: f.nextId, text: a.text, level: a.level ?? "info" }],
        nextId: f.nextId + 1,
      };
    }
    case "toggle":
      return {
        ...s,
        blocks: s.blocks.map((b) => (b.id === a.id && b.kind === "tool" ? { ...b, collapsed: !b.collapsed } : b)),
      };
    case "clear-turn": {
      const f = finalizeActive(s);
      return { ...f, toolByCallId: {}, suppressCallIds: {} };
    }
    default:
      return s;
  }
}

/**
 * One conversation turn: the user message that opens it plus every block that
 * follows until the next user message. Blocks that arrive before any user message
 * (a leading banner/notice) form a `user`-less preamble turn. Rendered as a single
 * connected "thread" — a continuous left rail (git-graph style) runs from the user
 * node at the top down through the turn's tool steps and answer.
 */
export interface Turn {
  /** The user message that anchors the turn, or undefined for a leading preamble. */
  user?: Extract<Block, { kind: "user" }>;
  /** The turn's non-user blocks (assistant / tool / notice), in arrival order. */
  items: Block[];
  /** Stable render/fold key: the user-message id, or a negative synthetic id for a
   * preamble (so `<Index>` positions and the collapsed-turns set stay stable). */
  key: number;
}

/**
 * Group the flat append-only block list into {@link Turn}s. Pure and testable;
 * app.tsx renders each turn as one threaded unit. Turns only ever append (the
 * transcript never reorders), so a turn's `key` is stable across recomputes.
 */
export function groupIntoTurns(blocks: Block[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const b of blocks) {
    if (b.kind === "user") {
      cur = { user: b, items: [], key: b.id };
      turns.push(cur);
    } else {
      if (!cur) {
        // A block before the first user message → a keyed, node-less preamble.
        cur = { items: [], key: -1 - turns.length };
        turns.push(cur);
      }
      cur.items.push(b);
    }
  }
  return turns;
}

/**
 * Turn grouping: map each block to its turn's user-message id, and count the
 * non-user blocks per turn — so tapping a user message can fold (and count) its
 * whole exchange.
 */
export function groupTurns(blocks: Block[]): { turnKey: Map<number, number>; counts: Map<number, number> } {
  const turnKey = new Map<number, number>();
  const counts = new Map<number, number>();
  let cur = -1;
  for (const b of blocks) {
    if (b.kind === "user") {
      cur = b.id;
      turnKey.set(b.id, b.id);
    } else if (cur >= 0) {
      turnKey.set(b.id, cur);
      counts.set(cur, (counts.get(cur) ?? 0) + 1);
    }
  }
  return { turnKey, counts };
}

/**
 * Collapsed tool-row detail: "diff" for a diff, else the search-result count for
 * a web_search (reads far better than "33 lines" of payload), else the raw line count.
 */
export function collapsedHint(t: Extract<Block, { kind: "tool" }>): string {
  if (t.isDiff) return "diff";
  if (t.label.startsWith("◈")) {
    const results = t.output.filter((l) => /^\d+\.\s/.test(l)).length;
    if (results > 0) return `${results} result${results === 1 ? "" : "s"}`;
  }
  return `${t.output.length} line${t.output.length === 1 ? "" : "s"}`;
}

/** The first non-empty line of a (possibly multi-line) string, for one-line summaries. */
export function firstLine(s: string | undefined): string | undefined {
  const line = s?.split("\n").find((l) => l.trim().length > 0)?.trim();
  return line || undefined;
}

/** Truncate to `n` chars with an ellipsis. */
export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
