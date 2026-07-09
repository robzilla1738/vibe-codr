import type { Mode } from "@vibe/shared";
import { createSerialLock } from "@vibe/tools";
import type { Session } from "../session.ts";

/**
 * ONE tree-shared object (created lazily by the root runner, inherited through
 * SessionDeps like reportStore) backing the three subagent-parity capabilities:
 *
 *  1. CONTINUATION — a bounded LRU of completed shared-tree `spawn_subagent`
 *     children. The live Session object IS the retained context; eviction just
 *     drops the reference so it can be GC'd. `continue_subagent` looks children up
 *     here. Worktree/ensemble/task children are NEVER retained — their cwd is torn
 *     down, so resuming into a deleted worktree would be invalid.
 *  2. DETACHED tracking — background (`detach:true`) spawns register their
 *     AbortController + settle promise here so `check_task` can report status and
 *     engine finalize can abort + await them bounded.
 *  3. SURFACING — a finished-background pending list drained into the next root
 *     turn's `<workspace-state>` block.
 */

/** A tracked detached (background) subagent or task-batch. */
export interface DetachedRecord {
  readonly id: string;
  readonly kind: "subagent" | "tasks";
  status: "running" | "completed" | "failed";
  /** Aborted by engine finalize (the spawning turn ending must NOT abort it). */
  readonly abort: AbortController;
  /** Resolves when the background work settles (already try/caught by the caller). */
  readonly promise: Promise<void>;
  /** Short human label (the objective/prompt head) for check_task + surfacing. */
  readonly summary: string;
  /** Final report text once settled (capped by the caller before display). */
  report?: string;
  isError?: boolean;
}

export class ChildRegistry {
  /** Max retained completed children (config subagent.retainCompleted). */
  readonly #retainMax: number;
  /** The shared-tree working directory (the root runner's cwd). Only a child
   * whose cwd still matches this is safe to retain — a child spawned inside a
   * worktree/ensemble task has that task's isolated cwd, which is torn down, so
   * resuming into it would land in a deleted directory. */
  readonly #sharedCwd: string | undefined;
  /** Insertion-ordered LRU: least-recently-used is the first key. */
  readonly #retained = new Map<string, Session>();
  /** Pre-coercion modes of retained children that continue_subagent forced to
   * plan while the parent was planning — restored (and cleared) on a later
   * continuation once the parent is executing again. Typed and keyed by child
   * id, never stashed as an untyped property on the Session. */
  readonly #coercedMode = new Map<string, Mode>();
  readonly #detached = new Map<string, DetachedRecord>();
  /** Background completions not yet surfaced into a root turn's workspace state. */
  #pendingFinished: string[] = [];
  /** Per-child serial locks for continue_subagent — two parallel continues on
   * the same retained Session would interleave Session.run. Different ids
   * keep independent locks so fan-out continues stay parallel. */
  readonly #continueLocks = new Map<string, <T>(fn: () => Promise<T>) => Promise<T>>();

  constructor(retainMax: number, sharedCwd?: string) {
    this.#retainMax = Math.max(0, retainMax);
    this.#sharedCwd = sharedCwd;
  }

  /** Run `fn` under the serial lock for retained child `id` (one continue at a
   * time per id). Creates the lock lazily. */
  withContinueLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    let lock = this.#continueLocks.get(id);
    if (!lock) {
      lock = createSerialLock();
      this.#continueLocks.set(id, lock);
    }
    return lock(fn);
  }

  // ── Continuation (LRU of completed spawn_subagent children) ────────────────

  /** Retain a completed child (or bump it to most-recently-used). No-op when
   * retention is disabled (retainMax 0) or when the child's cwd left the shared
   * tree (a worktree/ensemble descendant whose dir will be torn down); evicts the
   * oldest past the cap. */
  retain(child: Session): void {
    if (this.#retainMax === 0) return;
    // A worktree/ensemble-descended child's cwd is deleted when the task ends;
    // retaining it would let continue_subagent resume into an ENOENT. Only
    // shared-tree children (cwd unchanged from the root) are resumable.
    if (this.#sharedCwd !== undefined && child.cwd !== this.#sharedCwd) return;
    if (this.#retained.has(child.id)) this.#retained.delete(child.id);
    this.#retained.set(child.id, child);
    while (this.#retained.size > this.#retainMax) {
      const oldest = this.#retained.keys().next().value;
      if (oldest === undefined) break;
      this.#retained.delete(oldest); // dropping the ref lets the Session be GC'd
    }
  }

  /** Drop a retained child by id — e.g. continue_subagent found its working
   * directory gone (a worktree it descended from was cleaned up). */
  evict(id: string): void {
    this.#retained.delete(id);
    this.#coercedMode.delete(id);
    this.#continueLocks.delete(id);
  }

  /** Remember a child's mode before continue_subagent coerces it to plan (while
   * the parent is planning). No-op if one is already remembered: a child is only
   * coerced FROM a non-plan mode, so the first record is the true pre-coercion
   * mode and a re-coercion must not overwrite it. */
  rememberCoercedMode(id: string, mode: Mode): void {
    if (!this.#coercedMode.has(id)) this.#coercedMode.set(id, mode);
  }

  /** Return and clear a child's remembered pre-coercion mode — undefined if it
   * was never coerced (a plan-native child is never auto-promoted). */
  takeCoercedMode(id: string): Mode | undefined {
    const mode = this.#coercedMode.get(id);
    if (mode !== undefined) this.#coercedMode.delete(id);
    return mode;
  }

  /** Look up a retained child by id, marking it most-recently-used. */
  lookup(id: string): Session | undefined {
    const child = this.#retained.get(id);
    if (child) {
      // Refresh LRU position so an actively-continued child isn't evicted.
      this.#retained.delete(id);
      this.#retained.set(id, child);
    }
    return child;
  }

  get retainedSize(): number {
    return this.#retained.size;
  }

  // ── Detached (background) tracking ─────────────────────────────────────────

  registerDetached(rec: DetachedRecord): void {
    this.#detached.set(rec.id, rec);
  }

  getDetached(id: string): DetachedRecord | undefined {
    return this.#detached.get(id);
  }

  /** Number of detached children still running (the concurrency ceiling gate). */
  runningDetachedCount(): number {
    let n = 0;
    for (const rec of this.#detached.values()) if (rec.status === "running") n++;
    return n;
  }

  /** Mark a detached child settled and queue a one-line surfacing note. The
   * subagent-finished UI event is emitted by the runner, not here. */
  markDetachedFinished(id: string, result: { report: string; isError: boolean }): void {
    const rec = this.#detached.get(id);
    if (!rec) return;
    rec.status = result.isError ? "failed" : "completed";
    rec.report = result.report;
    rec.isError = result.isError;
    this.#pendingFinished.push(`\`${id}\`${rec.summary ? ` (${rec.summary})` : ""} — ${rec.status}`);
  }

  /** Abort every still-running detached child (engine finalize). */
  abortAllDetached(): void {
    for (const rec of this.#detached.values()) {
      if (rec.status === "running") rec.abort.abort();
    }
  }

  /** Await all detached settle promises. When `timeoutMs` is provided, return
   * after that bound even if a wedged detached promise has not settled. */
  async awaitAllDetached(timeoutMs?: number): Promise<void> {
    const promises = [...this.#detached.values()].map((r) => r.promise);
    if (!promises.length) return;
    if (timeoutMs === undefined) {
      await Promise.allSettled(promises);
      return;
    }
    await Promise.race([
      Promise.allSettled(promises),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  // ── Surfacing ──────────────────────────────────────────────────────────────

  /** Return and clear the pending background-finished notes (root turn drains it). */
  takePendingFinished(): string[] {
    if (!this.#pendingFinished.length) return [];
    const out = this.#pendingFinished;
    this.#pendingFinished = [];
    return out;
  }
}
