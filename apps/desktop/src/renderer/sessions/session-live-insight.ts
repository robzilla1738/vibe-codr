import { contextUsagePercent } from "../../shared/context-usage";
import type { TranscriptState } from "../../shared/reducer";
import type { SessionChrome } from "../hooks/useSession";

export type LiveSessionState = "working" | "needs-input" | "review" | "done";

export interface LiveSessionInsight {
  sessionId: string;
  cwd: string;
  state: LiveSessionState;
  headline: string;
  model: string;
  mode: SessionChrome["mode"];
  goal: string | null;
  taskProgress: { completed: number; total: number } | null;
  runningSubagents: number;
  runningJobs: number;
  queueDepth: number;
  changedFiles: number;
  contextPercent: number | null;
  totalTokens: number;
  costUSD: number;
  lastGate: SessionChrome["lastGate"];
}

function compactLine(value: string | null | undefined, max = 160): string | null {
  const line = value?.split("\n").find((candidate) => candidate.trim())?.replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function toolHeadline(transcript: TranscriptState): string | null {
  const block = transcript.blocks.findLast((candidate) => candidate.kind === "tool" && !candidate.done);
  if (block?.kind !== "tool") return null;
  return compactLine(block.label.replace(/^[^\p{L}\p{N}/.$@]+/u, ""));
}

export function buildLiveSessionInsight(options: {
  chrome: SessionChrome;
  transcript: TranscriptState;
  needsInput: boolean;
  needsReview: boolean;
  attention?: string | null;
}): LiveSessionInsight | null {
  const { chrome, transcript, needsInput, needsReview } = options;
  if (!chrome.sessionId || !chrome.cwd) return null;

  const activeTask = chrome.tasks.find((task) => task.status === "in_progress");
  const activeActivity = chrome.activities.findLast((activity) => activity.status === "running");
  const activeSubagent = chrome.subagents.find((subagent) => subagent.status === "running");
  const state: LiveSessionState = needsInput
    ? "needs-input"
    : needsReview
      ? "review"
      : chrome.busy
        ? "working"
        : "done";

  const headline = compactLine(options.attention)
    ?? toolHeadline(transcript)
    ?? compactLine(activeTask?.title)
    ?? compactLine(activeActivity?.summary)
    ?? compactLine(activeActivity?.label)
    ?? compactLine(activeSubagent?.activity)
    ?? compactLine(activeSubagent?.prompt)
    ?? compactLine(chrome.thinkingStream)
    ?? compactLine(chrome.queueActive?.label)
    ?? (state === "working"
      ? "Working…"
      : state === "needs-input"
        ? "Waiting for your input"
        : state === "review"
          ? "Checks need review"
          : chrome.lastGate === "green"
            ? "Checks passed"
            : "Ready to continue");

  return {
    sessionId: chrome.sessionId,
    cwd: chrome.cwd,
    state,
    headline,
    model: chrome.model,
    mode: chrome.mode,
    goal: chrome.goal,
    taskProgress: chrome.tasksTotal > 0
      ? { completed: chrome.tasksCompletedTotal, total: chrome.tasksTotal }
      : null,
    runningSubagents: chrome.subagents.filter((subagent) => subagent.status === "running").length,
    runningJobs: chrome.jobs.filter((job) => job.status === "running").length,
    queueDepth: chrome.queuePendingTotal,
    changedFiles: transcript.changedFiles.length,
    contextPercent: contextUsagePercent(chrome.ctxUsed, chrome.ctxWindow),
    totalTokens: chrome.usage.totalTokens,
    costUSD: chrome.usage.costUSD,
    lastGate: chrome.lastGate,
  };
}
