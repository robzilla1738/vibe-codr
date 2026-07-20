import { describe, expect, test } from "bun:test";
import { AcpSessionPresenter } from "./acp-session.ts";

describe("AcpSessionPresenter", () => {
  test("renders chat, plans, decisions, and remembers diffs without engine ownership", async () => {
    const markdown: string[] = [];
    const progress: string[] = [];
    const decisions: unknown[] = [];
    const presenter = new AcpSessionPresenter();
    presenter.sink = { markdown: (text) => markdown.push(text), progress: (text) => progress.push(text) };
    presenter.onDecision = (decision) => { decisions.push(decision); };
    await presenter.handle({ sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } } });
    await presenter.handle({ sessionId: "s1", update: { sessionUpdate: "plan", entries: [{ content: "Ship it", priority: "high", status: "completed" }] } });
    await presenter.handle({ sessionId: "s1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "" }, _meta: { "vibe/pendingDecisionId": "p1", "vibe/event": { type: "permission-request", path: "a.ts", diff: "+x" } } } });
    expect(markdown.join(" ")).toContain("Hello");
    expect(markdown.join(" ")).toContain("Ship it");
    expect(decisions).toHaveLength(1);
  });
});
