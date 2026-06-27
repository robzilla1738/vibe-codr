import { join } from "node:path";
import { createId } from "@vibe/shared";

export interface Checkpoint {
  id: string;
  label: string;
  /** Commit object capturing the full working tree at snapshot time. */
  commit: string;
  createdAt: number;
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

  async #git(args: string[]): Promise<GitResult> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: this.#cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
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
  async snapshot(label: string): Promise<Checkpoint | null> {
    if (!(await this.isGitRepo())) return null;
    await this.#ensureLoaded();

    await this.#git(["add", "-A"]);
    const tree = (await this.#git(["write-tree"])).stdout;
    if (!tree) return null;

    const head = await this.#git(["rev-parse", "HEAD"]);
    const parent = head.ok ? ["-p", head.stdout] : [];
    const commit = (
      await this.#git(["commit-tree", tree, ...parent, "-m", `vibecodr: ${label}`])
    ).stdout;
    if (!commit) return null;

    const id = createId("cp");
    await this.#git(["update-ref", `refs/vibecodr/${id}`, commit]);
    // Restore the index to HEAD so the user's staging area is left untouched.
    if (head.ok) await this.#git(["reset", "-q"]);

    const cp: Checkpoint = { id, label, commit, createdAt: Date.now() };
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

    // index := snapshot tree; write it to the working tree; drop files created
    // since (untracked, not ignored); then restore the index to HEAD.
    await this.#git(["read-tree", cp.commit]);
    await this.#git(["checkout-index", "-a", "-f"]);
    await this.#git(["clean", "-fdq"]);
    if ((await this.#git(["rev-parse", "HEAD"])).ok) {
      await this.#git(["reset", "-q"]);
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
