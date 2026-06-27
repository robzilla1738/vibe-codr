import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookBus } from "./hooks.ts";
import { CommandRegistry } from "./commands.ts";
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

test("PluginHost survives a broken plugin", async () => {
  const hooks = new HookBus();
  const host = new PluginHost({
    hooks,
    commands: new CommandRegistry(),
    skills: new SkillRegistry(),
    registerTool: () => {},
    registerProvider: () => {},
    addSkillDir: () => {},
  });
  // Should not throw even though the module does not exist.
  await host.load(["/nonexistent/does-not-exist.ts"]);
  expect(true).toBe(true);
});
