# vibe-codr — Bug & Weakness Audit

**Status:** Fix pass in progress (2026-07-06) — 36 confirmed active findings, 43 fixed, 2 refuted (intentional design)
**Mode:** Active remediation — fixed entries carry `**Fix:**` and `**Verification:**`
**Method:** Static code review + cross-reference with tests and invariants in `AGENTS.md`. Every entry is grounded in source; speculative items are excluded.

**Loop 2 scope:** Compaction/clear accounting, build/gate/worktrees/ensemble, LSP, memory/embeddings/vector store, config hooks/schema, remaining tools, shared contracts, release scripts.

**Loop 3 scope:** Remaining core (`agents`, `loop`, `crash`, `update-check`, `blackboard`, `loaders`, `diagnostics`), CLI sessions listing, TUI editor/commands-catalog, e2e regression mining.

---

## How to use this file

Each loop should:

1. Read the **Coverage tracker** and pick the next unaudited (or partially audited) area.
2. Re-read changed files since the last loop (`git diff` / recent commits).
3. Add new findings with the next `BUG-###` id; never duplicate an existing issue.
4. Update the coverage tracker and loop header.


## Verification pass (2026-07-06)

Every `BUG-001`–`BUG-081` was re-read against current source. Each entry carries `**Verdict:**`.

| Outcome | Count | IDs |
|---------|-------|-----|
| **confirmed active** | 36 | All except 001, 002, 003, 004, 005, 006, 007, 008, 009, 010, 011, 012, 013, 014, 015, 016, 017, 018, 019, 020, 021, 022, 023, 024, 025, 026, 027, 028, 029, 030, 031, 032, 033, 034, 035, 036, 037, 038, 039, 040, 041, 042, 043, 044, 045 |
| **fixed** | 43 | BUG-001, BUG-002, BUG-003, BUG-004, BUG-005, BUG-006, BUG-007, BUG-008, BUG-009, BUG-010, BUG-011, BUG-012, BUG-013, BUG-014, BUG-015, BUG-016, BUG-017, BUG-018, BUG-019, BUG-020, BUG-021, BUG-022, BUG-023, BUG-024, BUG-025, BUG-026, BUG-027, BUG-028, BUG-029, BUG-030, BUG-031, BUG-032, BUG-034, BUG-036, BUG-037, BUG-038, BUG-039, BUG-040, BUG-041, BUG-042, BUG-043, BUG-044, BUG-045 |
| **refuted** | 2 | BUG-033 (permission glob limitation), BUG-035 (LRU stale-write tradeoff) |
| **stale citation** | 0 | Line numbers verified against current source |

---

## Summary (post-verification)

| Severity | Active | Refuted | Notes |
|----------|--------|---------|-------|
| Critical | 0 | 0 | BUG-001 fixed |
| High | 3 | 0 | BUG-002, BUG-003, BUG-004, BUG-005, BUG-006, BUG-007, BUG-008, BUG-009, BUG-010 fixed |
| Medium | 18 | 0 | BUG-010, BUG-011, BUG-012, BUG-013, BUG-014, BUG-015, BUG-016, BUG-017, BUG-018, BUG-019, BUG-020, BUG-021, BUG-022, BUG-023, BUG-024, BUG-025, BUG-026, BUG-027, BUG-028, BUG-029, BUG-030, BUG-031 fixed |
| Low | 15 | 2 | BUG-032, BUG-034, BUG-036, BUG-037, BUG-038, BUG-039, BUG-040, BUG-041, BUG-042, BUG-043, BUG-044, BUG-045 fixed; BUG-033, BUG-035 → intentional design |
| **Total** | **36** | **2** | 81 audited; 36 active, 43 fixed |

**Verification method:** Static read of every cited file at current line numbers (2026-07-06). Full per-id log in scratch `verification-log.md`.

---

## Critical

### BUG-001 — `finalize()` tears down MCP/bus without awaiting in-flight queue work

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/engine.ts` |
| **Lines** | 1065–1119 (`#doFinalize`) |
| **Severity** | Critical |

**Verdict:** fixed (2026-07-06)

**Fix:** `Engine.finalize()` now marks shutdown requested, cancels queued work,
aborts active sessions, stops loop scheduling, releases pending permission waits,
and awaits the active drain promise before closing jobs, MCP, diagnostics, memory,
or the event bus. The drain loop exposes its active promise and suppresses
`session.idle` follow-up turns during shutdown, so teardown begins only after the
in-flight FIFO item has unwound.

**Verification:** `bun test packages/core/src/queue.test.ts`; `bun run typecheck`.

**Description:** Shutdown aborts the main/loop session and clears `#pending`, but does not await the active `#drain()` loop or the in-flight `item.run()` from the FIFO queue. `finalize()` then closes `#mcp`, `#diagnostics`, `#memory`, and `#bus` while a turn may still be executing tools that depend on those resources.

**Evidence:** `#doFinalize` calls `this.#session.abort()` then proceeds directly to `await this.#mcp.close()` / `this.#bus.close()` with no `await this.#drain()` or idle wait. `whenIdle()` exists (lines 1122–1126) but is not used inside finalize.

**Reproduction:**

1. Start an interactive session with MCP tools connected.
2. Submit a prompt that triggers a long-running tool call.
3. Exit (`/exit`, Ctrl+C graceful path, or `shutdown` command) while the tool is in flight.
4. The tool adapter may still be running against a closed MCP client or emitting to a closed bus.

**Mitigation elsewhere:** Headless `-p` waits for `engine-idle` before `finalize()` (`packages/cli/src/index.ts`, `packages/tui/src/headless.ts`). TUI graceful exit is *designed* to settle first, but any caller that invokes `finalize()` without `whenIdle()` retains the race.

**Impact:** Resource leaks, silent event drops, MCP transport errors on exit, possible partial persistence.

---

## High

---

### BUG-002 — `planIdentity` omits `worktree`, `hard`, `agent`, and `outputSchema`

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **Files** | `packages/core/src/build/journal.ts` (138–146), `packages/core/src/orchestrator.ts` (15–56) |
| **Severity** | High |

**Verdict:** fixed (2026-07-06)

**Fix:** `planIdentity()` now hashes every execution-bearing `TaskSpec` field
that can change how a task runs: `worktree`, `hard`, `agent`, and
`outputSchema` in addition to the existing id/objective/deps/files/verify/check/
tier fields. `outputSchema` is canonicalized with sorted object keys before
hashing so semantically identical schemas remain stable while real schema changes
force a new plan identity.

**Verification:** `bun test packages/core/src/build/journal.test.ts`; `bun run typecheck`.

**Description:** Orchestration journal seeding hashes only `id`, `objective`, `deps`, `files`, `verify`, `check`, and `tier`. `TaskSpec` also carries `worktree`, `hard`, `agent`, and `outputSchema` — none are included in the hash. A resumed or re-submitted plan that changes only these fields reuses stale completion records and skips work.

**Evidence:** `planIdentity` signature explicitly `Pick`s only seven fields. Tests (`journal.test.ts` 150–156) assert `verify`/`check`/`files`/`tier` change identity but do **not** cover `worktree`/`hard`/`agent`/`outputSchema`.

**Reproduction:**

1. `spawn_tasks` with `{ id: "impl", objective: "…", worktree: false }` → task completes; journal stamped with hash `H`.
2. Re-submit same ids/objective with `worktree: true` → same hash `H`.
3. `loadCompletedTasks(cwd, sessionId, H)` seeds the old completion → task skipped; worktree isolation never runs.

Same class for flipping `hard`, `agent`, or `outputSchema` without changing hashed fields.

---

---

### BUG-003 — Goal run can declare "met" while gate is `unverified`

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **Files** | `packages/core/src/engine.ts` (158–168, 2805–2833) |
| **Severity** | High |

**Verdict:** fixed (2026-07-06)

**Fix:** `applyGateToVerdict()` now rejects a model-supplied `met: true`
verdict when the latest gate outcome is `unverified` or `aborted`, in addition
to `red`. A goal can no longer accumulate clean passes from an explicitly
unverified machine-check state; the run stays active with a concrete
`project checks unverified` gap instead.

**Verification:** `bun test packages/core/src/engine-goal.test.ts`; `bun run typecheck`.

**Description:** `applyGateToVerdict` forces `met: false` only when `gate === "red"`. A model verdict of `met: true` with `#lastGateOutcome === "unverified"` is accepted. `#goalCleanPasses` increments and the goal can finish after two consecutive "clean" passes without any machine verification.

**Evidence:**

```typescript
// applyGateToVerdict — only red blocks "met"
if (!verdict.met || gate !== "red") return verdict;
```

`#maybeContinueGoal` (line 2805) calls `applyGateToVerdict(await this.#assessGoal(goal), this.#lastGateOutcome)` then increments `#goalCleanPasses` on `verdict.met` with no `unverified` guard.

**Reproduction:** `/goal` on a repo with no detected checks (gate stays `unverified`). Model assessment returns `met: true` twice → goal completes with notice "verified across 2 consecutive clean passes" despite no checks ever running.

---

---

### BUG-004 — `/loop` iterations use ephemeral sessions without history, repo profile, or post-turn gate

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/engine.ts` (1607–1671) |
| **Severity** | High |

**Verdict:** fixed (2026-07-06)

**Fix:** Loop iterations no longer construct a fresh ephemeral `Session`.
They keep their FIFO `origin:"loop"` provenance, but execute through the main
`#handlePrompt()` path, so loop ticks inherit conversation history, repo profile,
repo map, diagnostics, checkpoints, prompt hooks, and the normal post-turn
verification/continuation path. `#loopSession` now aliases the active main
session while a tick runs so `/loop stop`, abort, and shutdown still target the
in-flight loop turn.

**Verification:** `bun test packages/core/src/engine-e2e.test.ts`; `bun run typecheck`.

**Description:** Each loop tick builds a fresh `Session` via `#buildSession()` with shared infra but **no** `store`, `initialModelMessages`, `initialHistory`, `repoProfile`, `repoMap`, or `diagnostics`. Loop iterations do not pass through engine `#afterTurn()` (no green-gate, verify, or goal continuation). Loop shares `#bus` with the main session, so events interleave.

**Evidence:** `#buildSession` constructor omits store/history/repo fields. `#runLoopIteration` only calls `session.run(text)` on the ephemeral session.

**Reproduction:** `/loop 30s "fix the failing tests"` — each tick starts with empty model context; `run_check` / REPO FACTS unavailable; automatic verification never runs on loop ticks.

---

---

### BUG-005 — Ollama Cloud onboarding skips API key prompt and reports success

| Field | Value |
|-------|-------|
| **Package** | `@vibe/cli`, `@vibe/providers` |
| **Files** | `packages/cli/src/onboarding.ts` (603–648), `packages/providers/src/defs.ts` (280–285), `packages/providers/src/registry.ts` (70–74) |
| **Severity** | High |

**Verdict:** fixed (2026-07-06)

**Fix:** Onboarding now evaluates provider choices with `choiceIsConfigured()`
instead of relying only on provider-level `registry.isConfigured()`. Local
keyless choices such as Ollama local still skip key prompts, but the Ollama
Cloud choice requires an actual resolved credential (`OLLAMA_API_KEY`, saved
config key, or token-derived key) despite sharing the keyless `ollama` provider
id. Skipping the cloud key therefore produces the honest “Almost there” path
instead of a false success.

**Verification:** `bun test packages/cli/src/onboarding.test.ts`; `bun test packages/providers/src/registry.test.ts`; `bun run typecheck`.

**Description:** The "Ollama Cloud · subscription" onboarding path uses registry id `ollama`, which is marked `keyless: true`. `registry.isConfigured("ollama", config)` always returns `true` for keyless providers, so onboarding skips the key prompt, prints "Using your saved credentials", and `configured` is `true` even when no `OLLAMA_API_KEY` exists.

**Evidence:** `onboarding.test.ts` (112–120) expects cloud to require a key, but runtime logic short-circuits on `isConfigured`.

**Reproduction:** Fresh install → onboarding → choose Ollama Cloud → skip key → see "You're all set" → first chat fails against local daemon with a cloud-only model id.

---

---

### BUG-006 — Subagent `fork()` inherits parent `initialLastInputTokens` and recall state

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/session.ts` (1665–1691, 330–332) |
| **Severity** | High |

**Verdict:** fixed (2026-07-06)

**Fix:** `Session.fork()` now clears the remaining resume-only seeds:
`initialLastInputTokens`, `initialRecalledContext`, and `initialSources`, in
addition to the existing history/usage/cost/store/task resets. Subagents keep
shared infrastructure such as locks, limiter, diagnostics, memory service, and
repo facts, but start with a clean conversation, token baseline, recall block,
and citation ledger unless the caller explicitly supplies overrides.

**Verification:** `bun test packages/core/src/subagent.test.ts`; `bun run typecheck`.

**Description:** `fork()` clears `initialModelMessages`, `initialHistory`, `initialUsage`, `store`, etc., but spreads `...this.#deps` first and does **not** clear `initialLastInputTokens`, `initialRecalledContext`, or `initialSources`. Child sessions inherit the parent's provider token count and proactive-recall payload with an empty message list.

**Evidence:** Constructor reads `deps.initialLastInputTokens ?? 0` into `#lastInputTokens`. `fork()` never sets these to `undefined`.

**Reproduction:** Resume parent with `lastInputTokens: 200_000` and recalled context set → `parent.fork({ bus, depth: 1 })` → child shows ~200k context fill with zero messages → spurious compaction threshold / wrong `ctx %` on first child turn; child system prompt carries parent recall text.

---

---

### BUG-007 — In-turn item window hides blocks with no way to reveal them

| Field | Value |
|-------|-------|
| **Package** | `@vibe/tui` |
| **Files** | `packages/tui/src/app.tsx` (155–161, 2255–2258), `packages/tui/src/trail.ts` (91–96) |
| **Severity** | High |

**Verdict:** fixed (2026-07-06)

**Fix:** In-turn item windowing now has a per-turn reveal affordance instead of
a dead static row. `turnWindowStart()` accepts a reveal budget, `App` tracks
revealed item counts by stable turn key, and the `"earlier items in this turn
hidden"` row is clickable/tappable to page older blocks back into the layout
tree while preserving the existing bounded render window and scroll anchoring.

**Verification:** `bun test packages/tui/src/trail.test.ts`; `bun run smoke:tui`.

**Description:** Turns with more than `TURN_ITEMS_MAX` (120) items slice rendered blocks via `turnWindowStart()`. Older items are removed from the layout tree; only a static `"▸ N earlier items in this turn hidden"` message is shown. Unlike cross-turn windowing (`revealOlder`), there is no click handler, keyboard shortcut, or pager to access hidden items. Data remains in `blocks` but is unreachable in the UI.

**Reproduction:** Run a turn with 150+ tool calls (large refactor, many greps). Items 1–30 are permanently hidden with no expand affordance.

---

---

### BUG-008 — Shift+Tab mode cycle lacks optimistic mirror update (stale-state skip)

| Field | Value |
|-------|-------|
| **Package** | `@vibe/tui` |
| **Files** | `packages/tui/src/app.tsx` (1194–1197), `packages/tui/src/modes.ts` (25–42) |
| **Severity** | High |

**Verdict:** fixed (2026-07-06)

**Fix:** Shift+Tab mode cycling now computes from the local `uiMode()` signal
and immediately updates the local `mode`/`approvals` mirrors with
`engineStateForUiMode()` after dispatching the engine commands. Engine echo
events remain authoritative, but rapid consecutive keypresses now advance from
the just-selected local state instead of recomputing from stale closure values.

**Verification:** `bun test packages/tui/src/modes.test.ts`; `bun run smoke:tui`.

**Description:** `cycleMode()` computes the next mode from closure variables `mode` / `approvals`, which update only when engine events arrive. `engineStateForUiMode()` exists specifically for optimistic local updates (documented in `modes.ts` 25–29), and `modes.test.ts` (84–99) asserts two rapid presses must advance plan → execute → yolo. `app.tsx` never calls `engineStateForUiMode` or updates local mirrors optimistically.

**Reproduction:** Rapid double Shift+Tab while engine is busy → both presses compute from the same stale state → UI sends duplicate commands for the same target → user appears stuck on one mode.

---

---

### BUG-009 — `/undo <id>` does not skip green checkpoint markers (unlike bare `/undo`)

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **Files** | `packages/core/src/checkpoints.ts` (411–421 vs 462–531), `packages/core/src/engine-commands.ts` (1095–1107) |
| **Severity** | High |

**Verdict:** fixed (2026-07-06)

**Fix:** User-facing checkpoint selection now filters out green result markers
before resolving `/undo <index|id>` and before rendering `/checkpoints`.
The raw `CheckpointManager.list()` still exposes green metadata for internal
gate/tests, but slash-command targets now match the visible restorable checkpoint
set and cannot land on a hidden green no-op marker.

**Verification:** `bun test packages/core/src/engine-commands.test.ts`; `bun test packages/core/src/checkpoints.test.ts`; `bun run typecheck`.

**Description:** Bare `undo()` pops checkpoints newest-first and **skips** `green` markers (lines 417–421) because their tree equals the post-edit state. `restoreTo(id)` restores directly to the target without skipping greens. Restoring a green checkpoint rewinds conversation to that mark while files often stay unchanged, dropping later chat history.

**Reproduction:** Git repo → one edit turn creates pre-edit + green checkpoints → more read-only turns → `/checkpoints` shows green as #1 → `/undo 1` → files unchanged, `messageCount` drops to green's mark; subsequent model context missing later turns.

---

## Medium

---

### BUG-010 — Shared-tree orchestrator task with `verify: true` can complete without review when child doesn't mutate

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/orchestration/orchestrator-runner.ts` (1245–1258) |
| **Severity** | Medium |

**Verdict:** fixed (2026-07-06)

**Fix:** Shared-tree task verification no longer treats a non-mutating child as
implicitly complete when `verify:true` is set. The task runner now skips review
only when `spec.verify` is false; verified tasks always run the reviewer, even
with an empty diff, so the objective/report still receives an explicit
`REVIEW-CLEAN` or actionable feedback.

**Verification:** `bun test packages/core/src/orchestration-advanced.test.ts`; `bun test packages/core/src/orchestration-integration.test.ts`; `bun run typecheck`.

**Description:** On first attempt, if `!child.didMutate && !feedback`, the task settles as `completed` even when `spec.verify === true`, skipping adversarial diff review. Retry path correctly falls through when `feedback` is set.

**Reproduction:** `spawn_tasks` task with `verify: true`; child narrates without editing → orchestrator reports success with no review.

---

---

### BUG-011 — Cross-process checkpoint metadata race (last-writer-wins)

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/checkpoints.ts` (19–24, 202–248) |
| **Severity** | Medium |

**Verdict:** fixed (2026-07-06)

**Fix:** Checkpoint metadata saves are now serialized across processes with an
atomic lock-directory around the read/merge/atomic-rename critical section.
Stale lock dirs are removed after 60s so a crashed writer cannot permanently
block saves; the existing in-process promise lock still prevents local
interleaving.

**Verification:** `bun test packages/core/src/checkpoints.test.ts`; `bun run typecheck`.

**Description:** `checkpointSaveLocks` serializes saves within one process. Comment acknowledges a separate OS process can still race on `checkpoints.json` read-merge-rename.

**Reproduction:** Two `vibecodr` processes checkpoint the same repo concurrently → one session's checkpoint metadata can be lost.

---

---

### BUG-012 — Orchestration journal append is non-atomic

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/build/journal.ts` (66–72) |
| **Severity** | Medium |

**Verdict:** fixed (2026-07-06)

**Fix:** Orchestration events now persist as individual temp-plus-rename JSON
files under the global orchestration state dir, so a crash can leave only an
ignored `.tmp` file rather than tearing the durable event. Resume reads those
atomic event files in filename order and still falls back to legacy global or
in-cwd JSONL journals for migration.

**Verification:** `bun test packages/core/src/build/journal.test.ts`; `bun run typecheck`.

**Description:** `appendOrchestrationEvent` uses `appendFileSync` without temp+rename. Crash mid-line produces a torn JSONL line (tolerated on read, but that event is lost).

**Reproduction:** Kill process during journal append → resume may re-run tasks that actually finished.

---

---

### BUG-013 — `ChildRegistry.awaitAllDetached(5000)` can return before background work finishes

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **Files** | `packages/core/src/orchestration/child-registry.ts` (154–161), `packages/core/src/engine.ts` (1102–1105) |
| **Severity** | Medium |

**Verdict:** fixed (2026-07-06)

**Fix:** `ChildRegistry.awaitAllDetached()` now has an unbounded mode when no
timeout is supplied. `Engine.finalize()` aborts all detached work and uses that
unbounded wait before closing jobs, MCP, diagnostics, memory, or the event bus,
so detached children cannot keep running against torn-down resources.

**Verification:** `bun test packages/core/src/orchestration/child-registry.test.ts`; `bun test packages/core/src/orchestration-integration.test.ts -t "engine finalize aborts an outstanding detached subagent"`; `bun run typecheck`.

**Description:** `Promise.race` with 5s timeout; after timeout, finalize closes MCP/bus while detached children may still be running (only `abort()` was signaled).

---

---

### BUG-014 — Semantic index path under project `.vibe/` while memory docs use global state

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **Files** | `packages/core/src/semantic-memory.ts` (78–81), `packages/core/src/memory-store.ts` |
| **Severity** | Medium |

**Verdict:** fixed (2026-07-06)

**Fix:** The semantic vector index now lives under the per-project global state
dir (`globalStateDir(cwd)/memory/index.sqlite`) instead of project
`.vibe/memory`. The markdown memory files remain the source of truth, while the
SQLite index is machine-local rebuildable state keyed consistently with sessions,
checkpoints, and orchestration journals.

**Verification:** `bun test packages/core/src/semantic-memory.test.ts`; `bun run typecheck`.

**Description:** Vector index lives at `<cwd>/.vibe/memory/index.sqlite`, but searchable memory docs were relocated to global dirs. Stale/duplicate indexes possible across worktrees; recall inconsistency until re-index.

---

---

### BUG-015 — Background `bash` ignores `dangerouslyUnsandboxed`

| Field | Value |
|-------|-------|
| **Package** | `@vibe/tools` |
| **Files** | `packages/tools/src/builtins/bash.ts` (57–65), `packages/tools/src/builtins/jobs.ts` (69–72) |
| **Severity** | Medium |

**Verdict:** fixed (2026-07-06)

**Fix:** Background jobs now accept `dangerouslyUnsandboxed` start options and
share a pure argv builder with tests. The `bash` tool passes its approved
unsandboxed flag through when `background:true`, so foreground and background
commands consistently skip the OS sandbox only after the same permission-gated
input requests it.

**Verification:** `bun test packages/tools/src/builtins/jobs.test.ts`; `bun run typecheck`.

**Description:** Foreground `bash` respects `dangerouslyUnsandboxed` after approval. `background: true` calls `jobs.start(command, ctx.cwd)` only — always sandbox-wrapped when policy is set.

**Reproduction:** Sandbox with `network: "off"` → approve unsandboxed `bash({ command: "npm run dev", background: true, dangerouslyUnsandboxed: true })` → job still sandboxed; foreground equivalent succeeds.

---

---

### BUG-016 — Ripgrep `fileType` aliases diverge from builtin fallback

| Field | Value |
|-------|-------|
| **Package** | `@vibe/tools` |
| **File** | `packages/tools/src/builtins/grep.ts` (39–46, 112–116) |
| **Severity** | Medium |

**Verdict:** fixed (2026-07-06)

**Fix:** The ripgrep path now uses the same `FILE_TYPE_EXTS` alias table as the
builtin fallback when a requested `fileType` is not present in `rg --type-list`.
Known ripgrep types still use `-t`, while aliases such as `python` and
`typescript` degrade to the real extension globs (`*.py`, `*.pyi`, `*.ts`,
`*.tsx`, `*.mts`, `*.cts`) instead of literal `*.python`/`*.typescript`.

**Verification:** `bun test packages/tools/src/builtins/grep.test.ts`; `bun run typecheck`.

**Description:** `FILE_TYPE_EXTS` maps `python` → `["py","pyi"]`, `typescript` → `["ts","tsx",…]` for builtin fallback. Ripgrep path uses `-t <fileType>` only if name appears in `rg --type-list`; otherwise `--glob *.<fileType>` (e.g. `*.python`, `*.typescript`), which matches no real files.

**Reproduction:** `grep({ pattern: "needle", fileType: "python" })` with `rg` on PATH → searches `*.python` → misses `foo.py`. `VIBE_GREP_NO_RIPGREP=1` finds the match.

---

---

### BUG-017 — `web_search` reports "No results" when all engines are on cooldown

| Field | Value |
|-------|-------|
| **Package** | `@vibe/tools` |
| **File** | `packages/tools/src/builtins/web-search.ts` (128–141, 196–201) |
| **Severity** | Medium |

**Verdict:** fixed (2026-07-06)

**Fix:** `web_search` now treats an empty fanout caused by every configured
engine being on cooldown as a real search failure, not a genuine no-results
answer. The retry/reformulation path uses the same guard, and the tool reports
that engines are temporarily cooling down without issuing more requests.

**Verification:** `bun test packages/tools/src/builtins/web-search.test.ts`; `bun run typecheck`.

**Description:** If every engine is skipped by `cooldown.blocked()`, `runFanout` returns `[]`. Then `anyAnswered === false` and `errors.length === 0` → normal `No results for "…"` instead of `isError: true`. Transient 429/403/503 blocks masquerade as empty results.

---

---

### BUG-018 — Builtin `grep` loads whole files into memory (OOM risk)

| Field | Value |
|-------|-------|
| **Package** | `@vibe/tools` |
| **File** | `packages/tools/src/builtins/grep.ts` (208–217) |
| **Severity** | Medium |

**Verdict:** fixed (2026-07-06)

**Fix:** Builtin fallback grep now stats each candidate before reading it and
skips files over a 10MB fallback cap, preventing a single huge file from being
loaded into memory when ripgrep is unavailable or disabled. Results include an
explicit skipped-file note so a fallback miss is not silently overconfident.

**Verification:** `bun test packages/tools/src/builtins/grep.test.ts`; `bun run typecheck`.

**Description:** Fallback path does `await Bun.file(...).text()` per candidate with per-line regex guard but **no file-size cap**. Multi-hundred-MB files can OOM when `rg` is missing or `VIBE_GREP_NO_RIPGREP` is set.

---

---

### BUG-019 — Linux `bwrap` may bind-mount non-existent writable roots

| Field | Value |
|-------|-------|
| **Package** | `@vibe/tools`, `@vibe/core` |
| **Files** | `packages/tools/src/sandbox.ts` (262–268), `packages/core/src/engine.ts` (398–406) |
| **Severity** | Medium (Linux + bwrap only) |

**Verdict:** fixed (2026-07-06)

**Fix:** Engine construction now derives the sandbox state-dir list once,
creates each app/cache/project state directory synchronously, and passes the
same list into `resolveSandboxPolicy`. On Linux, bwrap therefore receives
existing bind sources for `.vibe`, the global project state dir, config, and
cache roots before the first sandboxed command runs.

**Verification:** `bun test packages/core/src/engine.test.ts -t "constructor creates sandbox state dirs"`; `bun run typecheck`.

**Description:** `bwrapArgs` emits `--bind <root> <root>` for every writable root including `join(cwd, ".vibe")` and `globalStateDir(cwd)`. Those dirs are created lazily (`ensureStateDir` on first save), not at engine startup. `bubblewrap` requires bind sources to exist. Seatbelt macOS uses `(subpath …)` and is less affected.

**Reproduction:** Fresh project, no `.vibe` yet, sandbox `workspace-write` enabled → first sandboxed `bash` may fail immediately on Linux.

---

---

### BUG-020 — Ollama context-window probe ignores config-stored API keys

| Field | Value |
|-------|-------|
| **Package** | `@vibe/providers`, `@vibe/core` |
| **Files** | `packages/providers/src/ollama-probe.ts` (30–40), `packages/core/src/engine.ts` (1750–1754) |
| **Severity** | Medium |

**Verdict:** fixed (2026-07-06)

**Fix:** `probeOllamaContextWindow` now accepts a resolved API key from config
and uses it both to choose the Ollama Cloud native endpoint and to send the
Bearer auth header. The engine passes `config.providers.ollama.apiKey`, and the
probe cache is keyed by resolved root/auth shape so local and cloud probes do
not share one model-only memo entry.

**Verification:** `bun test packages/providers/src/ollama-probe.test.ts`; `bun run typecheck`.

**Description:** `probeOllamaContextWindow` only checks `process.env.OLLAMA_API_KEY` for cloud routing/auth, not `config.providers.ollama.apiKey`. Engine passes only `config.providers?.ollama?.baseURL`, not the resolved cloud endpoint. Cloud users with saved config key (no env var) get localhost probe → wrong context window → bad compaction thresholds.

---

---

### BUG-021 — "Ollama · local" onboarding routes to cloud when `OLLAMA_API_KEY` is set

| Field | Value |
|-------|-------|
| **Package** | `@vibe/cli` |
| **File** | `packages/cli/src/onboarding.ts` (412–418, 626) |
| **Severity** | Medium |

**Verdict:** fixed (2026-07-06)

**Fix:** Onboarding model-list options are now route-aware. Local-keyless
choices such as "Ollama · local" preserve local base URL/header configuration
but deliberately drop env/config API keys, so `OLLAMA_API_KEY` cannot make the
local choice list or route to cloud models. Cloud choices still pass the entered
or env key through normally.

**Verification:** `bun test packages/cli/src/onboarding.test.ts`; `bun run typecheck`.

**Description:** Local choice's `chooseModel` falls back to `registry.resolveAuth("ollama", config)`, which reads `OLLAMA_API_KEY` from env. Key makes `buildDef` prefer cloud base URL. User picking "Ollama · local" with env key set gets cloud model list and routing.

---

---

### BUG-022 — `McpHub.close()` does not unregister MCP tools from toolset

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/mcp.ts` (678–684 vs 299, 361, 417) |
| **Severity** | Medium |

**Verdict:** fixed (2026-07-06)

**Fix:** `McpHub.close()` now unregisters every per-server MCP tool, unregisters
the aggregate `read_mcp_resource` and `get_mcp_prompt` tools when present, resets
their registration flags, clears the hub-wide exposed-name set, and only then
closes transports and clears entries.

**Verification:** `bun test packages/core/src/mcp.test.ts`; `bun run typecheck`.

**Description:** `close()` clears transports and `#entries` but never calls `#unregisterServerTools()`. MCP tools remain registered in the toolset after shutdown. Reconnect/re-init in the same process without a fresh toolset leaves stale tool definitions callable.

---

---

### BUG-023 — MCP OAuth token store has no locking; parallel flows can drop grants

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **Files** | `packages/core/src/mcp-oauth.ts` (110–115), `packages/core/src/mcp.ts` (968–980) |
| **Severity** | Medium |

**Verdict:** fixed (2026-07-06)

**Fix:** `McpTokenStore.merge()` now serializes the complete read-merge-write
critical section through a per-store promise chain, so concurrent OAuth saves
cannot overwrite each other's fields. Temp files are per-write unique and cleaned
up on failure before the atomic rename path.

**Verification:** `bun test packages/core/src/mcp-oauth.test.ts`; `bun run typecheck`.

**Description:** `McpTokenStore.merge()` is read–merge–write without serialization. Parallel OAuth flows for two servers can interleave and drop tokens.

---

---

### BUG-024 — MCP OAuth callback listener conflicts on same redirect URL

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/mcp-oauth.ts` (250–305) |
| **Severity** | Medium |

**Verdict:** fixed (2026-07-06)

**Fix:** OAuth loopback callbacks now share one listener per redirect
host/port/path. `redirectToAuthorization()` records the authorization `state`,
and `waitForOAuthCallback()` registers state-specific waiters so concurrent
flows on the same redirect URL resolve to their own callback even when browser
redirects arrive out of order. Flows without state keep the existing FIFO
fallback behavior.

**Verification:** `bun test packages/core/src/mcp-oauth.test.ts`; `bun run typecheck`.

**Description:** `waitForOAuthCallback()` binds one `Bun.serve` per flow on the redirect host/port. Second in-flight OAuth on the same redirect URL errors or steals/wrong callback.

---

---

### BUG-025 — Corrupt `messages.jsonl` lines silently skipped on resume

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/store.ts` (186–200) |
| **Severity** | Medium |

**Verdict:** fixed (2026-07-06)

**Fix:** `SessionStore` now truncates JSONL loading at the first malformed line,
returns resume warnings, and the CLI prints those warnings when resuming. This
preserves the last valid transcript prefix and avoids accepting later tool
results whose matching tool calls may have been lost.

**Verification:** `bun test packages/core/src/store.test.ts`; `bun test packages/cli/src/index.test.ts`; `bun run typecheck`.

**Description:** `#readJsonl` skips unparseable lines with no user-visible error. Truncated last line (crash mid-write) loads with broken tool-call/tool-result pairing → provider 400 on next turn.

---

---

### BUG-026 — `/clear` race: late engine events can repopulate cleared transcript

| Field | Value |
|-------|-------|
| **Package** | `@vibe/tui` |
| **File** | `packages/tui/src/app.tsx` (1803–1831, event loop ~1485–1738) |
| **Severity** | Medium |

**Verdict:** fixed (2026-07-06)

**Fix:** The TUI now opens a `/clear` suppression window after resetting local
turn state. Transcript-producing events from the aborted turn are ignored until
the engine reaches idle or a fresh `user-message` starts a new turn, so late
deltas, tool rows, notices, plan cards, permission cards, and verify notices
cannot repopulate the cleared screen.

**Verification:** `bun run smoke:tui`; `bun run typecheck`.

**Description:** `/clear` aborts, resets local transcript, then forwards `/clear` to engine. Event loop has no generation guard. In-flight events from the aborted turn (deltas, tool-finish, notices) can still append to the freshly cleared transcript.

---

---

### BUG-027 — Assistant prose markdown always uses `streaming={false}`

| Field | Value |
|-------|-------|
| **Package** | `@vibe/tui` |
| **File** | `packages/tui/src/app.tsx` (3306–3308) |
| **Severity** | Medium |

**Verdict:** fixed (2026-07-06)

**Fix:** Assistant prose markdown now receives the reducer's live `streaming`
flag instead of hardcoding `streaming={false}`. OpenTUI can therefore use its
streaming markdown behavior while assistant text is still arriving, then switch
to finalized markdown after the reducer flips the block at turn end.

**Verification:** `bun run smoke:tui`; `bun run typecheck`.

**Description:** `AssistantText` accepts `streaming` prop and transcript passes it, but `<markdown>` for prose blocks is hardcoded `streaming={false}`. During active assistant streams, OpenTUI streaming markdown behavior (partial inline formatting) is never used for prose; only the custom block splitter handles structure. Can cause flickering or delayed inline formatting while tokens arrive.

---

---

### BUG-028 — Running subagent spinners freeze when parent turn ends

| Field | Value |
|-------|-------|
| **Package** | `@vibe/tui` |
| **File** | `packages/tui/src/app.tsx` (1466–1468, 2539–2542) |
| **Severity** | Medium |

**Verdict:** fixed (2026-07-06)

**Fix:** The TUI animation timer now advances while any subagent remains
`running`, not only while the parent turn is `working` or the jobs view is open.
Running subagent spinners and elapsed labels therefore continue updating after
the parent turn reaches `turn-finished`.

**Verification:** `bun run smoke:tui`; `bun run typecheck`.

**Description:** Animation `tick` advances only when `working() || showJobs()`. When parent turn finishes (`setWorking(false)`) while subagents are still `running`, subagent elapsed timers and spinners freeze until `subagent-finished`.

---

---

### BUG-029 — Clipboard copy reports success before async write completes

| Field | Value |
|-------|-------|
| **Package** | `@vibe/tui` |
| **Files** | `packages/tui/src/clipboard.ts` (22–33, 44–59), `packages/tui/src/app.tsx` (584–586) |
| **Severity** | Medium |

**Verdict:** fixed (2026-07-06)

**Fix:** Clipboard command writes are now awaited through stdin flush, stdin
close, and process exit; non-zero exits report failure. `copyToClipboard()` is
async, falls through failed platform writers, still honors successful OSC52, and
the TUI selection toast appears only after a copy path actually succeeds.

**Verification:** `bun test packages/tui/src/clipboard.test.ts`; `bun run smoke:tui`; `bun run typecheck`.

**Description:** `bunWrite()` returns `true` on successful `Bun.spawn`; stdin flush and process exit are fire-and-forget. `copyToClipboard()` returns `true` immediately; `flashCopied()` runs before write completes. Failed/truncated async write can still show "Copied to clipboard".

---

---

### BUG-030 — Plugin hook chain blind-replaces payload (partial returns drop fields)

| Field | Value |
|-------|-------|
| **Package** | `@vibe/plugins`, `@vibe/core` |
| **Files** | `packages/plugins/src/hooks.ts` (91), `packages/core/src/engine.ts` (2176) |
| **Severity** | Medium |

**Verdict:** fixed (2026-07-06)

**Fix:** `HookBus.run()` now merges partial object returns into the current
payload instead of replacing the payload wholesale. Partial directives such as
`{ deny: false }`, `{ additionalContext: "..." }`, or `{ continue: true }`
therefore preserve required fields like prompt `text`, tool `input`, and
`sessionId` for the rest of the chain and for engine call sites.

**Verification:** `bun test packages/plugins/src/plugin.test.ts`; `bun test packages/core/src/config-hooks.test.ts`; `bun run typecheck`.

**Description:** `if (next) current = next` replaces the full hook payload. A plugin returning `{}` or `{ deny: false }` without `text` on `user.prompt.submit` causes `text = hooked.text` → `undefined` prompt. No validation that required fields are preserved.

---

---

### BUG-031 — Unclosed YAML frontmatter fence silently ignored in skills/commands

| Field | Value |
|-------|-------|
| **Package** | `@vibe/plugins` |
| **File** | `packages/plugins/src/skills.ts` (64–65) |
| **Severity** | Medium |

**Verdict:** fixed (2026-07-06)

**Fix:** `parseSkillMarkdown()` now rejects files that open with a frontmatter
fence but never close it. Skill and command loaders already isolate per-file
parse failures, so malformed files are skipped without leaking `name:` or
`description:` lines into the body and without blocking valid neighboring files.

**Verification:** `bun test packages/plugins/src/skills.test.ts`; `bun test packages/core/src/loaders.test.ts`; `bun run typecheck`.

**Description:** `parseSkillMarkdown` only recognizes `^---\n…\n---`. Missing closing `---` returns `{ frontmatter: {}, body: raw }` — entire file including `name:` lines becomes body. Wrong metadata with no error.

---

## Low

---

### BUG-032 — `ReportStore.get()` uses `taskId` as `objective` on disk fallback

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/orchestration/report-store.ts` (43–48) |
| **Severity** | Low |

**Verdict:** fixed (2026-07-06)

**Fix:** `ReportStore` disk fallback now reads the persisted report body from
the deterministic report path and recovers the task objective from the
orchestration journal for the same session/task id. Resumed `read_report` state
therefore preserves the original objective instead of substituting the task id.

**Verification:** `bun test packages/core/src/orchestration-advanced.test.ts`; `bun test packages/core/src/build/journal.test.ts`; `bun run typecheck`.

**Description:** Disk fallback returns `{ objective: taskId, output: disk }` instead of real objective from journal.

---

---

### BUG-034 — Pre-first-step spend guard uses prior turn's `#price` estimate flag

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/session.ts` (861–869) |
| **Severity** | Low |

**Verdict:** fixed (2026-07-06)

**Fix:** Session cost accounting now tracks total accrued cost, the exact
non-estimated subset, and whether any estimated pricing contributed. The
pre-turn hard spend gate no longer consults the current/previous model's price
flag; it blocks only when prior actual spend is over the limit, while estimated
spend can still warn without hard-stopping a possibly-free local session.

**Verification:** `bun test packages/core/src/session.test.ts`; `bun run typecheck`.

**Description:** Budget block at turn start uses `this.#price` from previous step before `getPricing` runs for new model. Model switch to/from `estimated` pricing can allow or block one turn incorrectly.

---

---

### BUG-036 — `read` records freshness baseline before streaming body (narrow TOCTOU)

| Field | Value |
|-------|-------|
| **Package** | `@vibe/tools` |
| **File** | `packages/tools/src/builtins/read.ts` (45–48) |
| **Severity** | Low |

**Verdict:** fixed (2026-07-06)

**Fix:** `read` now captures the file mtime before streaming, verifies it is
unchanged after the stream, and refuses the read with an explicit re-read error
if the file moved mid-read. It records the stale-write freshness baseline only
after a stable successful read, so binary/error reads and mid-stream races no
longer mark unseen content as safe to edit.

**Verification:** `bun test packages/tools/src/builtins/read.test.ts`; `bun test packages/tools/src/builtins/freshness.test.ts`; `bun run typecheck`.

**Description:** `recordSeen` runs before streaming content. External edit during read can produce torn content; stale detection depends on post-read mtime change.

---

---

### BUG-037 — `file-changed` fold drops tool timing metadata

| Field | Value |
|-------|-------|
| **Package** | `@vibe/tui` |
| **File** | `packages/tui/src/reducer.ts` (313–322) |
| **Severity** | Low |

**Verdict:** fixed (2026-07-06)

**Fix:** `file-changed` actions now carry an app-time finish stamp, and the
reducer preserves the producing tool row's `startedAt`, live `tail`, and computed
`elapsedMs` when folding it into an expanded diff row. Slow file edits keep their
duration metadata after the diff replaces the running tool row.

**Verification:** `bun test packages/tui/src/reducer.test.ts`; `bun run smoke:tui`; `bun run typecheck`.

**Description:** When `file-changed` folds a running tool into a diff block, `startedAt`, `elapsedMs`, `tail` are not copied. Slow edits lose duration label in meta column.

---

---

### BUG-038 — Brief "not working" gap between automated follow-up turns

| Field | Value |
|-------|-------|
| **Package** | `@vibe/tui` |
| **File** | `packages/tui/src/app.tsx` (1480–1484, 1687–1691) |
| **Severity** | Low |

**Verdict:** fixed (2026-07-06)

**Fix:** The TUI now treats `turn-finished`/`session-idle` as per-turn
transcript finalization only and keeps the working indicator active until the
terminal `engine-idle` event. Automated follow-up turns therefore do not flicker
through an idle-looking state between queue-drain passes.

**Verification:** `bun run smoke:tui`; `bun run typecheck`.

**Description:** `turn-finished` and `session-idle` both call `endTurn()` → `setWorking(false)`. Multi-turn gate-fix follow-ups flicker spinner off between idle and next enqueued turn. Headless waits for `engine-idle`; interactive TUI does not.

---

---

### BUG-039 — `needsOnboarding` uses naive `split("/")[0]` for provider id

| Field | Value |
|-------|-------|
| **Package** | `@vibe/cli` |
| **File** | `packages/cli/src/onboarding.ts` (22–25) |
| **Severity** | Low |

**Verdict:** fixed (2026-07-06)

**Fix:** Onboarding now uses the shared `parseModelString` parser instead of a
raw split. Malformed strings for known providers reopen setup so the user can
choose a valid `provider/model-id`, while unknown malformed strings still fall
through to normal model-resolution errors. The advanced manual model prompt also
re-prompts until the entered string is structurally valid.

**Verification:** `bun test packages/cli/src/onboarding.test.ts`; `bun run typecheck`.

**Description:** Malformed model string without `/` (e.g. `"anthropic"`) derives wrong provider id; onboarding skipped → runtime error instead of setup flow.

---

---

### BUG-040 — `custom` provider reported as configured without base URL

| Field | Value |
|-------|-------|
| **Package** | `@vibe/providers`, `@vibe/cli` |
| **Files** | `packages/providers/src/registry.ts` (70–74), `packages/cli/src/onboarding.ts` (18–26) |
| **Severity** | Low |

**Verdict:** fixed (2026-07-06)

**Fix:** Provider auth metadata now marks endpoint-required keyless providers,
and `ProviderRegistry.isConfigured()` requires either configured
`providers.custom.baseURL` or `$CUSTOM_BASE_URL` before reporting the generic
`custom` provider ready. CLI onboarding now delegates keyless readiness to the
registry, so `model: "custom/foo"` opens setup until an endpoint exists while
local keyless providers such as LM Studio remain ready by default.

**Verification:** `bun test packages/providers/src/registry.test.ts`; `bun test packages/cli/src/onboarding.test.ts`; `bun run typecheck`.

**Description:** `custom` is keyless → `isConfigured` always true without `baseURL`. `needsOnboarding` returns false for `model: "custom/foo"`; failure deferred to model creation.

---

---

### BUG-041 — `HookSchema` allows hooks with neither `command` nor `url`

| Field | Value |
|-------|-------|
| **Package** | `@vibe/config` |
| **Files** | `packages/config/src/schema.ts` (102–125), `packages/core/src/config-hooks.ts` (176–180) |
| **Severity** | Low |

**Verdict:** fixed (2026-07-06)

**Fix:** `HookSchema` now rejects hook entries that have neither a non-blank
`command` nor a valid HTTP `url`, so misspelled or incomplete hook
configuration fails at config validation instead of being accepted and later
dropped by the runtime hook registrar.

**Verification:** `bun test packages/config/src/config.test.ts`; `bun run typecheck`.

**Description:** Invalid hooks pass Zod validation; dropped at runtime with warning only. Typo'd hook in config silently never runs.

---

---

### BUG-042 — `ProviderAuthError` used for non-credential failures

| Field | Value |
|-------|-------|
| **Package** | `@vibe/providers` |
| **File** | `packages/providers/src/defs.ts` (302–304, 309, 365–367) |
| **Severity** | Low |

**Verdict:** fixed (2026-07-06)

**Fix:** Non-credential provider failures now throw `VibeError` with specific
codes (`PROVIDER_CONFIG`, `PROVIDER_SDK_INVALID`, `PROVIDER_UNSUPPORTED`)
instead of being wrapped as `ProviderAuthError`. Missing credentials still use
`ProviderAuthError`; missing custom endpoint configuration now reports a config
problem with the exact base URL setting/env var.

**Verification:** `bun test packages/providers/src/registry.test.ts`; `bun run typecheck`.

**Description:** Missing base URL, missing SDK export throw `ProviderAuthError` with free-form string in `envVars` array — mislabels config/dependency problems as missing API keys.

---

---

### BUG-043 — `read_mcp_resource` without `server` picks first matching URI (ambiguous)

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/mcp.ts` (538–552) |
| **Severity** | Low |

**Verdict:** fixed (2026-07-06)

**Fix:** Unscoped `read_mcp_resource` now detects when more than one connected
MCP server advertises the requested URI and returns an explicit ambiguity error
that lists the matching servers and asks for `server`. Scoped reads still call
the requested server directly.

**Verification:** `bun test packages/core/src/mcp.test.ts`; `bun run typecheck`.

**Description:** Duplicate URIs across MCP servers return whichever server appears first in `#entries`.

---

---

### BUG-044 — Invalid slash command names silently dropped on plugin register

| Field | Value |
|-------|-------|
| **Package** | `@vibe/plugins` |
| **File** | `packages/plugins/src/commands.ts` (25–27) |
| **Severity** | Low |

**Verdict:** fixed (2026-07-06)

**Fix:** `CommandRegistry.register()` now throws a clear error for slash-command
names the parser can never dispatch, so plugin authors get an explicit plugin
load failure instead of a silently dropped command. File-based command loading
continues to pre-filter invalid markdown filenames/frontmatter and skip them
gracefully.

**Verification:** `bun test packages/plugins/src/plugin.test.ts packages/core/src/loaders.test.ts`; `bun run typecheck`.

**Description:** `CommandRegistry.register` returns early when `!isSlashCommandName(cmd.name)`. Plugin still logs loaded; author believes command registered.

---

---

### BUG-045 — `whenToUse` frontmatter key ignored at skill load time

| Field | Value |
|-------|-------|
| **Package** | `@vibe/plugins`, `@vibe/core` |
| **Files** | `packages/plugins/src/skills.ts` (64–102), `packages/core/src/loaders.ts` (129–130) |
| **Severity** | Low |

**Verdict:** fixed (2026-07-06)

**Fix:** Skill loading now maps both `when_to_use` and `whenToUse`
frontmatter into the runtime `whenToUse` field, with the documented
snake_case key taking precedence when both are present.

**Verification:** `bun test packages/core/src/loaders.test.ts`; `bun run typecheck`.

**Description:** `parseSkillMarkdown` stores `whenToUse:` as-is; `loadSkillsFrom` only maps `when_to_use`. CamelCase frontmatter produces no progressive-disclosure hint.

---

## Loop 2 findings (BUG-046 — BUG-071)

---

### BUG-046 — `/clear` leaves stale token/offload accounting state

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/session.ts` (728–738, 745–749, 1155–1197, 1514–1529, 1577) |
| **Severity** | Medium |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** `clear()` wipes `#modelMessages` and `#history` but does **not** reset `#lastInputTokens`, `#overheadTokens`, `#lastSentEstimate`, or `#offloaded`. After a long session, `/context` and `context-updated` still report pre-clear provider fill; `#maybeCompact` can fire on a nearly empty transcript; `prepareStep` microcompaction may offload too aggressively. `#persist()` can write inflated `lastInputTokens` into session meta for `--resume`.

**Evidence:** `clear()` only assigns `[]` to messages/history and clears `#recalledContext` — no token/offload reset. Compaction explicitly resets `#lastInputTokens` (line 1577); `clear()` does not.

**Reproduction:** Run until `context-updated` shows 80k+ tokens → `/clear` → `/context` still ~80k with 0 messages → one short prompt may trigger compaction/offload → quit/`--resume` restores poisoned meta.

---

---

### BUG-047 — Orchestrator `check:true` treats `unverified` gate as success

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **Files** | `packages/core/src/orchestration/orchestrator-runner.ts` (1199–1258, 788–824), `packages/core/src/build/gate.ts` |
| **Severity** | High |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** Shared-tree and worktree tasks with `check` or `verify` run `runGate` but only `red` and `aborted` fail the task. **`unverified` falls through to `completed`**, contradicting gate honesty ("no detected checks → unverified, never green"). Differs from root engine path. Worktree path keeps merged changes when post-merge gate is `unverified`.

**Evidence:** Shared path lines 1230–1242: only `red` fails; comment says "green or unverified → fall through". Worktree path lines 797–824: only `red`/`aborted` revert; `unverified` returns `ok: true`.

**Reproduction:** `spawn_tasks` with `{ check: true }` on repo with empty `RepoProfile.commands` → gate `unverified` → task journals **`completed`** with no machine verification.

---

---

### BUG-048 — `#runWorktreeTask` ignores `commitWorktree` failure (silent work loss)

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **Files** | `packages/core/src/orchestration/orchestrator-runner.ts` (777–824), `packages/core/src/build/gitops.ts` (178–189) |
| **Severity** | High |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** `#runEnsembleAttempt` checks `commitWorktree` return value and bails on `false`. `#runWorktreeTask` **awaits but does not check** the boolean. If commit fails after child edits, merge may succeed with empty delta, gate passes on unchanged main, task reports **`completed`**, and `finally` removes the worktree — **orphaning child edits**.

**Evidence:** Line 777: `await commitWorktree(...)` with no `if (!committed)`. Ensemble path line 1055–1056 checks `if (!committed)`.

**Reproduction:** `worktree: true` task where `commitWorktree` returns `false` after child writes → merge + gate on unchanged main → `completed` → worktree removed, edits gone.

---

---

### BUG-049 — `ledger.jsonl` append is non-atomic across processes

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/build/ledger.ts` (57–64) |
| **Severity** | Medium |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** `appendLedger` uses bare `appendFileSync` with no locking. Two concurrent sessions appending green-gate records can interleave bytes → torn JSONL lines. `loadLedger` skips malformed lines silently → confirmed commands/conventions dropped.

**Reproduction:** Two processes hit green gate in same repo simultaneously → inspect `ledger.jsonl` for truncated lines; `loadLedger` returns stale/null record.

---

---

### BUG-050 — Ensemble with missing `repoProfile` scores attempts as passable without checks

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/orchestration/orchestrator-runner.ts` (1058–1074) |
| **Severity** | Medium |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** When `this.#handle.deps.repoProfile` is falsy, gate block is skipped; each attempt keeps defaults `score = 1`, `verdict = "unverified"`. Winner filter requires `score > 0`, so attempts with **no gate run** can win by `diffSize` tiebreak and squash-merge. Post-merge re-gate also gated on `profile`.

**Reproduction:** `hard: true` ensemble with `repoProfile` unset → all attempts `score: 1` without `runGate` → one merges and task completes with zero check execution.

---

---

### BUG-051 — `glob` `cwd` escapes workspace and bypasses permission path scoping

| Field | Value |
|-------|-------|
| **Package** | `@vibe/tools`, `@vibe/core` |
| **Files** | `packages/tools/src/builtins/glob.ts` (19–20), `packages/core/src/permissions.ts` (89–90) |
| **Severity** | Medium |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** `searchDir` built via string concat (`${ctx.cwd}/${cwd}`), not `resolve()` + containment. Model `cwd: "../../"` searches outside session root. `scopeString()` maps `path`/`url`/`command` only — not `glob`'s `cwd`/`pattern` — so path-scoped deny rules never apply to where glob scans.

**Reproduction:** `{ pattern: "**/*", cwd: "../../" }` lists files outside project; path deny rules for `read`/`edit` don't govern glob scope.

---

---

### BUG-052 — `read` calls `recordSeen` before binary refusal

| Field | Value |
|-------|-------|
| **Package** | `@vibe/tools` |
| **File** | `packages/tools/src/builtins/read.ts` (45–48, 131–135) |
| **Severity** | Low |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** `recordSeen()` runs after 4 KiB head sniff, before body stream. NUL deeper in file → `isError` binary refusal but mtime still recorded. Model never got content; stale-write guard may skip re-read prompts. Distinct from BUG-036 (mid-stream TOCTOU).

---

---

### BUG-053 — Observe-only config hooks block turns when `async` is false (default)

| Field | Value |
|-------|-------|
| **Package** | `@vibe/config`, `@vibe/core` |
| **Files** | `packages/core/src/config-hooks.ts` (191–196, 241), `packages/core/src/session.ts` (1246), `packages/config/src/schema.ts` (123–124) |
| **Severity** | Medium |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** Schema documents `async` for fire-and-forget, but default is `false`. For `session.start`, `step.finish`, `assistant.message`, `session.end`, handler **awaits** shell/HTTP (up to 10s) then **discards** JSON response. `step.finish` awaited on every agentic step — slow logging hook adds per-step latency with no veto benefit.

**Evidence:** Only `hook.async` triggers fire-and-forget (line 192); `step.finish` has no response contract but is still awaited (session.ts 1246).

---

---

### BUG-054 — `git_push` passes `branch`/`remote` without `--` separator

| Field | Value |
|-------|-------|
| **Package** | `@vibe/tools` |
| **File** | `packages/tools/src/builtins/git.ts` (167–169) |
| **Severity** | Medium |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** `git_diff` rejects refs starting with `-`. `git_push` appends `remote` and `branch` as positional args without `--`. Values like `--force` or branch `-delete-branch` parsed as git flags, not refspecs.

**Reproduction:** `git_push({ branch: "--force" })` or malicious ref name → wrong push behavior.

---

---

### BUG-055 — `repo_map` `path` can scan outside cwd on non-git fallback

| Field | Value |
|-------|-------|
| **Package** | `@vibe/tools` |
| **File** | `packages/tools/src/builtins/repo-map.ts` (161–164) |
| **Severity** | Low |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** Outside git, `listFiles()` builds `new Glob(\`${sub}/**/*\`)` with user `path` as `sub` without containing under `ctx.cwd`. `path: "../sibling-project"` walks sibling directory.

---

---

### BUG-056 — Declarative config hooks ignore turn/session abort

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **Files** | `packages/core/src/config-hooks.ts` (67–107, 165–244), `packages/core/src/engine.ts` (926–929) |
| **Severity** | Medium |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** `defaultExec`/`defaultPost` use only fixed `AbortSignal.timeout`. `registerConfigHooks` not wired with session abort. After Esc, hooks can run until 10s timeout, delaying teardown and competing with `finalize()`. Builtin tools honor `ctx.abortSignal`; config hooks do not.

---

---

### BUG-057 — Hook with both `command` and `url` silently runs only `command`

| Field | Value |
|-------|-------|
| **Package** | `@vibe/config`, `@vibe/core` |
| **Files** | `packages/config/src/schema.ts` (102–125), `packages/core/src/config-hooks.ts` (188–190) |
| **Severity** | Low |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** Runtime picks `hook.command ? exec : post`. Dual-entry hook runs shell only; HTTP endpoint never called, no warning (unlike neither-field hooks which warn).

---

---

### BUG-058 — `McpOAuthSchema.redirectUri` uses loose `z.string().url()`

| Field | Value |
|-------|-------|
| **Package** | `@vibe/config` |
| **File** | `packages/config/src/schema.ts` (175–176) |
| **Severity** | Low |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** Provider `baseURL` uses strict `httpUrl()` helper. `redirectUri` still uses `z.string().url()`, accepting scheme-less values like `localhost:8080/callback` (empty host) → OAuth callback binding fails at runtime with persisted invalid URI.

---

---

### BUG-059 — Exported `runVerify()` can hang on abort (orphan process tree)

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **Files** | `packages/core/src/verify.ts` (22–48), `packages/core/src/index.ts` |
| **Severity** | Low |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** Engine uses `#runVerifyCommand` → `bunExec` with `killTree`. Exported `runVerify()` forwards `signal` straight to `Bun.spawn` without tree kill — documented footgun for external callers; pipelines can hang `readCappedText` on abort.

---

---

### BUG-060 — HTTP config hooks treat non-2xx responses as silent no-ops

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/config-hooks.ts` (108–114) |
| **Severity** | Low |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** `defaultPost` returns `{}` when `!res.ok` without logging. Failing webhook (401/500) indistinguishable from empty allow — deny/rewrite never fires, operator gets no signal.

---

---

### BUG-061 — `localEmbedder` has no wall-clock timeout (model load or embed)

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/embeddings.ts` (26–30, 55–88, 97–124) |
| **Severity** | High |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** Cloud embedder uses `AbortSignal.timeout(EMBED_TIMEOUT_MS)` on `embedMany`. `localEmbedder` has no timeout on HF `pipeline()` load or per-text embed loop. `resolveEmbedder()` awaits during `MemoryService.create()` with no outer bound. Stalled download/wedged ONNX blocks startup or `#maybeProactiveRecall()` forever — callers catch throws, not hangs.

**Evidence:** Lines 26–30 document cloud timeout rationale; `localEmbedder` embed loop (80–86) has no abort/timeout.

**Reproduction:** `memory.semantic.model: "local"`, block HF CDN → startup or first prompt hangs on proactive recall.

---

---

### BUG-062 — LSP client ignores inbound server JSON-RPC requests

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/lsp/client.ts` (341–363) |
| **Severity** | Medium |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** `#dispatch()` handles client responses and `publishDiagnostics` only. Server **requests** (`client/registerCapability`, `workspace/configuration`, etc.) dropped with no reply. Servers that block on registration never get response → init/diagnose timeout. Comment says "harmless for diagnostics" but breaks strict servers (jdtls, some Go/Rust).

---

---

### BUG-063 — Semantic vector index has no multi-process write safety

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **Files** | `packages/core/src/vector-store.ts` (41–44, 78–99), `packages/core/src/memory-search.ts` (132–145) |
| **Severity** | Medium |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** SQLite WAL without `PRAGMA busy_timeout` or file lock. Two processes in same repo can hit `SQLITE_BUSY` on concurrent `upsert`. `searchMemory` swallows semantic failures → lexical-only recall with stale index, no user error.

---

---

### BUG-064 — `gatherMemoryDocs` fail-closed vs `scopeText` fail-open breaks dedup

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/memory-store.ts` (65–75, 258–270, 388–398) |
| **Severity** | Medium |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** `readMarkdownDocs()` propagates read errors → `gatherMemoryDocs()` fails safely. `appendMemory()` dedup uses `scopeText()` which returns `""` on any readdir/read failure (fail-open). Transient FS fault → dedup sees empty store → **appends duplicates**; search omits facts until reads recover.

**Reproduction:** Save fact → `chmod 000` on memory dir → `save_memory` same fact → `deduped: false`, duplicate written.

---

---

### BUG-065 — `LspClient.dispose()` leaves window where `diagnose()` still runs

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/lsp/client.ts` (164–165, 217–229, 247–262) |
| **Severity** | Low |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** `dispose()` kills process but doesn't set `#exited = true` synchronously; flips only on `#handleExit`. Gap where `diagnose()` may write to dead stdin before catch returns `undefined`.

---

---

### BUG-066 — `VectorStore.search()` loads entire corpus every query

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/vector-store.ts` (132–147) |
| **Severity** | Medium (at scale) |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** Every semantic query `SELECT … FROM chunks` with no pagination/ANN, decodes every vector, sorts in JS. Documented fine for thousands of chunks; unbounded episodic memory makes `/recall` O(n) RAM/CPU — multi-second stalls or OOM risk.

---

---

### BUG-067 — `UIEvent` `tool-call-progress` omits `subagentId`

| Field | Value |
|-------|-------|
| **Package** | `@vibe/shared`, `@vibe/tui` |
| **Files** | `packages/shared/src/events.ts` (31–36), `packages/tui/src/app.tsx` (1528–1551) |
| **Severity** | Low |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** `tool-call-started`/`finished` carry optional `subagentId`; `tool-call-progress` does not. TUI skips started/finished for subagents but would mis-attach progress if subagent events reached parent bus. Latent today (isolated subagent bus); contract inconsistent.

---

---

### BUG-068 — `AsyncQueue.push()` after `close()` silently drops events

| Field | Value |
|-------|-------|
| **Package** | `@vibe/shared`, `@vibe/core` |
| **Files** | `packages/shared/src/async-queue.ts` (11–18), `packages/core/src/event-bus.ts` (34–36) |
| **Severity** | Low |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** After `close()`, `push()` is no-op with no error. `EventBus.close()` during `finalize()` while in-flight work still `emit()` → late events dropped. Contributes to shutdown races (related BUG-001, BUG-026).

---

---

### BUG-069 — `CappedText` `headRatio` not clamped for `head+tail` mode

| Field | Value |
|-------|-------|
| **Package** | `@vibe/shared` |
| **File** | `packages/shared/src/stream.ts` (66–68) |
| **Severity** | Low |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** `headCap = Math.floor(cap * headRatio)` with no clamp. `headRatio > 1` makes `headCap > cap`, `tailCap` negative; `push()` uses `slice(-negative)` → wrong truncation behavior. Callers normally pass `0.3`; invalid options unchecked.

---

---

### BUG-070 — Plugin `register()` timeout can leave partial registrations

| Field | Value |
|-------|-------|
| **Package** | `@vibe/plugins` |
| **File** | `packages/plugins/src/plugin.ts` (79–83) |
| **Severity** | Medium |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** `withTimeout` abandons hung `register()` but does not roll back synchronous work already done (`registerCommand`, `hooks.on`, `registerTool`). Plugin that registers then hangs on `await` leaves half-wired state while boot continues.

---

---

### BUG-071 — Re-loading plugins duplicates hook handlers

| Field | Value |
|-------|-------|
| **Package** | `@vibe/plugins` |
| **Files** | `packages/plugins/src/hooks.ts` (63–66, 100), `packages/plugins/src/plugin.ts` |
| **Severity** | Low |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** `HookBus.on` always appends; `CommandRegistry` overwrites by name. Second `PluginHost.load()` with same plugin registers duplicate hook handlers → double prompt rewrites, double idle continues.

---

## Loop 3 findings (BUG-072 — BUG-081)

---

### BUG-072 — `loadAgents` aborts scan on first unreadable file

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/agents.ts` (87–116) |
| **Severity** | Medium |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** Unlike `loadCommandsFrom`/`loadSkillsFrom` (per-file try/catch in `loaders.ts`), `loadAgents` has one outer try around the entire scan. One I/O/permission failure aborts the loop; catch swallows error → partial map (defaults + agents before failure). Later definitions silently dropped.

**Reproduction:** `.vibe/agents/a.md` valid + `b.md` unreadable + `c.md` valid → only `a` loads; `/agents` omits `c` with no error.

---

---

### BUG-073 — Agent `name:` empty string bypasses filename fallback

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/agents.ts` (95–111) |
| **Severity** | Medium |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** `const name = frontmatter.name ?? basename(file, ".md")`. Bare `name:` parses to `""` (not nullish) → agent registers under `""`. Commands/skills use `frontmatter.name?.trim() || basename(...)` with tests; agents do not.

**Reproduction:** `explore.md` with empty `name:` → `spawn_subagent` with `agent: "explore"` fails; `agents.get("")` set.

---

---

### BUG-074 — `formatSessions` crashes on incomplete `meta.json`

| Field | Value |
|-------|-------|
| **Package** | `@vibe/cli` |
| **File** | `packages/cli/src/index.ts` (272–284) |
| **Severity** | Medium |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** `SessionStore.list()` casts meta without validation. `formatSessions` calls `m.model.length` / `m.id.length` — truncated or hand-edited meta missing `model`/`id` makes `vibecodr sessions` throw instead of skipping entry.

**Reproduction:** Delete `model` from `meta.json` → `vibecodr sessions` → `TypeError` on `m.model.length`.

---

---

### BUG-075 — Loop iterations expand only custom commands, not built-in slash handlers

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **Files** | `packages/core/src/engine.ts` (1635–1651), `packages/core/src/engine-commands.ts` |
| **Severity** | High |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** `#runLoopIteration` expands prompts only via `this.commands.get(slash.name)` (plugin/file commands). Built-ins (`/diff`, `/verify`, `/status`, etc.) live in `handleSlash` and are **not** in `CommandRegistry`. Loop prompt `/diff` passed verbatim to `session.run()` — model sees slash line, command never executes.

**Evidence:** Line 1639: `const cmd = this.commands.get(slash.name)` — no fallback to `handleSlash`.

**Reproduction:** `/loop 1h /diff` → iteration prompts model with `/diff` text; no diff output.

---

---

### BUG-076 — `parseLoopArgs` treats in-prompt `--until` as a flag

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/loop.ts` (51–56) |
| **Severity** | Medium |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** `--until` matched with `/--until\s+(.+)$/` on remainder before prompt finalized. Prompt ending with `--until <words>` splits incorrectly — tail becomes `until` condition, real prompt shortened.

**Reproduction:** `/loop 30s explain how --until loops work` → `until: "loops work"`, `prompt: "explain how"`.

---

---

### BUG-077 — `parseLoopArgs` false-positive warnings for `--until`/`--max` in prompt text

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/loop.ts` (85–91) |
| **Severity** | Low |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** Parser scans every whitespace token in prompt for exact `--until` or `--max`. Legitimate prompts mentioning those strings emit `"was not applied"` warnings when no flag was intended.

---

---

### BUG-078 — Crash logs with same millisecond overwrite each other

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/crash.ts` (88–94) |
| **Severity** | Low |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** Crash log paths use timestamp with `:`/`.` normalized. Two crashes in same millisecond get same filename; `writeFileSync` overwrites first log.

---

---

### BUG-079 — `update-check.json` write is non-atomic

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/update-check.ts` (115–121) |
| **Severity** | Low |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** `writeUpdateCache` uses bare `writeFile` without temp+rename. Crash mid-write → corrupt JSON; `readUpdateCache` returns null until next fetch. Same class as BUG-012/BUG-049.

---

---

### BUG-080 — External editor non-zero exit still replaces draft

| Field | Value |
|-------|-------|
| **Package** | `@vibe/tui` |
| **Files** | `packages/tui/src/editor-compose.ts` (81–101), `packages/tui/src/app.tsx` (1257–1261) |
| **Severity** | Medium |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** `editorSpawn` resolves on `proc.exited` regardless of exit code. `composeInEditor` always reads temp file after spawn. Editor exit 1 after partial write can still yield `{ kind: "replaced" }` instead of keeping prior draft.

---

---

### BUG-081 — `paletteState` value menu is prefix-only (no fuzzy match)

| Field | Value |
|-------|-------|
| **Package** | `@vibe/tui` |
| **File** | `packages/tui/src/commands-catalog.ts` (134–139) |
| **Severity** | Low |

**Verdict:** confirmed (static source review, 2026-07-06)

**Description:** Command tier uses prefix → substring → fuzzy. Value submenu (`/approvals`, `/theme`) uses only `v.startsWith(query)`. Typing `/approvals uto` closes menu even though `auto` substring-matches.

---

## Refuted / intentional design (not active bugs)

### Refuted — BUG-033 — Bash permission `match` rules are explicitly bypassable

| Field | Value |
|-------|-------|
| **Package** | `@vibe/core` |
| **File** | `packages/core/src/permissions.ts` (40–44) |
| **Severity** | Low (documented); High if treated as sandbox |

**Verdict:** refuted — documented best-effort limitation in `permissions.ts` (lines 40–44), not a defect

**Description:** `git  push`, `;git push`, `/usr/bin/git push` evade naive globs. Documented best-effort; not a structured sandbox.

---

### Refuted — BUG-035 — Stale-write guard disabled after per-session LRU eviction (accepted risk)

| Field | Value |
|-------|-------|
| **Package** | `@vibe/tools` |
| **File** | `packages/tools/src/builtins/freshness.ts` (23–27, 82–106) |
| **Severity** | Low |

**Verdict:** refuted — documented accepted LRU tradeoff in `freshness.ts` (lines 23–26), not a defect

**Description:** `MAX_PATHS_PER_SESSION` (2000) LRU eviction drops path entries; evicted paths treated as "never read" → `edit`/`write` skip stale check. Documented in source as accepted tradeoff.

---

## Coverage tracker

| Area | Package / path | Status | Notes |
|------|----------------|--------|-------|
| Engine lifecycle | `core/engine.ts` | ✅ Audited | BUG-001, 003, 004, 013, 056 |
| Session / fork | `core/session.ts` | ✅ Audited | BUG-006, 034, 046 |
| Orchestration | `core/orchestrator*.ts`, `orchestration/` | ✅ Audited | BUG-002, 010, 013, 032, 047, 048, 050 |
| Journal / reports | `core/build/journal.ts` | ✅ Audited | BUG-002, 012 |
| Checkpoints / undo | `core/checkpoints.ts` | ✅ Audited | BUG-009, 011 |
| Goal run | `core/engine.ts` (#goal*) | ✅ Audited | BUG-003 |
| Plan gate | `core/plan-gate.ts` | ✅ Reviewed | Rejection reset per user prompt is **intentional** — not filed |
| Compaction | `core/compaction.ts` | ✅ Reviewed | Structural invariants sound; clear accounting gap is BUG-046 |
| Microcompaction | `core/session.ts` (prepareStep) | ✅ Reviewed | Stale `#overheadTokens` after clear — BUG-046 |
| Memory / recall | `core/memory*.ts`, `bm25.ts`, `embeddings.ts`, `vector-store.ts` | ✅ Audited | BUG-014, 061–064, 066 |
| MCP | `core/mcp.ts`, `mcp-oauth.ts` | ✅ Audited | BUG-022–024, 043, 058 |
| Permissions | `core/permissions.ts` | ✅ Audited | BUG-051; BUG-033 refuted (documented) |
| Build / gate | `core/build/` | ✅ Audited | BUG-047, 048, 049; `gate.ts`/`check.ts`/`stubscan.ts` reviewed — abort/red honest |
| LSP diagnostics | `core/lsp/` | ✅ Audited | BUG-062, 065; manager/registry reviewed — lazy spawn OK |
| Store / resume | `core/store.ts` | ✅ Audited | BUG-025 |
| Limiter | `core/limiter.ts` | ✅ Reviewed | Main suspend pairing tested; miscounted `releaseSlot` theoretical only — not filed |
| Config hooks | `core/config-hooks.ts` | ✅ Audited | BUG-053, 056, 057, 060 |
| Tools — bash/edit/write | `tools/builtins/` | ✅ Audited | BUG-015, 036; BUG-035 refuted |
| Tools — grep/glob/read/repo_map | `tools/builtins/` | ✅ Audited | BUG-016, 018, 051, 052, 055 |
| Tools — git_* | `tools/builtins/git.ts` | ✅ Audited | BUG-054 |
| Tools — web/fetch/package | `tools/builtins/` | ✅ Audited | BUG-017; fetch-cache, pdftext, package_info reviewed — no new issues |
| Tools — sandbox | `tools/sandbox.ts` | ✅ Audited | BUG-019 |
| Tools — verify export | `core/verify.ts` | ✅ Audited | BUG-059 |
| Providers | `providers/` | ✅ Audited | BUG-005, 020, 021, 040, 042 |
| Config schema/load | `config/` | ✅ Audited | BUG-041, 058 |
| CLI | `cli/` | ✅ Audited | BUG-005, 021, 039 |
| Plugins / hooks | `plugins/` | ✅ Audited | BUG-030, 031, 044, 045, 070, 071 |
| Shared | `shared/` | ✅ Audited | BUG-067, 068, 069; logger/types/commands reviewed |
| TUI — app.tsx | `tui/app.tsx` | ✅ Audited | BUG-007, 008, 026–029, 038 |
| TUI — reducer/trail | `tui/reducer.ts`, `trail.ts` | ✅ Audited | BUG-037 |
| TUI — headless | `tui/headless.ts` | ✅ Reviewed | Idle wait correct |
| Scripts / release | `scripts/release/` | ✅ Reviewed | `build-npm.ts`, `set-version.ts` — inlined-SDK guard, atomic version stamp; no new issues |
| test-preload.ts | root | ✅ Reviewed | XDG isolation mirrored; no new issues |
| Integration / e2e tests | `core/engine-e2e.test.ts` | ✅ Reviewed | Regressions mined (blackboard clear, loop abort, handoff binding) — guarded by tests |
| Agents / loop / crash | `agents.ts`, `loop.ts`, `crash.ts`, `update-check.ts` | ✅ Audited | BUG-072–079, 075–077 |
| Blackboard / loaders / diagnostics | `blackboard.ts`, `loaders.ts`, `diagnostics.ts` | ✅ Reviewed | No new issues; loaders per-file guards sound |
| CLI sessions / upgrade | `cli/index.ts` (formatSessions), `upgrade.ts` | ✅ Audited | BUG-074; upgrade path reviewed |
| TUI secondary | `editor-compose.ts`, `slash.ts`, `commands-catalog.ts` | ✅ Audited | BUG-080, 081; slash routing sound |

**Audit status:** All `packages/*` reviewed; verification pass complete. BUG-033/035 refuted. Future loops should re-check only files changed via `git diff` since last audit date.

---

## Next loop targets (maintenance)

1. Re-audit files changed since 2026-07-06 via `git diff` / `git log`.
2. Re-spot-check Critical/High entries against current source after major refactors.
3. Add entries for any new regressions discovered in CI/test failures.

---

## Areas reviewed with strong guards (no issue filed)

Documented here so later loops don't re-investigate known-good paths unless code changes:

- Permission symlink/realpath handling (`permissions.ts`)
- Gate `aborted` vs `red` handling in engine root path (`build/gate.ts`)
- Limiter suspend/re-acquire for subagent fan-out (`limiter.ts` — main path)
- Session persist temp+rename (`store.ts` write path)
- Per-file atomic memory overwrite (`memory-store.ts` `atomicOverwrite`) — dedup asymmetry is BUG-064
- MCP connect timeout orphan cleanup (`mcp.ts`)
- Compaction tool-boundary preservation (`compaction.ts` — structural)
- Headless stream stall watchdog (`session.ts` `#consume`)
- `webfetch` SSRF pinning (`net-guard.ts` — extensive tests)
- `edit`/`write` atomic replace + file lock (`tools/builtins/`)
- Plan-gate rejection reset on user prompt — **by design** (`plan-gate.ts` 170–174)
- `fetch-cache.ts`, `pdftext.ts`, `package_info.ts` — reviewed Loop 2
- `scripts/release/` build/version guards — reviewed Loop 2
- LSP `manager.ts` lazy spawn + crash budget — reviewed Loop 2

---

*Verification complete: 79 active + 2 refuted. Maintenance: diff-driven re-audit only.*
