import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { UIEvent } from "@vibe/shared";
import { globalStateDir } from "../state-dir.ts";

/** Local, content-free orchestration telemetry. Never records prompts, outputs, paths, or tool input. */
export class OrchestrationTelemetry {
  readonly #path: string;

  constructor(cwd: string) {
    this.#path = join(globalStateDir(cwd), "telemetry", "orchestration.jsonl");
  }

  async record(event: UIEvent): Promise<void> {
    const row = this.#project(event);
    if (!row) return;
    try {
      await mkdir(dirname(this.#path), { recursive: true });
      await appendFile(this.#path, `${JSON.stringify(row)}\n`, "utf8");
    } catch {
      /* observability must never affect work */
    }
  }

  #id(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 12);
  }

  #project(event: UIEvent): Record<string, unknown> | undefined {
    const at = Date.now();
    switch (event.type) {
      case "subagent-started":
        return { at, type: event.type, session: this.#id(event.sessionId), child: this.#id(event.subagentId), agent: event.agent ?? null };
      case "subagent-finished":
        return { at, type: event.type, session: this.#id(event.sessionId), child: this.#id(event.subagentId), metrics: event.metrics ?? {} };
      case "orchestration-task":
        return { at, type: event.type, session: this.#id(event.sessionId), task: this.#id(event.taskId), status: event.status, attempts: event.attempts, durationMs: event.durationMs };
      case "goal-run":
        return { at, type: event.type, session: this.#id(event.sessionId), active: event.run.active, phase: event.run.phase, round: event.run.round, met: event.run.met, stagnationCount: event.run.stagnationCount, strategyResets: event.run.strategyResets };
      case "plan-state-changed":
        return { at, type: event.type, session: this.#id(event.sessionId), status: event.state.status };
      default:
        return undefined;
    }
  }
}
