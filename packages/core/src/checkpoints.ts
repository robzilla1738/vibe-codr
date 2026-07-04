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

/** One undone step on the redo stack. In-memory only (does NOT persist across
 * restarts — a fresh session starts with an empty redo line). `commit` is the
 * full-tree snapshot `redo` restores to; `reAdd` are the checkpoints that become
 * live in the visible list again when this step is applied; `ownedRefs` are the
 * hidden refs this entry is responsible for — deleted when it's dropped unapplied
 * (a new edit invalidates the redo line), or, on apply, only for those NOT re-added. */
interface RedoEntry {
  commit: string;
  label: string;
  reAdd: Checkpoint[];
  ownedRefs: string[];
  /** An opaque caller payload (e.g. the sliced-off conversation tail) handed back
   * by `redo` when this step is applied. The manager never inspects it — that keeps
   * this module free of session types while still round-tripping the model context.
   * Sits on the step that restores the pre-undo tree so /redo hands it back exactly
   * when the forward walk reaches that state. */
  payload?: unknown;
}

/** What `redo` reports back to the caller (mirrors the fields `/undo` uses). */
export interface RedoResult {
  id: string;
  label: string;
  /** Opaque payload the matching undo stashed (see RedoEntry.payload). */
  payload?: unknown;
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
  /** LIFO of undone steps (see RedoEntry). Session-scoped, never persisted. */
  #redo: RedoEntry[] = [];
  /** The redo step from the most recent undo/restoreTo that restores the working
   * tree as it was BEFORE the rewind — where a conversation tail belongs. */
  #lastRedoPointEntry: RedoEntry | undefined;
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

  /** Repo TOPLEVEL, resolved once. All snapshot/restore git ops must run from
   * the toplevel, not `#cwd`: `git add -A`/`write-tree` are repo-wide even from
   * a subdir, but `checkout-index -a -f` and `ls-files --others` are CWD-PREFIX
   * scoped — so restoring from `repo/sub` would revert only the subtree while
   * the conversation is rewound for the whole turn (the model forgets edits
   * still on disk). Null until resolved; falls back to `#cwd` outside a repo. */
  #gitRoot: string | null = null;

  /** Resolve and memoize the repo toplevel. The bootstrap `rev-parse` runs from
   * `#cwd` (with `#gitRoot` still null) — `--show-toplevel` is correct from any
   * subdir — then every later `#git` runs from the toplevel. */
  async #ensureRoot(): Promise<string> {
    if (this.#gitRoot === null) {
      const top = await this.#git(["rev-parse", "--show-toplevel"]);
      this.#gitRoot = top.ok && top.stdout ? top.stdout : this.#cwd;
    }
    return this.#gitRoot;
  }

  async #git(args: string[], env?: Record<string, string>): Promise<GitResult> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: this.#gitRoot ?? this.#cwd,
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
    // Resolve the repo toplevel before any git op so restore/cleanup are
    // repo-wide even when the session runs in a subdir (idempotent + memoized).
    await this.#ensureRoot();
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
      const mine = this.#sessionId?.();
      const myIds = new Set(this.#list.map((c) => c.id));
      const byId = new Map<string, Checkpoint>();
      for (const c of onDisk) {
        // An entry POSITIVELY tagged with this session's id but absent from
        // #list was removed here (undo/restoreTo splices #list only). Re-adding
        // it via the merge would resurrect it across a restart — then a bare
        // /undo, seeing it as the newest, moves the tree FORWARD to edits the
        // user rewound away. Drop it (removal = tombstone-by-omission). Only a
        // POSITIVE id match qualifies, so untagged legacy entries and other
        // sessions' entries (the concurrent-manager case) are always preserved.
        if (mine && c.sessionId === mine && !myIds.has(c.id)) continue;
        byId.set(c.id, c);
      }
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

  /** Delete a hidden checkpoint ref (best-effort — a missing ref is fine). */
  async #deleteRef(id: string): Promise<void> {
    await this.#git(["update-ref", "-d", `refs/vibecodr/${id}`]).catch(() => undefined);
  }

  /** Commit the CURRENT working tree to a hidden, GC-safe ref and return its id +
   * commit. Staged against a THROWAWAY index (never the user's staging area) —
   * correct even in a repo with no commits yet. Null on any git failure. Shared by
   * `snapshot` (which wraps it in a Checkpoint) and `undo` (pre-undo capture). */
  async #commitTree(label: string): Promise<{ id: string; commit: string } | null> {
    const id = createId("cp");
    const indexFile = join(tmpdir(), `vibecodr-index-${id}`);
    const env = { GIT_INDEX_FILE: indexFile };
    let commit = "";
    try {
      // A partial `add -A` (e.g. one unreadable file) still yields a valid
      // write-tree, so the checkpoint would record a tree MISSING that file —
      // and a later restore's untracked-cleanup would then delete it as
      // "created since". Bail on a failed add so the snapshot is all-or-nothing.
      if (!(await this.#git(["add", "-A"], env)).ok) return null;
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
    return { id, commit };
  }

  /** Restore the working tree to `commit` (read-tree into a throwaway index →
   * checkout-index), then remove files created since the snapshot. Returns false
   * WITHOUT touching the tree when the commit object is gone (empty read-tree) —
   * the dead-commit guard that keeps a GC'd snapshot from nuking the user's
   * untracked files. Shared by undo/restoreTo/redo. */
  async #tryRestore(commit: string): Promise<boolean> {
    const indexFile = join(tmpdir(), `vibecodr-restore-${createId("r")}`);
    const env = { GIT_INDEX_FILE: indexFile };
    let restored = false;
    try {
      // A dead commit (GC'd, or a silently-failed commit-tree) fails read-tree with
      // EMPTY stdout — indistinguishable from an empty snapshot. Bailing here stops
      // the cleanup below from treating "not in the snapshot tree" as "created
      // since" and deleting every untracked file.
      const read = await this.#git(["read-tree", commit], env);
      if (read.ok) {
        await this.#git(["checkout-index", "-a", "-f"], env);
        restored = true;
      }
    } finally {
      await rm(indexFile, { force: true }).catch(() => undefined);
    }
    if (!restored) return false;

    // Remove only files created since the snapshot — untracked now and absent from
    // the snapshot tree. Guard a FAILED ls-tree (empty stdout) so it can't read as
    // "the snapshot had no files" and delete everything untracked.
    const untracked = (await this.#git(["ls-files", "--others", "--exclude-standard"])).stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (untracked.length) {
      const snapshotList = await this.#git(["ls-tree", "-r", "--name-only", commit]);
      if (snapshotList.ok) {
        const inSnapshot = new Set(
          snapshotList.stdout
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
        );
        for (const file of untracked) {
          if (!inSnapshot.has(file)) {
            await rm(join(this.#gitRoot ?? this.#cwd, file), { force: true }).catch(() => undefined);
          }
        }
      }
    }
    return true;
  }

  /** Drop the whole redo line (a new checkpoint invalidates it), releasing the
   * hidden refs it owned so they don't leak. */
  async #clearRedo(): Promise<void> {
    const stale = this.#redo;
    this.#redo = [];
    for (const e of stale) for (const id of e.ownedRefs) await this.#deleteRef(id);
  }

  /** How many redo steps are available (for `/checkpoints` + `/redo`). */
  redoDepth(): number {
    return this.#redo.length;
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
    // A fresh checkpoint (a new edit) invalidates any pending redo line.
    await this.#clearRedo();

    const made = await this.#commitTree(label);
    if (!made) return null;
    const { id, commit } = made;

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
      if (old) await this.#deleteRef(old.id);
    }
    await this.#save();
    return cp;
  }

  /** Restore the most recent checkpoint (single-step LIFO). Null when none/not a
   * repo. Captures the pre-undo tree on the redo step so `redo` restores the FILES
   * byte-for-byte. The conversation is NOT reconstructed by this module: the caller
   * slices off the discarded tail and hands it to `stashRedoPayload`, which pins it
   * to this same step so `redo` returns it in lockstep with the files. */
  async undo(): Promise<Checkpoint | null> {
    if (!(await this.isGitRepo())) return null;
    await this.#ensureLoaded();
    this.#lastRedoPointEntry = undefined;

    // Capture the CURRENT (pre-undo) tree first, so `redo` can restore it exactly
    // — whether or not a green result-marker happens to sit on top.
    const preUndo = await this.#commitTree("redo point");

    // Pop newest-first, skipping GREEN result markers (their tree == the post-edit
    // state, so landing on one is a visible no-op — one `/undo` should revert the
    // turn) and advancing past any dead checkpoint, until a valid pre-edit snapshot
    // restores or the list empties.
    let cp = this.#list.pop();
    while (cp) {
      if (cp.green) {
        // Green markers are ephemeral; the preUndo capture already holds this tree.
        await this.#deleteRef(cp.id);
        cp = this.#list.pop();
        continue;
      }
      if (await this.#tryRestore(cp.commit)) break;
      // Dead checkpoint: drop its dangling ref and try the next-older one.
      await this.#deleteRef(cp.id);
      cp = this.#list.pop();
    }
    if (!cp) {
      // Nothing restorable — discard the pre-undo capture; persist dropped refs.
      if (preUndo) await this.#deleteRef(preUndo.id);
      await this.#save();
      return null;
    }

    // Landed on `cp` (removed from #list). Keep its ref alive on the redo step so a
    // later redo/undo can reach it again; the redo step restores the pre-undo tree.
    if (preUndo) {
      const entry: RedoEntry = {
        commit: preUndo.commit,
        label: cp.label,
        reAdd: [cp],
        ownedRefs: [preUndo.id, cp.id],
      };
      this.#redo.push(entry);
      // This lone step restores the pre-undo tree → it carries any conversation tail.
      this.#lastRedoPointEntry = entry;
    } else {
      // No pre-undo capture possible → no redo target; drop the restored ref as the
      // old single-step behavior did.
      await this.#deleteRef(cp.id);
    }

    await this.#save();
    return cp;
  }

  /** Restore the working tree to a CHOSEN checkpoint (multi-step rewind). Every
   * checkpoint newer than the target is moved onto the redo stack (refs kept) — it
   * behaves like undoing everything newer, with the most-recently-undone (closest
   * to the target) on top so `redo` walks forward one step at a time. Returns the
   * target, or null when the id is unknown, the snapshot is dead, or not a repo. */
  async restoreTo(id: string): Promise<Checkpoint | null> {
    if (!(await this.isGitRepo())) return null;
    await this.#ensureLoaded();
    this.#lastRedoPointEntry = undefined;
    const idx = this.#list.findIndex((c) => c.id === id);
    if (idx < 0) return null;
    const target = this.#list[idx]!;

    // Capture the CURRENT working tree BEFORE mutating it — the newest edits may sit
    // ABOVE the newest checkpoint and would otherwise be unrecoverable once the tree
    // is rewound (the bug the phantom step below fixes). #commitTree stages into a
    // throwaway index, so this leaves the working tree and the user's index untouched.
    const preTree = await this.#commitTree("redo point");

    // Dead-commit guard: refuse (and release the capture) without mutating anything
    // if the target snapshot is gone.
    if (!(await this.#tryRestore(target.commit))) {
      if (preTree) await this.#deleteRef(preTree.id);
      return null;
    }

    // Everything strictly newer than the target becomes a forward (redo) step.
    const newer = this.#list.splice(idx + 1);

    // A phantom step for the pre-rewind working tree, so the forward walk terminates
    // at the ORIGINAL tree rather than one state short. Skip it when that tree is
    // identical to the newest STACKED checkpoint (redoing that checkpoint already
    // lands there — and adding it would double the last step, as when the tree is
    // clean). With NO stacked checkpoints (the target IS the newest), the phantom is
    // kept even when the tree is unchanged: it is the only possible redo step, and
    // dropping it would orphan the conversation tail the caller stashes right after
    // (a no-edit newest target — files identical, but the rewound context would be
    // unrecoverable; redoing the same-tree phantom is a file no-op that hands the
    // tail back). Pushed FIRST → bottom of the batch → restored LAST by the forward
    // walk, so it also carries the conversation tail for the whole multi-step rewind.
    if (preTree) {
      const above = newer.at(-1);
      if (!above || !(await this.#sameTree(preTree.commit, above.commit))) {
        const phantom: RedoEntry = {
          commit: preTree.commit,
          label: above?.label ?? target.label,
          reAdd: [],
          ownedRefs: [preTree.id],
        };
        this.#redo.push(phantom);
        this.#lastRedoPointEntry = phantom;
      } else {
        await this.#deleteRef(preTree.id);
      }
    }

    // Own-tree steps for each stacked checkpoint, newest-first so the
    // closest-to-target ends up on top → redo re-applies it first, stepping the tree
    // forward one checkpoint at a time (each redo of "vN" restores vN's own tree).
    for (let i = newer.length - 1; i >= 0; i--) {
      const c = newer[i]!;
      const entry: RedoEntry = {
        commit: c.commit,
        label: c.label,
        reAdd: [c],
        ownedRefs: [c.id],
      };
      this.#redo.push(entry);
      // With no phantom, the pre-rewind tree == the newest checkpoint; its step
      // (restored last of these) carries the conversation tail instead.
      if (i === newer.length - 1 && !this.#lastRedoPointEntry) this.#lastRedoPointEntry = entry;
    }
    await this.#save();
    return target;
  }

  /** Whether two commits capture the identical tree (same content), ignoring commit
   * metadata — lets `restoreTo` skip a phantom redo step that would just re-restore
   * the newest checkpoint's tree. */
  async #sameTree(a: string, b: string): Promise<boolean> {
    const [ta, tb] = await Promise.all([
      this.#git(["rev-parse", `${a}^{tree}`]),
      this.#git(["rev-parse", `${b}^{tree}`]),
    ]);
    return ta.ok && tb.ok && ta.stdout === tb.stdout;
  }

  /** Pin an opaque caller payload (e.g. the sliced-off conversation tail) to the
   * redo step that restores the pre-rewind working tree, so `redo` hands it back
   * when — and only when — the forward walk reaches that state. No-op when the last
   * undo/restoreTo produced no redo target (e.g. nothing was restorable). */
  stashRedoPayload(payload: unknown): void {
    if (this.#lastRedoPointEntry) this.#lastRedoPointEntry.payload = payload;
  }

  /** Drop every stashed redo payload while keeping the file-restore steps. Called
   * when the conversation is reset (/clear): the stashed tails belong to a context
   * that no longer exists, but redoing the TREE forward stays valid. */
  dropRedoPayloads(): void {
    for (const entry of this.#redo) entry.payload = undefined;
  }

  /** Re-apply the most recently undone step: restore the tree state that existed
   * BEFORE that undo and re-add its checkpoint(s) to the visible list. Advances
   * past a dead redo target rather than giving up. Null when the stack is empty
   * (nothing to redo) or not a repo. */
  async redo(): Promise<RedoResult | null> {
    if (!(await this.isGitRepo())) return null;
    await this.#ensureLoaded();
    let entry = this.#redo.pop();
    while (entry) {
      if (await this.#tryRestore(entry.commit)) {
        const live = new Set(entry.reAdd.map((c) => c.id));
        for (const c of entry.reAdd) this.#list.push(c);
        // Release only the refs this step owned that aren't now live in the list
        // (e.g. a throwaway pre-undo capture); re-added checkpoints keep theirs.
        for (const refId of entry.ownedRefs) if (!live.has(refId)) await this.#deleteRef(refId);
        await this.#save();
        return {
          id: entry.reAdd[0]?.id ?? entry.commit,
          label: entry.label,
          ...(entry.payload !== undefined ? { payload: entry.payload } : {}),
        };
      }
      // Dead redo target — release its refs and try the next-most-recent step.
      for (const refId of entry.ownedRefs) await this.#deleteRef(refId);
      entry = this.#redo.pop();
    }
    return null;
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
