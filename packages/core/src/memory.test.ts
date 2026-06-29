import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadProjectMemory,
  loadMemorySources,
  formatMemory,
  MAX_MEMORY_BYTES,
} from "./memory.ts";

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

test("loadMemorySources reports scope, path, and content per file", async () => {
  const dir = await freshDir();
  await writeFile(join(dir, "VIBE.md"), "project conventions");
  const sources = await loadMemorySources(dir);
  expect(sources).toHaveLength(1);
  expect(sources[0]).toMatchObject({ scope: "project", path: "VIBE.md" });
  expect(sources[0]!.text).toContain("project conventions");
});

test("formatMemory lists loaded files and explains precedence", async () => {
  const dir = await freshDir();
  await writeFile(join(dir, "AGENTS.md"), "use bun");
  const out = formatMemory(await loadMemorySources(dir));
  expect(out).toContain("AGENTS.md");
  expect(out).toContain("precedence");
});

test("formatMemory explains how to add memory when none exists", () => {
  const out = formatMemory([]);
  expect(out).toContain("No memory files found");
  expect(out).toContain("VIBE.md");
});

test("walks up to the git root, with cwd taking precedence over ancestors", async () => {
  const root = await freshDir();
  await mkdir(join(root, ".git")); // marks the repo root
  await writeFile(join(root, "AGENTS.md"), "root-level conventions");
  const sub = join(root, "packages", "app");
  await mkdir(sub, { recursive: true });
  await writeFile(join(sub, "VIBE.md"), "app-level conventions");

  const sources = await loadMemorySources(sub);
  const paths = sources.map((s) => s.path);
  // Both files found; the ancestor file is shown relative to cwd.
  expect(paths).toContain("VIBE.md");
  expect(paths.some((p) => p.includes("AGENTS.md") && p.includes(".."))).toBe(true);
  // Lowest precedence first: the root ancestor precedes the cwd file.
  const rootIdx = paths.findIndex((p) => p.includes("AGENTS.md"));
  const cwdIdx = paths.indexOf("VIBE.md");
  expect(rootIdx).toBeLessThan(cwdIdx);
});

test("does NOT walk up when there is no .git ancestor (only reads cwd)", async () => {
  const root = await freshDir(); // no .git anywhere
  await writeFile(join(root, "AGENTS.md"), "should not be seen from child");
  const sub = join(root, "child");
  await mkdir(sub);
  await writeFile(join(sub, "VIBE.md"), "child only");
  const paths = (await loadMemorySources(sub)).map((s) => s.path);
  expect(paths).toEqual(["VIBE.md"]);
});

test("caps an oversized memory file with a truncation marker", async () => {
  const dir = await freshDir();
  await writeFile(join(dir, "VIBE.md"), "x".repeat(MAX_MEMORY_BYTES + 5000));
  const sources = await loadMemorySources(dir);
  expect(sources[0]!.text).toContain("[memory truncated");
  expect(Buffer.byteLength(sources[0]!.text, "utf8")).toBeLessThan(MAX_MEMORY_BYTES + 200);
});
