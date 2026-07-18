import { describe, expect, it } from "vitest";
import { initialTranscript, reduceTranscript } from "../../shared/reducer";
import { initialChrome, reduceChrome } from "../hooks/session-state";
import { buildLiveSessionInsight } from "./session-live-insight";

describe("live session insight", () => {
  it("surfaces the current tool and real-time metrics", () => {
    let chrome = initialChrome("/work/project");
    chrome = { ...chrome, sessionId: "session-1", busy: true, ctxUsed: 80, ctxWindow: 100 };
    chrome = reduceChrome(chrome, { type: "event", event: {
      type: "tasks-updated",
      sessionId: "session-1",
      tasks: [
        { id: "1", title: "Inspect", status: "completed" },
        { id: "2", title: "Verify", status: "in_progress" },
      ],
    } });
    let transcript = initialTranscript();
    transcript = reduceTranscript(transcript, {
      type: "tool-start",
      toolCallId: "tool-1",
      toolName: "bash",
      input: { command: "npm test" },
    });
    transcript = { ...transcript, changedFiles: [{ path: "src/app.ts", added: 1, removed: 0 }] };

    expect(buildLiveSessionInsight({ chrome, transcript, needsInput: false, needsReview: false })).toMatchObject({
      state: "working",
      headline: "$ npm test",
      taskProgress: { completed: 1, total: 2 },
      changedFiles: 1,
      contextPercent: 80,
    });
  });

  it("puts actionable input ahead of background activity", () => {
    const chrome = { ...initialChrome("/work/project"), sessionId: "session-1", busy: true };
    const insight = buildLiveSessionInsight({
      chrome,
      transcript: initialTranscript(),
      needsInput: true,
      needsReview: false,
      attention: "Approve bash · npm install",
    });
    expect(insight).toMatchObject({ state: "needs-input", headline: "Approve bash · npm install" });
  });
});
