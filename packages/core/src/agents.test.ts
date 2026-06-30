import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgents, defaultAgents } from "./agents.ts";

function projectWithAgents(files: Record<string, string>): string {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-agents-"));
  const dir = join(cwd, ".vibe", "agents");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return cwd;
}

test("loads a named agent's frontmatter and body", async () => {
  const cwd = projectWithAgents({
    "reviewer.md": `---\nname: reviewer\ndescription: Reviews diffs\nmodel: openai/gpt-x\nmode: plan\n---\nYou are a careful code reviewer.`,
  });
  const agents = await loadAgents(cwd);
  const a = agents.get("reviewer");
  expect(a?.description).toBe("Reviews diffs");
  expect(a?.model).toBe("openai/gpt-x");
  expect(a?.mode).toBe("plan");
  expect(a?.system).toBe("You are a careful code reviewer.");
});

test("falls back to the filename when no name is given, and ignores a bad mode", async () => {
  const cwd = projectWithAgents({
    "helper.md": `---\ndescription: A helper\nmode: bogus\n---\nbody`,
  });
  const a = (await loadAgents(cwd)).get("helper");
  expect(a?.name).toBe("helper"); // basename fallback
  expect(a?.mode).toBeUndefined(); // invalid mode dropped, not crashed
});

test("ships the built-in coding agents by default", () => {
  const defaults = defaultAgents();
  expect(defaults.get("explore")?.mode).toBe("plan"); // read-only
  expect(defaults.get("review")?.mode).toBe("plan"); // read-only
  expect(defaults.get("test")?.mode).toBe("execute"); // writes
  for (const a of defaults.values()) expect(a.system?.length).toBeGreaterThan(0);
});

test("no agents directory still yields the built-in defaults (not an error)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-noagents-"));
  const agents = await loadAgents(cwd);
  expect(agents.has("explore")).toBe(true);
  expect(agents.has("review")).toBe(true);
  expect(agents.has("test")).toBe(true);
});

test("a user .vibe/agents file overrides a built-in default by name", async () => {
  const cwd = projectWithAgents({
    "explore.md": `---\nname: explore\ndescription: My custom explorer\n---\nCustom explore instructions.`,
  });
  const agents = await loadAgents(cwd);
  expect(agents.get("explore")?.description).toBe("My custom explorer");
  expect(agents.get("explore")?.system).toBe("Custom explore instructions.");
  // The other defaults remain available alongside the override.
  expect(agents.has("review")).toBe(true);
});
