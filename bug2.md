# Bug Audit Report — vibe-codr (bug2.md)

> Fresh audit of the vibe-codr codebase. No prior bug files consulted.  
> **Date:** 2026-07-08  
> **Scope:** All packages — `core`, `tools`, `config`, `providers`, `shared`, `plugins`, `tui`, `cli`

---

## Severity Definitions

| Level | Meaning |
|-------|---------|
| **🔴 CRITICAL** | Data loss, corruption, deadlock, or security bypass that can occur under normal usage |
| **🟠 HIGH** | Significant behavioral defect that silently produces wrong results or degrades reliability |

---

## 🔴 CRITICAL Findings

### C-1: `edit` tool TOCTOU between `statSync(full).mode` and the prior atomic write

**File:** [edit.ts:215](file:///Users/robert/Code/vibe-codr/packages/tools/src/builtins/edit.ts#L215)

```typescript
await atomicReplace(full, buffer, statSync(full).mode);
```

`atomicReplace` first calls `derefSymlink(full)` which resolves to a **target** path, then renames the temp to **that target**. But the `statSync(full).mode` on line 215 stats the **original `full`** path — if `full` is a symlink, `statSync` follows it (it uses `stat`, not `lstat`), so the mode is correct by luck. However, the real race is that `atomicReplace` internally calls `derefSymlink → realpathSync`, and then uses `target` for the rename. Meanwhile `statSync(full)` is called *outside* `atomicReplace`, creating a window where the file could change between the stat and the rename. If a concurrent process replaces the file with one having different permissions between the `statSync` and the `rename`, the old permissions are written.

**Impact:** File permission corruption on concurrent access.  
**Fix:** Move the `statSync` call inside `atomicReplace`, immediately before `chmod`, on the already-resolved `target` path, or pass `mode` acquisition into the function more tightly.

---

### C-2: `write` tool races `statSync` against a concurrently deleted file

**File:** [write.ts:86](file:///Users/robert/Code/vibe-codr/packages/tools/src/builtins/write.ts#L86)

```typescript
await atomicReplace(full, content, exists ? statSync(full).mode : undefined);
```

The `exists` check (line 71, `await file.exists()`) and the `statSync(full)` on line 86 are not atomic. A file that existed at `exists` but was deleted between then and `statSync` will throw `ENOENT`, crashing the tool call with an unhandled error inside the `withFileLock` block. The file lock only serializes against other vibe-codr sessions, not external processes.

**Status:** **fixed** (see BUG-082).

**Impact:** Unhandled crash on a race with external file deletion.  
**Fix:** Wrap the `statSync` in a try/catch, treating a missing file's mode as `undefined` (same as a fresh create).

---

### C-3: Freshness registry is module-level singleton — leaks across concurrent sessions in the worker

**File:** [freshness.ts:32](file:///Users/robert/Code/vibe-codr/packages/tools/src/builtins/freshness.ts#L32)

```typescript
const registry = new Map<string, Map<string, number>>();
```

The freshness registry is a module-level `Map` keyed by `sessionId`. In the worker-thread architecture (`engine-worker-entry.ts`), the worker runs a single `Engine` with a single `Session` tree. The `clearSession` cleanup is called when a session ends. However:

1. **Subagent sessions** share the same worker process and same module scope. A subagent that reads a file records it under `sessionId = "sub_..."`. If the **parent** session then edits that same file, the freshness check passes (different sessionId) — but if a **sibling** subagent reads the same file under a *different* sub-session ID, its own stale-write guard is blind to the first sibling's (or parent's) edit.

2. The `MAX_PATHS_PER_SESSION = 2000` LRU eviction silently drops tracking. An evicted path's next edit will bypass the stale-write guard entirely. In a long session touching many files (e.g., a large refactor), the guard silently degrades.

**Status:** **fixed** (see BUG-083). The module-level `Map` is replaced with a `FreshnessRegistry` class held on the engine, threaded through `SessionDeps` and `ToolContext` as a required field. The LRU cap is removed entirely (per-tree lifetime is bounded by `clear()` at teardown). `clearSession(child.id)` runs on subagent settle so the per-tree footprint tracks the active session set, not the process lifetime.

**Impact:** The stale-write guard has blind spots across the subagent tree — two sibling subagents editing the same file won't be caught by freshness (they rely on the file-lock, which serializes but doesn't detect staleness).  
**Fix:** ~~Consider a tree-global freshness registry keyed by canonical path (not per-session), or at minimum make the freshness check use the shared file-lock's canonical key for cross-session visibility.~~ Implemented as a tree-scoped `FreshnessRegistry` class with per-session storage, explicit `clearSession` on child settle, and `clear()` at engine teardown. The structural `FreshnessRegistryLike` interface lives in `@vibe/shared`; `canonicalLockKey` is extracted to its own file to break the freshness ↔ toolset circular import.

---

### C-4: `EventBus.close()` races with concurrent `emit()` — subscriber Set mutation during iteration

**File:** [event-bus.ts:34-37](file:///Users/robert/Code/vibe-codr/packages/core/src/event-bus.ts#L34-L37)

```typescript
close(): void {
    for (const queue of this.#subscribers) queue.close();
    this.#subscribers.clear();
}
```

And:

```typescript
emit(event: UIEvent): void {
    for (const queue of this.#subscribers) queue.push(event);
}
```

If `close()` is called while an `emit()` is iterating over the same `Set`, the `queue.close()` inside the `close()` loop triggers the `#consume` generator's `finally` block, which calls `this.#subscribers.delete(queue)` — **mutating the Set during iteration**. While V8 handles Set iteration over concurrent deletes gracefully (the spec says you won't visit deleted elements, but won't crash), a `clear()` following the loop + the deletes from `#consume` is a double-free of the Set entries that could confuse the iteration order.

More critically, a `close()` on a subagent's isolated bus while its parent's `emit()` is running on the **same bus** (before the child rebinds to a fresh bus) can produce a `push` on a closed `AsyncQueue`.

**Impact:** Events dropped or pushed to a closed queue during shutdown/subagent teardown.  
**Fix:** Copy the subscribers to an array before iterating in `close()`: `for (const queue of [...this.#subscribers])`.

---

### C-5: Engine `#watchInternalEvents` subscriber never unsubscribes — leaked after finalize

**File:** [engine.ts:558-562](file:///Users/robert/Code/vibe-codr/packages/core/src/engine.ts#L558-L562)

```typescript
async #watchInternalEvents(): Promise<void> {
    for await (const event of this.#bus.subscribe()) {
        if (event.type === "plan-presented") await this.#onPlanPresented(event);
    }
}
```

This subscriber is created in the constructor (`void this.#watchInternalEvents()`) and iterates the bus's `subscribe()` generator forever. The only way it stops is when `this.#bus.close()` is called. However, the `void` fire-and-forget means:

1. If `#onPlanPresented` throws, the `for await` silently exits and the subscriber stops processing `plan-presented` events for the rest of the session.
2. The `void` means the constructor doesn't await it, so finalization can call `bus.close()` while `#onPlanPresented` is mid-await on a file write — creating a torn persist.

**Impact:** Silent loss of plan persistence if `#onPlanPresented` ever throws; potential torn writes during shutdown.  
**Fix:** Wrap the body of the loop in a try/catch so a single failure doesn't kill the subscriber for the rest of the session.

---

## 🟠 HIGH Findings

### H-1: Limiter `releaseSlot` / `acquireSlot` can desync `active` count on error

**File:** [limiter.ts:154-159](file:///Users/robert/Code/vibe-codr/packages/core/src/limiter.ts#L154-L159)

The `releaseSlot()` / `acquireSlot()` pair is documented as requiring strict pairing. However, `acquireSlot` returns a `Promise<void>` — if the caller's `fn()` throws before `acquireSlot` is called (after `releaseSlot` already decremented `active`), the `run()` wrapper's `finally { release() }` will also decrement `active`, making it go **negative**. The `pump()` function then sees `active < limit` and admits waiters that should be blocked.

The `Session.suspendLimiterSlot` is the sole caller and has its own try/finally, but if the function passed to `suspendLimiterSlot` rejects **before** the inner `acquireSlot` call completes, the `run()`'s `finally` release fires with `active` already at the pre-release count minus one.

**Impact:** Concurrency ceiling violation — more concurrent turns than `limit` allows, leading to provider overload (429s).  
**Fix:** Guard the `releaseSlot` → `acquireSlot` sequence with a `try { await fn() } finally { await acquireSlot() }` pattern in the limiter itself, or add an `active >= 0` assertion.

---

### H-2: Session `#persist()` called in `finally` block can overwrite a clean save with stale data

**File:** [session.ts:1412](file:///Users/robert/Code/vibe-codr/packages/core/src/session.ts#L1412)

```typescript
} finally {
    // …
    this.busy = false;
    await this.#persist();
    bus.emit({ type: "turn-finished", … });
}
```

The `finally` block always calls `#persist()`, even after an error that partially corrupted `#modelMessages` (e.g., `#committedSteps` was pushed to `#modelMessages` with a partial assistant tail on the error path). If the prior turn's save was clean, this overwrites it with the error-path state — including potentially orphaned tool results or a partial text.

A `--resume` of this session would load the error-state messages, which may have mismatched tool_use/tool_result pairs (if the committed steps included tool_uses whose tool results were in-flight when the error hit).

**Impact:** Resumed sessions can have corrupt message history after a mid-turn error.  
**Fix:** Only persist on success, or mark the persisted session with a "dirty" flag so `--resume` can warn.

---

### H-3: `SessionStore.save` parallel Bun.write + sequential rename has a crash window

**File:** [store.ts:139-143](file:///Users/robert/Code/vibe-codr/packages/core/src/store.ts#L139-L143)

```typescript
await Promise.all(targets.map(([tmpPath, , content]) => Bun.write(tmpPath, content)));
for (const name of ["messages.jsonl", "history.jsonl", "meta.json"]) {
    const [tmpPath, finalPath] = byName(name);
    await rename(tmpPath, finalPath);
}
```

The temp files are written in parallel, then renamed sequentially. If the process crashes between the `messages.jsonl` rename and the `history.jsonl` rename, the session state is inconsistent: `messages.jsonl` is newer than `history.jsonl`. The `load()` method reads them independently without any consistency check, so a resumed session could have model messages from one turn and UI history from a different turn.

The comments say "messages first, meta last" for monotone state, but the gap between the second and third renames (a crash losing `meta.json` but having updated `messages.jsonl` and `history.jsonl`) means the meta doesn't reflect the actual content.

**Impact:** Subtle conversation inconsistency after a crash during save — the UI transcript diverges from the model context.  
**Fix:** Use a single rename of a directory (write all three files into a new temp dir, then rename the dir), or add a generation/sequence number to meta.json that the loader validates against file hashes.

---

### H-4: `BackgroundJobs` never evicts exited jobs — unbounded memory growth

**File:** [jobs.ts:65](file:///Users/robert/Code/vibe-codr/packages/tools/src/builtins/jobs.ts#L65)

```typescript
#jobs = new Map<string, Job>();
```

The `#jobs` map grows monotonically. Every `start()` adds a job, but no code ever removes an exited/killed job from the map. The `output` field retains up to 100K chars per job. A session that starts many background jobs (e.g., a `/loop` that launches build processes, or a model that background-starts then forgets) will accumulate unbounded memory.

The job's `proc` reference also keeps the Bun subprocess object alive (and potentially its stdout/stderr pipe handles).

**Impact:** Memory leak proportional to the number of background jobs started in a session.  
**Fix:** Evict jobs that have been in `exited`/`killed` status for more than N minutes, or cap the total retained jobs.

---

### H-5: `#readJsonl` truncates on first corrupt line — silently drops all subsequent valid data

**File:** [store.ts:200-208](file:///Users/robert/Code/vibe-codr/packages/core/src/store.ts#L200-L208)

```typescript
try {
    out.push(JSON.parse(line, u8Reviver) as T);
} catch {
    warnings.push(`…corrupt JSONL line; transcript truncated at the last valid entry`);
    break;
}
```

On encountering a single corrupt line, the reader `break`s and drops **all** subsequent lines. A single byte corruption in line N (e.g., from a power loss during the parallel `Bun.write`) silently loses lines N+1 through the end. For `messages.jsonl`, this means losing the most recent turns — exactly the ones the user cares about when resuming.

**Impact:** A single corrupt byte in the middle of a JSONL file silently truncates the entire remainder, losing all more-recent conversation history.  
**Fix:** `continue` instead of `break` — skip the corrupt line and keep parsing subsequent valid lines. Track the count of skipped lines for the warning.

---

### H-6: `expandQueries` year-based recency boost can produce duplicate queries

**File:** [searchcore.ts:41-46](file:///Users/robert/Code/vibe-codr/packages/tools/src/builtins/searchcore.ts#L41-L46)

```typescript
if (!/\b(19|20)\d{2}\b|year|date|when|time/.test(base.toLowerCase())) {
    const y = new Date().getUTCFullYear();
    out.push(`${core} ${y - 1} OR ${y}`);
}
```

The recency variant (`core + "2025 OR 2026"`) uses `core` (the stopword-stripped keyword version), but `core` may be identical to `base` when the query has no stopwords. The dedup `Set` at the end catches exact duplicates, but the recency variant is always distinct from `core` due to the year suffix. However, if `core` is empty or very short (≤ 4 chars), it's filtered out by the `core.length > 4` guard — but the recency variant using that same empty/short `core` is **not** filtered, producing a nonsensical query like `" 2025 OR 2026"` or `"api 2025 OR 2026"`.

**Impact:** Low-quality search queries that waste engine quota and can return irrelevant results.  
**Fix:** Guard the recency push with the same `core.length > 4` check.

---

### H-7: `write` tool's "Created" vs "Overwrote" check uses `before === ""` — falsely reports "Overwrote" for empty files

**File:** [write.ts:102](file:///Users/robert/Code/vibe-codr/packages/tools/src/builtins/write.ts#L102)

```typescript
const verb = before === "" ? "Created" : "Overwrote";
```

When an existing empty file is overwritten, `before` is `""` (an empty string from `await file.text()`), so the verb is "Created" — but the file already existed. Conversely, the intent of "Created" is to indicate a new file, but the code reports it for any file whose prior content was empty.

**Impact:** Misleading tool output to the model, which may then incorrectly believe it created a new file rather than overwrote an existing one.  
**Fix:** Use the `exists` boolean (already computed on line 71) for the verb, not the content check.

---

### H-8: `OrchestratorRunner` worktree teardown in `finally` can race with the merge lock

**File:** [orchestrator-runner.ts:855](file:///Users/robert/Code/vibe-codr/packages/core/src/orchestration/orchestrator-runner.ts#L855)

```typescript
await this.#mergeLock(() => gitRemoveWorktree(mainCwd, wt, branch)).catch(() => {});
```

The `finally` block acquires `#mergeLock` to remove the worktree. If the session is being torn down (finalize), the merge lock may already be held by a sibling task's merge that's awaiting the lock. The `.catch(() => {})` swallows all errors including lock-acquisition timeouts or AbortErrors. If the process exits while the lock is held by a torn-down sibling, the worktree + branch leak on disk.

More subtly, `#mergeLock` is a `createSerialLock()` which uses a promise chain — if the lock holder's promise never resolves (a hung process), every subsequent `#mergeLock` call queues behind it forever.

**Impact:** Leaked git worktrees and branches on process teardown, gradually polluting `.git/worktrees` and the branch namespace.  
**Fix:** Add a timeout to the merge lock acquisition in `finally` blocks, and have finalize do a best-effort `git worktree list | grep vibe` cleanup.

---

### H-9: `canonicalizeUrl` doesn't encode query parameter values — lossy for URLs with special chars

**File:** [searchcore.ts:85](file:///Users/robert/Code/vibe-codr/packages/tools/src/builtins/searchcore.ts#L85)

```typescript
const query = pairs.length ? `?${pairs.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
```

Query parameter values are joined without encoding. If a URL had `?q=hello+world` (decoded by `URL.searchParams` to `hello world`), the re-serialization produces `?q=hello world` — an invalid URL with a space. This breaks canonical-URL dedup: the same URL accessed with different encoding (`%20` vs `+`) would canonicalize to different strings.

**Impact:** Duplicate search results not deduped, wasting context window space.  
**Fix:** Use `encodeURIComponent` for both keys and values, or use `u.searchParams.toString()` after sorting.

---

### H-10: `grep` fallback's `filterFiles` doesn't handle nested `.git` directories

**File:** [grep.ts:343](file:///Users/robert/Code/vibe-codr/packages/tools/src/builtins/grep.ts#L343)

```typescript
if (f.includes("node_modules/") || f === ".git" || f.startsWith(".git/")) continue;
```

The check `f.startsWith(".git/")` only catches `.git` at the root. A submodule's `.git` directory (e.g., `vendor/lib/.git/`) would not be caught. Files inside `vendor/lib/.git/objects/` would be scanned, wasting time and potentially matching binary content.

Additionally, `f.includes("node_modules/")` catches nested `node_modules` but other common dependency dirs (`vendor/`, `.venv/`, `__pycache__/`) are not excluded in the fallback (ripgrep's default excludes handle them).

**Impact:** Grep fallback scans git internals and dependency directories, producing false matches and wasting time.  
**Fix:** Use `f.includes("/.git/") || f.startsWith(".git/")` and add common dependency directory exclusions.

---

### H-11: `Session.fork` spreads `this.#deps` then applies overrides — but `goal` default is `null` not `undefined`

**File:** [session.ts:1714-1744](file:///Users/robert/Code/vibe-codr/packages/core/src/session.ts#L1714-L1744)

```typescript
fork(overrides: Partial<SessionDeps> & { model?: string }): Session {
    return new Session({
        ...this.#deps,
        // ...explicit undefineds...
        goal: overrides.goal ?? null,
        ...overrides,
    });
}
```

The `goal: overrides.goal ?? null` line is placed **before** `...overrides`. If `overrides` contains `goal: "something"`, the spread overwrites the explicit `null`. This is the intended behavior. However, if `overrides` contains `goal: undefined` (which `Partial<SessionDeps>` allows), the `??` operator on the explicit line converts it to `null`, but then `...overrides` spreads `goal: undefined` which overwrites the `null`. The Session constructor then sets `this.goal = deps.goal ?? null` — which handles it. So this isn't a bug per se, but the ordering is fragile and any future change to the constructor's null handling could break it.

More concerning: `...this.#deps` includes the parent's `goal`, which could be a non-null string. The explicit `goal: overrides.goal ?? null` is meant to reset it, but if `overrides` doesn't contain a `goal` key at all, the `...overrides` spread doesn't touch it, and the child inherits `null` from the explicit line. **However**, the AGENTS.md states `Session.fork() must NOT inherit the parent's goal` — and this is technically respected by the explicit `goal: overrides.goal ?? null` line. But the comment/code mismatch (there's no `undefined` for `goal` like there is for `initialModelMessages`) suggests this was partially patched.

**Impact:** Fragile ordering — a refactor that reorders the spread could re-introduce parent goal inheritance.  
**Fix:** Add `goal: undefined` to the explicit list (like `initialModelMessages: undefined`) to be consistent with the other "must NOT inherit" fields.

---

### H-12: `bash` tool's abort handler adds `once: true` but doesn't remove it on normal exit

**File:** [bash.ts:101](file:///Users/robert/Code/vibe-codr/packages/tools/src/builtins/bash.ts#L101)

```typescript
ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
```

Line 138:
```typescript
ctx.abortSignal.removeEventListener("abort", onAbort);
```

The `{ once: true }` option means the listener auto-removes after firing. But `removeEventListener` on a `{ once: true }` listener that already fired is a no-op (harmless). The actual concern is different: if the `abortSignal` fires **during** the `await proc.exited` (line 130), `onAbort` fires (killing the tree), and then the `finally` block calls `removeEventListener` — which is fine. But if the signal fires during the `Promise.race` on line 131-134 (after `proc.exited` resolved but while the drain is racing), `onAbort` fires and kills a process that's already exited — `killTreeAndWait` on a dead PID.

The `killTreeAndWait(proc.pid).catch(() => {})` swallows the error, but on macOS, sending signals to a dead PID may target a recycled PID (PIDs wrap around). This is a known class of signal-safety bug.

**Impact:** Extremely unlikely but theoretically possible signal to a wrong process on PID recycling.  
**Fix:** Check if `proc.exitCode !== null` before killing in the abort handler, or track a `killed` flag.

---

### H-13: `MCP` tool name sanitization truncation uses a hash suffix but doesn't prevent collisions

**File:** Referenced in AGENTS.md — `mcpToolName()` caps at 64 chars with a hash suffix.

If two MCP tools have names that share the same first ~56 characters but differ in the tail, they'll produce the same truncated prefix + different hash suffixes. But if the hash is only a few chars, collisions are possible with many tools. More importantly, the `callTool` path must reverse-map the sanitized name back to the real MCP name — if this mapping is lost (e.g., after a reconnect where the tool list changes), the call goes to the wrong tool.

**Impact:** MCP tool call misrouting after a reconnect if tool names collide after sanitization.  
**Fix:** Use a longer hash suffix or maintain a persistent name→realName mapping that survives reconnects.

---

### H-14: `manifestSignature` can return empty string — makes the gate refresh think nothing changed

**File:** [engine.ts:181-204](file:///Users/robert/Code/vibe-codr/packages/core/src/engine.ts#L181-L204)

If no manifest files exist AND `readdirSync(cwd)` throws (unreadable directory), `parts` is empty and the function returns `""`. The gate refresh compares this to `#lastGateReconSig`. If the first check also returned `""` (same scenario), the comparison `"" === ""` is true, and the guard skips the full recon — but the cwd may have been in a transient error state the first time. A subsequent call when the directory becomes readable would produce a different signature, triggering the scan. But the initial false-stable `""` means the first real user prompt after a transient readdir failure silently skips the recon.

**Impact:** Missed gate profile refresh after a transient filesystem error.  
**Fix:** Return a sentinel like `"<unreadable>"` when all sources fail, so it never equals a previous successful signature.

---

### H-15: `Session.compact()` creates a new `AbortController` — any prior Esc intention is lost

**File:** [session.ts:1426](file:///Users/robert/Code/vibe-codr/packages/core/src/session.ts#L1426)

```typescript
async compact(): Promise<void> {
    this.#abort = new AbortController();
    // …
}
```

If the user presses Esc during a turn that triggers auto-compaction, the turn's `run()` method checks `this.#aborted()` at several points. But `/compact` (called from the engine as a slash command, which runs through `#enqueue`) creates a fresh `AbortController`, discarding the prior one. If the user had pressed Esc **before** the `/compact` command was dequeued (setting the old controller's signal), the fresh controller means the compaction proceeds despite the user's cancel intent.

The comment says "a queued Esc can't be lost" because the engine sweeps pending items — but if the `/compact` is the **active** item (already dequeued and running), the sweep doesn't touch it.

**Impact:** `/compact` ignores a pending Esc cancel that arrived between dequeue and the `new AbortController()`.  
**Fix:** Check the engine-level abort state before creating the new controller, or propagate the engine abort signal rather than replacing it.

---

## Summary

| Severity | Count | Key Themes |
|----------|-------|------------|
| 🔴 CRITICAL | 5 | TOCTOU races in file tools, module-singleton freshness leaks, EventBus mutation during iteration, fire-and-forget subscriber crash |
| 🟠 HIGH | 15 | Limiter desync, persist-on-error, JSONL corruption, memory leaks, URL canonicalization, grep exclusions, abort handling, gate refresh |

The codebase shows exceptional engineering discipline overall — atomic writes, bounded outputs, file locks, tree-global coordination. The findings above are genuine edge cases and race conditions that the existing BUG-* audit history pattern suggests the team actively hunts and fixes.
