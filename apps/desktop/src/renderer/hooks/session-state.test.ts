import { describe, expect, it } from "vitest";
import {
  MAX_RETAINED_JOB_ITEMS,
  MAX_RETAINED_QUEUE_ITEMS,
  MAX_RETAINED_TASK_ITEMS,
} from "../../shared/chrome-state-bounds";
import type { UIEvent } from "../../shared/events";
import type { EngineSnapshot } from "../../shared/types";
import { initialChrome, reduceChrome, snapshotWithAttachedAppearance } from "./session-state";

function event(state: ReturnType<typeof initialChrome>, value: UIEvent) {
  return reduceChrome(state, { type: "event", event: value });
}

describe("session chrome state", () => {
  it("stays busy across per-turn idle events until engine-idle", () => {
    let state = initialChrome("/repo");
    state = event(state, { type: "user-message", sessionId: "s", text: "work" });
    expect(state.busy).toBe(true);
    state = event(state, { type: "turn-finished", sessionId: "s" });
    expect(state.busy).toBe(true);
    state = event(state, { type: "session-idle", sessionId: "s" });
    expect(state.busy).toBe(true);
    state = event(state, { type: "engine-idle", sessionId: "s", gate: "green" });
    expect(state.busy).toBe(false);
    expect(state.lastGate).toBe("green");
  });

  it("keeps busy across a recoverable engine error until engine-idle", () => {
    let state = initialChrome("/repo");
    state = event(state, { type: "user-message", sessionId: "s", text: "work" });
    state = event(state, { type: "engine-error", sessionId: "s", message: "provider failed" });
    expect(state.busy).toBe(true);
    expect(state.thinkingStream).toBe("");
    state = event(state, { type: "engine-idle", sessionId: "s" });
    expect(state.busy).toBe(false);
  });

  it("queues and settles permission cards by engine id", () => {
    let state = initialChrome("/repo");
    state = event(state, {
      type: "permission-request",
      sessionId: "s",
      id: "p1",
      toolName: "bash",
      input: { command: "pwd" },
    });
    state = event(state, {
      type: "permission-request",
      sessionId: "s",
      id: "p2",
      toolName: "write",
      input: {},
    });
    expect(state.perms.map((item) => item.id)).toEqual(["p1", "p2"]);
    state = event(state, {
      type: "permission-settled",
      sessionId: "s",
      ids: ["p1"],
      reason: "aborted",
    });
    expect(state.perms.map((item) => item.id)).toEqual(["p2"]);
  });

  it("deduplicates permission ids and retains only bounded display input", () => {
    let state = initialChrome("/repo");
    state = event(state, {
      type: "permission-request",
      sessionId: "s",
      id: "p1",
      toolName: "mcp_export",
      input: { payload: `head-${"x".repeat(300_000)}-tail` },
    });
    state = event(state, {
      type: "permission-request",
      sessionId: "s",
      id: "p1",
      toolName: "mcp_export",
      input: { payload: "replacement" },
    });
    expect(state.perms).toHaveLength(1);
    expect(state.perms[0]?.input).toEqual({ payload: "replacement" });
  });

  it("keeps plan evidence and clears it only when a new user turn begins", () => {
    let state = initialChrome("/repo");
    state = event(state, {
      type: "plan-presented",
      sessionId: "s",
      plan: "Ship safely",
      sources: [{ url: "https://example.com", title: "Reference" }],
      assumptions: ["CI is available"],
      ungrounded: true,
    });
    expect(state.plan).toMatchObject({
      text: "Ship safely",
      ungrounded: true,
      assumptions: ["CI is available"],
    });
    state = event(state, { type: "session-idle", sessionId: "s" });
    expect(state.plan?.text).toBe("Ship safely");
    state = event(state, { type: "user-message", sessionId: "s", text: "revise" });
    expect(state.plan).toBeNull();
  });

  it("resets every session-scoped overlay on clear", () => {
    const populated = {
      ...initialChrome("/repo"),
      busy: true,
      thinkingStream: "thinking",
      lastGate: "red" as const,
      tasks: [{ id: "t", title: "Task", status: "in_progress" as const }],
      checkpoints: [{ id: "c", label: "before" }],
    };
    const state = reduceChrome(populated, { type: "clear-session-overlays" });
    expect(state).toMatchObject({ busy: false, thinkingStream: "", tasks: [], lastGate: null });
    // Checkpoints belong to the session and must not survive /clear or /new.
    expect(state.checkpoints).toEqual([]);
  });

  it("bounds retained queue and job snapshots while preserving authoritative totals", () => {
    let state = initialChrome("/repo");
    state = event(state, {
      type: "queue-changed",
      active: null,
      pending: Array.from({ length: 1_200 }, (_, index) => ({
        id: `q-${index}`,
        label: `Queue ${index}`,
      })),
    });
    expect(state.queuePending).toHaveLength(MAX_RETAINED_QUEUE_ITEMS);
    expect(state.queuePendingTotal).toBe(1_200);

    state = event(state, {
      type: "jobs-changed",
      sessionId: "s",
      jobs: Array.from({ length: 700 }, (_, index) => ({
        id: `job-${index}`,
        command: `command ${index}`,
        status: index === 0 ? "running" as const : "exited" as const,
        exitCode: index === 0 ? null : 0,
        servers: [],
        outputTail: "",
      })),
    });
    expect(state.jobs).toHaveLength(MAX_RETAINED_JOB_ITEMS);
    expect(state.jobsTotal).toBe(700);
    expect(state.jobs.some((job) => job.id === "job-0")).toBe(true);
  });

  it("bounds task snapshots and preserves authoritative completion totals", () => {
    let state = initialChrome("/repo");
    state = event(state, {
      type: "tasks-updated",
      sessionId: "s",
      tasks: Array.from({ length: 1_500 }, (_, index) => ({
        id: `task-${index}`,
        title: `Task ${index}`,
        status: index < 1_200 ? "completed" as const : "pending" as const,
      })),
    });
    expect(state.tasks).toHaveLength(MAX_RETAINED_TASK_ITEMS);
    expect(state.tasksTotal).toBe(1_500);
    expect(state.tasksCompletedTotal).toBe(1_200);
    expect(state.tasksUnfinishedTotal).toBe(300);
  });

  it("bounds long-lived snapshot and plan metadata outside transcript blocks", () => {
    let state = initialChrome("/repo");
    state = event(state, {
      type: "goal-changed",
      sessionId: "s",
      goal: "g".repeat(3 * 1024 * 1024),
    });
    expect(state.goal?.length).toBe(2 * 1024 * 1024);

    state = event(state, {
      type: "plan-presented",
      sessionId: "s",
      plan: "plan",
      sources: [
        { url: `https://example.com/${"u".repeat(70 * 1024)}`, title: "drop" },
        { url: "https://example.com/ok", title: "t".repeat(80 * 1024) },
      ],
    });
    expect(state.plan?.sources).toHaveLength(1);
    expect(state.plan?.sources?.[0]?.title?.length).toBe(64 * 1024);

    state = event(state, {
      type: "plan-state-changed",
      sessionId: "s",
      state: {
        status: "pending",
        plan: "updated",
        sources: Array.from({ length: 700 }, (_, index) => ({
          url: `https://example.com/${index}`,
          title: index === 0 ? "t".repeat(80 * 1024) : `title-${index}`,
        })),
        assumptions: Array.from({ length: 300 }, (_, index) =>
          index === 0 ? "a".repeat(40 * 1024) : `assumption-${index}`
        ),
        updatedAt: 1,
      },
    });
    expect(state.plan?.sources).toHaveLength(500);
    expect(state.plan?.sources?.[0]?.title).toHaveLength(64 * 1024);
    expect(state.plan?.assumptions).toHaveLength(200);
    expect(state.plan?.assumptions?.[0]).toHaveLength(32 * 1024);

    state = event(state, {
      type: "question-request",
      sessionId: "s",
      question: {
        id: "q",
        question: "q".repeat(3 * 1024 * 1024),
        header: "h".repeat(80 * 1024),
        choices: Array.from({ length: 120 }, (_, index) => ({
          label: index === 0 ? "l".repeat(70 * 1024) : `choice-${index}`,
          description: index === 0 ? "d".repeat(140 * 1024) : `description-${index}`,
        })),
        multiple: false,
        allowFreeform: true,
        createdAt: 1,
      },
    });
    expect(state.question?.question).toHaveLength(2 * 1024 * 1024);
    expect(state.question?.header).toHaveLength(64 * 1024);
    expect(state.question?.choices).toHaveLength(100);
    expect(state.question?.choices[0]?.label).toHaveLength(64 * 1024);
    expect(state.question?.choices[0]?.description).toHaveLength(128 * 1024);

    state = event(state, {
      type: "activities-changed",
      sessionId: "s",
      activities: Array.from({ length: 1_200 }, (_, index) => ({
        id: `activity-${index}`,
        kind: "shell" as const,
        label: index === 200 ? "l".repeat(80 * 1024) : `label-${index}`,
        status: "running" as const,
        summary: index === 200 ? "s".repeat(300 * 1024) : `summary-${index}`,
        outputTail: index === 200 ? `old-${"x".repeat(300 * 1024)}-new` : `output-${index}`,
      })),
    });
    expect(state.activities).toHaveLength(1_000);
    expect(state.activities[0]?.id).toBe("activity-200");
    expect(state.activities[0]?.label).toHaveLength(64 * 1024);
    expect(state.activities[0]?.summary).toHaveLength(256 * 1024);
    expect(state.activities[0]?.outputTail).toHaveLength(256 * 1024);
    expect(state.activities[0]?.outputTail?.endsWith("-new")).toBe(true);

    state = event(state, {
      type: "goal-run",
      sessionId: "s",
      run: {
        active: false,
        phase: null,
        round: 0,
        max: 10,
        pausedReason: "p".repeat(80 * 1024),
        met: false,
      },
    });
    expect(state.goalRun?.pausedReason?.length).toBe(64 * 1024);
  });
});

describe("mode-changed plan dismissal", () => {
  it("dismisses the plan card when leaving plan mode", () => {
    let state = initialChrome("/repo");
    state = event(state, {
      type: "plan-presented",
      sessionId: "s",
      plan: "Do work",
    });
    expect(state.plan).not.toBeNull();
    state = event(state, { type: "mode-changed", sessionId: "s", mode: "execute" });
    expect(state.plan).toBeNull();
  });

  it("keeps the plan card when staying in plan mode", () => {
    let state = initialChrome("/repo");
    state = event(state, {
      type: "plan-presented",
      sessionId: "s",
      plan: "Do work",
    });
    state = event(state, { type: "mode-changed", sessionId: "s", mode: "plan" });
    expect(state.plan).not.toBeNull();
  });
});

describe("user-message per-turn reset", () => {
  it("resets subagents on new user message", () => {
    let state = initialChrome("/repo");
    state = event(state, {
      type: "subagent-started",
      sessionId: "s",
      subagentId: "sub1",
      prompt: "review code",
    });
    expect(state.subagents).toHaveLength(1);
    state = event(state, { type: "user-message", sessionId: "s", text: "next" });
    expect(state.subagents).toHaveLength(0);
  });

  it("resets thoughtLog on new user message", () => {
    let state = initialChrome("/repo");
    state = reduceChrome(state, { type: "set-trail", lines: ["thought 1", "thought 2"] });
    expect(state.thoughtLog).toHaveLength(2);
    state = event(state, { type: "user-message", sessionId: "s", text: "next" });
    expect(state.thoughtLog).toHaveLength(0);
  });

  it("resets orchestration rows on new user message", () => {
    let state = initialChrome("/repo");
    state = event(state, {
      type: "orchestration-task",
      sessionId: "s",
      taskId: "dag_1",
      objective: "Recon existing structure",
      status: "completed",
      attempts: 1,
      durationMs: 4200,
    });
    expect(state.orchestration).toHaveLength(1);
    state = event(state, { type: "user-message", sessionId: "s", text: "next" });
    expect(state.orchestration).toHaveLength(0);
  });
});

describe("subagent-activity running-only", () => {
  it("only updates activity for running subagents", () => {
    let state = initialChrome("/repo");
    state = event(state, {
      type: "subagent-started",
      sessionId: "s",
      subagentId: "sub1",
      prompt: "task a",
    });
    state = event(state, {
      type: "subagent-finished",
      sessionId: "s",
      subagentId: "sub1",
      result: "done",
    });
    state = event(state, {
      type: "subagent-activity",
      sessionId: "s",
      subagentId: "sub1",
      label: "should not update",
    });
    expect(state.subagents[0]?.activity).toBeUndefined();
  });
});

describe("subagent-started deduplication", () => {
  it("updates an existing subagent in place (continue_subagent reuses id)", () => {
    let state = initialChrome("/repo");
    state = event(state, {
      type: "subagent-started",
      sessionId: "s",
      subagentId: "sub1",
      prompt: "first prompt",
    });
    expect(state.subagents).toHaveLength(1);
    expect(state.subagents[0]?.prompt).toBe("first prompt");

    state = event(state, {
      type: "subagent-finished",
      sessionId: "s",
      subagentId: "sub1",
      result: "first result",
    });
    expect(state.subagents[0]?.status).toBe("done");
    expect(state.subagents[0]?.result).toBe("first result");

    // continue_subagent reuses the same id — update in place, not append
    state = event(state, {
      type: "subagent-started",
      sessionId: "s",
      subagentId: "sub1",
      prompt: "second prompt",
    });
    expect(state.subagents).toHaveLength(1);
    expect(state.subagents[0]?.prompt).toBe("second prompt");
    expect(state.subagents[0]?.status).toBe("running");
    expect(state.subagents[0]?.result).toBeUndefined();
    expect(state.subagents[0]?.activity).toBeUndefined();
  });

  it("appends a new subagent when the id is fresh", () => {
    let state = initialChrome("/repo");
    state = event(state, {
      type: "subagent-started",
      sessionId: "s",
      subagentId: "sub1",
      prompt: "task a",
    });
    state = event(state, {
      type: "subagent-started",
      sessionId: "s",
      subagentId: "sub2",
      prompt: "task b",
    });
    expect(state.subagents).toHaveLength(2);
    expect(state.subagents[0]?.id).toBe("sub1");
    expect(state.subagents[1]?.id).toBe("sub2");
  });
});

describe("large agent payload retention", () => {
  it("caps plan and subagent result payloads with a visible omission marker", () => {
    let state = initialChrome("/repo");
    state = event(state, {
      type: "plan-presented",
      sessionId: "s",
      plan: "p".repeat(2 * 1024 * 1024 + 100),
    });
    expect(state.plan?.text).toHaveLength(2 * 1024 * 1024);
    expect(state.plan?.text).toContain("earlier content omitted");

    state = event(state, {
      type: "subagent-started",
      sessionId: "s",
      subagentId: "sub-large",
      prompt: "review",
    });
    state = event(state, {
      type: "subagent-finished",
      sessionId: "s",
      subagentId: "sub-large",
      result: `old${"x".repeat(256 * 1024)}new`,
    });
    expect(state.subagents[0]?.result).toHaveLength(256 * 1024);
    expect(state.subagents[0]?.result).toContain("earlier content omitted");
    expect(state.subagents[0]?.result?.endsWith("new")).toBe(true);
  });
});

describe("durable orchestration state", () => {
  it("does not replace an established Cloud appearance with a remote default during attach", () => {
    const remote = {
      sessionId: "s",
      model: "crof/glm-5.2",
      mode: "execute",
      goal: null,
      history: [],
      tasks: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 },
      busy: false,
      theme: "graphite",
      accentColor: "#aabbcc",
      details: "verbose",
      mouse: true,
      approvalMode: "ask",
      commandNames: [],
    } satisfies EngineSnapshot;
    expect(snapshotWithAttachedAppearance(remote, {
      theme: "light",
      accentColor: "#e6e6e6",
      details: "normal",
    })).toMatchObject({ theme: "light", accentColor: "#e6e6e6", details: "normal" });
  });

  it("rehydrates a pending plan and structured question from the snapshot", () => {
    const snap: EngineSnapshot = {
      sessionId: "s",
      model: "provider/model",
      mode: "plan",
      goal: null,
      history: [],
      tasks: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 },
      busy: false,
      theme: "default",
      accentColor: "",
      details: "normal",
      mouse: true,
      approvalMode: "ask",
      commandNames: [],
      planState: { status: "pending", plan: "- [ ] ship", updatedAt: 1 },
      pendingQuestion: {
        id: "question_1",
        question: "Which path?",
        choices: [{ label: "A" }, { label: "B" }],
        multiple: false,
        allowFreeform: true,
        createdAt: 1,
      },
    };
    const state = reduceChrome(initialChrome("/repo"), { type: "seed", snap, cwd: "/repo" });
    expect(state.plan?.text).toBe("- [ ] ship");
    expect(state.question?.id).toBe("question_1");
  });

  it("retains worker transcript/metrics and unified activities", () => {
    let state = initialChrome("/repo");
    state = event(state, { type: "subagent-started", sessionId: "s", subagentId: "sub1", prompt: "inspect", agent: "review", startedAt: 10 });
    state = event(state, { type: "subagent-activity", sessionId: "s", subagentId: "sub1", label: "read app.ts", transcriptDelta: "[tool] read app.ts", metrics: { turns: 1, toolCalls: 1 } });
    state = event(state, { type: "subagent-finished", sessionId: "s", subagentId: "sub1", result: "REVIEW-CLEAN", transcript: "full transcript", metrics: { turns: 1, toolCalls: 1, inputTokens: 100 } });
    state = event(state, { type: "activities-changed", sessionId: "s", activities: [{ id: "sub1", kind: "subagent", label: "inspect", status: "completed" }] });
    expect(state.subagents[0]).toMatchObject({ agent: "review", transcript: "full transcript", metrics: { inputTokens: 100 } });
    expect(state.activities[0]?.kind).toBe("subagent");
  });
});
