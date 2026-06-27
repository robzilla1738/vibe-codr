import type { EngineClient, Task, UIEvent } from "@vibe/shared";
import { ansi } from "./ansi.ts";

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

export interface HeadlessOptions {
  /** Print reasoning deltas (default false). */
  showReasoning?: boolean;
  /** Print tool activity to stderr (default true). */
  showTools?: boolean;
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
    case "compacted":
      process.stderr.write(
        `${ansi.dim(`(compacted history, freed ~${event.freedTokens} tokens)`)}\n`,
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
  const events = engine.events();
  engine.send({ type: "submit-prompt", text: prompt });
  for await (const event of events) {
    render(event, opts);
    if (event.type === "session-idle") break;
  }
  process.stdout.write("\n");
}

/** Continuously print events (for a future headless REPL). Never resolves. */
export async function renderHeadless(
  engine: EngineClient,
  opts: HeadlessOptions = {},
): Promise<void> {
  for await (const event of engine.events()) render(event, opts);
}
