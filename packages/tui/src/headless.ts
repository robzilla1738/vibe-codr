import type { EngineClient, SessionUsage, Task, UIEvent } from "@vibe/shared";
import { ansi } from "./ansi.ts";

/** Compact "12.3k tok · $0.0421" usage label (cost omitted when unpriced). */
export function formatUsage(u: SessionUsage): string {
  const tok =
    u.totalTokens >= 1000
      ? `${(u.totalTokens / 1000).toFixed(1)}k`
      : `${u.totalTokens}`;
  const cost =
    u.costUSD > 0 ? ` · $${u.costUSD.toFixed(u.costUSD < 1 ? 4 : 2)}` : "";
  const cached =
    u.cachedInputTokens && u.cachedInputTokens > 0
      ? ` · ${u.cachedInputTokens} cached`
      : "";
  return `${tok} tok${cost}${cached}`;
}

/** Status → checklist glyph, shared by the headless printer and the OpenTUI app. */
export const TASK_GLYPH: Record<Task["status"], string> = {
  completed: "✔",
  in_progress: "▶",
  pending: "○",
};

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
  return `${ansi.dim(`Tasks (${done}/${tasks.length})`)}\n${lines.join("\n")}`;
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
        process.stderr.write(
          `\n${ansi.cyan("⚒")} ${ansi.bold(event.toolName)} ${ansi.dim(
            truncate(JSON.stringify(event.input ?? {}), 120),
          )}\n`,
        );
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
          `${ansi.cyan("✎")} ${ansi.bold(`${verb} ${event.path}`)} ${summary}\n`,
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
      process.stderr.write(`${ansi.green("⟲")} ${ansi.dim(`reverted: ${event.label}`)}\n`);
      break;
    case "verify-started":
      process.stderr.write(`\n${ansi.cyan("✓")} ${ansi.dim(`verifying: ${event.command}`)}\n`);
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
        `\n${ansi.cyan("↻")} ${ansi.dim(`loop iteration ${event.iteration}`)}\n`,
      );
      break;
    case "loop-stopped":
      process.stderr.write(`${ansi.cyan("■")} ${ansi.dim(`loop ${event.reason}`)}\n`);
      break;
    case "subagent-started":
      process.stderr.write(
        `\n${ansi.magenta("⤷")} ${ansi.dim(`subagent ${event.subagentId.slice(-6)}: ${truncate(event.prompt, 80)}`)}\n`,
      );
      break;
    case "subagent-finished":
      process.stderr.write(
        `${ansi.magenta("⤶")} ${ansi.dim(`subagent ${event.subagentId.slice(-6)} done`)}\n`,
      );
      break;
    case "plan-presented":
      process.stdout.write(
        `\n${ansi.magenta(ansi.bold("── Plan ──"))}\n${event.plan}\n${ansi.dim(
          "Run /execute to proceed.",
        )}\n`,
      );
      break;
    case "tasks-updated":
      if (event.tasks.length) process.stderr.write(`\n${formatTasks(event.tasks)}\n`);
      break;
    case "queue-changed":
      // Only surface a backlog (type-ahead); the active item is shown elsewhere.
      if (event.pending.length) {
        process.stderr.write(
          `${ansi.dim(
            `↳ ${event.pending.length} queued: ${event.pending
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
    // rather than printed on every step (which would be noisy).
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
): Promise<void> {
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
    if (event.type === "engine-error") error = event.message;
    if (!json) render(event, opts);
    // `session-idle` ends a normal turn. Also stop on `engine-error`: a failure
    // before the session's run loop starts (e.g. an unreadable @mention or a
    // corrupt checkpoint file) emits engine-error without a trailing
    // session-idle, which would otherwise hang the one-shot forever.
    if (event.type === "session-idle" || event.type === "engine-error") break;
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
    return;
  }

  process.stdout.write("\n");
  if (finalUsage.totalTokens > 0) {
    process.stderr.write(`${ansi.dim(formatUsage(finalUsage))}\n`);
  }
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
