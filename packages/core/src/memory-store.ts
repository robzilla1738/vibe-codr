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

/** Curated, ALWAYS-INJECTED memory files that live under the global memory dir
 * (USER.md) or a repo. They're permanently in the system prompt, so pulling them
 * into the searchable recall corpus too would double-embed them and let recall
 * surface content already in context — wasting the hit budget. Excluded here. */
const ALWAYS_INJECTED = new Set(["USER.md", "VIBE.md", "AGENTS.md", "CLAUDE.md"]);

/** Read every saved-fact `*.md` in `dir` as a MemoryDoc (skipping the sqlite
 * index and the always-injected curated files). */
async function readMarkdownDocs(dir: string, label: string): Promise<MemoryDoc[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    // ENOENT = the dir doesn't exist yet → legitimately empty. Any OTHER error
    // (permission, transient FS fault) must PROPAGATE: returning [] here would tell
    // the index reconciler "this scope has no docs" and it would prune every vector
    // for the scope, forcing a full re-embed once the read recovers.
    if ((err as { code?: string })?.code === "ENOENT") return [];
    throw err;
  }
  const docs: MemoryDoc[] = [];
  for (const name of entries.sort()) {
    if (!name.endsWith(".md")) continue;
    if (ALWAYS_INJECTED.has(name)) continue;
    const text = await Bun.file(join(dir, name)).text();
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
  /** "project" (this repo), "global" (all projects, recalled on demand), or
   * "user" (a stable user preference/fact — appended to the ALWAYS-INJECTED
   * USER.md so every future session starts with it). Default project. */
  scope?: "project" | "global" | "user";
  /** Optional tags for grouping/retrieval. */
  tags?: string[];
}

export interface SaveMemoryResult {
  /** Display path of the file the fact lives in. */
  path: string;
  /** True when an equivalent fact was already stored and the save was skipped. */
  deduped: boolean;
}

/** Lowercase + collapse whitespace, for duplicate detection across formatting. */
function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

/** Normalized form of a fact for dedup: case-, whitespace-, and trailing-
 * punctuation-insensitive, so "Use Bun." re-saved as "use bun" is one memory. */
function normalizeFact(fact: string): string {
  return normalizeText(fact).trim().replace(/[.!?]+$/, "");
}

/**
 * Whether an equivalent fact already exists in `existing`. A normalized
 * substring match, but only at WORD BOUNDARIES on both ends: "use bun" inside
 * "abuse bunting" or "fact 1" inside "fact 12" must NOT count as duplicates,
 * while "uses postgres" inside a longer stored "uses postgres via neon" does
 * (the knowledge is already stored — recall surfaces the fuller note).
 * An empty/punctuation-only fact counts as duplicate (nothing worth storing).
 */
function containsFact(existing: string, fact: string): boolean {
  const norm = normalizeFact(fact);
  if (!norm) return true;
  const hay = normalizeText(existing);
  let at = hay.indexOf(norm);
  while (at !== -1) {
    const before = at > 0 ? hay[at - 1]! : "";
    const after = at + norm.length < hay.length ? hay[at + norm.length]! : "";
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    at = hay.indexOf(norm, at + 1);
  }
  return false;
}

/** Read the concatenated text of every `*.md` in a scope dir, best-effort: dedup
 * must FAIL OPEN — a transient read error means "can't prove it's a duplicate",
 * and appending twice is recoverable where silently dropping a save is not. */
async function scopeText(dir: string): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return "";
  }
  const texts = await Promise.all(
    entries
      .filter((name) => name.endsWith(".md"))
      .map((name) => Bun.file(join(dir, name)).text().catch(() => "")),
  );
  return texts.join("\n");
}

/** Header written once when `save_memory` creates USER.md. */
const USER_MD_HEADER = `# User memory

Stable preferences and facts about the user, one \`- \` bullet each. This file is
injected into EVERY session's system prompt (all projects) — keep it short and
durable. Appended by \`save_memory\` (scope "user"); edit or prune freely.

`;

/**
 * Append a stable user preference/fact to the always-injected USER.md (global
 * memory dir). Bullets are one line each (whitespace collapsed) so the file
 * stays a clean, prunable list; an equivalent existing bullet skips the append.
 */
async function appendUserMemory(fact: string): Promise<SaveMemoryResult> {
  const dir = globalMemoryDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, "USER.md");
  let deduped = false;
  await serializeByPath(path, async () => {
    const existing = await Bun.file(path).text().catch(() => "");
    if (containsFact(existing, fact)) {
      deduped = true;
      return;
    }
    const header = existing.trim() ? "" : USER_MD_HEADER;
    const glue = existing && !existing.endsWith("\n") ? "\n" : "";
    await Bun.write(path, `${existing}${glue}${header}- ${fact.trim().replace(/\s+/g, " ")}\n`);
  });
  return { path: "~/.config/vibe-codr/memory/USER.md", deduped };
}

/**
 * Append a fact to the dated memory file for its scope (`YYYY-MM-DD.md`), or —
 * scope "user" — to the always-injected USER.md.
 *
 * Each dated fact gets its OWN `## HH:MM:SS — <fact>` heading under the day's
 * `# Memory` title, so `chunkMarkdown`'s heading-based splitter yields one chunk
 * PER FACT rather than collapsing a whole day into a single chunk. A day-blob
 * chunk both dilutes each fact's embedding across every unrelated topic saved
 * that day and makes recall return the entire day instead of the matching fact
 * (audit finding). The format stays human-readable: a dated title, then one
 * timestamped section per fact with its tags.
 *
 * Saves are DEDUPLICATED against the scope's whole store (normalized substring
 * match): re-saving a known fact — the same session digest after a `--resume`,
 * a preference the model re-learns every week — reports `deduped` instead of
 * accreting copies that recall would then surface as noise. The check runs
 * inside the per-path write lock so two racing saves of the same fact can't
 * both pass it. `now` is injectable for deterministic tests.
 */
export async function appendMemory(
  cwd: string,
  input: SaveMemoryInput,
  now: Date = new Date(),
): Promise<SaveMemoryResult> {
  const scope = input.scope ?? "project";
  if (scope === "user") return appendUserMemory(input.fact);
  const dir = scope === "global" ? globalMemoryDir() : projectMemoryDir(cwd);
  await mkdir(dir, { recursive: true });
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19); // HH:MM:SS — second precision cuts
  const path = join(dir, `${date}.md`);
  const tags = input.tags?.length ? `\n_(${input.tags.join(", ")})_` : "";
  // One heading per fact → one chunk per fact. The trailing blank line keeps
  // sections visually separated and the fact text lives in the heading so the
  // chunk is self-describing.
  const entry = `## ${time} — ${input.fact.trim()}${tags}\n\n`;
  let deduped = false;
  // The whole check → read → build → write must be atomic against a concurrent
  // save to the same file, or two racing writes drop an entry (or double-save
  // the same fact past the dedup check).
  await serializeByPath(path, async () => {
    // Scan the whole scope store (every dated file), not just today's file — a
    // fact saved last week must not re-append today.
    if (containsFact(await scopeText(dir), input.fact)) {
      deduped = true;
      return;
    }
    const existing = await Bun.file(path).text().catch(() => "");
    const header = existing.trim() ? "" : `# Memory — ${date}\n\n`;
    await Bun.write(path, `${existing}${header}${entry}`);
  });
  return {
    path: scope === "global" ? `~/.config/vibe-codr/memory/${date}.md` : `.vibe/memory/${date}.md`,
    deduped,
  };
}
