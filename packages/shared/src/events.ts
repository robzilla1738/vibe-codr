import type {
  GitInfo,
  GoalRunInfo,
  JobInfo,
  Mode,
  QueuedItem,
  SessionUsage,
  Task,
  Usage,
} from "./types.ts";

/**
 * Events emitted by the engine and consumed by any UI (TUI, headless printer).
 * The engine translates AI-SDK stream parts into these so the UI never depends
 * on the AI SDK. `subagentId` is set when the event originates from a subagent.
 */
export type UIEvent =
  | { type: "session-start"; sessionId: string; model: string; mode: Mode }
  | { type: "user-message"; sessionId: string; text: string }
  | {
      type: "assistant-text-delta";
      sessionId: string;
      subagentId?: string;
      delta: string;
    }
  | {
      type: "reasoning-delta";
      sessionId: string;
      subagentId?: string;
      delta: string;
    }
  | {
      type: "tool-call-started";
      sessionId: string;
      subagentId?: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | {
      type: "tool-call-progress";
      sessionId: string;
      subagentId?: string;
      toolCallId: string;
      chunk: string;
    }
  | {
      type: "tool-call-finished";
      sessionId: string;
      subagentId?: string;
      toolCallId: string;
      toolName: string;
      output: unknown;
      isError: boolean;
    }
  | { type: "step-finished"; sessionId: string; usage?: Usage }
  | { type: "usage-updated"; sessionId: string; usage: SessionUsage }
  | {
      /** Live context-window fill: estimated tokens in the model context vs. the
       * model's window. Emitted each turn so the UI can show "45% of 200k". */
      type: "context-updated";
      sessionId: string;
      usedTokens: number;
      contextWindow: number;
    }
  | { type: "mode-changed"; sessionId: string; mode: Mode }
  | { type: "model-changed"; sessionId: string; model: string }
  | { type: "goal-changed"; sessionId: string; goal: string | null }
  // The /goal autonomous run's live state (armed / phase / round / paused / met)
  // — drives the ★ header suffix and bare `/goal`. Always a fresh copy.
  | { type: "goal-run"; sessionId: string; run: GoalRunInfo }
  | { type: "theme-changed"; theme: string }
  | { type: "accent-changed"; accent: string }
  | { type: "details-changed"; details: "quiet" | "normal" | "verbose" }
  | { type: "mouse-changed"; mouse: boolean }
  | { type: "git-updated"; sessionId: string; git: GitInfo }
  | {
      /** Background shell jobs (and any localhost servers detected in their
       * output) changed — started, exited, or killed. Drives the `/jobs` view. */
      type: "jobs-changed";
      sessionId: string;
      jobs: JobInfo[];
    }
  | { type: "approvals-changed"; mode: "ask" | "auto" }
  | {
      /** A finished plan surfaced from plan mode's `present_plan`. `sources` are
       * the web pages the plan is grounded in; `assumptions` are items the model
       * could not verify; `ungrounded` marks a plan the readiness gate let
       * through only after its rejection budget was exhausted (the required
       * research never happened) — the UI renders it with a warning banner. */
      type: "plan-presented";
      sessionId: string;
      plan: string;
      sources?: { url: string; title?: string }[];
      assumptions?: string[];
      ungrounded?: boolean;
    }
  | {
      type: "permission-request";
      sessionId: string;
      id: string;
      toolName: string;
      input: unknown;
    }
  | {
      /** One or more pending permission prompts were resolved by the engine
       * WITHOUT a user answer — an abort (steer / budget-stop / loop-stop) or a
       * shutdown auto-denied them. The UI drops the now-dead card(s) so a stale
       * prompt can't linger into the next turn: block Esc-to-abort / plan
       * shortcuts (both gated on no pending prompt), or, if later clicked, write a
       * false "allowed" notice for a tool that was denied and never ran. Carries
       * the settled `permission-request` `id`s and why they settled. */
      type: "permission-settled";
      sessionId: string;
      ids: string[];
      reason: "aborted" | "shutdown";
    }
  | { type: "tasks-updated"; sessionId: string; tasks: Task[] }
  | {
      /** A scheduled orchestrator task changed state (spawn_tasks DAG). */
      type: "orchestration-task";
      sessionId: string;
      taskId: string;
      objective: string;
      status: "running" | "completed" | "failed" | "skipped";
      /** How many attempts the task ran (present on a terminal status). Optional
       * so the TUI needs no change — a reader that ignores it still works. */
      attempts?: number;
      /** Wall-clock the task took, ms (present on a terminal status). Optional. */
      durationMs?: number;
    }
  | {
      type: "queue-changed";
      /** Item currently running, if any. */
      active: QueuedItem | null;
      /** Items waiting to run, in order. */
      pending: QueuedItem[];
    }
  | {
      type: "file-changed";
      sessionId: string;
      /** The tool call that produced this change, so the UI can attribute the
       * diff to the exact tool block (no positional guessing). */
      toolCallId: string;
      /** Path relative to cwd. */
      path: string;
      /** "edit" replaced text in place; "write" created/overwrote the file. */
      action: "edit" | "write";
      /** Unified-diff text (` `/`+`/`-` prefixes); "" when nothing changed. */
      diff: string;
      added: number;
      removed: number;
    }
  | { type: "checkpoint-created"; id: string; label: string }
  | { type: "checkpoint-restored"; id: string; label: string }
  | { type: "verify-started"; command: string }
  | { type: "verify-finished"; ok: boolean; output: string }
  | { type: "compacted"; sessionId: string; freedTokens: number }
  | { type: "subagent-started"; sessionId: string; subagentId: string; prompt: string }
  /** Live one-line activity from a RUNNING subagent (its bus is otherwise
   * isolated): "$ bun test", "edit src/app.ts", … — so a minutes-long fan-out
   * shows what each child is doing right now, not just started/finished. */
  | { type: "subagent-activity"; sessionId: string; subagentId: string; label: string }
  | { type: "subagent-finished"; sessionId: string; subagentId: string; result: string }
  | { type: "loop-tick"; loopId: string; iteration: number }
  | { type: "loop-stopped"; loopId: string; reason: string }
  | { type: "notice"; level: "info" | "warn" | "error"; message: string }
  | { type: "engine-error"; sessionId?: string; message: string }
  | { type: "turn-finished"; sessionId: string }
  /** One turn's run loop settled. Emitted PER TURN — a single user prompt can
   * expand into several (a gate-fix / review-fix / verify-fix follow-up), so this
   * is NOT the end of the work for that prompt. */
  | { type: "session-idle"; sessionId: string }
  /** The engine's work queue fully drained: the submitted prompt AND every
   * follow-up turn it spawned are done, and nothing is running. This is the true
   * terminal signal for a headless one-shot (unlike per-turn `session-idle`).
   * `gate` carries the LAST green-gate outcome of the drained work (absent when
   * no gate ran), so a headless run can exit non-zero on a persistently-red gate
   * that the TUI would show as an amber "STILL RED" notice. */
  | { type: "engine-idle"; sessionId: string; gate?: "green" | "red" | "unverified" | "aborted" };

export type UIEventType = UIEvent["type"];
