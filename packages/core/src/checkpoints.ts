import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId } from "@vibe/shared";

export interface Checkpoint {
  id: string;
  label: string;
  /** Commit object capturing the full working tree at snapshot time. */
  commit: string;
  createdAt: number;
  /** Conversation length at snapshot time, so `/undo` can rewind history too. */
  conversation?: { messages: number; history: number };
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Keep at most this many checkpoints; older refs are pruned. */
const MAX_CHECKPOINTS = 50;

/**
 * Workspace checkpoints via git plumbing — a safety net for agent edits. Each
 * snapshot is a commit object on a hidden `refs/vibecodr/*` ref (GC-safe,
 * never touches the user's branch/index history). `undo` restores the working
 * tree to a snapshot. Git-repo-only: a no-op (returns null) elsewhere, so the
 * caller can surface an honest notice rather than pretend it worked.
 */
export class CheckpointManager {
  #cwd: string;
  #file: string;
  #list: Checkpoint[] = [];
  #isGit: boolean | null = null;
  #loaded = false;

  constructor(cwd: string) {
    this.#cwd = cwd;
    this.#file = join(cwd, ".vibe", "checkpoints.json");
  }

  async #git(args: string[], env?: Record<string, string>): Promise<GitResult> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: this.#cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
  }

  /** Whether `cwd` is inside a git work tree (memoized). */
  async isGitRepo(): Promise<boolean> {
    if (this.#isGit === null) {
      this.#isGit = (await this.#git(["rev-parse", "--is-inside-work-tree"])).ok;
    }
    return this.#isGit;
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const file = Bun.file(this.#file);
      if (await file.exists()) this.#list = (await file.json()) as Checkpoint[];
    } catch {
      this.#list = [];
    }
  }

  async #save(): Promise<void> {
    try {
      await Bun.write(this.#file, `${JSON.stringify(this.#list, null, 2)}\n`);
    } catch {
      // Non-fatal: a missing checkpoint log just means /undo can't span restarts.
    }
  }

  /** Snapshot the working tree. Returns the checkpoint, or null when not a repo. */
  async snapshot(
    label: string,
    conversation?: { messages: number; history: number },
  ): Promise<Checkpoint | null> {
    if (!(await this.isGitRepo())) return null;
    await this.#ensureLoaded();

    const id = createId("cp");
    // Stage and write the tree against a throwaway index file, so the user's
    // real staging area is never touched — correct even in a repo with no
    // commits yet (where `git reset` has no HEAD to restore the index to).
    const indexFile = join(tmpdir(), `vibecodr-index-${id}`);
    const env = { GIT_INDEX_FILE: indexFile };
    let commit = "";
    try {
      await this.#git(["add", "-A"], env);
      const tree = (await this.#git(["write-tree"], env)).stdout;
      if (!tree) return null;

      const head = await this.#git(["rev-parse", "HEAD"]);
      const parent = head.ok ? ["-p", head.stdout] : [];
      commit = (
        await this.#git(["commit-tree", tree, ...parent, "-m", `vibecodr: ${label}`])
      ).stdout;
    } finally {
      await rm(indexFile, { force: true }).catch(() => undefined);
    }
    if (!commit) return null;

    await this.#git(["update-ref", `refs/vibecodr/${id}`, commit]);

    const cp: Checkpoint = {
      id,
      label,
      commit,
      createdAt: Date.now(),
      ...(conversation ? { conversation } : {}),
    };
    this.#list.push(cp);
    // Prune the oldest checkpoints so refs don't grow without bound.
    while (this.#list.length > MAX_CHECKPOINTS) {
      const old = this.#list.shift();
      if (old) await this.#git(["update-ref", "-d", `refs/vibecodr/${old.id}`]);
    }
    await this.#save();
    return cp;
  }

  /** Restore the most recent checkpoint (popping it). Null when none/not a repo. */
  async undo(): Promise<Checkpoint | null> {
    if (!(await this.isGitRepo())) return null;
    await this.#ensureLoaded();
    const cp = this.#list.pop();
    if (!cp) return null;

    // Restore the working tree from the snapshot via a THROWAWAY index, so the
    // user's real staging area is never disturbed (the old code did `read-tree`
    // + `reset` on the live index, wiping the user's staged changes).
    const indexFile = join(tmpdir(), `vibecodr-undo-${cp.id}`);
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      await this.#git(["read-tree", cp.commit], env);
      await this.#git(["checkout-index", "-a", "-f"], env);
    } finally {
      await rm(indexFile, { force: true }).catch(() => undefined);
    }

    // Remove only files created since the snapshot — untracked now and absent
    // from the snapshot tree. The snapshot `add -A`'d everything, so any file the
    // user already had is in the tree and is preserved; this never deletes the
    // user's pre-existing untracked files (the old `clean -fdq` did).
    const untracked = (await this.#git(["ls-files", "--others", "--exclude-standard"])).stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (untracked.length) {
      const inSnapshot = new Set(
        (await this.#git(["ls-tree", "-r", "--name-only", cp.commit])).stdout
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      for (const file of untracked) {
        if (!inSnapshot.has(file)) {
          await rm(join(this.#cwd, file), { force: true }).catch(() => undefined);
        }
      }
    }

    await this.#git(["update-ref", "-d", `refs/vibecodr/${cp.id}`]);

    await this.#save();
    return cp;
  }

  /** Checkpoints, newest last. */
  async list(): Promise<Checkpoint[]> {
    await this.#ensureLoaded();
    return [...this.#list];
  }
}
