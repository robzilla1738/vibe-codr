import type { EngineClient, UIEvent } from "@vibe/shared";
import { ansi } from "./ansi.ts";

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
