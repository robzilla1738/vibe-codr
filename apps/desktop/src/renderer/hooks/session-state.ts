import { seedChromeFromSessionStart } from "../../shared/chrome-seed";
import {
  retainCommandNames,
  retainJobState,
  retainQueueState,
  retainTaskState,
} from "../../shared/chrome-state-bounds";
import { isTranscriptDensity, type TranscriptDensity } from "../../shared/density";
import type { UIEvent } from "../../shared/events";
import { permissionInputForDisplay } from "../../shared/permission-input";
import {
  dropSettledPerms,
  type PendingPerm,
  type Subagent,
} from "../../shared/reducer";
import { appendRollingText } from "../../shared/stream-cap";
import type {
  ActivityInfo,
  EngineSnapshot,
  GitInfo,
  GoalRunInfo,
  JobInfo,
  QueuedItem,
  SessionUsage,
  Task,
  StructuredQuestion,
} from "../../shared/types";

export interface AttachedAppearance {
  theme: string;
  accentColor: string;
  details: "quiet" | "normal" | "verbose";
}

export function snapshotWithAttachedAppearance(
  snapshot: EngineSnapshot,
  appearance?: AttachedAppearance,
): EngineSnapshot {
  return appearance ? { ...snapshot, ...appearance } : snapshot;
}

const PLAN_MAX_CHARS = 2 * 1024 * 1024;
const PLAN_MAX_SOURCES = 500;
const PLAN_SOURCE_URL_MAX_CHARS = 64 * 1024;
const PLAN_SOURCE_TITLE_MAX_CHARS = 64 * 1024;
const PLAN_MAX_ASSUMPTIONS = 200;
const PLAN_ASSUMPTION_MAX_CHARS = 32 * 1024;
const SUBAGENT_MAX_ROWS = 256;
const SUBAGENT_PROMPT_MAX_CHARS = 64 * 1024;
const SUBAGENT_RESULT_MAX_CHARS = 256 * 1024;
const SUBAGENT_ACTIVITY_MAX_CHARS = 4 * 1024;
const ORCHESTRATION_MAX_ROWS = 1_000;
const ORCHESTRATION_OBJECTIVE_MAX_CHARS = 64 * 1024;
const MODEL_NAME_MAX_CHARS = 4 * 1024;
const GOAL_MAX_CHARS = 2 * 1024 * 1024;
const GOAL_PAUSE_REASON_MAX_CHARS = 64 * 1024;
const THEME_NAME_MAX_CHARS = 256;
const ACCENT_NAME_MAX_CHARS = 256;
const REASONING_NAME_MAX_CHARS = 4 * 1024;
const GIT_BRANCH_MAX_CHARS = 64 * 1024;
const PERMISSION_TOOL_NAME_MAX_CHARS = 4 * 1024;
const CHECKPOINT_LABEL_MAX_CHARS = 64 * 1024;

function boundedDisplayText(value: string, maxChars: number): string {
  return appendRollingText("", value, maxChars);
}

function boundedMachineText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return value.slice(0, Math.max(0, maxChars));
  return `${value.slice(0, maxChars - 1)}…`;
}

function boundedGoal(value: string | null): string | null {
  return value === null ? null : boundedDisplayText(value, GOAL_MAX_CHARS);
}

function boundedGoalRun(run: GoalRunInfo | null | undefined): GoalRunInfo | null {
  if (!run) return null;
  return {
    ...run,
    pausedReason: run.pausedReason === null
      ? null
      : boundedDisplayText(run.pausedReason, GOAL_PAUSE_REASON_MAX_CHARS),
  };
}

function boundedGit(git: GitInfo | null | undefined): GitInfo | null {
  return git
    ? { ...git, branch: boundedMachineText(git.branch, GIT_BRANCH_MAX_CHARS) }
    : null;
}

export interface OrchestrationRow {
  taskId: string;
  objective: string;
  status: "running" | "completed" | "failed" | "skipped";
  attempts?: number;
  durationMs?: number;
}

export interface SessionChrome {
  sessionId: string;
  model: string;
  /** Dedicated subagent model, or undefined when subagents inherit main. */
  subagentModel?: string;
  mode: "plan" | "execute";
  approvals: "ask" | "auto";
  goal: string | null;
  goalRun: GoalRunInfo | null;
  git: GitInfo | null;
  usage: SessionUsage;
  ctxUsed: number;
  ctxWindow: number;
  busy: boolean;
  theme: string;
  accent: string;
  density: TranscriptDensity;
  reasoning?: string;
  tasks: Task[];
  tasksTotal: number;
  tasksCompletedTotal: number;
  tasksUnfinishedTotal: number;
  jobs: JobInfo[];
  jobsTotal: number;
  activities: ActivityInfo[];
  queueActive: QueuedItem | null;
  queuePending: QueuedItem[];
  queuePendingTotal: number;
  plan: {
    text: string;
    sources?: { url: string; title?: string }[];
    assumptions?: string[];
    ungrounded?: boolean;
  } | null;
  question: StructuredQuestion | null;
  perms: PendingPerm[];
  subagents: Subagent[];
  thinkingStream: string;
  /** Accumulated reasoning trail (persists across bursts, survives past turn end). */
  thoughtLog: string[];
  commandNames: string[];
  cwd: string;
  lastGate: "green" | "red" | "unverified" | "aborted" | null;
  orchestration: OrchestrationRow[];
  checkpoints: { id: string; label: string }[];
}

const emptyUsage = (): SessionUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costUSD: 0,
});

export function initialChrome(cwd: string): SessionChrome {
  return {
    sessionId: "",
    model: "",
    subagentModel: undefined,
    mode: "execute",
    approvals: "ask",
    goal: null,
    goalRun: null,
    git: null,
    usage: emptyUsage(),
    ctxUsed: 0,
    ctxWindow: 0,
    busy: false,
    theme: "default",
    accent: "",
    density: "normal",
    tasks: [],
    tasksTotal: 0,
    tasksCompletedTotal: 0,
    tasksUnfinishedTotal: 0,
    jobs: [],
    jobsTotal: 0,
    activities: [],
    queueActive: null,
    queuePending: [],
    queuePendingTotal: 0,
    plan: null,
    question: null,
    perms: [],
    subagents: [],
    thinkingStream: "",
    thoughtLog: [],
    commandNames: [],
    cwd,
    lastGate: null,
    orchestration: [],
    checkpoints: [],
  };
}

export type ChromeAction =
  | { type: "reset"; cwd: string }
  | { type: "seed"; snap: EngineSnapshot; cwd: string }
  | { type: "event"; event: UIEvent }
  | { type: "optimistic-mode"; mode: "plan" | "execute"; approvals: "ask" | "auto" }
  | { type: "optimistic-density"; density: TranscriptDensity }
  | { type: "set-busy"; busy: boolean }
  | { type: "set-thinking"; text: string }
  | { type: "set-trail"; lines: string[] }
  | { type: "set-subagent-model"; model: string | undefined }
  | { type: "clear-plan" }
  | { type: "drop-perm"; id: string }
  | { type: "clear-session-overlays" }
  | { type: "seed-from-session-start"; event: Extract<UIEvent, { type: "session-start" }>; snap: EngineSnapshot | null };

export function reduceChrome(s: SessionChrome, a: ChromeAction): SessionChrome {
  switch (a.type) {
    case "reset":
      return initialChrome(a.cwd);
    case "seed": {
      const snap = a.snap;
      const tasks = retainTaskState(snap.tasks ?? []);
      return {
        ...initialChrome(a.cwd),
        sessionId: snap.sessionId,
        model: boundedMachineText(snap.model, MODEL_NAME_MAX_CHARS),
        subagentModel: snap.subagentModel
          ? boundedMachineText(snap.subagentModel, MODEL_NAME_MAX_CHARS)
          : undefined,
        mode: snap.mode,
        approvals: snap.approvalMode,
        goal: boundedGoal(snap.goal),
        goalRun: boundedGoalRun(snap.goalRun),
        git: boundedGit(snap.git),
        usage: snap.usage,
        busy: snap.busy,
        theme: boundedMachineText(snap.theme || "default", THEME_NAME_MAX_CHARS),
        accent: boundedMachineText(snap.accentColor || "", ACCENT_NAME_MAX_CHARS),
        density: isTranscriptDensity(snap.details) ? snap.details : "normal",
        reasoning: snap.reasoning
          ? boundedMachineText(snap.reasoning, REASONING_NAME_MAX_CHARS)
          : undefined,
        thoughtLog: [],
        tasks: tasks.items,
        tasksTotal: tasks.total,
        tasksCompletedTotal: tasks.completed,
        tasksUnfinishedTotal: tasks.unfinished,
        activities: snap.activities ?? [],
        question: snap.pendingQuestion ?? null,
        plan: snap.planState?.status === "pending" && snap.planState.plan
          ? {
              text: appendRollingText("", snap.planState.plan, PLAN_MAX_CHARS),
              sources: snap.planState.sources,
              assumptions: snap.planState.assumptions,
              ungrounded: snap.planState.ungrounded,
            }
          : null,
        commandNames: retainCommandNames(snap.commandNames ?? []),
      };
    }
    case "seed-from-session-start": {
      const seeded = seedChromeFromSessionStart(a.event, a.snap);
      return {
        ...s,
        sessionId: a.event.sessionId,
        model: boundedMachineText(seeded.model, MODEL_NAME_MAX_CHARS),
        subagentModel: a.snap?.subagentModel
          ? boundedMachineText(a.snap.subagentModel, MODEL_NAME_MAX_CHARS)
          : s.subagentModel,
        mode: seeded.mode,
        approvals: seeded.approvalMode,
        goal: boundedGoal(seeded.goal),
        theme: boundedMachineText(seeded.theme, THEME_NAME_MAX_CHARS),
        accent: boundedMachineText(seeded.accentColor, ACCENT_NAME_MAX_CHARS),
        density: isTranscriptDensity(seeded.details) ? seeded.details : s.density,
      };
    }
    case "optimistic-mode":
      return { ...s, mode: a.mode, approvals: a.approvals };
    case "optimistic-density":
      return { ...s, density: a.density };
    case "set-busy":
      return { ...s, busy: a.busy };
    case "set-thinking":
      return { ...s, thinkingStream: a.text };
    case "set-trail":
      return { ...s, thoughtLog: a.lines };
    case "set-subagent-model":
      return {
        ...s,
        subagentModel: a.model
          ? boundedMachineText(a.model, MODEL_NAME_MAX_CHARS)
          : undefined,
      };
    case "clear-plan":
      return { ...s, plan: null };
    case "drop-perm":
      return { ...s, perms: s.perms.filter((p) => p.id !== a.id) };
    case "clear-session-overlays":
      return {
        ...s,
        plan: null,
        question: null,
        perms: [],
        subagents: [],
        queueActive: null,
        queuePending: [],
        queuePendingTotal: 0,
        tasks: [],
        tasksTotal: 0,
        tasksCompletedTotal: 0,
        tasksUnfinishedTotal: 0,
        thinkingStream: "",
        thoughtLog: [],
        busy: false,
        lastGate: null,
        orchestration: [],
        checkpoints: [],
        activities: [],
      };
    case "event":
      return applyEvent(s, a.event);
    default:
      return s;
  }
}

function applyEvent(s: SessionChrome, event: UIEvent): SessionChrome {
  switch (event.type) {
    case "session-start":
      return {
        ...s,
        sessionId: event.sessionId,
        model: boundedMachineText(event.model, MODEL_NAME_MAX_CHARS),
        mode: event.mode,
      };
    case "mode-changed":
      // Leaving plan mode DISMISSES the plan card (TUI parity) — live approve
      // already spent #lastPlan engine-side; if the card survived, the next
      // typed message would be captured as a plan REVISION.
      return event.mode !== "plan"
        ? { ...s, mode: event.mode, plan: null }
        : { ...s, mode: event.mode };
    case "model-changed":
      return { ...s, model: boundedMachineText(event.model, MODEL_NAME_MAX_CHARS) };
    case "goal-changed":
      return { ...s, goal: boundedGoal(event.goal) };
    case "goal-run":
      return { ...s, goalRun: boundedGoalRun(event.run) };
    case "theme-changed":
      return { ...s, theme: boundedMachineText(event.theme, THEME_NAME_MAX_CHARS) };
    case "accent-changed":
      return { ...s, accent: boundedMachineText(event.accent, ACCENT_NAME_MAX_CHARS) };
    case "details-changed":
      return {
        ...s,
        density: isTranscriptDensity(event.details) ? event.details : s.density,
      };
    case "git-updated":
      return { ...s, git: boundedGit(event.git) };
    case "jobs-changed": {
      const retained = retainJobState(event.jobs);
      return { ...s, jobs: retained.items, jobsTotal: retained.total };
    }
    case "approvals-changed":
      return { ...s, approvals: event.mode };
    case "usage-updated":
      return { ...s, usage: event.usage };
    case "context-updated":
      return { ...s, ctxUsed: event.usedTokens, ctxWindow: event.contextWindow };
    case "tasks-updated": {
      const tasks = retainTaskState(event.tasks);
      return {
        ...s,
        tasks: tasks.items,
        tasksTotal: tasks.total,
        tasksCompletedTotal: tasks.completed,
        tasksUnfinishedTotal: tasks.unfinished,
      };
    }
    case "queue-changed": {
      const retained = retainQueueState(event.pending);
      const active = event.active
        ? retainQueueState([event.active], 1).items[0] ?? null
        : null;
      return {
        ...s,
        queueActive: active,
        queuePending: retained.items,
        queuePendingTotal: retained.total,
      };
    }
    case "plan-presented":
      return {
        ...s,
        plan: {
          text: appendRollingText("", event.plan, PLAN_MAX_CHARS),
          sources: event.sources
            ?.filter((source) =>
              source.url.length <= PLAN_SOURCE_URL_MAX_CHARS &&
              !source.url.includes("\0"),
            )
            .slice(0, PLAN_MAX_SOURCES)
            .map((source) => ({
              url: source.url,
              ...(source.title
                ? {
                    title: boundedDisplayText(
                      source.title,
                      PLAN_SOURCE_TITLE_MAX_CHARS,
                    ),
                  }
                : {}),
            })),
          assumptions: event.assumptions
            ?.slice(0, PLAN_MAX_ASSUMPTIONS)
            .map((assumption) => appendRollingText(
              "",
              assumption,
              PLAN_ASSUMPTION_MAX_CHARS,
            )),
          ungrounded: event.ungrounded,
        },
      };
    case "plan-state-changed":
      if (event.state.status !== "pending" || !event.state.plan) return { ...s, plan: null };
      return {
        ...s,
        plan: {
          text: appendRollingText("", event.state.plan, PLAN_MAX_CHARS),
          sources: event.state.sources,
          assumptions: event.state.assumptions,
          ungrounded: event.state.ungrounded,
        },
      };
    case "question-request":
      return { ...s, question: event.question };
    case "question-settled":
      return s.question?.id === event.id ? { ...s, question: null } : s;
    case "activities-changed":
      return { ...s, activities: event.activities.slice(-1_000) };
    case "permission-request":
      return {
        ...s,
        perms: [
          ...s.perms.filter((permission) => permission.id !== event.id),
          {
            id: event.id,
            toolName: boundedMachineText(
              event.toolName,
              PERMISSION_TOOL_NAME_MAX_CHARS,
            ),
            input: permissionInputForDisplay(event.input),
          },
        ],
      };
    case "permission-settled":
      return { ...s, perms: dropSettledPerms(s.perms, event.ids) };
    case "orchestration-task": {
      const row: OrchestrationRow = {
        taskId: event.taskId,
        objective: appendRollingText(
          "",
          event.objective,
          ORCHESTRATION_OBJECTIVE_MAX_CHARS,
        ),
        status: event.status,
        attempts: event.attempts,
        durationMs: event.durationMs,
      };
      const rest = s.orchestration.filter((o) => o.taskId !== event.taskId);
      return {
        ...s,
        orchestration: [...rest, row].slice(-ORCHESTRATION_MAX_ROWS),
      };
    }
    case "checkpoint-created":
      return {
        ...s,
        checkpoints: [
          ...s.checkpoints,
          {
            id: event.id,
            label: boundedDisplayText(event.label, CHECKPOINT_LABEL_MAX_CHARS),
          },
        ].slice(-20),
      };
    case "subagent-started": {
      // Deduplicate by subagentId: a continue_subagent re-uses the same child
      // id, so UPDATE the existing row in place (preserving position) instead
      // of appending a duplicate (TUI parity).
      const existing = s.subagents.findIndex((x) => x.id === event.subagentId);
      if (existing >= 0) {
        const subagents = s.subagents.slice();
        subagents[existing] = {
          ...subagents[existing],
          prompt: appendRollingText(
            "",
            event.prompt,
            SUBAGENT_PROMPT_MAX_CHARS,
          ),
          status: "running" as const,
          activity: undefined,
          result: undefined,
          startedAt: event.startedAt ?? Date.now(),
          agent: event.agent,
          transcript: "",
          metrics: undefined,
        };
        return { ...s, subagents };
      }
      return {
        ...s,
        subagents: [
          ...s.subagents,
          {
            id: event.subagentId,
            prompt: appendRollingText(
              "",
              event.prompt,
              SUBAGENT_PROMPT_MAX_CHARS,
            ),
            status: "running" as const,
            startedAt: event.startedAt ?? Date.now(),
            agent: event.agent,
            transcript: "",
          },
        ].slice(-SUBAGENT_MAX_ROWS),
      };
    }
    case "subagent-activity": {
      // Attach activity only to the RUNNING child (TUI parity) so a stray
      // event arriving after it finished can't relight a done row's label.
      return {
        ...s,
        subagents: s.subagents.map((x) =>
          x.id === event.subagentId && x.status === "running"
            ? {
                ...x,
                activity: appendRollingText(
                  "",
                  event.label,
                  SUBAGENT_ACTIVITY_MAX_CHARS,
                ),
                transcript: event.transcriptDelta
                  ? appendRollingText(x.transcript ?? "", event.transcriptDelta, SUBAGENT_RESULT_MAX_CHARS)
                  : x.transcript,
                metrics: event.metrics ?? x.metrics,
              }
            : x,
        ),
      };
    }
    case "subagent-finished": {
      return {
        ...s,
        subagents: s.subagents.map((x) =>
          x.id === event.subagentId
            ? {
                ...x,
                status: "done" as const,
                result: appendRollingText(
                  "",
                  event.result,
                  SUBAGENT_RESULT_MAX_CHARS,
                ),
                activity: undefined,
                elapsedMs:
                  x.startedAt !== undefined ? Date.now() - x.startedAt : undefined,
                transcript: event.transcript
                  ? appendRollingText("", event.transcript, SUBAGENT_RESULT_MAX_CHARS)
                  : x.transcript,
                metrics: event.metrics ?? x.metrics,
              }
            : x,
        ),
      };
    }
    case "turn-finished":
    case "session-idle":
      // Keep busy until engine-idle (TUI parity — follow-up turns).
      return { ...s, thinkingStream: "" };
    case "engine-idle":
      return {
        ...s,
        busy: false,
        thinkingStream: "",
        lastGate: event.gate ?? null,
      };
    case "user-message":
      // Subagents and the reasoning trail are per-turn — start each turn clean (TUI parity).
      return { ...s, busy: true, plan: null, subagents: [], thoughtLog: [], orchestration: [] };
    case "engine-error":
      return { ...s, busy: false, thinkingStream: "" };
    default:
      return s;
  }
}
