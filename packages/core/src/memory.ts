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

async function readTrimmed(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  const text = (await file.text()).trim();
  return text.length ? text : undefined;
}

/**
 * Load and concatenate project memory: the user-global notes first (lowest
 * priority), then each project memory file that exists, in {@link MEMORY_FILES}
 * order. Returns `undefined` when nothing is found so the system prompt omits
 * the section entirely. The result is injected into every system prompt.
 */
export async function loadProjectMemory(cwd: string): Promise<string | undefined> {
  const blocks: string[] = [];

  const global = await readTrimmed(globalMemoryPath());
  if (global) blocks.push(`# ~/.config/vibe-codr/VIBE.md (global)\n\n${global}`);

  for (const name of MEMORY_FILES) {
    const text = await readTrimmed(join(cwd, name));
    if (text) blocks.push(`# ${name}\n\n${text}`);
  }

  return blocks.length ? blocks.join("\n\n") : undefined;
}
