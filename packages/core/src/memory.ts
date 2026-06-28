import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Project-memory file names, in load order. We support the conventions of the
 * neighbouring tools so an existing repo Just Works: vibe-codr's own `VIBE.md`,
 * OpenAI Codex's `AGENTS.md`, and Claude Code's `CLAUDE.md`. Every file that
 * exists is included (a repo may carry more than one), each under its own
 * heading so the model can tell them apart.
 */
export const MEMORY_FILES = ["VIBE.md", "AGENTS.md", "CLAUDE.md"] as const;

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
 *   2. project `./VIBE.md`, then `./AGENTS.md`, then `./CLAUDE.md`
 * Later files win when guidance conflicts. Returns the raw sources so callers
 * can both inject them (system prompt) and list them (`/memory`).
 */
export async function loadMemorySources(cwd: string): Promise<MemorySource[]> {
  const sources: MemorySource[] = [];

  const global = await readTrimmed(globalMemoryPath());
  if (global) {
    sources.push({ scope: "global", path: "~/.config/vibe-codr/VIBE.md", text: global });
  }

  for (const name of MEMORY_FILES) {
    const text = await readTrimmed(join(cwd, name));
    if (text) sources.push({ scope: "project", path: name, text });
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
  const lines = sources.map((s) => {
    const bytes = Buffer.byteLength(s.text, "utf8");
    const size = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
    return `  ${s.scope === "global" ? "○" : "●"} ${s.path.padEnd(28)} ${size}`;
  });
  return [
    "Memory loaded into every system prompt (lowest precedence first):",
    ...lines,
    "Later files override earlier ones when guidance conflicts.",
  ].join("\n");
}
