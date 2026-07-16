import { useEffect, useState } from "react";
import type { SessionChrome } from "../hooks/useSession";
import { firstLine, truncate, type Subagent } from "../../shared/reducer";
import { hasUnfinishedTasks, windowTasks } from "../../shared/task-window";
import { CopyButton } from "../CopyButton";
import { IconCheck, IconChevron } from "../icons";
import { MarkdownView } from "../transcript/MarkdownView";

export function MetaRow({
  label,
  value,
  hot,
}: {
  label: string;
  value: string;
  hot?: boolean;
}) {
  return (
    <div className={`meta-row${hot ? " ctx-hot" : ""}`}>
      <span className="meta-label">{label}</span>
      <span className="meta-value" title={value} aria-label={`${label}: ${value}`}>
        {value}
      </span>
    </div>
  );
}

export function StatusDot({
  status,
}: {
  status: "done" | "active" | "pending" | "running" | "completed" | "failed" | "skipped";
}) {
  const kind =
    status === "done" || status === "completed"
      ? "done"
      : status === "failed"
        ? "failed"
        : status === "skipped"
          ? "skipped"
          : status === "active" || status === "running"
            ? "active"
            : "pending";
  return (
    <span className={`status-dot status-dot-${kind}`} aria-hidden>
      {kind === "done" ? <IconCheck size={12} strokeWidth={2.2} /> : null}
    </span>
  );
}

export function projectName(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) || cwd || "—";
}

export function formatGitLine(
  git: SessionChrome["git"],
  opts?: { showClean?: boolean },
): string | null {
  if (!git) return null;
  return [
    git.branch,
    git.dirty ? `${git.dirty} dirty` : opts?.showClean ? "clean" : null,
    git.ahead ? `↑${git.ahead}` : null,
    git.behind ? `↓${git.behind}` : null,
    git.worktree ? "worktree" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Goal chrome for sidebar MetaRows (`meta`) or the context-line (`context`, ★ prefix).
 */
export function formatGoalLine(
  goal: SessionChrome["goal"],
  goalRun: SessionChrome["goalRun"],
  opts?: { style?: "meta" | "context" },
): string | null {
  if (!goal) return null;
  if (opts?.style === "context") {
    if (!goalRun) return `★ ${goal}`;
    if (goalRun.met) return `★ ${goal} · met`;
    if (goalRun.active) {
      // TUI parity: plan phase reads planning (not plan) and does NOT show
      // round/max until the execute phase begins.
      if (goalRun.phase === "plan") return `★ ${goal} · planning`;
      const phase = goalRun.phase ? ` · ${goalRun.phase}` : "";
      return `★ ${goal}${phase} · ${goalRun.round}/${goalRun.max}`;
    }
    if (goalRun.pausedReason) return `★ ${goal} · paused`;
    return `★ ${goal}`;
  }
  return [
    goal,
    goalRun?.active
      ? `${goalRun.phase ?? "run"} ${goalRun.round}/${goalRun.max}`
      : goalRun?.met
        ? "met"
        : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Compact path/git/goal line for context chrome (not topbar / splash crumb). */
export function formatChromeSummary(parts: {
  project?: string | null;
  git?: string | null;
  goal?: string | null;
}): string {
  return [parts.project, parts.git, parts.goal].filter(Boolean).join(" · ");
}

/** Prefer the prompt’s first line; fall back to a short id. */
export function subagentLabel(prompt: string | undefined, id: string): string {
  return firstLine(prompt) ?? truncate(id, 12);
}

function formatSubagentElapsed(elapsedMs: number | undefined): string | null {
  if (elapsedMs === undefined) return null;
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder.toString().padStart(2, "0")}s`;
}

function SubagentDetailRow({ subagent, now }: { subagent: Subagent; now: number }) {
  const [open, setOpen] = useState(subagent.status === "running");
  const label = subagentLabel(subagent.prompt, subagent.id);
  const elapsed = formatSubagentElapsed(
    subagent.elapsedMs ??
      (subagent.startedAt !== undefined ? now - subagent.startedAt : undefined),
  );

  return (
    <details
      className={`subagent-detail${subagent.status === "running" ? " is-running" : " is-done"}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="subagent-detail-summary">
        <IconChevron size={13} />
        <StatusDot status={subagent.status === "running" ? "running" : "completed"} />
        <span className="subagent-detail-title" title={subagent.prompt}>{label}</span>
        <span className="subagent-detail-meta">
          {subagent.status === "running" ? "Running" : "Done"}
          {elapsed ? ` · ${elapsed}` : ""}
        </span>
      </summary>
      {open ? <div className="subagent-detail-body">
        <div className="subagent-detail-block">
          <span className="subagent-detail-label">Task</span>
          <p className="subagent-detail-prompt">{subagent.prompt}</p>
        </div>
        {subagent.agent || subagent.metrics ? (
          <div className="subagent-live-row">
            <span>
              {subagent.agent ? `${subagent.agent} · ` : ""}
              {subagent.metrics?.turns != null ? `${subagent.metrics.turns} turns · ` : ""}
              {subagent.metrics?.toolCalls != null ? `${subagent.metrics.toolCalls} tools · ` : ""}
              {subagent.metrics?.inputTokens != null ? `${subagent.metrics.inputTokens.toLocaleString()} in · ` : ""}
              {subagent.metrics?.outputTokens != null ? `${subagent.metrics.outputTokens.toLocaleString()} out` : ""}
            </span>
          </div>
        ) : null}
        {subagent.status === "running" ? (
          <div className="subagent-live-row" role="status" aria-live="polite">
            <StatusDot status="running" />
            <span>{subagent.activity || "Working…"}</span>
          </div>
        ) : null}
        {subagent.result ? (
          <div className="subagent-detail-block subagent-result-block">
            <div className="subagent-result-head">
              <span className="subagent-detail-label">Result</span>
              <CopyButton text={subagent.result} label={`Copy result from ${label}`} />
            </div>
            <div className="subagent-result-content md">
              <MarkdownView>{subagent.result}</MarkdownView>
            </div>
          </div>
        ) : null}
        {subagent.transcript ? (
          <details className="subagent-detail-block subagent-result-block">
            <summary className="subagent-detail-label">Transcript</summary>
            <pre className="subagent-result-content">{subagent.transcript}</pre>
          </details>
        ) : null}
      </div> : null}
    </details>
  );
}

export function TasksSection({ tasks }: { tasks: SessionChrome["tasks"] }) {
  if (!hasUnfinishedTasks(tasks)) return null;
  const taskWindow = windowTasks(tasks, 8);
  return (
    <div className="sidebar-section">
      <h4>Tasks</h4>
      {taskWindow.lead > 0 && (
        <div className="sidebar-line task-summary">{taskWindow.lead} done</div>
      )}
      {taskWindow.visible.map((t) => (
        <div
          key={t.id}
          className={`task-row ${
            t.status === "completed" ? "done" : t.status === "in_progress" ? "active" : "pending"
          }`}
        >
          <StatusDot
            status={
              t.status === "completed" ? "done" : t.status === "in_progress" ? "active" : "pending"
            }
          />
          <span>{t.title}</span>
        </div>
      ))}
      {taskWindow.trailing > 0 && (
        <div className="sidebar-line task-summary">+{taskWindow.trailing} more</div>
      )}
    </div>
  );
}

export function OrchestrationSection({
  orchestration,
}: {
  orchestration: SessionChrome["orchestration"];
}) {
  if (orchestration.length === 0) return null;
  return (
    <div className="sidebar-section">
      <h4>Orchestration</h4>
      {orchestration.map((o) => {
        const label = o.objective.length > 48 ? `${o.objective.slice(0, 48)}…` : o.objective;
        return (
          <div key={o.taskId} className={`task-row orch-${o.status}`} title={o.objective}>
            <StatusDot status={o.status} />
            <span>{label}</span>
          </div>
        );
      })}
    </div>
  );
}

export function SubagentsSection({
  subagents,
}: {
  subagents: SessionChrome["subagents"];
}) {
  const hasRunning = subagents.some((subagent) => subagent.status === "running");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!hasRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasRunning]);

  if (subagents.length === 0) return null;
  const done = subagents.filter((subagent) => subagent.status === "done").length;
  return (
    <div className="sidebar-section subagents-section" data-inspector-section="subagents">
      <div className="sidebar-section-title-row">
        <h4>Subagents</h4>
        <span className="subagents-summary">
          {hasRunning ? `${subagents.length - done} running` : `${done} complete`}
        </span>
      </div>
      <div className="subagent-detail-list">
        {subagents.map((subagent) => (
          <SubagentDetailRow key={subagent.id} subagent={subagent} now={now} />
        ))}
      </div>
    </div>
  );
}

export function ThinkingTrail({
  lines,
  live = false,
}: {
  lines: string[];
  live?: boolean;
}) {
  if (lines.length === 0) return null;
  return (
    <div className="sidebar-section">
      <h4>{live ? "Thinking" : "Last thinking"}</h4>
      <div
        className="activity-stream thinking-panel trail"
        role="log"
        aria-live={live ? "polite" : "off"}
        aria-label={live ? "Live thinking trail" : "Last thinking trail"}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard-scrollable region
        tabIndex={0}
      >
        {lines.map((line, i) => (
          <div key={i} className="trail-line">
            {line || " "}
          </div>
        ))}
      </div>
    </div>
  );
}
