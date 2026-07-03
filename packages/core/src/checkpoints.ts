import { mkdir, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createId, type GateSummary } from "@vibe/shared";
import { globalStateDir } from "./state-dir.ts";

/** Monotonic per-process counter for unique checkpoint temp names (with pid). */
let checkpointWriteSeq = 0;

/** Serializes #save across CheckpointManagers sharing one checkpoints.json (two
 * sessions in ONE process, e.g. a subagent tree): both re-read + merge + rename,
 * so without a shared per-file lock they read the same stale snapshot and the
 * later rename clobbers the earlier merge. Keyed by the file path. (A separate
 * OS process is a rarer race the merge narrows but can't fully close.) */
const checkpointSaveLocks = new Map<string, Promise<void>>();

export interface Checkpoint {
  id: string;
  label: string;
  /** Commit object capturing the full working tree at snapshot time. */
  commit: string;
  createdAt: number;
  /** Conversation length at snapshot time, so `/undo` can rewind history too. */
  conversation?: { messages: number; history: number };
  /** A commit-on-green checkpoint (the real gate passed), as opposed to a
   * pre-edit safety snapshot. Absent on older/pre-edit entries (back-compat). */
  green?: boolean;
  /** The gate summary that produced a green checkpoint (absent otherwise). */
  gate?: GateSummary;
  /** The session that took this snapshot. `undo` only considers THIS session's
   * checkpoints (the shared cwd-keyed file accumulates every session's, so
   * without scoping a resumed session's /undo could revert ANOTHER session's
   * work). Absent on pre-scoping entries → treated as belonging to any session. */
  sessionId?: string;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Keep at most this many checkpoints; older refs are pruned. */
const MAX_CHECKPOINTS = 50;

/** Cap on a returned diff (chars) — a large refactor's diff would otherwise
 * blow the reviewer's context window (the same 20k bound the task reviewer uses). */
const MAX_DIFF = 20_000;

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
  #legacyFile: string;
  #list: Checkpoint[] = [];
  #isGit: boolean | null = null;
  #loaded = false;
  /** Lazy getter for the owning session id (evaluated at snapshot time — the
   * session may not exist when the manager is constructed). */
  #sessionId: (() => string | undefined) | undefined;

  constructor(cwd: string, sessionId?: () => string | undefined) {
    this.#cwd = cwd;
    this.#sessionId = sessionId;
    // Checkpoint METADATA is machine state → the project's global state dir
    // (the snapshots themselves are hidden git refs inside the repo). The old
    // in-project `.vibe/checkpoints.json` is read as a legacy fallback.
    this.#file = join(globalStateDir(cwd), "checkpoints.json");
    this.#legacyFile = join(cwd, ".vibe", "checkpoints.json");
  }

  /** Whether checkpoint `c` belongs to THIS session (so /undo + the visible list
   * are scoped to it). An untagged legacy checkpoint, or a manager with no
   * session id (tests), belongs to everyone — back-compat. */
  #ownedByThisSession(c: Checkpoint): boolean {
    const mine = this.#sessionId?.();
    return !mine || !c.sessionId || c.sessionId === mine;
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
    // Global state dir first; fall back to a pre-relocation in-project log.
    for (const path of [this.#file, this.#legacyFile]) {
      try {
        const file = Bun.file(path);
        if (await file.exists()) {
          // The shared cwd-keyed file holds EVERY session's checkpoints; scope the
          // in-memory list (which /undo + the visible list operate on) to THIS
          // session's, so a resumed session can't undo another session's work.
          // #save still re-reads the full file and merges, so nothing is dropped.
          this.#list = ((await file.json()) as Checkpoint[]).filter((c) => this.#ownedByThisSession(c));
          return;
        }
      } catch {
        /* try the next location */
      }
    }
    this.#list = [];
  }

  async #save(): Promise<void> {
    // Serialize concurrent saves to the same shared checkpoints.json so the
    // read-merge-rename critical section can't interleave (the merge alone left a
    // TOCTOU: two managers read the same snapshot, the later rename clobbered).
    const prev = checkpointSaveLocks.get(this.#file) ?? Promise.resolve();
    const run = prev.then(() => this.#saveLocked());
    // Keep the chain from rejecting so one failed save doesn't wedge the next.
    checkpointSaveLocks.set(this.#file, run.catch(() => {}));
    await run;
  }

  async #saveLocked(): Promise<void> {
    const tmp = `${this.#file}.${process.pid}.${checkpointWriteSeq++}.tmp`;
    try {
      await mkdir(dirname(this.#file), { recursive: true });
      // checkpoints.json is cwd-keyed → shared by every session in one repo. A
      // bare truncate-and-overwrite would (a) clobber a concurrent session's
      // entries (last-writer-wins) and (b) risk a torn file under interleaved
      // writes. Re-read the current on-disk list and MERGE by id (our view wins
      // for shared ids — e.g. a green marker we just added), then write via a
      // per-write-unique temp + atomic rename (mirrors the session store).
      // IMPORTANT: the merge is for the DISK FILE only — do NOT fold other
      // sessions' entries into this session's in-memory #list, or /undo would
      // restore ANOTHER session's checkpoint. #list stays scoped to this session.
      const onDisk = await this.#readListFrom(this.#file);
      const byId = new Map<string, Checkpoint>();
      for (const c of onDisk) byId.set(c.id, c);
      for (const c of this.#list) byId.set(c.id, c);
      const merged = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_CHECKPOINTS);
      await Bun.write(tmp, `${JSON.stringify(merged, null, 2)}\n`);
      await rename(tmp, this.#file);
    } catch {
      // Non-fatal: a missing checkpoint log just means /undo can't span restarts.
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  /** Read a checkpoint list from `path`, or [] if absent/corrupt. */
  async #readListFrom(path: string): Promise<Checkpoint[]> {
    try {
      const file = Bun.file(path);
      if (await file.exists()) return (await file.json()) as Checkpoint[];
    } catch {
      /* absent/corrupt → [] */
    }
    return [];
  }

  /** Snapshot the working tree. Returns the checkpoint, or null when not a repo.
   * `opts` marks a commit-on-green checkpoint (persisted in meta, back-compat). */
  async snapshot(
    label: string,
    conversation?: { messages: number; history: number },
    opts?: { green?: boolean; gate?: GateSummary },
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

    const owner = this.#sessionId?.();
    const cp: Checkpoint = {
      id,
      label,
      commit,
      createdAt: Date.now(),
      ...(conversation ? { conversation } : {}),
      ...(opts?.green ? { green: true } : {}),
      ...(opts?.gate ? { gate: opts.gate } : {}),
      ...(owner ? { sessionId: owner } : {}),
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

    // Pop checkpoints newest-first, skipping any whose snapshot commit is gone,
    // until we restore one or the list empties. This advances past a stale
    // checkpoint (e.g. GC'd object) to the next VALID one instead of giving up.
    let cp = this.#list.pop();
    while (cp) {
      // A GREEN checkpoint is a "this turn succeeded" RESULT marker whose tree
      // equals the post-edit working tree — restoring it is a visible no-op, so
      // `/undo` used to need TWO presses (one to pop the green marker, one to
      // actually revert). Discard the green marker (drop its dangling ref) and
      // undo to the pre-edit checkpoint beneath it, so ONE `/undo` reverts the turn.
      if (cp.green) {
        await this.#git(["update-ref", "-d", `refs/vibecodr/${cp.id}`]).catch(() => undefined);
        cp = this.#list.pop();
        continue;
      }
      const indexFile = join(tmpdir(), `vibecodr-undo-${cp.id}`);
      const env = { GIT_INDEX_FILE: indexFile };
      let restored = false;
      try {
        // If the snapshot commit object is gone (GC'd, or a `commit-tree` that
        // silently failed), read-tree fails with EMPTY stdout — indistinguishable
        // from a legitimately empty snapshot. Proceeding would make the cleanup
        // below (which treats "not in the snapshot tree" as "created since") delete
        // EVERY current untracked file. Skip this dead checkpoint (drop its dangling
        // ref) and try the next-older one rather than nuking the user's files.
        const read = await this.#git(["read-tree", cp.commit], env);
        if (read.ok) {
          await this.#git(["checkout-index", "-a", "-f"], env);
          restored = true;
        }
      } finally {
        await rm(indexFile, { force: true }).catch(() => undefined);
      }
      if (!restored) {
        await this.#git(["update-ref", "-d", `refs/vibecodr/${cp.id}`]).catch(() => undefined);
        cp = this.#list.pop();
        continue;
      }
      break;
    }
    if (!cp) {
      await this.#save(); // persist the dropped dead checkpoints
      return null;
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
      // Guard the snapshot listing too: a FAILED ls-tree (empty stdout) must not
      // read as "the snapshot had no files" and delete everything untracked. Only
      // prune when we could actually enumerate the snapshot tree.
      const snapshotList = await this.#git(["ls-tree", "-r", "--name-only", cp.commit]);
      if (snapshotList.ok) {
        const inSnapshot = new Set(
          snapshotList.stdout
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
    }

    await this.#git(["update-ref", "-d", `refs/vibecodr/${cp.id}`]);

    await this.#save();
    return cp;
  }

  /**
   * Unified diff of the CURRENT working tree against a checkpoint's commit
   * (`fromId`), or HEAD when the checkpoint is unknown/omitted. The tree is
   * staged into a THROWAWAY index (GIT_INDEX_FILE — never the user's) so that
   * new/untracked files show up in the diff: a plain `git diff <commit>` omits
   * them, but the reviewer must see added files. Capped at 20k chars with a
   * marker. Returns "" outside a repo or on any git error (best-effort).
   */
  async diffFrom(fromId: string | undefined, opts: { max?: number } = {}): Promise<string> {
    if (!(await this.isGitRepo())) return "";
    await this.#ensureLoaded();
    const base = fromId ? this.#list.find((c) => c.id === fromId)?.commit : undefined;
    const ref = base ?? "HEAD";
    const id = createId("diff");
    const indexFile = join(tmpdir(), `vibecodr-diff-${id}`);
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      // Stage everything into the throwaway index, then diff the base commit
      // against it — this is base→working-tree, including untracked new files,
      // without ever touching the user's real staging area.
      const add = await this.#git(["add", "-A"], env);
      if (!add.ok) return "";
      const r = await this.#git(["diff", "--cached", ref], env);
      if (!r.ok) return "";
      const max = opts.max ?? MAX_DIFF;
      return r.stdout.length > max
        ? `${r.stdout.slice(0, max)}\n…(diff truncated at ${max} chars)`
        : r.stdout;
    } finally {
      await rm(indexFile, { force: true }).catch(() => undefined);
    }
  }

  /** Checkpoints, newest last. */
  async list(): Promise<Checkpoint[]> {
    await this.#ensureLoaded();
    return [...this.#list];
  }
}
