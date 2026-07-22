/**
 * The transcript reducer: a pure `UIEvent → Block[]` state machine, lifted out of
 * app.tsx so the transcript-building logic (streaming coalescing, tool-block
 * creation, diff folding, cumulative file deltas) is unit-tested rather than
 * living untypechecked inside the `.tsx`. app.tsx owns the Solid signals + the
 * per-frame flush timer; it delegates every state transition here.
 */

import { isDensityChangeNotice } from "./density";
import type { AssistantOutputPhase } from "./events";
import { GLYPH } from "./glyphs";
import { truncateWidth } from "./markdown-blocks";
import { appendRollingText } from "./stream-cap";
import { isLongOutputTool, LONG_OUTPUT_COLLAPSE_LINES, toolLabel } from "./tool-icons";

const TOOL_OUTPUT_MAX_CHARS = 512 * 1024;
const FILE_DIFF_MAX_CHARS = 1024 * 1024;
const USER_OUTPUT_MAX_CHARS = 2 * 1024 * 1024;
const NOTICE_OUTPUT_MAX_CHARS = 128 * 1024;
/** Bound a single model reply while keeping its newest, most actionable tail.
 * The engine persists the authoritative history; this is the renderer's memory
 * safety ceiling for both live streams and snapshot hydration. */
export const ASSISTANT_OUTPUT_MAX_CHARS = 4 * 1024 * 1024;
export const REASONING_OUTPUT_MAX_CHARS = 256 * 1024;
/** Latest diffs remain reviewable without letting a long multi-file run retain
 * one megabyte per path forever. Metadata/totals remain for every changed file. */
export const CHANGED_FILE_DIFF_BUDGET_CHARS = 16 * 1024 * 1024;
/** Shared live/cache ceiling. Older or corrupted presentation caches above this
 * are discarded and rebuilt from authoritative engine history. */
export const MAX_RETAINED_TRANSCRIPT_BLOCKS = 2_500;

/** Keep the useful tail while bounding a single newline-free payload. */
function capTextTail(value: string, maxChars: number, kind: string): string {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `… ${omitted} earlier ${kind} characters omitted …\n${value.slice(-maxChars)}`;
}

/**
 * One block in the transcript. The transcript is append-only: positions never
 * move, so app.tsx renders it with <Index> (stable per-position rows) and only
 * the block currently being mutated re-renders. `id` is a stable click handle.
 */
export type Block = {
  /** Canonical protocol identity; numeric id remains the local click handle. */
  wireId?: string;
  turnId?: string;
  messageId?: string;
  revision?: number;
  turnDurationMs?: number;
} & (
  | {
      kind: "user";
      id: number;
      text: string;
      timestamp: number;
      origin?: "user" | "engine";
      label?: string;
    }
  | { kind: "assistant"; id: number; text: string; streaming: boolean; gap: boolean; timestamp: number; phase?: AssistantOutputPhase }
  | {
      kind: "tool";
      id: number;
      /** Tool name (for collapse policy / fail meta), when known. */
      toolName?: string;
      /** Header label ("→ read x" or, after a file change, "✎ edited x +n -m"). */
      label: string;
      /** Full captured output / diff hunk, shown only when expanded. */
      output: string[];
      collapsed: boolean;
      /** Explicit disclosure state chosen by the user. Density only supplies
       * defaults and must never make a visible chevron inert. */
      expandedOverride?: boolean;
      /** Output is a unified diff → color +/- lines when expanded. */
      isDiff: boolean;
      /** Output is markdown prose (a subagent's reply) → render via <markdown>. */
      isMarkdown?: boolean;
      /** Output is a web-search result list → render as clean source cards. */
      isSources?: boolean;
      isError: boolean;
      /** The call finished (result landed or its diff folded in). While false the
       * row is LIVE: its chevron spins and `tail` previews streaming output. */
      done: boolean;
      /** Rolling tail of streamed output (bash chunks) shown under the header
       * while the call runs — a long `bun test` is visibly alive, not a dead
       * row until it exits. Bounded; cleared when the result lands. */
      tail?: string;
      /** Stamp from the `tool-start` action (app time, ms). */
      startedAt?: number;
      /** Wall-clock the call took; the meta column shows it when it's ≥2s. */
      elapsedMs?: number;
      lifecycle?: "queued" | "running" | "waiting-permission" | "succeeded" | "failed" | "cancelled";
      outputPaths?: string[];
      sources?: string[];
    }
  | {
      /** A burst of the model's reasoning, landed as a collapsed row once the
       * model ACTS (text streams / a tool starts / the turn ends) — so the
       * thinking that led to each step stays reviewable in place, like the
       * live one-line preview but permanent. */
      kind: "thinking";
      id: number;
      text: string;
      collapsed: boolean;
      /** Explicit disclosure state chosen by the user. */
      expandedOverride?: boolean;
      /** How long the burst took, seconds (shown in the header when ≥1). */
      seconds?: number;
    }
  | { kind: "notice"; id: number; text: string; level: "info" | "warn" | "error" }
);

/** A subagent shown in the Subagents panel while it runs and after it finishes. */
export interface Subagent {
  id: string;
  prompt: string;
  status: "running" | "done";
  /** Live one-line "what it's doing right now" ("$ bun test", "edit app.js"),
   *  set from `subagent-activity` while RUNNING and cleared on finish. */
  activity?: string;
  /** One-line result summary, surfaced once the subagent finishes. */
  result?: string;
  /** App-time start stamp — drives the live per-row elapsed while running. */
  startedAt?: number;
  /** Total wall-clock once finished (the row's final duration). */
  elapsedMs?: number;
  agent?: string;
  transcript?: string;
  metrics?: import("./types").ActivityInfo["metrics"];
}

/** A file edited this session, with its cumulative line delta (footer summary). */
export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
  /** False when resume history proves the file changed but did not persist line counts. */
  countsKnown?: boolean;
  /** Latest unified diff hunk, used by the docked review view. */
  diff?: string;
}

/** Keep newest file diffs inside a total character budget. Files without a
 * retained diff still appear in Changes and can be opened in File view. */
export function capChangedFileDiffs(
  files: readonly ChangedFile[],
  budgetChars = CHANGED_FILE_DIFF_BUDGET_CHARS,
): ChangedFile[] {
  let remaining = Math.max(0, budgetChars);
  const kept = new Array<ChangedFile>(files.length);
  for (let index = files.length - 1; index >= 0; index -= 1) {
    const file = files[index]!;
    const diff = file.diff;
    if (!diff) {
      kept[index] = file;
      continue;
    }
    if (diff.length <= remaining) {
      remaining -= diff.length;
      kept[index] = file;
    } else {
      const { diff: _diff, ...metadata } = file;
      kept[index] = metadata;
    }
  }
  return kept;
}

export interface PendingPerm {
  id: string;
  toolName: string;
  input: unknown;
}

/** Drop the permission cards the engine auto-settled (an abort or shutdown
 * denied them with no user answer), matched by request id. An unknown id is a
 * benign no-op — a card the UI already answered and removed — so a settle event
 * that races the answer never throws or clears the wrong card. Pure so the
 * perms-card lifecycle is unit-tested, not buried in app.tsx signals. */
export function dropSettledPerms(perms: PendingPerm[], settledIds: readonly string[]): PendingPerm[] {
  if (settledIds.length === 0) return perms;
  const settled = new Set(settledIds);
  return perms.filter((p) => !settled.has(p.id));
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

/**
 * Enforce the renderer's retained-block ceiling for every state ingress path.
 * Live actions, IndexedDB restores, and engine-history hydration must all pass
 * through the same cursor-safe shift or a resumed session can bypass the cap.
 */
export function capTranscriptState(
  state: TranscriptState,
  maxBlocks = MAX_RETAINED_TRANSCRIPT_BLOCKS,
): TranscriptState {
  const limit = Math.max(0, Math.floor(maxBlocks));
  if (state.blocks.length <= limit) return state;
  const overflow = state.blocks.length - limit;
  const toolByCallId: Record<string, number> = {};
  for (const [id, index] of Object.entries(state.toolByCallId)) {
    const shifted = index - overflow;
    if (shifted >= 0) toolByCallId[id] = shifted;
  }
  return {
    ...state,
    blocks: state.blocks.slice(overflow),
    activeAssistant:
      state.activeAssistant >= overflow ? state.activeAssistant - overflow : -1,
    toolByCallId,
  };
}

/** Transcript-affecting actions. app.tsx maps engine UIEvents (and its own
 * coalesced deltas + click toggles) onto these. */
export type TranscriptAction =
  | {
      type: "user";
      text: string;
      timestamp?: number;
      origin?: "user" | "engine";
      label?: string;
      turnId?: string;
      messageId?: string;
      partId?: string;
      revision?: number;
    }
  /** A coalesced batch of streamed assistant text (app.tsx buffers per frame). */
  | { type: "delta"; text: string; timestamp?: number; phase?: AssistantOutputPhase; turnId?: string; messageId?: string; partId?: string; revision?: number }
  /** Land the streaming reply: flip `streaming` off so <markdown> closes fences. */
  | { type: "finalize" }
  | { type: "set-assistant-phase"; partId?: string; phase: AssistantOutputPhase; revision?: number }
  /** `at` = app-time stamp (ms); with tool-finish's it yields the row's duration. */
  | { type: "tool-start"; toolCallId: string; toolName: string; input: unknown; at?: number; turnId?: string; messageId?: string; partId?: string; revision?: number; status?: "queued" | "running" | "waiting-permission" | "succeeded" | "failed" | "cancelled" }
  /** A chunk of live streamed output from a RUNNING call (bash stdout/stderr). */
  | { type: "tool-progress"; toolCallId: string; chunk: string; turnId?: string; partId?: string; revision?: number }
  | { type: "tool-status"; toolCallId: string; status: "queued" | "running" | "waiting-permission" | "succeeded" | "failed" | "cancelled" }
  | { type: "tool-finish"; toolCallId: string; output: unknown; isError: boolean; at?: number; turnId?: string; messageId?: string; partId?: string; revision?: number; status?: "queued" | "running" | "waiting-permission" | "succeeded" | "failed" | "cancelled"; outputPaths?: string[]; sources?: string[] }
  /** A finished reasoning burst → a collapsed, expandable thinking row. */
  | { type: "thinking"; text: string; seconds?: number; turnId?: string; messageId?: string; partId?: string; revision?: number }
  | {
      type: "file-changed";
      toolCallId: string;
      path: string;
      action: "write" | "edit";
      added: number;
      removed: number;
      countsKnown?: boolean;
      diff?: string;
      at?: number;
    }
  | { type: "notice"; text: string; level?: "info" | "warn" | "error" }
  | { type: "turn-performance"; turnId: string; totalMs: number }
  | { type: "toggle"; id: number }
  | { type: "set-expanded"; id: number; expanded: boolean }
  /** Expand every thinking row if any is collapsed, else collapse them all
   * (the Ctrl+T companion to Ctrl+O's whole-turn fold). */
  | { type: "toggle-thinking-all"; density: "quiet" | "normal" | "verbose" }
  /** Turn boundary: finalize the reply and drop per-turn call maps. */
  | { type: "clear-turn" };

/** Finalize the streaming reply: land it (flip `streaming` off) and clear the cursor. */
function finalizeActive(s: TranscriptState, phase?: AssistantOutputPhase): TranscriptState {
  if (s.activeAssistant < 0) return s;
  const b = s.blocks[s.activeAssistant];
  if (b?.kind !== "assistant" || !b.streaming) return { ...s, activeAssistant: -1 };
  const blocks = s.blocks.slice();
  blocks[s.activeAssistant] = { ...b, streaming: false, ...(phase && !b.phase ? { phase } : {}) };
  return { ...s, blocks, activeAssistant: -1 };
}

function markUnphasedBeforeTool(s: TranscriptState): TranscriptState {
  let turnStart = 0;
  for (let index = s.blocks.length - 1; index >= 0; index -= 1) {
    if (s.blocks[index]?.kind === "user") { turnStart = index + 1; break; }
  }
  let changed = false;
  const blocks = s.blocks.map((block, index) => {
    if (index < turnStart || block.kind !== "assistant" || block.phase) return block;
    changed = true;
    return { ...block, phase: "commentary" as const };
  });
  return changed ? { ...s, blocks } : s;
}

export function classifyAssistantPhases(state: TranscriptState): TranscriptState {
  const blocks = state.blocks.slice();
  let unresolved: number[] = [];
  const settleTurn = () => {
    if (!unresolved.length) return;
    const finalIndex = unresolved[unresolved.length - 1]!;
    for (const index of unresolved) {
      const block = blocks[index];
      if (block?.kind === "assistant" && !block.phase) blocks[index] = { ...block, phase: index === finalIndex ? "final" : "commentary" };
    }
    unresolved = [];
  };
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (block.kind === "user") settleTurn();
    else if (block.kind === "assistant" && !block.phase) unresolved.push(index);
    else if (block.kind === "tool" && unresolved.length) {
      for (const pending of unresolved) {
        const assistant = blocks[pending];
        if (assistant?.kind === "assistant" && !assistant.phase) blocks[pending] = { ...assistant, phase: "commentary" };
      }
      unresolved = [];
    }
  }
  settleTurn();
  return blocks.some((block, index) => block !== state.blocks[index]) ? { ...state, blocks } : state;
}

/** Apply one action, returning the next immutable state. Pure — no signals, no timers. */
export function reduceTranscript(s: TranscriptState, a: TranscriptAction): TranscriptState {
  switch (a.type) {
    case "user": {
      const f = classifyAssistantPhases(finalizeActive(s));
      return {
        ...f,
        blocks: [
          ...f.blocks,
          {
            kind: "user",
            id: f.nextId,
            text: appendRollingText("", a.text, USER_OUTPUT_MAX_CHARS),
            timestamp: a.timestamp ?? Date.now(),
            ...(a.origin ? { origin: a.origin } : {}),
            ...(a.label ? { label: a.label } : {}),
            ...(a.turnId ? { turnId: a.turnId } : {}),
            ...(a.messageId ? { messageId: a.messageId } : {}),
            ...(a.partId ? { wireId: a.partId } : {}),
            ...(a.revision !== undefined ? { revision: a.revision } : {}),
          },
        ],
        nextId: f.nextId + 1,
        // A new turn starts with clean per-turn call maps.
        toolByCallId: {},
        suppressCallIds: {},
      };
    }
    case "delta": {
      const cur = s.blocks[s.activeAssistant];
      if (s.activeAssistant >= 0 && cur && cur.kind === "assistant") {
        if (a.phase && cur.phase && a.phase !== cur.phase) return reduceTranscript(finalizeActive(s), a);
        const blocks = s.blocks.slice();
        blocks[s.activeAssistant] = {
          ...cur,
          text: appendRollingText(
            cur.text,
            a.text,
            ASSISTANT_OUTPUT_MAX_CHARS,
          ),
          ...(a.phase ? { phase: a.phase } : {}),
          ...(a.turnId ? { turnId: a.turnId } : {}),
          ...(a.messageId ? { messageId: a.messageId } : {}),
          ...(a.partId ? { wireId: a.partId } : {}),
          ...(a.revision !== undefined ? { revision: a.revision } : {}),
        };
        return { ...s, blocks };
      }
      // The first flushed delta opens a new block with a blank line above it.
      const blocks = [
        ...s.blocks,
        {
          kind: "assistant" as const,
          id: s.nextId,
          text: appendRollingText("", a.text, ASSISTANT_OUTPUT_MAX_CHARS),
          streaming: true,
          gap: true,
          timestamp: a.timestamp ?? Date.now(),
          ...(a.phase ? { phase: a.phase } : {}),
          ...(a.turnId ? { turnId: a.turnId } : {}),
          ...(a.messageId ? { messageId: a.messageId } : {}),
          ...(a.partId ? { wireId: a.partId } : {}),
          ...(a.revision !== undefined ? { revision: a.revision } : {}),
        },
      ];
      return { ...s, blocks, nextId: s.nextId + 1, activeAssistant: blocks.length - 1 };
    }
    case "finalize":
      return finalizeActive(s);
    case "set-assistant-phase": {
      if (!a.partId) return s;
      const index = s.blocks.findIndex((block) =>
        block.kind === "assistant" && block.wireId === a.partId
      );
      if (index < 0) return s;
      const blocks = s.blocks.slice();
      blocks[index] = {
        ...blocks[index]!,
        phase: a.phase,
        ...(a.revision !== undefined ? { revision: a.revision } : {}),
      } as Block;
      return { ...s, blocks };
    }
    case "tool-start": {
      const f = markUnphasedBeforeTool(finalizeActive(s, "commentary"));
      const label = toolLabel(a.toolName, a.input);
      // A subagent reply / task-DAG report is markdown prose; a web-search result
      // list renders as clean source cards — both instead of raw dumped lines.
      // Spawn tools stay collapsed by default (the Subagents panel owns fan-out
      // awareness; opening five full replies floods the transcript). Verbose
      // density force-opens them at render time.
      const isMarkdown = a.toolName === "spawn_subagent" || a.toolName === "spawn_tasks";
      const isSources = a.toolName === "web_search";
      const blocks = [
        ...f.blocks,
        {
          kind: "tool" as const,
          id: f.nextId,
          toolName: a.toolName,
          label,
          output: [] as string[],
          collapsed: true,
          isDiff: false,
          isMarkdown,
          isSources,
          isError: false,
          done: false,
          lifecycle: a.status ?? "running",
          ...(a.at !== undefined ? { startedAt: a.at } : {}),
          ...(a.turnId ? { turnId: a.turnId } : {}),
          ...(a.messageId ? { messageId: a.messageId } : {}),
          ...(a.partId ? { wireId: a.partId } : {}),
          ...(a.revision !== undefined ? { revision: a.revision } : {}),
        },
      ];
      return {
        ...f,
        blocks,
        nextId: f.nextId + 1,
        toolByCallId: { ...f.toolByCallId, [a.toolCallId]: blocks.length - 1 },
      };
    }
    case "tool-progress": {
      // Live streamed output for a RUNNING call: keep a bounded rolling tail on
      // the block (rendering shows its last lines). Once the result has landed
      // (done), stray late chunks are dropped — they'd resurrect a dead preview.
      const idx = s.toolByCallId[a.toolCallId];
      const b = idx == null ? undefined : s.blocks[idx];
      if (idx == null || b?.kind !== "tool" || b.done) return s;
      const blocks = s.blocks.slice();
      blocks[idx] = { ...b, tail: ((b.tail ?? "") + a.chunk).slice(-600) };
      return { ...s, blocks };
    }
    case "tool-status": {
      const idx = s.toolByCallId[a.toolCallId];
      const block = idx == null ? undefined : s.blocks[idx];
      if (idx == null || block?.kind !== "tool" || block.done) return s;
      const blocks = s.blocks.slice();
      blocks[idx] = { ...block, lifecycle: a.status };
      return { ...s, blocks };
    }
    case "tool-finish": {
      // Skip only the echo for the exact call whose diff we already folded.
      if (s.suppressCallIds[a.toolCallId]) {
        const suppressCallIds = { ...s.suppressCallIds };
        const toolByCallId = { ...s.toolByCallId };
        delete suppressCallIds[a.toolCallId];
        delete toolByCallId[a.toolCallId];
        return { ...s, suppressCallIds, toolByCallId };
      }
      const idx = s.toolByCallId[a.toolCallId];
      const toolByCallId = { ...s.toolByCallId };
      delete toolByCallId[a.toolCallId]; // call ids are single-use
      let out: string;
      if (typeof a.output === "string") {
        out = a.output;
      } else if (a.output === undefined || a.output === null) {
        out = "";
      } else {
        try {
          // JSON.stringify(undefined) is undefined (not a string) — never call .split on it.
          out = JSON.stringify(a.output, null, 2) ?? "";
        } catch {
          out = String(a.output);
        }
      }
      out = capTextTail(out, TOOL_OUTPUT_MAX_CHARS, "output");
      // Cap retained tool bodies in the reducer (windowing only bounds DOM).
      // Very large bash dumps otherwise pin RAM for the whole session.
      const TOOL_OUTPUT_MAX_LINES = 4_000;
      let lines = out.split("\n").filter((l, i, arr) => l.length || i < arr.length - 1);
      if (lines.length > TOOL_OUTPUT_MAX_LINES) {
        const omitted = lines.length - TOOL_OUTPUT_MAX_LINES;
        lines = [
          `… ${omitted} earlier lines omitted …`,
          ...lines.slice(-TOOL_OUTPUT_MAX_LINES),
        ];
      }
      if (idx == null) return { ...s, toolByCallId };
      const b = s.blocks[idx];
      if (b?.kind !== "tool") return { ...s, toolByCallId };
      const blocks = s.blocks.slice();
      const { tail: _tail, ...rest } = b;
      // Failed calls open expanded (errors are the next action). Long successful
      // bash/git dumps stay collapsed with a line-count meta — expanding is a click.
      const longOk =
        !a.isError &&
        lines.length >= LONG_OUTPUT_COLLAPSE_LINES &&
        isLongOutputTool(b.toolName ?? "");
      blocks[idx] = {
        ...rest,
        output: lines,
        isError: a.isError,
        collapsed: a.isError ? false : longOk ? true : b.collapsed,
        done: true,
        lifecycle: a.status ?? (a.isError ? "failed" : "succeeded"),
        ...(a.outputPaths?.length ? { outputPaths: a.outputPaths.slice(0, 100) } : {}),
        ...(a.sources?.length ? { sources: a.sources.slice(0, 100) } : {}),
        ...(a.at !== undefined && b.startedAt !== undefined
          ? { elapsedMs: Math.max(0, a.at - b.startedAt) }
          : {}),
      };
      return { ...s, blocks, toolByCallId };
    }
    case "thinking": {
      const text = appendRollingText(
        "",
        a.text.trim(),
        REASONING_OUTPUT_MAX_CHARS,
      );
      if (!text) return s;
      const f = finalizeActive(s);
      return {
        ...f,
        blocks: [
          ...f.blocks,
          {
            kind: "thinking" as const,
            id: f.nextId,
            text,
            collapsed: true,
            ...(a.seconds !== undefined ? { seconds: a.seconds } : {}),
            ...(a.turnId ? { turnId: a.turnId } : {}),
            ...(a.messageId ? { messageId: a.messageId } : {}),
            ...(a.partId ? { wireId: a.partId } : {}),
            ...(a.revision !== undefined ? { revision: a.revision } : {}),
          },
        ],
        nextId: f.nextId + 1,
      };
    }
    case "file-changed": {
      // A no-op change (empty diff, ±0 lines — e.g. a write that produced the
      // identical file) must NOT convert the tool block into an expanded empty
      // diff and suppress its real result text. Leave the block alone so the
      // tool's own output ("no changes") lands normally.
      if (!a.diff && a.added === 0 && a.removed === 0 && a.countsKnown !== false) return s;
      const suppressCallIds = { ...s.suppressCallIds, [a.toolCallId]: true as const };
      const verb = a.action === "write" ? "wrote" : "edited";
      const header = a.countsKnown === false
        ? `${GLYPH.file} ${verb} ${a.path}`
        : `${GLYPH.file} ${verb} ${a.path}  +${a.added} -${a.removed}`;
      // Same line budget as tool bodies — huge multi-file diffs must not pin RAM.
      const FILE_DIFF_MAX_LINES = 4_000;
      let storedDiff = a.diff
        ? capTextTail(a.diff, FILE_DIFF_MAX_CHARS, "diff")
        : a.diff;
      let lines = storedDiff ? storedDiff.split("\n") : [];
      if (lines.length > FILE_DIFF_MAX_LINES) {
        const omitted = lines.length - FILE_DIFF_MAX_LINES;
        lines = [
          `… ${omitted} earlier diff lines omitted …`,
          ...lines.slice(-FILE_DIFF_MAX_LINES),
        ];
        storedDiff = lines.join("\n");
      }
      // Cumulative per-file delta for the footer summary.
      const ci = s.changedFiles.findIndex((f) => f.path === a.path);
      let changedFiles: ChangedFile[];
      if (ci >= 0) {
        const f = s.changedFiles[ci]!;
        const updated: ChangedFile = {
          path: f.path,
          added: f.added + a.added,
          removed: f.removed + a.removed,
          ...(
            f.countsKnown === false || a.countsKnown === false
              ? { countsKnown: false as const }
              : {}
          ),
          ...(storedDiff || f.diff ? { diff: storedDiff || f.diff } : {}),
        };
        // Treat the latest edit as newest for the retained-diff budget. Display
        // order is independently sorted by the Changes surfaces.
        changedFiles = [
          ...s.changedFiles.slice(0, ci),
          ...s.changedFiles.slice(ci + 1),
          updated,
        ];
      } else {
        changedFiles = [
          ...s.changedFiles,
          {
            path: a.path,
            added: a.added,
            removed: a.removed,
            ...(a.countsKnown === false ? { countsKnown: false as const } : {}),
            ...(storedDiff ? { diff: storedDiff } : {}),
          },
        ];
      }
      changedFiles = capChangedFileDiffs(changedFiles);
      const fin = finalizeActive({ ...s, suppressCallIds, changedFiles });
      const idx = fin.toolByCallId[a.toolCallId];
      const target = idx == null ? undefined : fin.blocks[idx];
      const canFold = !!target && target.kind === "tool" && !target.isDiff;
      const prior = canFold ? (target as Extract<Block, { kind: "tool" }>) : undefined;
      const folded: Block = {
        kind: "tool",
        id: prior ? prior.id : fin.nextId,
        label: header,
        output: lines,
        collapsed: false,
        isDiff: true,
        isError: false,
        done: true,
        ...(prior?.tail !== undefined ? { tail: prior.tail } : {}),
        ...(prior?.startedAt !== undefined ? { startedAt: prior.startedAt } : {}),
        ...(prior?.elapsedMs !== undefined
          ? { elapsedMs: prior.elapsedMs }
          : a.at !== undefined && prior?.startedAt !== undefined
            ? { elapsedMs: Math.max(0, a.at - prior.startedAt) }
            : {}),
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
      if (isDensityChangeNotice(a.text)) return s;
      const f = finalizeActive(s);
      return {
        ...f,
        blocks: [
          ...f.blocks,
          {
            kind: "notice",
            id: f.nextId,
            text: appendRollingText("", a.text, NOTICE_OUTPUT_MAX_CHARS),
            level: a.level ?? "info",
          },
        ],
        nextId: f.nextId + 1,
      };
    }
    case "turn-performance": {
      let target = -1;
      for (let index = s.blocks.length - 1; index >= 0; index -= 1) {
        const block = s.blocks[index];
        if (block?.kind === "assistant" && (!a.turnId || block.turnId === a.turnId)) {
          target = index;
          break;
        }
      }
      if (target < 0) return s;
      const blocks = s.blocks.slice();
      blocks[target] = { ...blocks[target]!, turnDurationMs: Math.max(0, a.totalMs) };
      return { ...s, blocks };
    }
    case "toggle":
      return {
        ...s,
        blocks: s.blocks.map((b) =>
          b.id === a.id && (b.kind === "tool" || b.kind === "thinking")
            ? { ...b, collapsed: !b.collapsed }
            : b,
        ),
      };
    case "set-expanded":
      return {
        ...s,
        blocks: s.blocks.map((b) =>
          b.id === a.id && (b.kind === "tool" || b.kind === "thinking")
            ? { ...b, expandedOverride: a.expanded }
            : b,
        ),
      };
    case "toggle-thinking-all": {
      if (!s.blocks.some((b) => b.kind === "thinking")) return s;
      // Any effectively collapsed row → open everything; all open → fold all.
      // Density supplies only the default and this keyboard choice is explicit.
      const expand = s.blocks.some((b) =>
        b.kind === "thinking"
        && (b.expandedOverride !== undefined
          ? !b.expandedOverride
          : a.density === "verbose"
            ? false
            : b.collapsed),
      );
      return {
        ...s,
        blocks: s.blocks.map((b) =>
          b.kind === "thinking" ? { ...b, expandedOverride: expand } : b,
        ),
      };
    }
    case "clear-turn": {
      const f = classifyAssistantPhases(finalizeActive(s));
      // The turn is over (finished or aborted): settle any still-live tool rows
      // so an interrupted call doesn't spin forever with a stale output tail.
      const blocks = f.blocks.some((b) => b.kind === "tool" && !b.done)
        ? f.blocks.map((b) => {
            if (b.kind !== "tool" || b.done) return b;
            const { tail: _tail, ...rest } = b;
            return { ...rest, done: true };
          })
        : f.blocks;
      return { ...f, blocks, toolByCallId: {}, suppressCallIds: {} };
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
  /** Protocol-stable React identity. Numeric `key` remains the local fold key. */
  renderKey: string;
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
      cur = { user: b, items: [], key: b.id, renderKey: b.turnId ?? `local-turn-${b.id}` };
      turns.push(cur);
    } else {
      if (!cur) {
        // A block before the first user message → a keyed, node-less preamble.
        cur = { items: [], key: -1 - turns.length, renderKey: `preamble-${turns.length}` };
        turns.push(cur);
      }
      cur.items.push(b);
    }
  }
  return turns;
}

export function updateGroupedTurns(
  previousBlocks: readonly Block[],
  previousTurns: readonly Turn[],
  blocks: Block[],
): Turn[] {
  if (blocks === previousBlocks) return previousTurns as Turn[];
  if (
    previousBlocks.length === 0 || blocks.length === 0 ||
    blocks.length < previousBlocks.length || previousBlocks[0] !== blocks[0]
  ) return groupIntoTurns(blocks);
  if (blocks === previousBlocks) return previousTurns as Turn[];
  let restartAt = blocks.length - 1;
  while (restartAt > 0 && blocks[restartAt]?.kind !== "user") restartAt -= 1;
  if (restartAt === 0) return groupIntoTurns(blocks);
  const restart = blocks[restartAt];
  if (restart?.kind !== "user") return groupIntoTurns(blocks);
  const preserveCount = previousTurns.at(-1)?.key === restart.id ? previousTurns.length - 1 : previousTurns.length;
  return [...previousTurns.slice(0, preserveCount), ...groupIntoTurns(blocks.slice(restartAt))];
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
 * Collapsed tool-row detail: short fail meta when the call failed (so a red row
 * still scans under quiet density without expanding), "diff" for a diff, else
 * the search-result count for a web_search, else the raw line count.
 */
export function collapsedHint(t: Extract<Block, { kind: "tool" }>): string {
  if (t.isError) return failMeta(t.output);
  if (t.isDiff) return "diff";
  // Web search icon is ◈ — count numbered result lines.
  if (t.label.startsWith("◈") || t.toolName === "web_search" || t.toolName === "websearch") {
    const results = t.output.filter((l) => /^\d+\.\s/.test(l)).length;
    if (results > 0) return `${results} result${results === 1 ? "" : "s"}`;
  }
  const name = (t.toolName ?? "").toLowerCase();
  if (/^(bash|shell|exec|terminal|run)/.test(name)) {
    const exitLine = t.output.find((line) => /\b(?:exit|status|code)\s*[:=]?\s*\d+\b/i.test(line));
    const exit = exitLine?.match(/\b(?:exit|status|code)\s*[:=]?\s*(\d+)\b/i)?.[1];
    return exit && exit !== "0" ? `exit ${exit}` : "completed";
  }
  if (/^(read|view|open)/.test(name)) {
    return t.output.length > 0 ? `${t.output.length} lines` : "read";
  }
  if (/^(write|edit|patch|apply)/.test(name)) return "changed";
  if (/^(find|search|grep|glob|rg)/.test(name)) {
    const matches = t.output.filter((line) => line.trim()).length;
    return `${matches} match${matches === 1 ? "" : "es"}`;
  }
  if (t.output.length === 0) return "done";
  return `${t.output.length} line${t.output.length === 1 ? "" : "s"}`;
}

/** First-line fail summary for a collapsed error tool: `fail · exit 1` or truncated. */
export function failMeta(output: readonly string[]): string {
  const first = output.find((l) => l.trim().length > 0)?.trim() ?? "";
  if (!first) return "error";
  const exit =
    first.match(/\bexit(?:ed)?(?:\s+code)?[:\s]+(\d+)\b/i) ??
    first.match(/\bstatus[:\s]+(\d+)\b/i) ??
    first.match(/\bcode[:\s]+(\d+)\b/i);
  if (exit) return `fail · exit ${exit[1]}`;
  const clipped = first.length > 36 ? `${first.slice(0, 35)}…` : first;
  return `fail · ${clipped}`;
}

/**
 * The tool row's right-aligned duration label. Two states, one column:
 *  • FINISHED — the call's final wall-clock (`elapsedMs`), shown only when it was
 *    slow (≥2s), a scannable "what cost time" marker down a run of steps;
 *  • RUNNING — a LIVE ticking elapsed once the call has been going >2s, so a tool
 *    with no streamed tail (crawl_docs, web_search, a long git op — only bash
 *    streams a live tail) never sits on a bare spinner looking dead.
 * Both gated at ≥2s so quick calls stay clean. `now` is injected (app.tsx feeds
 * `Date.now()` on the tick) so the finished/running branches are unit-tested.
 */
export function toolDurationLabel(t: Extract<Block, { kind: "tool" }>, now: number): string {
  if (t.elapsedMs !== undefined) return t.elapsedMs >= 2000 ? `${(t.elapsedMs / 1000).toFixed(1)}s` : "";
  if (!t.done && t.startedAt !== undefined) {
    const live = now - t.startedAt;
    return live >= 2000 ? `${Math.round(live / 1000)}s` : "";
  }
  return "";
}

/** The first non-empty line of a (possibly multi-line) string, for one-line summaries. */
export function firstLine(s: string | undefined): string | undefined {
  const line = s?.split("\n").find((l) => l.trim().length > 0)?.trim();
  return line || undefined;
}

/** Truncate to `n` display CELLS with an ellipsis. Cell-aware (a CJK/emoji
 * glyph counts 2, so the cut lands inside the column, not past it) and
 * code-point-safe — the old `.slice(0, n - 1)` cut UTF-16 units and could
 * strand half a surrogate pair mid-label. */
export function truncate(s: string, n: number): string {
  return truncateWidth(s, n);
}
