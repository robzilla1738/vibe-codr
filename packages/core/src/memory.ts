import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, relative, resolve } from "node:path";

/**
 * Project-memory file names, in load order. We support the conventions of the
 * neighbouring tools so an existing repo Just Works: vibe-codr's own `VIBE.md`,
 * OpenAI Codex's `AGENTS.md`, and Claude Code's `CLAUDE.md`. Every file that
 * exists is included (a repo may carry more than one), each under its own
 * heading so the model can tell them apart.
 */
export const MEMORY_FILES = ["VIBE.md", "AGENTS.md", "CLAUDE.md"] as const;

/** Per-file soft cap so a giant memory file can't bloat (and cache) every turn. */
export const MAX_MEMORY_BYTES = 32 * 1024;

/**
 * Directories to search for memory, lowest precedence first: from the git root
 * down to `cwd`. We only walk up when a `.git` ancestor is found — otherwise we
 * read just `cwd`, so running outside a repo never silently slurps `~/AGENTS.md`.
 */
function memoryDirs(cwd: string): string[] {
  const start = resolve(cwd);
  const fsRoot = parse(start).root;
  const home = homedir();
  const chain: string[] = [];
  let dir = start;
  let foundGit = false;
  while (true) {
    chain.push(dir);
    if (existsSync(join(dir, ".git"))) {
      foundGit = true;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir || dir === fsRoot || dir === home) break;
    dir = parent;
  }
  // chain is [cwd, …, gitRoot]; reverse → [gitRoot, …, cwd] (cwd wins).
  return foundGit ? chain.reverse() : [start];
}

/** Soft-cap a memory file's content, appending a visible truncation marker.
 * Truncates by ENCODED BYTES (not `String.slice`'s UTF-16 code units), so a
 * file of CJK/emoji text actually honors the byte budget it claims to enforce. */
function capMemory(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= MAX_MEMORY_BYTES) return text;
  // Decode the byte-truncated slice non-fatally and drop a dangling partial
  // codepoint (U+FFFD) the cut may have produced.
  const kept = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, MAX_MEMORY_BYTES))
    .replace(/�+$/, "")
    .trimEnd();
  return `${kept}\n\n…[memory truncated to ${Math.floor(MAX_MEMORY_BYTES / 1024)} KB]`;
}

/** Path to the user-global notes file (applies across all projects). */
export function globalMemoryPath(): string {
  return join(homedir(), ".config", "vibe-codr", "VIBE.md");
}

/** One discovered memory file: where it came from and its content. */
export interface MemorySource {
  /** Human label, e.g. "global" or "project". */
  scope: "global" | "project";
  /** Display path (the global path is shown with `~`). */
  path: string;
  /** The file's trimmed content. */
  text: string;
}

async function readTrimmed(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  const text = (await file.text()).trim();
  return text.length ? text : undefined;
}

/**
 * Discover every memory file that exists, in precedence order (lowest first):
 *   1. global  `~/.config/vibe-codr/VIBE.md`
 *   2. project — walking from the git root down to `cwd`, at each directory
 *      `VIBE.md`, then `AGENTS.md`, then `CLAUDE.md`.
 * Later sources win when guidance conflicts (so `cwd` overrides the repo root,
 * which overrides global). Returns the raw sources so callers can both inject
 * them (system prompt) and list them (`/memory`). Each file is byte-capped.
 */
export async function loadMemorySources(cwd: string): Promise<MemorySource[]> {
  const sources: MemorySource[] = [];

  const global = await readTrimmed(globalMemoryPath());
  if (global) {
    sources.push({ scope: "global", path: "~/.config/vibe-codr/VIBE.md", text: capMemory(global) });
  }

  const here = resolve(cwd);
  const seen = new Set<string>();
  for (const dir of memoryDirs(cwd)) {
    for (const name of MEMORY_FILES) {
      const abs = join(dir, name);
      if (seen.has(abs)) continue;
      seen.add(abs);
      const text = await readTrimmed(abs);
      if (!text) continue;
      // Show repo-root/ancestor files by their path relative to cwd; the cwd's
      // own files stay bare (e.g. "AGENTS.md").
      const rel = dir === here ? name : `${relative(here, dir) || "."}/${name}`;
      sources.push({ scope: "project", path: rel, text: capMemory(text) });
    }
  }

  return sources;
}

/**
 * Load and concatenate project memory for the system prompt. Each source is
 * given an explicit, labelled heading (with a precedence note) so the model can
 * tell global notes from project notes and knows which wins on conflict. Returns
 * `undefined` when nothing is found so the system prompt omits the section.
 */
export async function loadProjectMemory(cwd: string): Promise<string | undefined> {
  const sources = await loadMemorySources(cwd);
  if (!sources.length) return undefined;
  const blocks = sources.map((s) => {
    const label =
      s.scope === "global"
        ? `${s.path} (global notes — apply to every project)`
        : `${s.path} (project notes — override global on conflict)`;
    return `## ${label}\n\n${s.text}`;
  });
  return blocks.join("\n\n");
}

/** `/memory` — show which memory files are loaded and their precedence. */
export function formatMemory(sources: MemorySource[]): string {
  if (!sources.length) {
    return [
      "No memory files found.",
      "  Project: add VIBE.md, AGENTS.md, or CLAUDE.md to the repo root.",
      "  Global:  add ~/.config/vibe-codr/VIBE.md (applies to every project).",
      "These notes are injected into every system prompt so the agent follows",
      "your stack and conventions. Project files override the global one.",
    ].join("\n");
  }
  const width = Math.max(...sources.map((s) => s.path.length));
  const lines = sources.map((s) => {
    const bytes = Buffer.byteLength(s.text, "utf8");
    const size = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
    return `  ${s.scope === "global" ? "○" : "●"} ${s.path.padEnd(width)} ${size}`;
  });
  return [
    "Memory loaded into every system prompt (lowest precedence first):",
    ...lines,
    "Later files override earlier ones when guidance conflicts.",
  ].join("\n");
}
