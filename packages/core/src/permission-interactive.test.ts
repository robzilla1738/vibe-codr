import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { z } from "zod";
import type { UIEvent, ToolDefinition } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { defaultConfig } from "@vibe/config";
import { Engine } from "./engine.ts";

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function toolCall(id: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: id, toolName: "danger", input: "{}" },
        { type: "finish", finishReason: "tool-calls", usage: USAGE },
      ] as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
}
function finalText() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "done" },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: "stop", usage: USAGE },
      ] as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
}

/** Build an engine whose model runs `steps`, with a counting `danger` tool. */
function makeEngine(
  steps: unknown[],
  interactive: boolean,
  permissions: { tool: string; match?: string; action: "allow" | "deny" | "ask" }[] = [],
) {
  let runs = 0;
  const danger: ToolDefinition<{ command?: string }> = {
    name: "danger",
    description: "side effect",
    inputSchema: z.object({ command: z.string().optional() }),
    readOnly: false,
    execute: async () => {
      runs += 1;
      return { output: "did it" };
    },
  };
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });
  const registry = new ProviderRegistry([
    { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
  ]);
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test", permissions },
    registry,
    toolset: new Toolset([danger]),
    interactive,
    cwd: mkdtempSync(join(tmpdir(), "vibe-perm-")), // isolated, non-git
  });
  return { engine, runs: () => runs };
}

/** A `danger` tool call carrying a `command` scope (for scoped-rule tests). */
function toolCallCmd(id: string, command: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: id, toolName: "danger", input: JSON.stringify({ command }) },
        { type: "finish", finishReason: "tool-calls", usage: USAGE },
      ] as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
}

/** Auto-answer every permission-request with `decision`; collect events. */
function drive(engine: Engine, decision: "once" | "always" | "deny") {
  const events: UIEvent[] = [];
  void (async () => {
    for await (const e of engine.events()) {
      events.push(e);
      if (e.type === "permission-request") {
        engine.send({ type: "resolve-permission", id: e.id, decision });
      }
    }
  })();
  return events;
}

test("interactive: an allowed (once) permission lets the tool run", async () => {
  const { engine, runs } = makeEngine([toolCall("c1"), finalText()], true);
  const events = drive(engine, "once");
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  expect(events.some((e) => e.type === "permission-request")).toBe(true);
  expect(runs()).toBe(1);
});

test("interactive: a denied permission blocks the tool", async () => {
  const { engine, runs } = makeEngine([toolCall("c1"), finalText()], true);
  const events = drive(engine, "deny");
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  expect(events.some((e) => e.type === "permission-request")).toBe(true);
  expect(runs()).toBe(0);
  expect(events.some((e) => e.type === "notice" && e.message.includes("Blocked danger"))).toBe(true);
});

test("interactive: 'always' suppresses the second prompt", async () => {
  const { engine, runs } = makeEngine(
    [toolCall("c1"), toolCall("c2"), finalText()],
    true,
  );
  const events = drive(engine, "always");
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  const asks = events.filter((e) => e.type === "permission-request").length;
  expect(asks).toBe(1); // asked once, remembered for the second call
  expect(runs()).toBe(2);
});

test("interactive: two tool calls in one step each get a distinct prompt", async () => {
  const twoCalls = {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: "c1", toolName: "danger", input: "{}" },
        { type: "tool-call", toolCallId: "c2", toolName: "danger", input: "{}" },
        { type: "finish", finishReason: "tool-calls", usage: USAGE },
      ] as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
  const { engine, runs } = makeEngine([twoCalls, finalText()], true);
  const events = drive(engine, "once");
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();

  const ids = events
    .filter((e) => e.type === "permission-request")
    .map((e) => (e as Extract<UIEvent, { type: "permission-request" }>).id);
  expect(ids.length).toBe(2);
  expect(new Set(ids).size).toBe(2); // distinct ids, both resolvable
  expect(runs()).toBe(2);
});

test("re-gating approvals to ask forgets a prior 'always' grant (it can't bypass the fresh gate)", async () => {
  // Prompt 1: model calls danger → user grants 'always'. Then approvals are
  // re-gated to ask (a /plan/-execute/plan-accept transition). Prompt 2's danger
  // call must PROMPT AGAIN — the old 'always' grant must not silently bypass it.
  const { engine, runs } = makeEngine(
    [toolCall("c1"), finalText(), toolCall("c2"), finalText()],
    true,
  );
  const events: UIEvent[] = [];
  void (async () => {
    for await (const e of engine.events()) {
      events.push(e);
      if (e.type === "permission-request") engine.send({ type: "resolve-permission", id: e.id, decision: "always" });
    }
  })();
  engine.send({ type: "submit-prompt", text: "one" });
  await engine.whenIdle();
  const asksAfter1 = events.filter((e) => e.type === "permission-request").length;
  expect(asksAfter1).toBe(1); // asked once, remembered

  // Re-gate to ask (clears the always-allow set).
  engine.send({ type: "run-slash", name: "execute", args: "" });
  await engine.whenIdle();

  engine.send({ type: "submit-prompt", text: "two" });
  await engine.whenIdle();
  const asksTotal = events.filter((e) => e.type === "permission-request").length;
  // A SECOND prompt was required for the second danger call — the grant didn't carry over.
  expect(asksTotal).toBe(2);
  expect(runs()).toBe(2);
});

test("non-interactive: side-effecting tools auto-allow without prompting", async () => {
  const { engine, runs } = makeEngine([toolCall("c1"), finalText()], false);
  const events = drive(engine, "deny"); // would deny if asked
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  expect(events.some((e) => e.type === "permission-request")).toBe(false);
  expect(runs()).toBe(1);
});

test("non-interactive: an EXPLICIT ask rule fails CLOSED (a human gate can't auto-allow)", async () => {
  // A deliberately-authored `{action:"ask"}` gate must not silently become
  // `allow` in a headless run — there is no human to approve.
  const { engine, runs } = makeEngine([toolCall("c1"), finalText()], false, [
    { tool: "danger", action: "ask" },
  ]);
  const events = drive(engine, "once");
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  expect(events.some((e) => e.type === "permission-request")).toBe(false); // nothing to answer
  expect(runs()).toBe(0); // blocked, not run
  expect(events.some((e) => e.type === "notice" && e.message.includes("Blocked danger"))).toBe(true);
});

test("abort auto-denies a pending permission AND emits permission-settled with its id", async () => {
  // A non-user abort (steer / budget-stop / loop-stop) auto-resolves the pending
  // prompt as deny. Without an event the TUI's card lingered into the next turn;
  // permission-settled tells the UI to drop it (and answering the dead id is then
  // a silent no-op instead of a false "allowed" notice).
  const { engine, runs } = makeEngine([toolCall("c1"), finalText()], true);
  const events: UIEvent[] = [];
  let pendingId: string | undefined;
  void (async () => {
    for await (const e of engine.events()) {
      events.push(e);
      // Interrupt WHILE the prompt is pending instead of answering it.
      if (e.type === "permission-request") {
        pendingId = e.id;
        engine.send({ type: "abort" });
      }
    }
  })();
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();

  const settled = events.find(
    (e): e is Extract<UIEvent, { type: "permission-settled" }> => e.type === "permission-settled",
  );
  expect(settled).toBeDefined();
  expect(settled?.reason).toBe("aborted");
  expect(settled?.ids).toContain(pendingId);
  expect(runs()).toBe(0); // the cancelled tool never ran
});

test("interactive: 'always' is remembered per content scope, not for the whole tool", async () => {
  // Approving `danger {command:"safe"}` with 'always' must NOT auto-allow a later
  // `danger {command:"rm -rf /"}` — that call still prompts.
  const { engine, runs } = makeEngine(
    [toolCallCmd("c1", "safe"), toolCallCmd("c2", "rm -rf /"), finalText()],
    true,
  );
  const events: UIEvent[] = [];
  const prompts: string[] = [];
  void (async () => {
    for await (const e of engine.events()) {
      events.push(e);
      if (e.type === "permission-request") {
        prompts.push(JSON.stringify(e.input));
        // 'always' the first (safe) call; 'deny' the second (rm) call.
        const decision = prompts.length === 1 ? "always" : "deny";
        engine.send({ type: "resolve-permission", id: e.id, decision });
      }
    }
  })();
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  // Both calls prompted — the 'always' for "safe" did not cover "rm -rf /".
  expect(prompts.length).toBe(2);
  expect(runs()).toBe(1); // only the safe one ran
});

/** A path-bearing side-effecting tool + a stream that calls it with a `path`.
 * The built-in `edit`/`write` need a real file on disk; a mock keeps the
 * canonical-path keying test hermetic while still flowing a `path` scope through
 * the permission gate. */
function makePathEngine(steps: unknown[]) {
  let runs = 0;
  const writer: ToolDefinition<{ path?: string }> = {
    name: "writer",
    description: "writes a path",
    inputSchema: z.object({ path: z.string().optional() }),
    readOnly: false,
    execute: async () => {
      runs += 1;
      return { output: "wrote" };
    },
  };
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });
  const registry = new ProviderRegistry([
    { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
  ]);
  const engine = new Engine({
    config: { ...defaultConfig(), model: "mock/test" },
    registry,
    toolset: new Toolset([writer]),
    interactive: true,
    cwd: mkdtempSync(join(tmpdir(), "vibe-perm-path-")),
  });
  return { engine, runs: () => runs };
}

/** A `writer` tool call carrying a `path` scope. */
function writerCall(id: string, path: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: id, toolName: "writer", input: JSON.stringify({ path }) },
        { type: "finish", finishReason: "tool-calls", usage: USAGE },
      ] as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
}

test("interactive: 'always' for a path is keyed canonically — a re-spelled same file doesn't re-prompt", async () => {
  // Approving `writer {path:"src/x.ts"}` with 'always' must also cover the next
  // call spelled `./src/x.ts` (the SAME file after resolve(cwd, path)) — the
  // grant map keys the scope by its canonical absolute form, not the raw
  // spelling, so no second prompt.
  const { engine, runs } = makePathEngine([
    writerCall("c1", "src/x.ts"),
    writerCall("c2", "./src/x.ts"),
    finalText(),
  ]);
  const events = drive(engine, "always");
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  const asks = events.filter((e) => e.type === "permission-request").length;
  expect(asks).toBe(1); // ./src/x.ts is the same canonical file as src/x.ts
  expect(runs()).toBe(2);
});

test("interactive: 'always' for a path does NOT cover a DIFFERENT file", async () => {
  // A grant for src/x.ts must not green-light src/y.ts — a different canonical
  // path still prompts.
  const { engine, runs } = makePathEngine([
    writerCall("c1", "src/x.ts"),
    writerCall("c2", "src/y.ts"),
    finalText(),
  ]);
  const prompts: string[] = [];
  void (async () => {
    for await (const e of engine.events()) {
      if (e.type === "permission-request") {
        prompts.push(JSON.stringify(e.input));
        engine.send({ type: "resolve-permission", id: e.id, decision: "always" });
      }
    }
  })();
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  expect(prompts.length).toBe(2); // both distinct files prompted
  expect(runs()).toBe(2);
});

test("interactive: a command grant stays EXACT-string keyed (a path-looking command isn't canonicalized)", async () => {
  // PATH scopes are spelling-equivalent; COMMAND scopes are not. Two command
  // strings that WOULD canonicalize to one path ("./src/x.ts" vs "src/x.ts") are
  // DISTINCT command grants — both prompt — so path canonicalization never leaks
  // into command keying.
  const { engine, runs } = makeEngine(
    [toolCallCmd("c1", "./src/x.ts"), toolCallCmd("c2", "src/x.ts"), finalText()],
    true,
  );
  const prompts: string[] = [];
  void (async () => {
    for await (const e of engine.events()) {
      if (e.type === "permission-request") {
        prompts.push(JSON.stringify(e.input));
        engine.send({ type: "resolve-permission", id: e.id, decision: "always" });
      }
    }
  })();
  engine.send({ type: "submit-prompt", text: "go" });
  await engine.whenIdle();
  expect(prompts.length).toBe(2); // command scopes are exact — both prompted
  expect(runs()).toBe(2);
});
