import { join } from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import type { MemoryDoc } from "./semantic-memory.ts";
import { vibeConfigDir } from "./memory.ts";

/**
 * The agent-writable, searchable "episodic" memory store: dated markdown files of
 * saved facts/decisions, separate from the human-curated, always-injected files
 * (VIBE/AGENTS/CLAUDE/USER). These are NOT injected into every prompt — they're
 * recalled on demand (hybrid search) and optionally surfaced via proactive recall,
 * so the store can grow without bloating the context window.
 */

/** Project-scoped saved memory (committed with the repo if the user wants). */
export function projectMemoryDir(cwd: string): string {
  return join(cwd, ".vibe", "memory");
}

/** User-global saved memory (applies across all projects). */
export function globalMemoryDir(): string {
  return join(vibeConfigDir(), "memory");
}

/** Read every `*.md` in `dir` as a MemoryDoc (skipping the sqlite index). */
async function readMarkdownDocs(dir: string, label: string): Promise<MemoryDoc[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return []; // dir doesn't exist yet — no saved memory
  }
  const docs: MemoryDoc[] = [];
  for (const name of entries.sort()) {
    if (!name.endsWith(".md")) continue;
    const text = await Bun.file(join(dir, name)).text().catch(() => "");
    if (text.trim()) docs.push({ source: `${label}/${name}`, text });
  }
  return docs;
}

/** Gather the full searchable memory corpus (project + global saved facts). */
export async function gatherMemoryDocs(cwd: string): Promise<MemoryDoc[]> {
  const [project, global] = await Promise.all([
    readMarkdownDocs(projectMemoryDir(cwd), ".vibe/memory"),
    readMarkdownDocs(globalMemoryDir(), "global-memory"),
  ]);
  return [...project, ...global];
}

/**
 * Serialize the read-modify-write of each dated memory file per path. Without
 * this, two concurrent `save_memory` calls (parallel subagents, or a fan-out
 * that saves several facts in one step) both read the same `existing` snapshot
 * and the later `Bun.write` clobbers the earlier one's entry — a silently lost
 * memory. In-process is sufficient: the store is written by one vibe-codr tree.
 */
const appendChains = new Map<string, Promise<unknown>>();
function serializeByPath<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = appendChains.get(path) ?? Promise.resolve();
  const result = prev.then(fn, fn);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  appendChains.set(path, settled);
  // Prune the entry once it's the tail and has settled, so the map can't grow.
  void settled.then(() => {
    if (appendChains.get(path) === settled) appendChains.delete(path);
  });
  return result;
}

export interface SaveMemoryInput {
  /** The fact/decision/preference to remember (concise, self-contained). */
  fact: string;
  /** "project" (this repo) or "global" (all projects). Default project. */
  scope?: "project" | "global";
  /** Optional tags for grouping/retrieval. */
  tags?: string[];
}

/**
 * Append a fact to the dated memory file for its scope (`YYYY-MM-DD.md`),
 * creating a day heading on first write so chunking groups the day's entries.
 * Returns a display path. `now` is injectable for deterministic tests.
 */
export async function appendMemory(
  cwd: string,
  input: SaveMemoryInput,
  now: Date = new Date(),
): Promise<string> {
  const scope = input.scope ?? "project";
  const dir = scope === "global" ? globalMemoryDir() : projectMemoryDir(cwd);
  await mkdir(dir, { recursive: true });
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 16);
  const path = join(dir, `${date}.md`);
  const tags = input.tags?.length ? ` _(${input.tags.join(", ")})_` : "";
  const entry = `- ${time} — ${input.fact.trim()}${tags}\n`;
  // The whole read → build → write must be atomic against a concurrent save to
  // the same file, or the two racing writes drop one entry.
  await serializeByPath(path, async () => {
    const existing = await Bun.file(path).text().catch(() => "");
    const header = existing.trim() ? "" : `# Memory — ${date}\n\n`;
    await Bun.write(path, `${existing}${header}${entry}`);
  });
  return scope === "global" ? `~/.config/vibe-codr/memory/${date}.md` : `.vibe/memory/${date}.md`;
}
