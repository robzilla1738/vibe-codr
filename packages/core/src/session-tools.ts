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
      "Search long-term memory — saved facts/decisions and past vibe-codr sessions — for relevant prior context. Use this when the user references earlier work, asks 'what did we decide', or you need context beyond the current conversation.",
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
  scope?: "project" | "global";
  tags?: string[];
}> {
  const memory = handle.deps.memory;
  return {
    name: "save_memory",
    description:
      "Persist a durable fact, decision, or user preference to long-term memory so future sessions can recall it (architecture choices, conventions, gotchas, stable preferences). Use sparingly — not for transient task state, which the task list already tracks. Choose scope: 'project' for this repo, 'global' for things true across all the user's projects.",
    inputSchema: z.object({
      fact: z.string().min(1).describe("The fact to remember, as one concise self-contained statement."),
      scope: z.enum(["project", "global"]).optional().describe("project (this repo, default) or global (all projects)."),
      tags: z.array(z.string()).optional().describe("Optional tags for grouping."),
    }),
    readOnly: false,
    concurrencySafe: false,
    execute: async ({ fact, scope, tags }) => {
      if (!memory) {
        return { output: "Memory is not available in this session.", isError: true };
      }
      const path = await memory.save({ fact, ...(scope ? { scope } : {}), ...(tags ? { tags } : {}) });
      return { output: `Saved to ${path}. It will surface via recall_memory when relevant.` };
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

/** Build the per-session `update_tasks` tool (closes over this session). */
export function buildTasksTool(handle: SessionToolsHandle): ToolDefinition<{
  tasks: { title: string; status: TaskStatus }[];
}> {
  const Task = z.object({
    title: z.string().describe("Short imperative description of the task."),
    status: z
      .enum(["pending", "in_progress", "completed"])
      .describe("Exactly one task should be in_progress at a time."),
  });
  return {
    name: "update_tasks",
    description:
      "Record and update your working task list for a multi-step request. " +
      "Pass the COMPLETE list every time (it replaces the previous one). " +
      "Keep exactly one task in_progress, mark tasks completed as you finish " +
      "them, and add new tasks as they emerge. Use this to plan and to show " +
      "the user live progress on non-trivial work.",
    inputSchema: z.object({ tasks: z.array(Task) }),
    readOnly: true,
    concurrencySafe: false,
    execute: async ({ tasks }) => {
      const updated = handle.setTasks(tasks);
      const done = updated.filter((t) => t.status === "completed").length;
      return { output: `Task list updated (${done}/${updated.length} complete).` };
    },
  };
}
