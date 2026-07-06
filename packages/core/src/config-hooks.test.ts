import { test, expect } from "bun:test";
import { HookBus } from "@vibe/plugins";
import type { HookConfig } from "@vibe/config";
import { registerConfigHooks, parseHookOutput, defaultExec, type HookRunResult } from "./config-hooks.ts";

const hook = (h: Partial<HookConfig>): HookConfig => ({
  event: "tool.before.execute",
  async: false,
  ...h,
} as HookConfig);

test("parseHookOutput reads deny/reason/input, ignores non-JSON", () => {
  expect(parseHookOutput("")).toEqual({});
  expect(parseHookOutput("a log line")).toEqual({});
  expect(parseHookOutput('{"deny":true,"reason":"no"}')).toEqual({ deny: true, reason: "no" });
  expect(parseHookOutput('{"input":{"path":"x"}}')).toEqual({ input: { path: "x" } });
});

test("parseHookOutput accepts a final JSON directive after stdout logs", () => {
  expect(parseHookOutput('checking policy...\n{"deny":true,"reason":"blocked"}')).toEqual({
    deny: true,
    reason: "blocked",
  });
  expect(parseHookOutput('first\n{"deny":true,"reason":"old"}\nlast non-json log')).toEqual({
    deny: true,
    reason: "old",
  });
});

test("parseHookOutput ignores malformed JSON-looking log lines", () => {
  expect(parseHookOutput('log\n{"deny":true')).toEqual({});
  expect(parseHookOutput('log\n{"deny":true}\n{not json}')).toEqual({ deny: true });
});

test("parseHookOutput reads a prompt-rewrite {text}", () => {
  expect(parseHookOutput('{"text":"rewritten"}')).toEqual({ text: "rewritten" });
});

test("a user.prompt.submit hook rewrites the prompt text via {text}", async () => {
  const bus = new HookBus();
  registerConfigHooks([hook({ event: "user.prompt.submit", command: "rewrite.sh" })], bus, {
    exec: async (): Promise<HookRunResult> => ({ text: "cleaned prompt" }),
  });
  const out = await bus.run("user.prompt.submit", { text: "raw prompt" });
  expect(out.text).toBe("cleaned prompt");
  expect(out.deny).toBeUndefined();
});

test("a user.prompt.submit hook rewrites the prompt text via a string {input}", async () => {
  const bus = new HookBus();
  registerConfigHooks([hook({ event: "user.prompt.submit", command: "rewrite.sh" })], bus, {
    exec: async (): Promise<HookRunResult> => ({ input: "from input" }),
  });
  const out = await bus.run("user.prompt.submit", { text: "raw prompt" });
  expect(out.text).toBe("from input");
});

test("a user.prompt.submit DENY marks the payload so the engine cancels the turn", async () => {
  const bus = new HookBus();
  registerConfigHooks([hook({ event: "user.prompt.submit", command: "guard.sh" })], bus, {
    exec: async (): Promise<HookRunResult> => ({ deny: true, text: "ignored" }),
  });
  const out = await bus.run("user.prompt.submit", { text: "secret" }) as { text: string; deny?: boolean };
  expect(out.deny).toBe(true);
  expect(out.text).toBe("secret"); // deny short-circuits the rewrite
});

test("parseHookOutput reads additionalContext and continue", () => {
  expect(parseHookOutput('{"additionalContext":"note"}')).toEqual({ additionalContext: "note" });
  expect(parseHookOutput('{"continue":true,"reason":"more"}')).toEqual({ continue: true, reason: "more" });
  expect(parseHookOutput('{"continue":false}')).toEqual({}); // false is not a continue
});

test("declarative tool.after.execute hook maps additionalContext onto the payload", async () => {
  const bus = new HookBus();
  registerConfigHooks([hook({ event: "tool.after.execute", command: "annotate.sh" })], bus, {
    exec: async (): Promise<HookRunResult> => ({ additionalContext: "linted OK" }),
  });
  const out = await bus.run("tool.after.execute", { toolName: "write", output: "wrote file" }) as {
    additionalContext?: string;
  };
  expect(out.additionalContext).toBe("linted OK");
});

test("declarative tool.after.execute hook maps deny/reason onto the payload (override the result)", async () => {
  const bus = new HookBus();
  registerConfigHooks([hook({ event: "tool.after.execute", command: "guard.sh" })], bus, {
    exec: async (): Promise<HookRunResult> => ({ deny: true, reason: "secret leaked" }),
  });
  const out = await bus.run("tool.after.execute", { toolName: "read", output: "AKIA…" }) as {
    deny?: boolean;
    reason?: string;
  };
  expect(out.deny).toBe(true);
  expect(out.reason).toBe("secret leaked");
});

test("declarative tool.after.execute hook honors the matcher", async () => {
  const bus = new HookBus();
  let ran = 0;
  registerConfigHooks([hook({ event: "tool.after.execute", command: "x", matcher: "write" })], bus, {
    exec: async (): Promise<HookRunResult> => {
      ran++;
      return { additionalContext: "n" };
    },
  });
  await bus.run("tool.after.execute", { toolName: "read", output: "x" }); // no match
  expect(ran).toBe(0);
  const out = await bus.run("tool.after.execute", { toolName: "write", output: "x" }) as {
    additionalContext?: string;
  };
  expect(ran).toBe(1);
  expect(out.additionalContext).toBe("n");
});

test("declarative session.idle hook maps continue/reason onto the payload", async () => {
  const bus = new HookBus();
  registerConfigHooks([hook({ event: "session.idle", command: "stop-check.sh" })], bus, {
    exec: async (): Promise<HookRunResult> => ({ continue: true, reason: "tests still failing" }),
  });
  const out = await bus.run("session.idle", { sessionId: "s" }) as {
    continue?: boolean;
    reason?: string;
  };
  expect(out.continue).toBe(true);
  expect(out.reason).toBe("tests still failing");
});

test("declarative session.idle hook without continue leaves the payload settling idle", async () => {
  const bus = new HookBus();
  registerConfigHooks([hook({ event: "session.idle", command: "stop-check.sh" })], bus, {
    exec: async (): Promise<HookRunResult> => ({}), // hook satisfied, no continue
  });
  const out = await bus.run("session.idle", { sessionId: "s" }) as { continue?: boolean };
  expect(out.continue).toBeUndefined();
});

test("a non-vetoable event (assistant.message) stays observe-only", async () => {
  const bus = new HookBus();
  registerConfigHooks([hook({ event: "assistant.message", command: "notify.sh" })], bus, {
    exec: async (): Promise<HookRunResult> => ({ deny: true, text: "tampered" }),
  });
  const out = await bus.run("assistant.message", { sessionId: "s", text: "hello" });
  expect(out).toEqual({ sessionId: "s", text: "hello" }); // untouched
});

test("a command-less hook warns and registers nothing", async () => {
  const bus = new HookBus();
  const warnings: string[] = [];
  registerConfigHooks([hook({})], bus, {
    exec: async () => ({ deny: true }),
    onWarn: (m) => warnings.push(m),
  });
  const out = await bus.run("tool.before.execute", { toolName: "bash", input: {} });
  expect(out.deny).toBeUndefined(); // nothing registered
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("neither a command nor a url");
});

test("a tool.before.execute hook can DENY a tool", async () => {
  const bus = new HookBus();
  registerConfigHooks([hook({ command: "policy.sh", matcher: "bash" })], bus, {
    exec: async (): Promise<HookRunResult> => ({ deny: true, reason: "no shell" }),
  });
  const out = await bus.run("tool.before.execute", { toolName: "bash", input: { cmd: "rm -rf /" } });
  expect(out.deny).toBe(true);
  expect(out.reason).toBe("no shell");
});

test("the matcher scopes a tool hook to matching tool names", async () => {
  const bus = new HookBus();
  let ran = 0;
  registerConfigHooks([hook({ command: "x", matcher: "git_*" })], bus, {
    exec: async (): Promise<HookRunResult> => {
      ran++;
      return { deny: true };
    },
  });
  await bus.run("tool.before.execute", { toolName: "read", input: {} }); // no match
  expect(ran).toBe(0);
  const out = await bus.run("tool.before.execute", { toolName: "git_commit", input: {} }); // match
  expect(ran).toBe(1);
  expect(out.deny).toBe(true);
});

test("a hook can REWRITE the tool input", async () => {
  const bus = new HookBus();
  registerConfigHooks([hook({ command: "redact.sh" })], bus, {
    exec: async (): Promise<HookRunResult> => ({ input: { cmd: "echo redacted" } }),
  });
  const out = await bus.run("tool.before.execute", { toolName: "bash", input: { cmd: "echo secret" } });
  expect(out.input).toEqual({ cmd: "echo redacted" });
});

test("an async hook is fire-and-forget (can't deny)", async () => {
  const bus = new HookBus();
  let called = false;
  registerConfigHooks([hook({ event: "user.prompt.submit", url: "https://notify", async: true })], bus, {
    post: async (): Promise<HookRunResult> => {
      called = true;
      return { deny: true }; // ignored — async hooks can't block
    },
  });
  const out = await bus.run("user.prompt.submit", { text: "hi" });
  expect(out).toEqual({ text: "hi" }); // unchanged
  // The fire-and-forget runner still fired (give the microtask a tick).
  await new Promise((r) => setTimeout(r, 5));
  expect(called).toBe(true);
});

test("a hook with neither command nor url is skipped", async () => {
  const bus = new HookBus();
  registerConfigHooks([hook({})], bus, {
    exec: async () => ({ deny: true }),
  });
  const out = await bus.run("tool.before.execute", { toolName: "bash", input: {} });
  expect(out.deny).toBeUndefined();
});

test("defaultExec bounds wall-clock even when the hook backgrounds a lingering child", async () => {
  // The command prints its verdict then backgrounds a 30s sleep that inherits the
  // stdout pipe. The old `Response(stdout).text()` blocked on that fd for 30s;
  // defaultExec must return within ~the timeout and still parse the verdict.
  const start = Date.now();
  const result = await defaultExec(
    `echo '{"deny":true,"reason":"blocked"}'; sleep 30 &`,
    "{}",
    400,
  );
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(2000); // NOT 30s — the timeout bounded it
  // The verdict that was printed before the timeout is still honored.
  expect(result.deny).toBe(true);
  expect(result.reason).toBe("blocked");
});

test("defaultExec returns a fast hook's verdict immediately (no timeout wait)", async () => {
  const start = Date.now();
  const result = await defaultExec(`echo '{"deny":false}'`, "{}", 5000);
  expect(Date.now() - start).toBeLessThan(1000); // well under the 5s timeout
  expect(result.deny).toBeUndefined(); // deny:false → not a block
});
