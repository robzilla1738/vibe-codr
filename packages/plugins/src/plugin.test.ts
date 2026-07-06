import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookBus } from "./hooks.ts";
import { CommandRegistry, parseSlash } from "./commands.ts";
import { SkillRegistry } from "./skills.ts";
import { PluginHost } from "./plugin.ts";

test("PluginHost loads a plugin that registers a command and a hook", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-plugin-"));
  const pluginPath = join(dir, "plugin.ts");
  await Bun.write(
    pluginPath,
    `export function register(api) {
       api.registerCommand({
         name: "hello",
         description: "say hi",
         source: "plugin",
         run: () => ({ kind: "notice", message: "hi from plugin" }),
       });
       api.hooks.on("user.prompt.submit", (p) => ({ text: p.text + " [seen]" }));
     }`,
  );

  const hooks = new HookBus();
  const commands = new CommandRegistry();
  const skills = new SkillRegistry();
  const host = new PluginHost({
    hooks,
    commands,
    skills,
    registerTool: () => {},
    registerProvider: () => {},
    addSkillDir: () => {},
  });

  await host.load([pluginPath]);

  const cmd = commands.get("hello");
  expect(cmd).toBeDefined();
  expect(cmd!.run("").kind).toBe("notice");

  const result = await hooks.run("user.prompt.submit", { text: "hi" });
  expect(result.text).toBe("hi [seen]");
});

test("a broken plugin leaks no partial registrations and does not poison a later good plugin", async () => {
  const hooks = new HookBus();
  const commands = new CommandRegistry();
  const host = new PluginHost({
    hooks,
    commands,
    skills: new SkillRegistry(),
    registerTool: () => {},
    registerProvider: () => {},
    addSkillDir: () => {},
  });
  // A missing module must not throw AND must not leave partial state behind:
  // no command registered, no hook handler leaked into the bus.
  await host.load(["/nonexistent/does-not-exist.ts"]);
  expect(commands.list()).toEqual([]);
  const passthrough = await hooks.run("user.prompt.submit", { text: "hi" });
  expect(passthrough.text).toBe("hi"); // untouched — nothing from the failed load ran

  // One bad plugin doesn't poison the host: a well-behaved plugin loaded
  // afterward still registers into the same registries.
  const dir = mkdtempSync(join(tmpdir(), "vibe-plugin-"));
  const okPath = join(dir, "ok.ts");
  await Bun.write(
    okPath,
    `export function register(api) {
       api.registerCommand({ name: "after", description: "x", source: "plugin", run: () => ({ kind: "notice", message: "ok" }) });
     }`,
  );
  await host.load([okPath]);
  expect(commands.get("after")).toBeDefined();
});

test("PluginHost does not hang on a plugin whose register() never resolves", async () => {
  // Regression: register() was awaited with no deadline, so a never-resolving
  // plugin blocked the entire CLI boot. It must time out (logged) and move on —
  // and a WELL-BEHAVED plugin loaded after it must still register.
  const dir = mkdtempSync(join(tmpdir(), "vibe-plugin-"));
  const hangPath = join(dir, "hang.ts");
  await Bun.write(hangPath, `export function register() { return new Promise(() => {}); }`);
  const okPath = join(dir, "ok.ts");
  await Bun.write(
    okPath,
    `export function register(api) {
       api.registerCommand({ name: "after", description: "x", source: "plugin", run: () => ({ kind: "notice", message: "ok" }) });
     }`,
  );
  const commands = new CommandRegistry();
  const host = new PluginHost({
    hooks: new HookBus(),
    commands,
    skills: new SkillRegistry(),
    registerTool: () => {},
    registerProvider: () => {},
    addSkillDir: () => {},
  });
  const start = performance.now();
  // Short deadline so the test is fast; the hanging plugin is abandoned.
  await host.load([hangPath, okPath], { timeoutMs: 50 });
  expect(performance.now() - start).toBeLessThan(2000); // did NOT hang
  expect(commands.get("after")).toBeDefined(); // the good plugin still loaded
});

test("PluginHost does not hang on a plugin whose module IMPORT never resolves", async () => {
  // The import() itself was outside the register() deadline, so a module with a
  // hanging top-level await blocked boot BEFORE register() was ever reached. The
  // import is now bounded too — it times out (logged) and a good plugin after it
  // still loads.
  const dir = mkdtempSync(join(tmpdir(), "vibe-plugin-import-"));
  const okPath = join(dir, "ok.ts");
  await Bun.write(
    okPath,
    `export function register(api) {
       api.registerCommand({ name: "after-import", description: "x", source: "plugin", run: () => ({ kind: "notice", message: "ok" }) });
     }`,
  );
  const commands = new CommandRegistry();
  const host = new PluginHost({
    hooks: new HookBus(),
    commands,
    skills: new SkillRegistry(),
    registerTool: () => {},
    registerProvider: () => {},
    addSkillDir: () => {},
  });
  // A data: module whose top-level await never resolves.
  const hangImport = "data:text/javascript,await new Promise(() => {})";
  const start = performance.now();
  await host.load([hangImport, okPath], { timeoutMs: 50 });
  expect(performance.now() - start).toBeLessThan(2000); // did NOT hang on the import
  expect(commands.get("after-import")).toBeDefined();
});

test("HookBus times out a hung handler and still runs later handlers", async () => {
  // A never-resolving plugin handler is awaited on hot paths (session.idle inside
  // the drain loop, user.prompt.submit at turn start, etc.) — it must time out
  // (reported via onError) and let the chain continue, not hang the engine.
  const errors: string[] = [];
  const bus = new HookBus((_name, err) => errors.push(err.message), 30); // 30ms deadline
  let laterRan = false;
  bus.on("session.idle", () => new Promise<never>(() => {})); // hangs forever
  bus.on("session.idle", (p) => {
    laterRan = true;
    return p;
  });
  const start = performance.now();
  await bus.run("session.idle", { sessionId: "s" });
  expect(performance.now() - start).toBeLessThan(2000); // did NOT hang
  expect(errors.some((m) => /timed out/.test(m))).toBe(true);
  expect(laterRan).toBe(true); // the chain continued past the hung handler
});

test("HookBus isolates a throwing onError reporter too", async () => {
  const bus = new HookBus(() => {
    throw new Error("reporter down");
  });
  let laterRan = false;
  bus.on("session.idle", () => {
    throw new Error("handler down");
  });
  bus.on("session.idle", (p) => {
    laterRan = true;
    return { ...p, reason: "continued" };
  });

  const out = await bus.run("session.idle", { sessionId: "s" });
  expect(laterRan).toBe(true);
  expect(out.reason).toBe("continued");
});

test("parseSlash only treats plausible slash command names as commands", () => {
  expect(parseSlash("/queue clear")).toEqual({ name: "queue", args: "clear" });
  expect(parseSlash("/run-tests src")).toEqual({ name: "run-tests", args: "src" });

  // Paths, comments, and HTTP-ish routes are prompts that merely start with "/".
  expect(parseSlash("/etc/hosts is world-readable")).toBeNull();
  expect(parseSlash("// TODO: fix this later")).toBeNull();
  expect(parseSlash("/api/users returns 500")).toBeNull();
  expect(parseSlash("/foo.bar")).toBeNull();
});

test("CommandRegistry ignores names the slash parser can never dispatch", () => {
  const commands = new CommandRegistry();
  commands.register({
    name: "ship-it",
    description: "ok",
    source: "plugin",
    run: () => ({ kind: "notice", message: "ok" }),
  });
  commands.register({
    name: "ship.it",
    description: "dead",
    source: "plugin",
    run: () => ({ kind: "notice", message: "dead" }),
  });
  commands.register({
    name: "ship it",
    description: "dead",
    source: "plugin",
    run: () => ({ kind: "notice", message: "dead" }),
  });

  expect(commands.get("ship-it")).toBeDefined();
  expect(commands.get("ship.it")).toBeUndefined();
  expect(commands.get("ship it")).toBeUndefined();
  expect(commands.list().map((c) => c.name)).toEqual(["ship-it"]);
});
