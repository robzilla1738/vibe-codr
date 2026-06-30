import { test, expect } from "bun:test";
import { HookBus } from "@vibe/plugins";
import type { HookConfig } from "@vibe/config";
import { registerConfigHooks, parseHookOutput, type HookRunResult } from "./config-hooks.ts";

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
