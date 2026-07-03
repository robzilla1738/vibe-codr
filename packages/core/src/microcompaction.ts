import { readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ModelMessage } from "ai";

/**
 * Mid-turn context management (Claude-Code-style microcompaction): when a long
 * agentic turn fills the window with bulky tool results, the oldest/superseded
 * results are OFFLOADED — full text written to a session artifact on disk (an
 * ABSOLUTE path under the project's global state dir), replaced in the prompt by
 * a short preview plus that path to `read` the rest.
 * Lossless-ish and retrievable, unlike summarization; it runs FIRST (at a lower
 * threshold), with the LLM summarizer remaining the between-turn last resort.
 *
 * Everything here is pure over ModelMessage[] (unit-testable like compaction.ts);
 * the session owns the disk writes and the prepareStep wiring. Only `role:"tool"`
 * messages are ever touched, so the alternation / tool-boundary invariants that
 * compaction.ts protects are structurally safe, and untouched messages keep
 * their identity (the orphan-rollback check in Session.run depends on it).
 */

/** Leading marker of an offloaded preview (drives idempotence detection).
 * Distinctive on purpose: a legitimate result starting with a plain "[" (a
 * JSON array) must still be offloadable. */
export const OFFLOAD_SENTINEL = "[vibecodr:offloaded ";

export interface OffloadRecord {
  /** ABSOLUTE artifact path holding the full result text (under the project's
   * global state dir), so the `read`-back pointer resolves independent of cwd. */
  path: string;
  toolName: string;
  fullChars: number;
}

export interface ToolResultRef {
  callId: string;
  toolName: string;
  /** Input the originating tool-call carried (for supersession analysis). */
  input: unknown;
  /** Extractable text length of the result. */
  chars: number;
  /** Index of the containing message in the scanned array. */
  messageIndex: number;
}

interface ToolResultPartLike {
  type: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: { type?: string; value?: unknown };
}

/** The extractable text of a tool-result output (json rendered compactly). */
export function resultText(output: { type?: string; value?: unknown } | undefined): string {
  if (!output) return "";
  const v = output.value;
  if (typeof v === "string") return v;
  if (output.type === "content" && Array.isArray(v)) {
    return v
      .map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : ""))
      .join("\n");
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Walk messages, correlating each tool RESULT with its originating tool-call
 * (by toolCallId in the preceding assistant messages) to recover the input —
 * needed to tell "a later read of the same file supersedes this one". */
export function classifyToolResults(messages: ModelMessage[]): ToolResultRef[] {
  const inputs = new Map<string, { toolName: string; input: unknown }>();
  const out: ToolResultRef[] = [];
  for (const [i, m] of messages.entries()) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const part of m.content as ToolResultPartLike[]) {
        if (part?.type === "tool-call" && part.toolCallId) {
          inputs.set(part.toolCallId, { toolName: part.toolName ?? "tool", input: part.input });
        }
      }
    }
    if (m.role === "tool" && Array.isArray(m.content)) {
      for (const part of m.content as ToolResultPartLike[]) {
        if (part?.type !== "tool-result" || !part.toolCallId) continue;
        const call = inputs.get(part.toolCallId);
        out.push({
          callId: part.toolCallId,
          toolName: part.toolName ?? call?.toolName ?? "tool",
          input: call?.input,
          chars: resultText(part.output).length,
          messageIndex: i,
        });
      }
    }
  }
  return out;
}

/** The file path a read-like tool call targets, when it has one. Canonicalized
 * (when a canonicalizer is supplied) so an absolute-path read and a later
 * relative-path edit of the SAME file are recognized as the same path — without
 * it, supersession silently misses across path spellings. */
function targetPath(ref: ToolResultRef, canonicalize?: (p: string) => string): string | undefined {
  const input = ref.input as { path?: unknown } | undefined;
  const p = input && typeof input === "object" ? input.path : undefined;
  if (typeof p !== "string") return undefined;
  return canonicalize ? canonicalize(p) : p;
}

/** Slice a preview to at most `n` UTF-16 code units WITHOUT splitting a
 * surrogate pair — a lone surrogate serializes to an invalid string some
 * providers reject. Backs off one unit when the cut lands mid-pair. */
function surrogateSafeSlice(s: string, n: number): string {
  if (n <= 0 || n >= s.length) return s.slice(0, Math.max(0, n));
  const code = s.charCodeAt(n - 1);
  // A high surrogate (0xD800–0xDBFF) at the last kept position pairs with the
  // dropped next unit — drop it too rather than emit a lone half.
  const end = code >= 0xd800 && code <= 0xdbff ? n - 1 : n;
  return s.slice(0, end);
}

const READ_LIKE = new Set(["read", "ls", "grep", "glob"]);
const WRITE_LIKE = new Set(["read", "edit", "write"]);

export interface PlanOptions {
  /** Results at or above this size are offload-eligible. */
  maxResultBytes: number;
  /** Never offload the most recent N tool results (the live working set). */
  keepLiveResults: number;
  /** Chars the plan should free (the caller derives this from context fill). */
  targetChars: number;
  /** Call ids already offloaded (skip re-planning them). */
  existing: ReadonlySet<string>;
  /** Canonicalize a tool-call path (e.g. resolve against cwd) so supersession
   * matches across absolute/relative spellings of the same file. Identity when
   * omitted (keeps planOffloads pure/testable without a filesystem). */
  canonicalize?: (p: string) => string;
  /** Chars each offloaded result KEEPS inline (the preview). Subtracted from a
   * victim's credited free, since offloading a result doesn't remove it whole —
   * a preview stays. Without this the planner over-credits every pick and stops
   * early, freeing less than `targetChars`. Defaults to 0 (whole-result credit). */
  previewChars?: number;
}

/**
 * Choose offload victims, in priority order: (1) superseded reads — a
 * read/ls/grep result for a path that a LATER read/edit/write also targets
 * (the old view is stale by construction); then (2) oldest-first among the
 * remaining bulky results. Stops once `targetChars` is covered.
 */
export function planOffloads(messages: ModelMessage[], opts: PlanOptions): ToolResultRef[] {
  const refs = classifyToolResults(messages);
  const liveCutoff = Math.max(0, refs.length - opts.keepLiveResults);
  const eligible = refs
    .slice(0, liveCutoff)
    .filter((r) => r.chars >= opts.maxResultBytes && !opts.existing.has(r.callId));
  if (!eligible.length) return [];

  // Last position any path is touched by a read/write-like call — an earlier
  // read-like result for that path is superseded.
  const lastTouch = new Map<string, number>();
  refs.forEach((r, i) => {
    const p = targetPath(r, opts.canonicalize);
    if (p && WRITE_LIKE.has(r.toolName)) lastTouch.set(p, i);
  });
  const isSuperseded = (r: ToolResultRef): boolean => {
    const p = targetPath(r, opts.canonicalize);
    if (!p || !READ_LIKE.has(r.toolName)) return false;
    const last = lastTouch.get(p);
    return last !== undefined && last > refs.indexOf(r);
  };

  const ordered = [
    ...eligible.filter(isSuperseded),
    ...eligible.filter((r) => !isSuperseded(r)),
  ];
  // Offloading a result leaves a preview (+ a short note) inline, so the actual
  // reduction is the result MINUS what stays — credit that, not the whole result,
  // or the planner stops early and the step can remain over threshold.
  const preview = Math.max(0, opts.previewChars ?? 0);
  const picked: ToolResultRef[] = [];
  let freed = 0;
  for (const r of ordered) {
    if (freed >= opts.targetChars) break;
    picked.push(r);
    freed += Math.max(0, r.chars - preview);
  }
  return picked;
}

/**
 * Return a new message array where each tool result in `offloaded` is replaced
 * by a preview + retrieval note. Pure and idempotent; messages without an
 * offloaded result are returned BY REFERENCE (identity preserved). Only
 * `role:"tool"` messages are rebuilt.
 */
export function applyOffloads(
  messages: ModelMessage[],
  offloaded: ReadonlyMap<string, OffloadRecord>,
  previewChars: number,
): ModelMessage[] {
  if (!offloaded.size) return messages;
  let changed = false;
  const next = messages.map((m) => {
    if (m.role !== "tool" || !Array.isArray(m.content)) return m;
    const parts = m.content as ToolResultPartLike[];
    if (!parts.some((p) => p?.type === "tool-result" && p.toolCallId && offloaded.has(p.toolCallId))) {
      return m;
    }
    changed = true;
    const rebuilt = parts.map((p) => {
      if (p?.type !== "tool-result" || !p.toolCallId) return p;
      const rec = offloaded.get(p.toolCallId);
      if (!rec) return p;
      const full = resultText(p.output);
      // Idempotence: an already-offloaded preview carries the sentinel — never
      // re-wrap it (the note itself can exceed previewChars).
      if (full.length <= previewChars || full.startsWith(OFFLOAD_SENTINEL)) return p;
      const note =
        `${OFFLOAD_SENTINEL}${rec.toolName} result: full ${rec.fullChars} chars saved to ${rec.path} — ` +
        `read that path if you need the rest (it may exceed one read; use offset/limit to page). Preview:]\n${surrogateSafeSlice(full, previewChars)}`;
      return { ...p, output: { type: "text", value: note } };
    });
    return { ...m, content: rebuilt } as ModelMessage;
  });
  return changed ? next : messages;
}

/**
 * Enforce a per-session byte budget over an offload artifact directory: when the
 * total exceeds `capBytes`, evict oldest-first the files whose absolute path is
 * NOT in `livePaths` (the working set the current process still points at).
 * Evicted artifacts' previews remain in the transcript — only the re-readable
 * full text is reclaimed. Returns the number of files removed. Pure w.r.t. the
 * caller: all fs errors are swallowed (best-effort reclamation).
 */
export function pruneArtifacts(dir: string, capBytes: number, livePaths: ReadonlySet<string>): number {
  if (!capBytes || capBytes <= 0) return 0;
  let entries: { path: string; size: number; mtimeMs: number }[];
  try {
    entries = readdirSync(dir).map((name) => {
      const p = join(dir, name);
      const st = statSync(p);
      return { path: p, size: st.size, mtimeMs: st.mtimeMs };
    });
  } catch {
    return 0;
  }
  let total = entries.reduce((n, e) => n + e.size, 0);
  if (total <= capBytes) return 0;
  const evictable = entries.filter((e) => !livePaths.has(e.path)).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let removed = 0;
  for (const e of evictable) {
    if (total <= capBytes) break;
    try {
      rmSync(e.path, { force: true });
      total -= e.size;
      removed++;
    } catch {
      /* a file we can't remove just stays — best-effort */
    }
  }
  return removed;
}
