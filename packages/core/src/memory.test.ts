import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadProjectMemory,
  loadMemorySources,
  formatMemory,
  memoryDirs,
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

test("caps a multibyte memory file by BYTES, not UTF-16 code units", async () => {
  const dir = await freshDir();
  // '中' is 3 UTF-8 bytes but 1 UTF-16 code unit. A file of MAX code units is
  // ~3x the byte budget; the old String.slice cap kept all of it.
  const text = "中".repeat(MAX_MEMORY_BYTES);
  await writeFile(join(dir, "VIBE.md"), text);
  const memory = await loadProjectMemory(dir);
  expect(memory).toBeDefined();
  expect(memory).toContain("memory truncated");
  // The whole injected block (heading + capped body + marker) must stay close to
  // the byte budget — not ~3x it as the code-unit bug produced.
  expect(Buffer.byteLength(memory!, "utf8")).toBeLessThan(MAX_MEMORY_BYTES + 2_000);
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

test("a dotfiles-as-repo $HOME/.git does not make the walk ascend into $HOME", async () => {
  // Home is itself a git repo (common with dotfiles); a project below it with no
  // closer .git must NOT ascend into $HOME (which would slurp ~/AGENTS.md). Tested
  // via the injectable home param since os.homedir() ignores $HOME under Bun.
  const home = await freshDir();
  await mkdir(join(home, ".git")); // dotfiles repo at $HOME
  const project = join(home, "work", "project");
  await mkdir(project, { recursive: true });

  const dirs = memoryDirs(project, home);
  // Only the project dir — the walk stopped before reaching $HOME.
  expect(dirs).toEqual([project]);
  // $HOME is never in the searched set.
  expect(dirs).not.toContain(home);
});

test("memoryDirs still finds a real git root below $HOME", async () => {
  // The home guard must not break the normal case: a repo at ~/work/repo is found.
  const home = await freshDir();
  const repo = join(home, "work", "repo");
  const sub = join(repo, "src");
  await mkdir(sub, { recursive: true });
  await mkdir(join(repo, ".git"));
  const dirs = memoryDirs(sub, home);
  expect(dirs).toEqual([repo, sub]); // gitRoot first, cwd last
});

test("caps an oversized memory file with a truncation marker", async () => {
  const dir = await freshDir();
  await writeFile(join(dir, "VIBE.md"), "x".repeat(MAX_MEMORY_BYTES + 5000));
  const sources = await loadMemorySources(dir);
  expect(sources[0]!.text).toContain("[memory truncated");
  expect(Buffer.byteLength(sources[0]!.text, "utf8")).toBeLessThan(MAX_MEMORY_BYTES + 200);
});

test("an over-budget USER.md keeps the NEWEST bullets + header, trims the oldest, marks the trim", async () => {
  // USER.md is appended NEWEST-last by save_memory, so a plain head-keep cap would
  // silently drop every freshly-learned preference. Isolate the global dir per-test.
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = await freshDir();
  try {
    const memDir = join(process.env.XDG_CONFIG_HOME!, "vibe-codr", "memory");
    await mkdir(memDir, { recursive: true });
    // Header, an OLDEST bullet, enough filler to blow the cap, then a NEWEST bullet
    // at the tail (where save_memory appends).
    const header = "# User memory\n\nStable preferences, one bullet each.";
    const oldest = "- OLDEST-FACT prefers tabs over spaces";
    const filler = Array.from(
      { length: 4000 },
      (_, i) => `- filler preference number ${i} kept as byte padding`,
    ).join("\n");
    const newest = "- NEWEST-FACT deploys on Fridays only";
    const body = `${header}\n${oldest}\n${filler}\n${newest}\n`;
    await writeFile(join(memDir, "USER.md"), body);
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(MAX_MEMORY_BYTES);

    // cwd is a fresh, git-less dir so ONLY the global USER.md source is returned.
    const cwd = await freshDir();
    const sources = await loadMemorySources(cwd);
    const user = sources.find((s) => s.path.endsWith("USER.md"));
    expect(user).toBeDefined();
    const text = user!.text;
    // The header and the NEWEST bullet survive; the OLDEST is trimmed out.
    expect(text).toContain("# User memory");
    expect(text).toContain("NEWEST-FACT deploys on Fridays only");
    expect(text).not.toContain("OLDEST-FACT prefers tabs over spaces");
    // A marker records the drop, and the whole injected block stays within budget.
    expect(text).toMatch(/older USER\.md bullet/i);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(MAX_MEMORY_BYTES + 300);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});
