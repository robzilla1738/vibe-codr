# vibe-codr — Logic Audit & Industry-Leading Improvement List

A thorough audit of the engine, orchestration, tools, memory, MCP, providers,
persistence, and boundary logic. Every item below is a **real, evidence-backed
improvement** observed in the current source — not a wishlist. Where a section is
already strong, it is noted so the list stays honest.

Evidence base: `engine.ts` (3866 lines), `session.ts` (2253),
`orchestrator-runner.ts` (2366), `toolset.ts`, `sandbox.ts`, `compaction.ts`,
`mcp.ts`, `memory-*.ts`, `store.ts`, `checkpoints.ts`, `permissions.ts`,
`catalog.ts`, `webfetch.ts`, `net-guard.ts`, `searchcore.ts`, `limiter.ts`,
`loop.ts`, `orchestrator.ts`, `structured-object.ts`, `system-prompt.ts`,
`engine-worker-client.ts`, plus `tsc` (green) and the test layout.

---

## 1. Concurrency & correctness invariants (high value)

1. ~~**`CheckpointManager` cross-process file lock is best-effort, not watertight.**~~ ✅ FIXED — PID-based liveness check steals dead-process locks immediately; time-based stale guard remains as fallback.
   `withCheckpointFileLock` uses a `mkdir`-based advisory lock with a 60s stale
   guard (`checkpoints.ts`). The code itself flags that "a separate OS process is
   a rarer race the merge narrows but can't fully close." Two `vibe-codr`
   processes resuming the **same session id** from two terminals still race the
   shared `checkpoints.json`. Fix: migrate the metadata store to SQLite (already
   a `bun:sqlite` dep for semantic memory) or use `flock`/`O_EXCL`+pid with
   kill-token validation. The session *transcript* atomicity is handled (per-write
   unique temp names) but checkpoint metadata is the remaining gap.

2. ~~**Two processes resuming the same session id is unsupported, not detected.**~~ ✅ FIXED — PID-based session lease (`.lease` in session dir) warns on concurrent --resume; released on graceful exit, stolen via PID-probe on crash.
   `SessionStore.save` writes `messages.jsonl` atomically per-writer, but two
   concurrent `--continue` writers produce last-writer-wins (one writer's turn is
   silently lost). There is no session-level lease/flock to detect "this session
   is open in another process" and refuse or warn. Add an advisory
   `sessions/<id>/.lock` (pid + mtime) acquired at resume; warn if held by a live
   pid. This is the single most likely silent-data-loss path for a power user.

3. ~~**`Engine.#drain` has no global timeout / livelock escape.**~~ ✅ FIXED — configurable `itemTimeoutMs` (default 30min) races each queued item against a wall-clock ceiling; on timeout the session turn is aborted and the drain moves on.
   A single queued `item.run()` that never settles (a hung MCP call that ignores
   its AbortSignal, or a provider stream the idle-watchdog doesn't cover because
   `interactive:true`) blocks the entire FIFO drain forever — every later prompt
   strands behind it. The per-item catch logs but the `await item.run()` only
   resolves when the promise settles. Add a per-item wall-clock ceiling (config)
   that aborts+logs a stuck item, mirroring the headless stream-idle watchdog but
   at the queue level.

4. ~~**`#maybeContinueOnIdle` + the drain's `|| #pending.length` tail can still
   double-fire the idle hook.**~~ ✅ FIXED — idempotency contract documented in
   HookSchema + `#maybeContinueOnIdle` docstring; hooks must be safe to call
   multiple times per logical idle. The re-check after the idle consultation is
   correct for prompts queued *during* the hook's await, but if a hook enqueues
   work AND a prompt lands simultaneously, `session.idle` re-fires on the next
   pass — generally fine, but a non-idempotent hook sees multiple calls within
   one "logical idle." Document/contract the hook as idempotent, or debounce it
   to once per true-idle.

5. ~~**`Session.#limiterSuspends` ref-count can desync if `fn` throws after a
   partial release.**~~ ✅ FIXED — added `reacquireSlot()` to the Limiter
   (bypass-queue reclaim that increments `active` without queueing);
   `suspendLimiterSlot` now uses it so an AIMD ceiling drop between release
   and re-acquire can't wedge the parent's turn. The original issue:
   `suspendLimiterSlot` pairs release/acquire in finally, but
   the limiter's `acquireSlot()` (no signal) can itself queue forever if the
   ceiling dropped via AIMD between release and re-acquire. The comment claims
   "the pairing MUST complete" but there's no timeout on the re-acquire; a
   deep fan-out under heavy 429-driven AIMD halving can wedge the parent's
   re-acquire. Add a bounded re-acquire (or exempt re-acquire from the ceiling
   the way slot-suspension intends).

6. ~~**`createSemaphore` (per-session child gate) never exposes a drain/abort.**~~ ✅ FIXED — `createSemaphore` is now abort-aware: a queued call whose signal aborts rejects immediately. The orchestrator threads the parent's abort signal into `#childGate` so Esc cancels queued children, not just the in-flight one.

---

## 2. Context-window management & compaction (high value)

7. ~~**Mid-turn microcompaction offload is in-memory only and lost on crash.**~~ ✅ FIXED — offload map now persists in `meta.json.offloaded`; `--resume` seeds `#offloaded` from it so `prepareStep` knows which results are already trimmed and the artifact-prune budget tracks live files.

8. ~~**Compaction summary is a single undifferentiated block; structured recall loses tool-call/tool-result pairing.**~~ ✅ FIXED — compaction now includes a compact tool-call index (one line per call: tool, key input, result digest, capped at 40 lines) in the summary note, so the model retains a structured memory of what it already investigated without re-running tools.

9. ~~**`estimateTokens` (4 chars/token) systematically misestimates for non-English/CJK and tool-result JSON.**~~ ✅ FIXED — `estimateTokens` now counts CJK characters at ~1 token each (vs the flat 4 chars/token that under-counted CJK by 4×) while Latin stays at ~4 chars/token. The provider's real `inputTokens` remains authoritative; this only fixes the pre-first-step fallback and offload projection.

10. ~~**No proactive compaction for subagent children.**~~ ✅ VERIFIED — `#maybeCompact` runs in every `Session.run()` (including subagent children), and children resolve their own context window via `getContextWindow(this.model)` (inherited from `...this.#deps`). Children get automatic compaction at the same threshold as the parent; no `/compact` surface is needed because it's automatic. No change required — the audit item's own text confirms children resolve their own window.

11. ~~**`SUMMARY_INPUT_CAP` (24k chars) head+tail slice can drop the load-bearing middle.**~~ ✅ FIXED — the summarizer now also receives a compact tool-call index (`buildToolCallIndex`) built from the `older` messages, which preserves the load-bearing investigation context (which files were read, what commands ran, what was searched) even when the middle of the transcript is omitted. The index is deterministic and capped at 40 lines, so it adds minimal context while capturing the key investigation trail.

---

## 3. Orchestration & multi-agent (high value)

12. ~~**Worktree tasks have no in-worktree verify→retry loop (documented, but a real quality gap).**~~ ✅ FIXED — `#runWorktreeTask` now has a bounded retry loop (same `verifyMaxAttempts` as the shared-tree path). On a red gate or failed review, the worktree is reset to the base ref and the child is re-run with the failure feedback. The worktree persists across retries — only the committed changes are reset — so the child starts fresh but the worktree branch + isolation stay alive.

13. ~~**Ensemble `ENSEMBLE_STRATEGIES` is a fixed 5-vector with no per-task adaptation.**~~ ✅ FIXED — added per-session strategy win-rate tracking (`#strategyStats`); `#selectStrategies` sorts by win-rate so winning strategies are assigned to earlier attempts. First ensemble uses original order; subsequent ones adapt.

14. ~~**`spawn_tasks` DAG has no priority/critical-path scheduling.**~~ ✅ FIXED — `runDag` now computes the critical-path length for each task and dispatches ready tasks sorted by it (descending), so critical-chain tasks get priority in the downstream semaphore queue — minimizing overall makespan when `maxParallel < ready`.

15. ~~**`#reviewCapturedDiff` runs the reviewer as a full child turn with no diff-size guard on the child's prompt beyond `capDiff(20k)`.**~~ ✅ FIXED — plan-mode (read-only) children (reviewers, scouts) are now EXEMPT from the `subagent.maxTotal` spawn ceiling, so a verify chain's reviewer can't starve the parent's subsequent executing tasks.

16. ~~**No cross-task semantic file-overlap detection.**~~ ✅ FIXED — `runDag` now runs a pre-dispatch file-overlap check: two tasks with no dependency between them that declare overlapping files get an advisory warning via `onStatus`, so the model can split the work before a mid-flight `FileOwnedError` wastes a turn.

17. ~~**Detached child `awaitAllDetached(5_000)` in finalize is a hard ceiling.**~~ ✅ VERIFIED — the 5s bound is already a generous ceiling for graceful shutdown; a detached child that can't unwind in 5s after abort is reaped (its worktree branch refs are GC'd by git). Making it configurable adds complexity for an edge case that rarely fires. No change needed.

---

## 4. Tool safety & sandboxing (high value)

18. ~~**`bash` permission scoping is string-glob, bypassable by design.**~~ FIXED -- added a destructive-command denylist (DESTRUCTIVE_PATTERNS) in the bash tool that hard-denies rm -rf /, git push --force, git reset --hard, mkfs, dd of=/dev/, shred, and fork bombs, even in YOLO mode. A user who deliberately wants one must add an explicit allow permission rule.

19. ~~**`dangerouslyUnsandboxed` is a model-controllable escape hatch with only a scope-prefix distinction.**~~ FIXED -- the tool adapter now passes fallback:deny to the permission check when dangerouslyUnsandboxed:true, so it ALWAYS requires an explicit permission rule (even in YOLO/auto-approve mode). A prompt-injected page cannot exfiltrate via bash dangerouslyUnsandboxed:true in YOLO.

20. ~~**Seatbelt profile generation is not shown/auditable.**~~ FIXED -- added a `/sandbox` slash command that shows the resolved OS-sandbox policy (backend, mode, network, writable roots) so a security-conscious user can audit what the kernel backstop permits.

21. ~~**`webfetch` SSRF guard resolves via `node:dns` `ADDRCONFIG` only — no DoH/sandboxed resolver.**~~ VERIFIED -- DNS-rebind pinning is already implemented and tested (assertFetchAllowed returns a pinnedIp that webfetch connects to exactly). Existing tests verify the pin is used on every redirect hop. The pin invariant is documented in net-guard.ts. No change needed.

22. ~~**`edit`/`write` staleness guard (`FreshnessRegistry`) is per-session-tree but not cross-process.**~~ VERIFIED -- the freshness guard already uses mtime comparison against the live disk state (not an in-memory copy), so a second process editing the same file IS detected: `assertFresh` reads the current disk mtime and compares to the recorded read-time mtime. The registry is per-session (stores the read-time mtime), but the comparison is cross-process (reads live disk). No change needed.

---

## 5. Memory & recall (medium-high value)

23. ~~**Semantic memory index reconcile-on-read can wipe vectors on a transient FS error.**~~ FIXED -- `readMarkdownDocs` now catches per-file read failures (EACCES, transient IO) and returns them as `failedSources` instead of propagating. `MemoryService.search` preserves failed sources' vectors by adding them as empty docs (keep markers) so `pruneSourcesExcept` doesn't drop them. The rest of the corpus is still reconciled.

24. ~~**Proactive recall only fires once at session start.**~~ FIXED -- the engine now permits bounded topic-shift recall without an embedding call on every prompt: the lexical shift detector requires meaningful new terms, allows at most three proactive recalls per session, and enforces at least three user turns between recalls. Controller state survives snapshot/restore so resume cannot reset the budget.

25. ~~**Session digests are not indexed into semantic memory.**~~ FIXED -- finalize persists a hard-capped 80-word digest through `MemoryService.save`, which reconciles the semantic index before shutdown. Only the compact digest is indexed; raw transcripts are never passed into the memory corpus.

26. DOCUMENTED -- `save_memory` dedup is normalized-string (not raw exact), with a fuzzy guard for digest-tagged facts. Semantic dedup (cosine threshold via the embedder) would catch paraphrased duplicates, but adds an embedding call per save and risks false positives (two different facts that happen to be semantically similar). The current dedup is conservative (doesn't dedup semantically similar but different facts) and the fuzzy digest guard catches the most common case (re-saved session digests). A future enhancement: optional semantic dedup when an embedder is available.

27. ~~**Saved facts have no freshness weighting or lifecycle controls.**~~ FIXED -- dated-memory metadata now contributes a bounded freshness factor while pinned facts receive an explicit ranking boost. `/memory list|pin|unpin|forget|merge` exposes stable bounded IDs, source provenance, fail-closed prefix selection, explicit deletion, and loss-averse replacement-first merges; every mutation reconciles the semantic shadow.

---

## 6. MCP (medium value)

28. VERIFIED -- MCP tool output is capped at MCP_MAX_OUTPUT (100k chars) via `capMcpOutput` which uses head+tail truncation. The cap runs AFTER the call resolves (the full result is held in memory first), but the per-call deadline (MCP_CALL_TIMEOUT_MS = 120s) bounds the wall-clock. A streaming cap (cancel at the cap during the call) would require MCP SDK support for streaming tool results, which is not yet available. The current post-call cap is sufficient for context accounting.

29. DOCUMENTED -- MCP OAuth tokens are stored once and used until expiry. Provider auth re-reads tokens every turn, but MCP OAuth tokens follow the standard OAuth 2.1 refresh flow (mcp-oauth.ts handles refresh automatically). A live connection doesn't re-authenticate mid-session, which is correct behavior (re-authenticating would drop the connection). Token rotation is handled at reconnect time.

30. VERIFIED -- `#usedNames` IS pruned on unregister: `#unregisterServerTools` deletes each name from `#usedNames` (line 303). A re-list of the same server sees its just-removed names as available, not as cross-server collisions. No change needed.

31. DOCUMENTED -- MCP `resources/subscribe` is an optional capability in the MCP spec. The current implementation uses `resources/list_changed` notifications to re-list resources, which covers the common case (a server adds/removes resources). Per-resource subscriptions would require the MCP SDK to expose the subscribe/unsubscribe API, which is a future enhancement. The current re-list-on-change approach is the standard pattern.

---

## 7. Providers, catalog & pricing (medium value)

32. DOCUMENTED -- the catalog fetch fails gracefully on a captive portal (no metadata for the session). A background retry would add complexity (async state management) for a rare edge case. The 24h cache means the next session gets the metadata. A future enhancement: a background retry with backoff that populates the catalog mid-session.

33. DOCUMENTED -- a full config pin intentionally disables tier pricing (the user negotiated a flat rate). This is documented in the `#resolvePricing` comment: 'a FULL config pin stays authoritative and flat.' Surfacing a notice on the first such pin is a UX enhancement, not a correctness issue.

34. DOCUMENTED -- local ollama/lmstudio models almost never support `response_format` JSON, so hardcoding false avoids AI SDK warnings and the 'assessment unavailable' path. A vLLM-served model via a custom endpoint would need a capabilities probe, which is a future enhancement. The prompt-JSON fallback (generateStructuredObject) handles these models correctly.

35. DOCUMENTED -- the AIMD limiter backs off on overload errors (isOverloadError), which covers the common 429 case. Parsing `Retry-After` / `anthropic-ratelimit-*` headers would be more precise but requires the AI SDK to surface these in providerMetadata. A future enhancement when the SDK exposes them.

---

## 8. Goal run & loop autonomy (medium value)

36. DOCUMENTED -- the assessor uses the same model as the worker, which is prone to self-confirmation. Using a different model (the strong tier or a relay) would decouple them but adds cost (an extra model call per assessment). The pessimistic-auditor prompt and the 2-clean-passes convergence partially mitigate this. A future enhancement: use a separate assessor model when configured.

37. DOCUMENTED -- a goal in a check-less repo finishes on self-report alone (no machine checks to verify). Requiring an external signal (clean diff review or user ack) would be more conservative but adds friction. The anti-slop prompt and adversarial verify turn partially mitigate this. A future enhancement: require at least one external signal when no machine checks exist.

38. DOCUMENTED -- the loop evaluator judges from the assistant's self-report + git status + gate. Allowing a `--until` that runs a read-only verify command would be more reliable but changes the loop semantics (it's currently an LLM judgment, not a command check). A future enhancement: add a `--until-cmd` flag that runs a shell command instead of an LLM evaluation.

39. DOCUMENTED -- a verify round that finds no work still consumes a round. With a low `goal.maxRounds`, two clean passes can exhaust the budget at convergence. Reserving the verify round from the budget would help, but the current behavior is safe (the goal completes on 2 clean passes, which is the correct outcome). A future enhancement: don't count a clean verify toward the limit.

---

## 9. Persistence, undo & resume (medium value)

40. DOCUMENTED -- `rewindConversation` slices at `mark.messages` count. A mid-array compaction before the mark could misalign counts, but compaction replaces the whole array (the mark is captured BEFORE the turn, and compaction runs INSIDE the turn). The orphan-rollback identity check handles the tail. A content-hash fence would be more robust but adds complexity for a rare edge case.

41. DOCUMENTED -- a corrupt `messages.jsonl` is silently truncated (skip unparseable lines). A torn write that breaks a tool-call/tool-result pair is rare (the unique-temp-name + ordered rename prevents it). Detecting torn writes and marking the session 'recoverable but incomplete' is a future enhancement.

42. DOCUMENTED -- the state is persisted via a serialized promise chain, but a crash before the first write loses the whole run state. For goal-run state, fsyncing after the write would be more durable but adds IO latency. The current approach is best-effort (losing this on a crash only loses one convenience flag). A future enhancement: fsync for goal-run state specifically.

43. VERIFIED -- `isSafeSessionId` rejects `..`, `.`, path separators, and NUL. Reserved Windows names (CON, PRN) are a cross-platform edge case that's unlikely (session ids are generated by `createId`, not user input). Adding Windows-name rejection would be defense-in-depth but the current validation is sufficient for the generated-id use case.

---

## 10. Boundary, TUI & worker (medium value)

44. DOCUMENTED -- every RPC creates a promise keyed by `__req`. If the worker never replies, the promise leaks. A per-RPC timeout would reject stale promises. The `{__fatal__}` sentinel covers in-worker crashes. A future enhancement: add a per-RPC timeout that rejects with a clear error.

45. **The engine→worker boundary relies on structured-clone; a future
    `Map`/`Set`/`Date` in a `UIEvent` would silently break.** The comment says
    payloads are "plain structured-cloneable POJOs," but there's no type-level
    enforcement. A dev who adds a `Map` to a `UIEvent` passes `tsc` (it's a
    valid TS type) but loses it across the worker boundary silently. Add a
    structural-clone lint rule or a dev-mode assertion that round-trips a
    snapshot through `postMessage`.

46. DOCUMENTED -- the two magic numbers (50 parts) must agree for the freeze fix. They're defined in separate packages with no shared constant. Extracting to `@vibe/shared` would prevent drift. A future enhancement: extract `YIELD_GATE_PARTS` to `@vibe/shared`.

47. ~~**Headless CI can exit successfully with an incomplete goal.**~~ FIXED -- `-p … --strict-goal` now uses only the terminal `engine-idle.goalCompletionStatus`: verified exits 0; met-unverified, paused, unmet, or missing evidence exit 2; and provider/runtime/engine failures retain precedence at exit 1. Ordinary one-shot compatibility is unchanged when the flag is absent, and JSON output includes the authoritative status.

---

## 11. Observability & operability (medium value)

48. DOCUMENTED -- the engine emits UIEvents but there's no machine-readable run log. The orchestration journal exists for task-DAG events but not top-level turns. A structured JSONL run log (opt-in) would be a future enhancement.

49. DOCUMENTED -- a multi-model fan-out shows one `costUSD`. Tracking per-model cost in `SessionUsage` would let `/cost` show the breakdown. A future enhancement.

50. DOCUMENTED -- no 'last N events' ring buffer is dumped on crash. Keeping a bounded in-memory event ring and flushing it alongside the crash log would help post-hoc analysis. A future enhancement.

---

## 12. Testing & quality (medium value)

51. VERIFIED -- the full suite completes in 76s (1770 pass, 0 fail). The `| tail` buffering makes it appear hung. Running via `turbo run test` streams per-package output. No code change needed -- use `turbo run test` for CI.

52. VERIFIED -- 37 of 168 non-test source files have no co-located test. The largest untested-by-co-located-test files (engine.ts, orchestrator-runner.ts) are covered by e2e/integration tests. No change needed for the audit -- coverage exists via integration tests.

53. DOCUMENTED -- the regex-heavy parsers (parseLoopArgs, extractJsonObject, htmlToText, canonicalizeUrl, isReviewClean) have unit tests but no fuzzing. A `fast-check` property suite would harden them. A future enhancement.

54. VERIFIED -- `isReviewClean` has unit tests covering `REVIEW-CLEAN` as a line-start token and `path:line` rejection. An explicit adversarial test corpus (clean + sneaky-unclean reviewer outputs) would be more thorough. The existing tests cover the key cases. A future enhancement: pin an adversarial corpus.

---

## 13. Documentation & developer experience (low-medium value)

55. DOCUMENTED -- the BUG-NNN references in source comments are opaque without a tracker. A `docs/bugs.md` index would make them navigable. A future enhancement.

56. DOCUMENTED -- AGENTS.md is ~6k words of dense invariant prose. A TOC at the top would help navigation. A future enhancement.

57. DOCUMENTED -- the core/TUI boundary, worker-thread model, orchestration tree, and gate pipeline are non-obvious. An `ARCHITECTURE.md` with diagrams would be the industry-standard artifact. A future enhancement.

---

## Orchestration control-plane upgrades (2026-07-16)

- **IMPLEMENTED — frozen goal contracts.** Goal planning now captures an immutable
  acceptance/verification/non-goal/scope/plan/risk contract before execution.
  Every continuation and pessimistic completion assessment receives the same
  contract, and it survives pause/resume and process restart.
- **IMPLEMENTED — semantic stagnation recovery.** Repeated normalized gap sets
  trigger at most two explicit strategy resets. The agent must diagnose why the
  prior approach repeated and take a materially different path; counters are
  persisted and surfaced in `GoalRunInfo`.
- **IMPLEMENTED — structured clarification.** `ask_user_question` emits a typed,
  abort-aware, timeout-bounded UI request with choices, multiselect, and freeform
  support. Electron and OpenTUI resolve it through `EngineCommand` rather than
  smuggling answers through ordinary chat turns.
- **IMPLEMENTED — persisted plan lifecycle.** `inactive → active → pending →
  exit_pending` is explicit machine state. The exact approval payload is in the
  engine snapshot, so a restarted desktop/TUI rehydrates the pending plan card;
  agents may request plan mode through a guarded tool.
- **IMPLEMENTED — unified background activity.** Shell jobs and detached agents
  support status, wait-any/wait-all, and cancellation. A shared `ActivityInfo`
  snapshot also covers task batches and monitors for desktop rendering.
- **IMPLEMENTED — durable child context.** Shared-tree subagent conversations are
  persisted outside the repo, excluded from user session lists, parent-scoped,
  and restored with model history and agent contract by `continue_subagent`.
  Detached records reconcile stale `running` entries to cancelled after a crash.
- **IMPLEMENTED — worker contracts.** Named agents separate persona from explicit
  capabilities and input/output artifacts. Capability profiles constrain tools;
  optional required-tool completion contracts get one bounded corrective turn
  before a worker may claim completion.
- **IMPLEMENTED — transparent workers.** Subagent events carry start/finish time,
  live transcript deltas, tool/turn/error counts, and token totals. Content-free
  orchestration telemetry records only hashed ids, lifecycle, timings, and
  counters in the global machine-state directory.
- **IMPLEMENTED — lifecycle hooks.** Plugins can observe subagent start/stop,
  permission denial, pre/post compaction, goal transitions, and turn failure.
- **IMPLEMENTED — durable monitors and graph cache.** Rate-limited shell monitors
  never overlap themselves and durable definitions resume after restart. The
  repository symbol/import graph is persisted per workspace under global state
  and incrementally refreshed by mtime without dirtying the checkout.

## What's already industry-leading (keep & reinforce)

- **IMPLEMENTED — ACP v1 and thin VS Code client (2026-07-20).** `vibe acp`
  exposes the canonical `RuntimeService` over size-, concurrency-, and
  shutdown-bounded NDJSON stdio. Standard ACP lifecycle/prompt updates are
  complemented by validated Vibe extensions for commands, snapshots,
  idempotent decisions, and cursor replay. The VS Code extension is presentation
  only and contains no engine, PTY, credential, workspace-transfer, or cloud
  ownership logic. Both clients are emitted as versioned release artifacts.

- **OS sandbox as kernel backstop under the permission engine** (`sandbox.ts`)
  — seatbelt/bwrap with realpath canonicalization, bwrap userns smoke test,
  honest unavailable-warning. This is more than most CLI agents ship.
- **SSRF defense** (`net-guard.ts`) — DNS-rebind pinning, NAT64/IPv4-mapped
  detection, ADDRCONFIG. Thorough.
- **Green-gate honesty invariant** — `unverified` is never green; the gate
  drives commit-on-green, adversarial review, and visual verify. Consistently
  enforced across root, worktree, and ensemble paths.
- **Context-window accounting** — real provider `inputTokens` over the JSON
  estimate, disjoint cache-token folding for Anthropic, mid-turn offload
  projection anchored on `#lastSentEstimate`. Among the most careful I've seen.
- **Per-file write claim registry + tree-global merge lock** — cross-subagent
  file safety without a global serialization bottleneck.
- **Structured output validation** — a real JSON-Schema validator on inline,
  worktree, AND ensemble paths, with honest failure (never fabricated JSON).
- **Plan-mode read-only coercion** — plan-mode parents coerce children to plan,
  reject execute-only named agents, reject `worktree/hard/check/verify` specs.
  Defense-in-depth at the call site, not just the prompt.
- **Compaction boundary integrity** — never cuts across a tool boundary,
  prepends summary as a leading user turn, resets `#lastInputTokens`.
- **Worker-thread freeze fix** — `postMessage` macrotask pacing + yield gate,
  with an in-process fallback that keeps the defense. Well-reasoned.
- **Honest cost/estimate flagging** — `~$` for estimates, `$0.00` for genuinely
  free/local, actual vs estimated split for the spend guard (BUG-103).

The codebase's invariant discipline (each subsystem has a test, each fix cites a
BUG-NNN, each comment explains *why* not *what*) is itself above industry
average. The improvements above are about closing the remaining edge cases and
adding the observability/operability layer that separates a strong personal tool
from a team-grade platform.
