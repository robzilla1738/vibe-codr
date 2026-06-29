import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgents } from "./agents.ts";

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

test("no agents directory yields an empty map (not an error)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-noagents-"));
  expect((await loadAgents(cwd)).size).toBe(0);
});
