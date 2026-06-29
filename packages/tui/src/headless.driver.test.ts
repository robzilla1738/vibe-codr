import { test, expect } from "bun:test";
import { AsyncQueue, type EngineClient, type EngineSnapshot, type UIEvent } from "@vibe/shared";
import { runOneShot } from "./headless.ts";

/**
 * A minimal EngineClient that replays a scripted event stream on submit-prompt.
 * Lets us drive the real `runOneShot` headless renderer without a model.
 */
class MockEngine implements Partial<EngineClient> {
  #q = new AsyncQueue<UIEvent>();
  constructor(private script: UIEvent[]) {}
  events(): AsyncIterable<UIEvent> {
    return this.#q;
  }
  send(cmd: { type: string }): void {
    if (cmd.type === "submit-prompt") for (const e of this.script) this.#q.push(e);
  }
  snapshot(): EngineSnapshot {
    return {
      sessionId: "ses_mock",
      model: "mock/test",
      mode: "execute",
      goal: null,
      history: [],
      tasks: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 },
      busy: false,
      theme: "default",
      approvalMode: "ask",
      commandNames: [],
    };
  }
}

const sid = "ses_mock";

function happyPath(): UIEvent[] {
  return [
    { type: "user-message", sessionId: sid, text: "hi" },
    { type: "tool-call-started", sessionId: sid, toolCallId: "c1", toolName: "read", input: { path: "x" } },
    { type: "tool-call-finished", sessionId: sid, toolCallId: "c1", toolName: "read", output: "ok", isError: false },
    { type: "assistant-text-delta", sessionId: sid, delta: "All " },
    { type: "assistant-text-delta", sessionId: sid, delta: "done." },
    { type: "usage-updated", sessionId: sid, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUSD: 0.01 } },
    { type: "turn-finished", sessionId: sid },
    { type: "session-idle", sessionId: sid },
  ];
}

test("runOneShot streams assistant text to stdout and returns true on success", async () => {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => {
    out += s;
    return true;
  }) as typeof process.stdout.write;
  try {
    const ok = await runOneShot(new MockEngine(happyPath()) as unknown as EngineClient, "hi");
    expect(ok).toBe(true);
    expect(out).toContain("All done.");
  } finally {
    process.stdout.write = orig;
  }
});

test("runOneShot --output-format json emits a parseable result and no streamed text", async () => {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => {
    out += s;
    return true;
  }) as typeof process.stdout.write;
  try {
    const ok = await runOneShot(new MockEngine(happyPath()) as unknown as EngineClient, "hi", {
      outputFormat: "json",
    });
    expect(ok).toBe(true);
    const parsed = JSON.parse(out) as { text: string; usage: { totalTokens: number } };
    expect(parsed.text).toBe("All done.");
    expect(parsed.usage.totalTokens).toBe(15);
  } finally {
    process.stdout.write = orig;
  }
});

test("runOneShot returns false (exit non-zero) when the turn errors", async () => {
  const script: UIEvent[] = [
    { type: "user-message", sessionId: sid, text: "hi" },
    { type: "engine-error", sessionId: sid, message: "provider exploded" },
  ];
  const orig = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    const ok = await runOneShot(new MockEngine(script) as unknown as EngineClient, "hi");
    expect(ok).toBe(false);
  } finally {
    process.stdout.write = orig;
    process.stderr.write = origErr;
  }
});
