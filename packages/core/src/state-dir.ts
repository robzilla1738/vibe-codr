import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, appendFile, readFile } from "node:fs/promises";

/**
 * Per-project MACHINE state lives OUTSIDE the project: `~/.vibe/state/<hash>/`,
 * keyed by a hash of the resolved cwd, with a `path` file inside for reverse
 * lookup. Session transcripts, engine state, checkpoints, and saved plans are
 * agent bookkeeping the user never edits — planting them in the project cwd
 * meant a brand-new directory was dirty before the agent wrote a single project
 * file, which broke scaffolders (`create-next-app .` refuses a non-empty dir)
 * and left `.vibe/` for the user to gitignore. Only user-facing artifacts
 * (`.vibe/config.json`, `VIBE.md`, agents) stay in-project.
 */
export function globalStateDir(cwd: string): string {
  const abs = resolve(cwd);
  const hash = createHash("sha256").update(abs).digest("hex").slice(0, 16);
  return join(stateRoot(), hash);
}

/** The root under which every project's state dir lives (`~/.vibe/state`).
 * Overridable via VIBE_STATE_DIR for tests and unusual homes. */
export function stateRoot(): string {
  return process.env.VIBE_STATE_DIR || join(homedir(), ".vibe", "state");
}

/** Create a project's state dir and drop the reverse-lookup `path` file.
 * Idempotent and best-effort — state writes are always best-effort. */
export async function ensureStateDir(cwd: string): Promise<string> {
  const dir = globalStateDir(cwd);
  try {
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "path"), `${resolve(cwd)}\n`);
  } catch {
    /* best-effort */
  }
  return dir;
}

/**
 * Append `.vibe/` to the project's `.gitignore` when an in-project `.vibe/`
 * artifact is created inside a git repo and it isn't ignored yet. Best-effort:
 * never throws, never rewrites existing content.
 */
export async function ensureVibeIgnored(cwd: string): Promise<void> {
  try {
    const root = join(cwd, ".git");
    if (!(await Bun.file(join(root, "HEAD")).exists())) return;
    const gitignore = join(cwd, ".gitignore");
    let current = "";
    try {
      current = await readFile(gitignore, "utf8");
    } catch {
      /* no .gitignore yet */
    }
    const ignored = current
      .split("\n")
      .map((l) => l.trim())
      .some((l) => l === ".vibe" || l === ".vibe/" || l === "/.vibe" || l === "/.vibe/");
    if (ignored) return;
    const lead = current.length && !current.endsWith("\n") ? "\n" : "";
    await appendFile(gitignore, `${lead}.vibe/\n`);
  } catch {
    /* best-effort */
  }
}
