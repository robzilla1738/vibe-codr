import type { EngineClient, SessionUsage, Task, UIEvent } from "@vibe/shared";
import { ansi } from "./ansi.ts";
import { GLYPH } from "./glyphs.ts";
import { toolLabel } from "./tool-icons.ts";

/**
 * Compact "12.3k tok · $0.0421" usage label. Cost is always shown so any
 * provider/model reports something real: `$0.00` for a free/local model, and a
 * `~$` prefix when the price is an estimate (a base-model catalog fallback).
 */
export function formatUsage(u: SessionUsage): string {
  const tok = fmtCount(u.totalTokens);
  const prefix = u.costEstimated ? "~$" : "$";
  const digits = u.costUSD === 0 ? 2 : u.costUSD < 1 ? 4 : 2;
  const cost = ` · ${prefix}${u.costUSD.toFixed(digits)}`;
  // Format the cached count like the total (`1.1k`, not `1100`) so the footer
  // reads uniformly.
  const cached =
    u.cachedInputTokens && u.cachedInputTokens > 0
      ? ` · ${fmtCount(u.cachedInputTokens)} cached`
      : "";
  return `${tok} tok${cost}${cached}`;
}

/** Compact token count: `1.5k` at ≥1000, the raw number below. */
function fmtCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/** Status → checklist glyph, shared by the headless printer and the OpenTUI app. */
export const TASK_GLYPH: Record<Task["status"], string> = {
  completed: "✔",
  in_progress: "▶",
  pending: "○",
};

/**
 * Window `tasks` to at most `max` visible rows WITHOUT hiding the active work:
 * when the list overflows, completed tasks before the first unfinished one
 * collapse into a leading `lead` count (rendered as one "✔ N done" line) so the
 * in-progress task is always on screen — a 20-task run used to show only its
 * first 8 (all completed) rows. `trailing` counts tasks cut after the window.
 */
export function windowTasks(
  tasks: Task[],
  max: number,
): { lead: number; visible: Task[]; trailing: number } {
  if (tasks.length <= max) return { lead: 0, visible: tasks, trailing: 0 };
  const firstActive = tasks.findIndex((t) => t.status !== "completed");
  // Start at the first unfinished task, backing off so the window stays full
  // when the tail is short (all-completed lists show their last `max`).
  const start = Math.max(0, Math.min(firstActive === -1 ? tasks.length : firstActive, tasks.length - max));
  return {
    lead: start,
    visible: tasks.slice(start, start + max),
    trailing: Math.max(0, tasks.length - start - max),
  };
}

/** Render the task list as an indented checklist. */
export function formatTasks(tasks: Task[]): string {
  if (!tasks.length) return "";
  const lines = tasks.map((t) => {
    const glyph = TASK_GLYPH[t.status];
    const color =
      t.status === "completed"
        ? ansi.green
        : t.status === "in_progress"
          ? ansi.cyan
          : ansi.dim;
    const title = t.status === "completed" ? ansi.dim(t.title) : t.title;
    return `  ${color(glyph)} ${title}`;
  });
  const done = tasks.filter((t) => t.status === "completed").length;
  return `${ansi.dim(`Tasks · ${done}/${tasks.length}`)}\n${lines.join("\n")}`;
}

/** Colorize a unified diff: green additions, red deletions, dim context. */
export function formatDiff(diff: string): string {
  if (!diff) return "";
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+")) return ansi.green(line);
      if (line.startsWith("-")) return ansi.red(line);
      if (line === "…") return ansi.dim(line);
      return ansi.dim(line);
    })
    .join("\n");
}

export interface HeadlessOptions {
  /** Print reasoning deltas (default false). */
  showReasoning?: boolean;
  /** Print tool activity to stderr (default true). */
  showTools?: boolean;
  /** Output format for one-shot mode: streamed text (default) or a JSON object. */
  outputFormat?: "text" | "json";
  /** Single-prompt `-p` run: suppress interactive hints ("approve with
   * /execute") that nothing can act on once the process exits. */
  oneShot?: boolean;
}

/** The machine-readable result of a one-shot run (`--output-format json`). */
export interface OneShotResult {
  sessionId: string;
  model: string;
  mode: string;
  text: string;
  usage: SessionUsage;
  error?: string;
}

/** Serialize a one-shot result as a stable, pretty JSON document. */
export function formatJsonResult(result: OneShotResult): string {
  return JSON.stringify(result, null, 2);
}

/** Render a single event. Assistant text -> stdout; meta -> stderr. */
function render(event: UIEvent, opts: HeadlessOptions): void {
  switch (event.type) {
    case "assistant-text-delta":
      process.stdout.write(event.delta);
      break;
    case "reasoning-delta":
      if (opts.showReasoning) process.stderr.write(ansi.dim(event.delta));
      break;
    case "tool-call-started":
      if (opts.showTools !== false) {
        process.stderr.write(`\n${ansi.cyan(toolLabel(event.toolName, event.input))}\n`);
      }
      break;
    case "tool-call-finished":
      if (opts.showTools !== false && event.isError) {
        process.stderr.write(`${ansi.red("✗ tool error")}\n`);
      }
      break;
    case "file-changed":
      if (opts.showTools !== false) {
        const verb = event.action === "write" ? "wrote" : "edited";
        const summary = `${ansi.green(`+${event.added}`)} ${ansi.red(`-${event.removed}`)}`;
        process.stderr.write(
          `${ansi.cyan(GLYPH.file)} ${ansi.bold(`${verb} ${event.path}`)} ${summary}\n`,
        );
        if (event.diff) process.stderr.write(`${formatDiff(event.diff)}\n`);
      }
      break;
    case "compacted":
      process.stderr.write(
        `${ansi.dim(`(compacted history, freed ~${event.freedTokens} tokens)`)}\n`,
      );
      break;
    case "checkpoint-restored":
      process.stderr.write(
        `${ansi.green(GLYPH.revert)} ${ansi.dim(`reverted: ${event.label}`)}\n`,
      );
      break;
    case "verify-started":
      process.stderr.write(
        `\n${ansi.cyan(GLYPH.check)} ${ansi.dim(`verifying: ${event.command}`)}\n`,
      );
      break;
    case "verify-finished":
      process.stderr.write(
        event.ok
          ? `${ansi.green("✓ verification passed")}\n`
          : `${ansi.red("✗ verification failed")}\n`,
      );
      break;
    case "loop-tick":
      process.stderr.write(
        `\n${ansi.cyan(GLYPH.loopTick)} ${ansi.dim(`loop iteration ${event.iteration}`)}\n`,
      );
      break;
    case "loop-stopped":
      process.stderr.write(`${ansi.cyan(GLYPH.loopStop)} ${ansi.dim(`loop ${event.reason}`)}\n`);
      break;
    case "subagent-started":
      process.stderr.write(
        `\n${ansi.magenta(GLYPH.subagentIn)} ${ansi.dim(`subagent ${event.subagentId.slice(-6)}: ${truncate(event.prompt, 80)}`)}\n`,
      );
      break;
    case "subagent-finished":
      process.stderr.write(
        `${ansi.magenta(GLYPH.subagentOut)} ${ansi.dim(`subagent ${event.subagentId.slice(-6)} done`)}\n`,
      );
      break;
    case "plan-presented": {
      // The hint matches what /execute actually does now (arms the handoff; the
      // NEXT message starts implementation) — and is suppressed in a one-shot
      // run, where the process exits and nothing can act on it.
      const hint = opts.oneShot
        ? ""
        : `${ansi.dim(
            "Approve with /execute — your next message starts implementation. Or reply to refine the plan.",
          )}\n`;
      process.stdout.write(`\n${ansi.magenta(ansi.bold("── Plan ──"))}\n${event.plan}\n${hint}`);
      break;
    }
    case "tasks-updated":
      if (event.tasks.length) process.stderr.write(`\n${formatTasks(event.tasks)}\n`);
      break;
    case "queue-changed":
      // Only surface a backlog (type-ahead); the active item is shown elsewhere.
      if (event.pending.length) {
        process.stderr.write(
          `${ansi.dim(
            `${GLYPH.queue} ${event.pending.length} queued: ${event.pending
              .map((p) => p.label)
              .join(", ")}`,
          )}\n`,
        );
      }
      break;
    case "notice":
      process.stderr.write(
        `${noticeColor(event.level)(`[${event.level}] ${event.message}`)}\n`,
      );
      break;
    case "engine-error":
      process.stderr.write(`${ansi.red(`error: ${event.message}`)}\n`);
      break;
    // `usage-updated` is tracked by the drivers and shown as a per-turn footer
    // rather than printed on every step (which would be noisy). `subagent-activity`
    // is likewise a high-frequency live signal (the TUI's Subagents panel consumes
    // it): too chatty for this line-per-milestone log, so it's intentionally dropped
    // here while `subagent-started`/`-finished` still print the milestones.
    default:
      break;
  }
}

function noticeColor(level: "info" | "warn" | "error") {
  return level === "error" ? ansi.red : level === "warn" ? ansi.yellow : ansi.dim;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Drive the engine for a single prompt and print until the turn ends.
 * Used by `vibe -p "..."` (one-shot / pipeable) mode.
 */
export async function runOneShot(
  engine: EngineClient,
  prompt: string,
  opts: HeadlessOptions = {},
): Promise<boolean> {
  opts = { ...opts, oneShot: true };
  const json = opts.outputFormat === "json";
  const events = engine.events();
  engine.send({ type: "submit-prompt", text: prompt });
  let usage: SessionUsage | undefined;
  let text = "";
  let error: string | undefined;
  for await (const event of events) {
    if (event.type === "usage-updated") usage = event.usage;
    // In JSON mode, accumulate the answer silently instead of streaming it; in
    // text mode, render events as they arrive (the existing behaviour).
    if (event.type === "assistant-text-delta") text += event.delta;
    // A plan-mode turn's output IS the presented plan (delivered via
    // plan-presented, not assistant-text-delta), so capture it too — otherwise a
    // headless `--mode plan --output-format json` run returns empty text and the
    // plan is silently lost. Text mode already renders it to stdout.
    if (event.type === "plan-presented") text += (text ? "\n\n" : "") + event.plan;
    if (event.type === "engine-error") error = event.message;
    if (!json) render(event, opts);
    // Stop on `engine-idle` — the queue is FULLY drained, i.e. the prompt AND
    // every follow-up turn it spawned (gate-fix / review-fix / verify-fix) are
    // done. Breaking on the per-turn `session-idle` (the old behaviour) cut off
    // that follow-up output and let the CLI's finalize() race the in-flight turn.
    // `engine-idle` always fires at drain end — even after an engine-error, and
    // even for a pre-run-loop failure (unreadable @mention / corrupt checkpoint)
    // whose session never emits `session-idle` — so this can't hang.
    if (event.type === "engine-idle") break;
  }

  const finalUsage = usage ?? emptyUsage();
  if (json) {
    const snap = engine.snapshot();
    process.stdout.write(
      `${formatJsonResult({
        sessionId: snap.sessionId,
        model: snap.model,
        mode: snap.mode,
        text: text.trim(),
        usage: finalUsage,
        ...(error ? { error } : {}),
      })}\n`,
    );
    return error === undefined;
  }

  process.stdout.write("\n");
  if (finalUsage.totalTokens > 0) {
    process.stderr.write(`${ansi.dim(formatUsage(finalUsage))}\n`);
  }
  // false → the caller exits non-zero (scripting/CI correctness).
  return error === undefined;
}

function emptyUsage(): SessionUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 };
}

/** Continuously print events (used by the REPL). Never resolves. */
export async function renderHeadless(
  engine: EngineClient,
  opts: HeadlessOptions = {},
): Promise<void> {
  let usage: SessionUsage | undefined;
  for await (const event of engine.events()) {
    if (event.type === "usage-updated") usage = event.usage;
    render(event, opts);
    // After each turn, show a compact running token/cost footer.
    if (event.type === "turn-finished" && usage && usage.totalTokens > 0) {
      process.stderr.write(`${ansi.dim(formatUsage(usage))}\n`);
    }
  }
}
