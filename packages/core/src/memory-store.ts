import { join } from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readdir, rename, chmod, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import type { MemoryDoc } from "./semantic-memory.ts";
import { MAX_MEMORY_BYTES, vibeConfigDir } from "./memory.ts";

/** Monotonic per-process counter for unique temp names (paired with the pid), so
 * two concurrent appends never collide on one temp path. */
let writeSeq = 0;

/**
 * Overwrite `path` ATOMICALLY: write to a per-write-unique temp in the SAME
 * directory (rename is atomic only within one filesystem), preserve an existing
 * file's mode, then rename over the target. The per-path write lock already
 * serializes in-process racers; temp+rename ADDITIONALLY closes the crash-
 * truncation window — a process killed mid-append leaves the ORIGINAL memory
 * file, never a half-written one that would drop or corrupt saved facts. On any
 * failure we unlink our own temp and re-throw. Mirrors the session store's
 * temp+rename discipline (pid + counter suffix, cleanup-on-failure).
 */
async function atomicOverwrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${writeSeq++}.tmp`;
  let mode: number | undefined;
  try {
    mode = statSync(path).mode;
  } catch {
    // First write of this file — no prior mode to preserve.
  }
  try {
    await Bun.write(tmp, data);
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

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
async function readMarkdownDocs(
  dir: string,
  label: string,
): Promise<{ docs: MemoryDoc[]; failedSources: string[] }> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    // ENOENT = the dir doesn't exist yet → legitimately empty. Any OTHER error
    // (permission, transient FS fault) must PROPAGATE: returning [] here would tell
    // the index reconciler "this scope has no docs" and it would prune every vector
    // for the scope, forcing a full re-embed once the read recovers.
    if ((err as { code?: string })?.code === "ENOENT") return { docs: [], failedSources: [] };
    throw err;
  }
  const docs: MemoryDoc[] = [];
  const failedSources: string[] = [];
  for (const name of entries.sort()) {
    if (!name.endsWith(".md")) continue;
    if (ALWAYS_INJECTED.has(name)) continue;
    const source = `${label}/${name}`;
    try {
      const text = await Bun.file(join(dir, name)).text();
      if (text.trim()) docs.push({ source, text });
    } catch {
      // A per-file read failure (EACCES, transient IO) must NOT propagate and
      // force the whole gather to fail (which would skip index reconciliation
      // entirely). Instead, skip the file and report it as failed so the caller
      // can preserve its existing vectors (not prune them) while still
      // reconciling the rest of the corpus.
      failedSources.push(source);
    }
  }
  return { docs, failedSources };
}

/** Gather the full searchable memory corpus (project + global saved facts). */
export async function gatherMemoryDocs(
  cwd: string,
): Promise<{ docs: MemoryDoc[]; failedSources: string[] }> {
  const [project, global] = await Promise.all([
    readMarkdownDocs(projectMemoryDir(cwd), ".vibe/memory"),
    readMarkdownDocs(globalMemoryDir(), "global-memory"),
  ]);
  return {
    docs: [...project.docs, ...global.docs],
    failedSources: [...project.failedSources, ...global.failedSources],
  };
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
  /** Only for scope "user": the post-append USER.md is over the injection byte
   * budget, so the structure-aware cap keeps only the NEWEST bullets and trims the
   * oldest out of the injected prompt. Surfaced so `save_memory` reports honestly
   * (the file needs pruning) instead of claiming the whole file is in context. */
  overBudget?: boolean;
}

/** Lowercase + collapse whitespace, for duplicate detection across formatting. */
function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

/** Normalized form of a fact for dedup: case-, whitespace-, and trailing-
 * punctuation-insensitive, so "Use Bun." re-saved as "use bun" is one memory. */
function normalizeFact(fact: string): string {
  return normalizeText(fact)
    .trim()
    .replace(/[.!?]+$/, "");
}

/**
 * Whether an equivalent fact already exists in `existing`. A normalized
 * substring match, but only at WORD BOUNDARIES on both ends: "use bun" inside
 * "abuse bunting" or "fact 1" inside "fact 12" must NOT count as duplicates,
 * while "uses postgres" inside a longer stored "uses postgres via neon" does
 * (the knowledge is already stored — recall surfaces the fuller note).
 * An empty/punctuation-only fact counts as duplicate (nothing worth storing).
 * The haystack is `factContent(existing)` — only real fact text, never the
 * boilerplate (USER.md prose header, `# Memory`/`## HH:MM:SS —` headings, tag
 * lines) — so a short fact equal to a boilerplate phrase ("all projects") or a
 * heading's timestamp isn't falsely dropped as already-known.
 */
function containsFact(existing: string, fact: string): boolean {
  const norm = normalizeFact(fact);
  if (!norm) return true;
  // Match within a SINGLE stored fact, never across the boundary between two.
  // Collapsing the whole scope into one space-joined blob let a new fact that
  // straddles fact A's tail and fact B's head read as already-stored, silently
  // dropping a genuinely-new save. Each fact is one line in factContent().
  for (const line of factContent(existing).split("\n")) {
    const hay = normalizeText(line);
    let at = hay.indexOf(norm);
    while (at !== -1) {
      const before = at > 0 ? hay[at - 1]! : "";
      const after = at + norm.length < hay.length ? hay[at + norm.length]! : "";
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
      at = hay.indexOf(norm, at + 1);
    }
  }
  return false;
}

/** Lowercased word-token SET (length ≥ 2) of a fact, for fuzzy (Jaccard)
 * near-duplicate detection. */
function tokenSet(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2),
  );
}

/** Jaccard similarity (|A∩B| / |A∪B|) of two token sets; 0 when either is empty. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Split a stored-memory blob into INDIVIDUAL facts for per-fact fuzzy matching.
 * Dated facts live in their `## HH:MM:SS — <fact>` heading; USER.md preferences
 * live as `- <fact>` bullets. Fuzzy similarity has to compare against one fact at
 * a time — Jaccard against the whole-scope blob is always ~0 (its union swamps
 * any single fact), so it would never catch a near-duplicate. */
function individualFacts(existing: string): string[] {
  const out: string[] = [];
  for (const line of existing.split("\n")) {
    const dated = DATED_FACT_HEADING.exec(line);
    if (dated) {
      out.push(dated[1]!);
      continue;
    }
    const bullet = /^-\s+(.*)$/.exec(line.trim());
    if (bullet) out.push(bullet[1]!);
  }
  return out;
}

/** Minimum DISTINCT-token count before a save is eligible for FUZZY dedup. A
 * near-match on a SHORT string is false-positive-prone — two unrelated short
 * preferences ("uses bun", "uses npm") already share most of their tokens — so
 * the fuzzy guard only applies to longer, paraphrase-prone text (session
 * digests). Short facts fall back to the exact-substring check alone, so a terse
 * user preference is never fuzzily deduped away. */
const FUZZY_MIN_TOKENS = 10;

/** Jaccard threshold above which a paraphrase-prone save counts as a near-
 * duplicate. 0.8 is deliberately high: an LLM re-digesting the SAME resumed
 * session rewords heavily but keeps ~all its content tokens (so genuine near-
 * dupes clear 0.8), while digests of DIFFERENT sessions — different files,
 * commands, decisions — share far fewer tokens and fall well below it. */
const FUZZY_DEDUP_THRESHOLD = 0.8;

/**
 * Whether `fact` is a FUZZY near-duplicate of an existing fact in `existing`.
 * Only paraphrase-prone saves (session digests) opt into this — the exact-
 * substring `containsFact` check misses reworded near-dupes, so `--resume`
 * sessions accrete near-identical digests that recall then surfaces as noise.
 * Gated on {@link FUZZY_MIN_TOKENS} because Jaccard over short strings
 * false-positives too easily. Composes WITH (never replaces) `containsFact`.
 */
function isNearDuplicate(existing: string, fact: string): boolean {
  const set = tokenSet(fact);
  if (set.size < FUZZY_MIN_TOKENS) return false;
  for (const prior of individualFacts(existing)) {
    if (jaccard(set, tokenSet(prior)) >= FUZZY_DEDUP_THRESHOLD) return true;
  }
  return false;
}

/** The tag the engine attaches to LLM-generated session digests — the marker for
 * the paraphrase-prone saves that get the fuzzy near-duplicate guard. A plain
 * `save_memory` fact carries no such tag, so it keeps exact-substring dedup only. */
const DIGEST_TAG = "session-digest";

/** Read the concatenated text of every `*.md` in a scope dir for dedup.
 * BUG-064: fail CLOSED on unreadable dirs (return null) so callers skip
 * append rather than treating "can't read" as "no existing facts". */
async function scopeText(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    // Missing dir is empty store (OK to append); other errors are fail-closed.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return "";
    return null;
  }
  const texts = await Promise.all(
    entries
      .filter((name) => name.endsWith(".md"))
      .map((name) =>
        Bun.file(join(dir, name))
          .text()
          .catch(() => null),
      ),
  );
  if (texts.some((t) => t === null)) return null;
  return texts.join("\n");
}

/** Header written once when `save_memory` creates USER.md. */
const USER_MD_HEADER = `# User memory

Stable preferences and facts about the user, one \`- \` bullet each. This file is
injected into EVERY session's system prompt (all projects) — keep it short and
durable. Appended by \`save_memory\` (scope "user"); edit or prune freely.

`;

/** A dated-memory fact heading: `## HH:MM:SS — <fact>`. The fact text lives IN the
 * heading, so — unlike every other markdown heading, which is pure boilerplate —
 * its `<fact>` is real content we keep for dedup while dropping the timestamp. */
const DATED_FACT_HEADING = /^#{2,6} \d{2}:\d{2}:\d{2} — (.*)$/;

/**
 * Reduce a stored-memory blob to only its actual FACT content, for dedup matching.
 * The scaffolding around facts must NOT be part of the haystack, or a short fact
 * equal to a boilerplate phrase is falsely reported as already-known — e.g. the
 * USER.md prose header contains "all projects", and every dated fact sits under a
 * `# Memory — <date>` title and a `## HH:MM:SS — ` timestamp prefix. We strip: the
 * fixed USER.md header block, every markdown heading line (keeping only the `<fact>`
 * captured from a dated fact heading, since that is where dated facts live), and
 * `_(tag, tag)_` lines. Remaining lines (USER.md `- ` bullets, fact bodies) stay.
 */
function factContent(existing: string): string {
  const withoutHeader = existing.split(USER_MD_HEADER).join("");
  const kept: string[] = [];
  for (const line of withoutHeader.split("\n")) {
    const dated = DATED_FACT_HEADING.exec(line);
    if (dated) {
      kept.push(dated[1]!);
      continue;
    }
    if (line.startsWith("#")) continue; // a `# Memory`/`# User memory` title or other heading
    if (/^_\(.*\)_\s*$/.test(line.trim())) continue; // a `_(tag, tag)_` line
    kept.push(line);
  }
  return kept.join("\n");
}

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
  let overBudget = false;
  await serializeByPath(path, async () => {
    const existing = await Bun.file(path)
      .text()
      .catch(() => "");
    if (containsFact(existing, fact)) {
      deduped = true;
      return;
    }
    const header = existing.trim() ? "" : USER_MD_HEADER;
    const glue = existing && !existing.endsWith("\n") ? "\n" : "";
    const next = `${existing}${glue}${header}- ${fact.trim().replace(/\s+/g, " ")}\n`;
    await atomicOverwrite(path, next);
    // Honesty: once USER.md exceeds the injection budget the structure-aware cap
    // keeps only the NEWEST bullets (this one included) and trims the oldest, so the
    // file is no longer injected whole — report it so save_memory can suggest pruning.
    overBudget = new TextEncoder().encode(next).length > MAX_MEMORY_BYTES;
  });
  return {
    path: "~/.config/vibe-codr/memory/USER.md",
    deduped,
    ...(overBudget ? { overBudget: true } : {}),
  };
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
  // Collapse newlines/whitespace in BOTH the fact and each tag: a fact is one
  // line in its `## HH:MM:SS — <fact>` heading, and an un-collapsed newline in
  // either would write a line the fact-heading parser reads as a spurious dated
  // fact (skewing dedup + chunk boundaries).
  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
  const cleanTags = input.tags?.map(oneLine).filter(Boolean) ?? [];
  const tags = cleanTags.length ? `\n_(${cleanTags.join(", ")})_` : "";
  // One heading per fact → one chunk per fact. The trailing blank line keeps
  // sections visually separated and the fact text lives in the heading so the
  // chunk is self-describing.
  const entry = `## ${time} — ${oneLine(input.fact)}${tags}\n\n`;
  let deduped = false;
  // The whole check → read → build → write must be atomic against a concurrent
  // save to the same file, or two racing writes drop an entry (or double-save
  // the same fact past the dedup check).
  const fuzzy = input.tags?.includes(DIGEST_TAG) ?? false;
  await serializeByPath(path, async () => {
    // Scan the whole scope store (every dated file), not just today's file — a
    // fact saved last week must not re-append today. Exact-substring dedup always
    // applies; the fuzzy near-duplicate guard is layered on ONLY for digests
    // (paraphrase-prone), so a reworded re-digest of a resumed session is caught
    // without over-deduping ordinary saves.
    const scope = await scopeText(dir);
    // BUG-064: unreadable store → refuse append rather than duplicate.
    if (scope === null) {
      throw new Error(`memory scope unreadable: ${dir}`);
    }
    if (containsFact(scope, input.fact) || (fuzzy && isNearDuplicate(scope, input.fact))) {
      deduped = true;
      return;
    }
    const existing = await Bun.file(path)
      .text()
      .catch(() => "");
    const header = existing.trim() ? "" : `# Memory — ${date}\n\n`;
    await atomicOverwrite(path, `${existing}${header}${entry}`);
  });
  return {
    path: scope === "global" ? `~/.config/vibe-codr/memory/${date}.md` : `.vibe/memory/${date}.md`,
    deduped,
  };
}

/** One engine-formatted episodic memory entry. IDs are stable across pin/unpin
 * because they derive from source + timestamp + normalized fact, never tags. */
export interface StoredMemoryEntry {
  id: string;
  scope: "project" | "global";
  source: string;
  fact: string;
  tags: string[];
  pinned: boolean;
  createdAt: number;
}

interface LocatedMemoryEntry extends StoredMemoryEntry {
  filePath: string;
  sectionStart: number;
  sectionEnd: number;
}

const MEMORY_ID_MIN_PREFIX = 6;
const MEMORY_ID_LENGTH = 16;
const DATED_MEMORY_FILE = /^\d{4}-\d{2}-\d{2}\.md$/;
const STORED_FACT_HEADING = /^## (\d{2}:\d{2}:\d{2}) — (.*)$/gm;

function storedMemoryId(
  scope: "project" | "global",
  name: string,
  time: string,
  fact: string,
): string {
  return createHash("sha256")
    .update(`${scope}\0${name}\0${time}\0${normalizeFact(fact)}`)
    .digest("hex")
    .slice(0, MEMORY_ID_LENGTH);
}

function sectionTags(section: string): string[] {
  const match = /^_\(([^\n)]*)\)_\s*$/m.exec(section);
  if (!match) return [];
  return [
    ...new Set(
      match[1]!
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

function parseStoredEntries(
  text: string,
  opts: { scope: "project" | "global"; name: string; filePath: string; source: string },
): LocatedMemoryEntry[] {
  const matches = [...text.matchAll(STORED_FACT_HEADING)];
  return matches.map((match, index) => {
    const time = match[1]!;
    const fact = match[2]!.trim();
    const sectionStart = match.index!;
    const sectionEnd = matches[index + 1]?.index ?? text.length;
    const tags = sectionTags(text.slice(sectionStart, sectionEnd));
    const date = opts.name.slice(0, 10);
    return {
      id: storedMemoryId(opts.scope, opts.name, time, fact),
      scope: opts.scope,
      source: opts.source,
      fact,
      tags,
      pinned: tags.some((tag) => tag.toLowerCase() === "pinned"),
      createdAt: Date.parse(`${date}T${time}.000Z`),
      filePath: opts.filePath,
      sectionStart,
      sectionEnd,
    };
  });
}

async function entriesInScope(
  dir: string,
  scope: "project" | "global",
): Promise<LocatedMemoryEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  const entries: LocatedMemoryEntry[] = [];
  for (const name of names.filter((value) => DATED_MEMORY_FILE.test(value)).sort()) {
    const filePath = join(dir, name);
    const text = await Bun.file(filePath).text();
    const source =
      scope === "project" ? `.vibe/memory/${name}` : `~/.config/vibe-codr/memory/${name}`;
    entries.push(...parseStoredEntries(text, { scope, name, filePath, source }));
  }
  return entries;
}

async function locatedMemoryEntries(cwd: string): Promise<LocatedMemoryEntry[]> {
  const [project, global] = await Promise.all([
    entriesInScope(projectMemoryDir(cwd), "project"),
    entriesInScope(globalMemoryDir(), "global"),
  ]);
  return [...project, ...global].sort(
    (a, b) =>
      b.createdAt - a.createdAt || a.source.localeCompare(b.source) || a.id.localeCompare(b.id),
  );
}

function publicEntry(entry: LocatedMemoryEntry): StoredMemoryEntry {
  const {
    filePath: _filePath,
    sectionStart: _sectionStart,
    sectionEnd: _sectionEnd,
    ...value
  } = entry;
  return value;
}

export class MemorySelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemorySelectionError";
  }
}

function normalizeMemoryPrefix(prefix: string): string {
  const value = prefix.trim().toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${MEMORY_ID_MIN_PREFIX},${MEMORY_ID_LENGTH}}$`).test(value)) {
    throw new MemorySelectionError(
      `memory id must be a ${MEMORY_ID_MIN_PREFIX}-${MEMORY_ID_LENGTH} character hexadecimal prefix`,
    );
  }
  return value;
}

export function selectMemoryEntry<T extends StoredMemoryEntry>(entries: T[], prefix: string): T {
  const normalized = normalizeMemoryPrefix(prefix);
  const matches = entries.filter((entry) => entry.id.startsWith(normalized));
  if (!matches.length) throw new MemorySelectionError(`unknown memory id: ${normalized}`);
  if (matches.length > 1) throw new MemorySelectionError(`ambiguous memory id: ${normalized}`);
  return matches[0]!;
}

/** List only engine-formatted dated facts. Arbitrary user markdown remains
 * searchable, but is never destructively rewritten by these controls. */
export async function listMemoryEntries(cwd: string): Promise<StoredMemoryEntry[]> {
  return (await locatedMemoryEntries(cwd)).map(publicEntry);
}

/** Pin/unpin one exact, unambiguous entry while preserving all other content. */
export async function setMemoryPinned(
  cwd: string,
  prefix: string,
  pinned: boolean,
): Promise<StoredMemoryEntry> {
  const chosen = selectMemoryEntry(await locatedMemoryEntries(cwd), prefix);
  await serializeByPath(chosen.filePath, async () => {
    const text = await Bun.file(chosen.filePath).text();
    const live = selectMemoryEntry(
      parseStoredEntries(text, {
        scope: chosen.scope,
        name: chosen.source.split("/").at(-1)!,
        filePath: chosen.filePath,
        source: chosen.source,
      }),
      chosen.id,
    );
    const section = text.slice(live.sectionStart, live.sectionEnd);
    const tagMatch = /^_\(([^\n)]*)\)_\s*$/m.exec(section);
    const tags = sectionTags(section).filter((tag) => tag.toLowerCase() !== "pinned");
    if (pinned) tags.unshift("pinned");
    let nextSection: string;
    if (tagMatch?.index !== undefined) {
      const replacement = tags.length ? `_(${tags.join(", ")})_` : "";
      nextSection = `${section.slice(0, tagMatch.index)}${replacement}${section.slice(tagMatch.index + tagMatch[0].length)}`;
    } else if (tags.length) {
      const headingEnd = section.indexOf("\n");
      nextSection =
        headingEnd === -1
          ? `${section}\n_(${tags.join(", ")})_\n`
          : `${section.slice(0, headingEnd + 1)}_(${tags.join(", ")})_\n${section.slice(headingEnd + 1)}`;
    } else {
      nextSection = section;
    }
    await atomicOverwrite(
      chosen.filePath,
      `${text.slice(0, live.sectionStart)}${nextSection}${text.slice(live.sectionEnd)}`,
    );
  });
  const updated = selectMemoryEntry(await locatedMemoryEntries(cwd), chosen.id);
  return publicEntry(updated);
}

/** Explicitly forget one exact entry. Pinned protects automatic policies only;
 * a direct user command remains authoritative. */
export async function forgetMemoryEntry(cwd: string, prefix: string): Promise<StoredMemoryEntry> {
  const chosen = selectMemoryEntry(await locatedMemoryEntries(cwd), prefix);
  await serializeByPath(chosen.filePath, async () => {
    const text = await Bun.file(chosen.filePath).text();
    const live = selectMemoryEntry(
      parseStoredEntries(text, {
        scope: chosen.scope,
        name: chosen.source.split("/").at(-1)!,
        filePath: chosen.filePath,
        source: chosen.source,
      }),
      chosen.id,
    );
    const next = `${text.slice(0, live.sectionStart)}${text.slice(live.sectionEnd)}`.trimEnd();
    if (!/^## /m.test(next)) await rm(chosen.filePath, { force: true });
    else await atomicOverwrite(chosen.filePath, `${next}\n`);
  });
  return publicEntry(chosen);
}
