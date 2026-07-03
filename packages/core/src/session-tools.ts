import { z } from "zod";
import type { CheckName, Task, TaskStatus, ToolDefinition } from "@vibe/shared";
import { searchSessions, formatRecall } from "./recall.ts";
import { formatMemoryHits } from "./memory-search.ts";
import { formatNotes } from "./blackboard.ts";
import { bunExec } from "./build/exec.ts";
import { formatCheckResult, parseCheckOutput } from "./build/check.ts";
import type { SessionDeps } from "./session.ts";

/**
 * The slice of a `Session` the leaf tool factories depend on. Each `buildXTool`
 * closes over this handle instead of the whole Session, so the tools stay decoupled
 * from the conversation machinery: they read the session id/depth, its deps
 * (cwd, skills, memory, blackboard), and — for `update_tasks` — replace the
 * working task list via `setTasks`.
 */
export interface SessionToolsHandle {
  readonly id: string;
  readonly depth: number;
  readonly deps: SessionDeps;
  /** Replace the working task list (emits `tasks-updated`). */
  setTasks(incoming: { title: string; status: TaskStatus }[]): Task[];
  /** Patch task statuses by 1-based position (`t<N>`) and append new tasks. */
  patchTasks(
    updates: { index: number; status: TaskStatus }[],
    add?: string[],
  ): { tasks: Task[]; applied: number; ignored: number[] };
}

/** Cap on the SKILL.md body injected by `use_skill` — a skill body lands in the
 * prompt verbatim, so a multi-thousand-line catalog would blow the context window
 * and 400 the turn. Same head-cap discipline as read/edit/spawn_subagent (matches
 * the memory-injection cap). The model gets the head + a pointer to the full file. */
export const MAX_SKILL_BODY = 32 * 1024;

/** Build the `use_skill` tool that loads a skill's full body into context. */
export function buildUseSkillTool(handle: SessionToolsHandle): ToolDefinition<{ name: string }> {
  const skills = handle.deps.skills;
  return {
    name: "use_skill",
    description:
      "Load the full instructions for a named skill before performing a task it applies to. Call this when a listed skill is relevant.",
    inputSchema: z.object({
      name: z.string().describe("The skill name to load."),
    }),
    readOnly: true,
    execute: async ({ name }) => {
      const skill = skills?.get(name);
      if (!skill) {
        return { output: `Unknown skill "${name}".`, isError: true };
      }
      const body = await skill.load();
      const capped =
        body.length > MAX_SKILL_BODY
          ? `${body.slice(0, MAX_SKILL_BODY)}\n\n…(skill body truncated at ${MAX_SKILL_BODY} chars — read the full file at ${skill.dir}/SKILL.md for the rest)`
          : body;
      return { output: `# Skill: ${skill.name}\n\n${capped}` };
    },
  };
}

/** Build the read-only `recall_memory` tool: hybrid search over saved memory +
 * past sessions when a MemoryService is wired; lexical session search otherwise. */
export function buildRecallTool(handle: SessionToolsHandle): ToolDefinition<{ query: string; limit?: number }> {
  const cwd = handle.deps.cwd;
  const selfId = handle.id;
  const memory = handle.deps.memory;
  return {
    name: "recall_memory",
    description:
      "Search long-term memory — saved facts/decisions and past vibe-codr sessions — for relevant prior context. Use this when the user references earlier work, asks 'what did we decide', before re-deriving a past decision, or to check what's already known before saving a memory.",
    inputSchema: z.object({
      query: z.string().min(1).describe("What to look for in saved memory and past sessions."),
      limit: z.number().int().positive().max(20).optional().describe("Max matches (default 8)."),
    }),
    readOnly: true,
    concurrencySafe: true,
    execute: async ({ query, limit }) => {
      // Defense in depth against an empty query the schema would already reject:
      // an all-whitespace query has no lexical/semantic signal — return nothing
      // rather than arbitrary nearest-neighbours.
      if (!query.trim()) return { output: "No query provided." };
      if (memory) {
        const hits = await memory.search(query, limit ?? 8);
        return { output: formatMemoryHits(query, hits) };
      }
      const hits = await searchSessions(cwd, query, {
        excludeId: selfId,
        ...(limit ? { limit } : {}),
      });
      return { output: formatRecall(query, hits) };
    },
  };
}

/** Build the `save_memory` write tool: persist a durable fact to long-term
 * memory (permission-gated, since it writes a file). */
export function buildSaveMemoryTool(handle: SessionToolsHandle): ToolDefinition<{
  fact: string;
  scope?: "project" | "global" | "user";
  tags?: string[];
}> {
  const memory = handle.deps.memory;
  return {
    name: "save_memory",
    description:
      "Persist a durable fact to long-term memory so future sessions know it. Save the moment you learn something durable: a decision AND its rationale ('chose X over Y because …'), a hard-won gotcha the code doesn't record, a stable user preference or correction. NOT for transient task state (the task list tracks it), facts derivable from the code or git history, or secrets/credentials. One concise, self-contained fact per call; an equivalent already-saved fact is detected and skipped, so saving when unsure is safe.",
    inputSchema: z.object({
      fact: z.string().min(1).describe("The fact to remember, as one concise self-contained statement (include the why for decisions)."),
      scope: z
        .enum(["project", "global", "user"])
        .optional()
        .describe(
          "project (this repo, default) · global (true across all the user's projects, recalled on demand) · user (a stable preference or fact about the USER — auto-loaded into every future session's prompt; reserve for durable how-they-work preferences).",
        ),
      tags: z.array(z.string()).optional().describe("Optional tags for grouping."),
    }),
    readOnly: false,
    concurrencySafe: false,
    execute: async ({ fact, scope, tags }) => {
      if (!memory) {
        return { output: "Memory is not available in this session.", isError: true };
      }
      const saved = await memory.save({ fact, ...(scope ? { scope } : {}), ...(tags ? { tags } : {}) });
      if (saved.deduped) {
        return { output: `Already known — an equivalent memory exists in ${saved.path}; skipped the duplicate.` };
      }
      if (scope === "user") {
        const base = `Saved to ${saved.path} — loaded into every future session automatically.`;
        // Don't claim the whole file is injected when it's over the budget: the cap
        // keeps only the newest bullets, so say so and point at pruning.
        return {
          output: saved.overBudget
            ? `${base} Note: USER.md now exceeds the injection budget, so only the newest preferences are injected — prune older bullets so none are dropped.`
            : base,
        };
      }
      return {
        output: `Saved to ${saved.path}. It will surface via recall_memory when relevant.`,
      };
    },
  };
}

const NOTE_KINDS = ["claim", "decision", "conflict", "info"] as const;

/** Build the `post_note` tool: share a coordination note with sibling agents. */
export function buildPostNoteTool(
  handle: SessionToolsHandle,
): ToolDefinition<{ note: string; kind?: (typeof NOTE_KINDS)[number] }> {
  const board = handle.deps.blackboard;
  const from = handle.depth === 0 ? "lead" : `sub:${handle.id.slice(-4)}`;
  return {
    name: "post_note",
    description:
      "Share a short coordination note with the other agents working in parallel. Other agents see it via read_notes. Keep it terse and factual.",
    inputSchema: z.object({
      note: z.string().min(1).describe("The note to share (one short factual line)."),
      kind: z
        .enum(NOTE_KINDS)
        .optional()
        .describe(
          "claim = a file/area you're taking; decision = a settled choice others must respect; conflict = a disagreement needing the lead; info = an incidental fact (default).",
        ),
    }),
    readOnly: true,
    concurrencySafe: true,
    execute: async ({ note, kind }) => {
      if (!board) return { output: "No shared board in this session.", isError: true };
      board.post(from, note, kind);
      return { output: "Posted to the shared board." };
    },
  };
}

/** Build the `read_notes` tool: read what sibling agents have shared. */
export function buildReadNotesTool(
  handle: SessionToolsHandle,
): ToolDefinition<{ limit?: number; kind?: (typeof NOTE_KINDS)[number] }> {
  const board = handle.deps.blackboard;
  return {
    name: "read_notes",
    description:
      "Read the coordination notes other parallel agents have shared (decisions, claimed files, conflicts). Check this before and during delegated work to avoid duplicating or contradicting a sibling.",
    inputSchema: z.object({
      limit: z.number().int().positive().max(100).optional().describe("Max recent notes (default all)."),
      kind: z
        .enum(NOTE_KINDS)
        .optional()
        .describe("Only notes of this kind (claim / decision / conflict / info). Default: all kinds."),
    }),
    readOnly: true,
    concurrencySafe: true,
    execute: async ({ limit, kind }) => {
      if (!board) return { output: "No shared board in this session." };
      return { output: formatNotes(board.read(limit, kind)) };
    },
  };
}

const CHECK_NAMES = ["build", "typecheck", "test", "lint", "install"] as const;

/** Build the `run_check` tool: run one of the repo's DETECTED commands and
 * return a compact parsed verdict (`PASS 142/142` / `FAIL 3/142` + first
 * failures) instead of raw log spew — one step to a verdict, not twenty.
 * Only offered when recon found commands; side-effecting (tests/builds touch
 * the workspace), so it rides the permission gate like bash. */
export function buildRunCheckTool(handle: SessionToolsHandle): ToolDefinition<{
  check: CheckName;
  timeoutSec?: number;
}> {
  return {
    name: "run_check",
    description:
      "Run one of this repo's real, detected commands (build / typecheck / test / lint / install) " +
      "and get a compact parsed verdict — PASS/FAIL with counts and the first failures — instead of " +
      "a raw log. ALWAYS prefer this over invoking build/test commands through bash: it runs the " +
      "command the repo actually uses and costs one step to read.",
    inputSchema: z.object({
      check: z.enum(CHECK_NAMES).describe("Which detected check to run."),
      timeoutSec: z
        .number()
        .int()
        .positive()
        .max(1800)
        .optional()
        .describe("Wall-clock cap in seconds (default 600)."),
    }),
    readOnly: false,
    concurrencySafe: false,
    execute: async ({ check, timeoutSec }, ctx) => {
      const command = handle.deps.repoProfile?.commands[check];
      if (!command) {
        const known = Object.keys(handle.deps.repoProfile?.commands ?? {});
        return {
          output:
            `No ${check} command was detected for this repo` +
            (known.length ? ` (detected: ${known.join(", ")}).` : " (no commands detected at all)."),
          isError: true,
        };
      }
      const started = Date.now();
      const r = await bunExec()(command, {
        cwd: ctx.cwd,
        timeoutSec: timeoutSec ?? 600,
        signal: ctx.abortSignal,
      });
      const parsed = parseCheckOutput(check, r.out, r.code);
      return {
        output: formatCheckResult(check, command, parsed, ((Date.now() - started) / 1000).toFixed(1)),
        ...(parsed.pass ? {} : { isError: true }),
      };
    },
  };
}

/** Parse a task reference the model may spell as `"t3"`, `"3"`, or `3` into a
 * 1-based position. Returns undefined for anything unparseable. */
export function parseTaskRef(ref: string | number): number | undefined {
  if (typeof ref === "number") return Number.isInteger(ref) && ref > 0 ? ref : undefined;
  const m = /^t?(\d+)$/i.exec(ref.trim());
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Build the per-session `update_tasks` tool (closes over this session).
 *
 * Two shapes, one tool:
 * - `updates`/`add` — the PRIMARY, id-addressed form: flip one task's status by
 *   its `t<N>` id (shown in CURRENT TASKS) without re-sending the list. Partial
 *   updates are what weak models actually manage to do mid-execution; the old
 *   replace-the-whole-list-by-verbatim-title contract silently desynced the
 *   moment a model reworded a title.
 * - `tasks` — the legacy full-list replace, kept for laying out a fresh list
 *   (and for anything still speaking the old shape).
 */
export function buildTasksTool(handle: SessionToolsHandle): ToolDefinition<{
  tasks?: { title: string; status: TaskStatus }[];
  updates?: { id: string | number; status: TaskStatus }[];
  add?: string[];
}> {
  const Status = z
    .enum(["pending", "in_progress", "completed"])
    .describe("Exactly one task should be in_progress at a time.");
  const TaskItem = z.object({
    title: z.string().describe("Short imperative description of the task."),
    status: Status,
  });
  const Update = z.object({
    id: z
      .union([z.string(), z.number()])
      .describe('Task id as shown in CURRENT TASKS — "t3" (or just 3).'),
    status: Status,
  });
  return {
    name: "update_tasks",
    description:
      "Update your working task list. PREFERRED: pass `updates` with the task ids " +
      'from CURRENT TASKS to change statuses — e.g. {"updates":[{"id":"t2","status":"in_progress"}]} ' +
      "— and `add` to append new task titles. Mark a task in_progress when you start it and " +
      "completed the moment you verify it, keeping exactly one in_progress. To lay out a brand-new " +
      "list, pass `tasks` (the complete list; it replaces any previous one). Use this on every " +
      "non-trivial multi-step request — it shows the user live progress.",
    inputSchema: z.object({
      tasks: z.array(TaskItem).optional().describe("Full replacement list (new plans only)."),
      updates: z.array(Update).optional().describe("Status changes by task id (preferred)."),
      add: z.array(z.string()).optional().describe("New task titles to append as pending."),
    }),
    readOnly: true,
    concurrencySafe: false,
    execute: async ({ tasks, updates, add }) => {
      if (tasks?.length) {
        const updated = handle.setTasks(tasks);
        const done = updated.filter((t) => t.status === "completed").length;
        return { output: `Task list updated (${done}/${updated.length} complete).` };
      }
      if (!updates?.length && !add?.length) {
        return {
          output:
            "Nothing to do — pass `updates` (status changes by id), `add` (new titles), or `tasks` (a full new list).",
          isError: true,
        };
      }
      const parsed: { index: number; status: TaskStatus }[] = [];
      const bad: (string | number)[] = [];
      for (const u of updates ?? []) {
        const index = parseTaskRef(u.id);
        if (index === undefined) bad.push(u.id);
        else parsed.push({ index, status: u.status });
      }
      const { tasks: all, ignored } = handle.patchTasks(parsed, add ?? []);
      const done = all.filter((t) => t.status === "completed").length;
      const problems = [
        ...bad.map((b) => `unparseable id "${b}"`),
        ...ignored.map((i) => `t${i} does not exist`),
      ];
      return {
        output:
          `Task list updated (${done}/${all.length} complete).` +
          (problems.length ? ` Ignored: ${problems.join(", ")}.` : ""),
      };
    },
  };
}
