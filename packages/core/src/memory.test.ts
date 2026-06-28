import { test, expect } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectMemory } from "./memory.ts";

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vibe-mem-"));
}

test("returns undefined when no memory files exist", async () => {
  const dir = await freshDir();
  expect(await loadProjectMemory(dir)).toBeUndefined();
});

test("loads VIBE.md when present", async () => {
  const dir = await freshDir();
  await writeFile(join(dir, "VIBE.md"), "Bun monorepo. Run bun test.");
  const memory = await loadProjectMemory(dir);
  expect(memory).toContain("Bun monorepo");
  expect(memory).toContain("# VIBE.md");
});

test("concatenates multiple memory files under their own headings", async () => {
  const dir = await freshDir();
  await writeFile(join(dir, "AGENTS.md"), "Codex conventions here.");
  await writeFile(join(dir, "CLAUDE.md"), "Claude conventions here.");
  const memory = await loadProjectMemory(dir);
  expect(memory).toContain("# AGENTS.md");
  expect(memory).toContain("Codex conventions here.");
  expect(memory).toContain("# CLAUDE.md");
  expect(memory).toContain("Claude conventions here.");
});

test("ignores empty/whitespace-only memory files", async () => {
  const dir = await freshDir();
  await writeFile(join(dir, "VIBE.md"), "   \n\n  ");
  expect(await loadProjectMemory(dir)).toBeUndefined();
});
