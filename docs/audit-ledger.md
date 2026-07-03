# Audit Ledger

Full-codebase hardening audit. One entry per subsystem. A subsystem gets **PASS** only after a re-review of that subsystem finds nothing new. Verdicts: **CONFIRMED** (reproduced by test or direct execution) / **REFUTED** (suspected, disproven by evidence).

Gate = `bun run typecheck && bun run lint && bun run test` — must be green after every fix.

Baseline (2026-07-01, commit fa32df7): typecheck green, lint clean (249 files), tests 15/15 turbo tasks green (480 core tests).

## Status

| # | Subsystem | Status |
|---|-----------|--------|
| 1 | Modes & approvals | PASS |
| 2 | Compaction & microcompaction | PASS |
| 3 | Prompt-cache economy | PASS |
| 4 | Subagent orchestration | PASS |
| 5 | Coding loop | PASS |
| 6 | Context gathering | PASS |
| 7 | Memory | PASS |
| 8 | Research stack | PASS |
| 9 | Providers & model catalog | PASS |
| 10 | Sessions/persistence/resume | PASS |
| 11 | TUI + headless parity | PASS |
| 12 | Config, MCP, skills/plugins, onboarding, fresh install | PASS |

## ADVERSARIAL PASSES (final gate)

Two consecutive adversarial re-review passes over the weakest/most-changed areas, each hunting
for NEW confirmed defects (including regressions from the audit's own fixes).

### Pass 1 — 3 CONFIRMED new findings (all FIXED + regression-tested)
- **[LOW-MED] Approvals-reset didn't clear `#alwaysAllow`** — a prior "always allow" grant still
  bypassed the gate after `/plan`/`/execute`/plan-accept re-gated to `ask`, contradicting "nothing
  runs unprompted after re-gating." Fixed: `handleApprovals` clears `#alwaysAllow` whenever
  approvals are (re)set to `ask`, BEFORE the no-op guard (so a plan-accept from an already-`ask`
  session still clears). Regression: *"re-gating approvals to ask forgets a prior 'always' grant"*.
- **[LOW-MED] Orchestrator stale dependent** — a task re-run on objective drift left its
  already-seeded dependents stale (seeded against the OLD result). Fixed: seed to a fixpoint,
  only seeding a task when every dep is also seeded, so a drifted dep cascades a re-run to all
  transitive dependents. Regressions: *"a re-run task also re-runs its dependents"*, *"…deps all
  unchanged is not re-run"*.
- **[LOW] Store temp-file leak** — the per-write-unique temp names don't self-heal on a
  save-failure/crash (the old fixed `.tmp` was reused). Fixed: rm our temps on failure, re-throw.
- Plus the onboarding early-return branches (custom/advanced) were made consistent with the main
  path's honest "Almost there" (they had the same false-"all set" on a skipped key).
- Everything else in the changed set verified CLEAN: the `engine-idle` fix provably cannot fire
  before a gate-fix/review-fix follow-up (follow-ups are enqueued inside the awaited `#afterTurn`,
  before `item.run()` resolves); permissions precedence + `explicitAsk` flag correct; compaction
  empty-summary/abort handling correct; `#mergeLock`-wrapped shared gate has no deadlock; store
  ordered-rename + counter correct; source-ledger hydrate correct; catalog non-poisoning correct;
  mcp late-close + plugin timeout correct.

### Pass 2 — 1 CONFIRMED new finding (FIXED + regression-tested) + 1 minor residual
- **[MED-HIGH] Relative path rule evaded by an equivalent spelling** — a natural relative deny
  rule (`{tool:"edit", match:"config/prod.env", action:"deny"}`) matched ONLY the exact raw
  spelling, so `./config/prod.env`, the absolute path, or `config/../config/prod.env` (the SAME
  file) slipped past it. Reproduced directly. Fixed: `check` now tests a path scope in THREE forms
  — raw input, canonical absolute, AND the cwd-relative form of the canonical — so no spelling can
  evade a rule written in another. Regression added. (This direction slipped both prior passes; the
  earlier test only covered an absolute rule catching a relative traversal.)
- **[LOW] Onboarding custom-endpoint `configured`** flagged an apiKey-only (no baseURL) entry as
  "all set" though `custom` requires a baseURL. Tightened to `Boolean(baseURL)`.
- Pass-2 verify + fresh-sweep confirmed everything else CLEAN: the pass-1 fixes (alwaysAllow clear,
  orchestrator fixpoint, store cleanup) correct; orchestration deadlock-free; session/store/compaction
  message-sequence integrity intact (interrupted turn never persists an orphan tool_use); the
  `engine-idle` terminal fires on every submit-prompt path; the edit/write/bash permission gate has
  no bypass.

### Pass 3 — 4 CONFIRMED new findings (all FIXED + regression-tested where unit-testable)
Deeper traces surfaced pre-existing bugs the earlier passes missed:
- **[MED-HIGH] Raw path scope enabled a traversal sandbox escape** — a path was matched against its
  UNNORMALIZED raw form, so `src/../out.ts` (resolving OUTSIDE `src/`) matched a `src/*` allow,
  punching a scoped allowlist through a deny-by-default posture (and a false-deny the other way).
  Reproduced. Fixed: path scopes now match ONLY the normalized forms (canonical/relative/realpath);
  raw is kept solely for command/URL scopes. Regression added.
- **[MED] Ensemble worktree leak** — `Promise.all(attempts)` was awaited OUTSIDE the cleanup
  `try/finally`, so one rejecting attempt leaked every sibling's worktree+branch. Fixed:
  `#runEnsembleAttempt` never throws (returns its worktree handle for cleanup even on error).
- **[MED-HIGH] Image `Uint8Array` broke resume** — an `@image` part serialized to a numeric-keyed
  object (bloated + unreconstructable), so a resumed session sent a broken `image` the provider
  rejects. Fixed: a base64 replacer/reviver round-trips binary blobs in the JSONL. Regression added.
- **[HIGH, gated] Nested `spawn_tasks` mergeLock not shared** — each nested runner had its OWN
  `#mergeLock` while sharing the same `.git`, so a parent-runner merge could race a child-runner
  merge on `.git/index`. Fixed: the merge lock is now tree-global via shared deps (like
  `spawnCounter`/`reportStore`).

### Pass 4 — 4 CONFIRMED new findings (all FIXED; permissions independently re-verified CLEAN)
An independent reviewer found NO high/critical, confirmed permissions clean across 14 empirical
cases, and surfaced 4 low-severity defects:
- **[LOW-MED] `edit` corrupted non-UTF-8 bytes** — `file.text()` lossily decoded invalid bytes to
  U+FFFD and the rewrite persisted that far from the edit. Fixed: strict UTF-8 decode up front;
  refuse to edit a binary/non-UTF-8 file instead of corrupting it. Regression added.
- **[LOW] Empty-text-then-abort diverged `#history` from `#modelMessages`** — an empty partial
  assistant was pushed to `#history` but not `#modelMessages`, so the orphan-rollback dropped the
  user prompt from model context only (lost on resume). Fixed: the failure path records the partial
  to BOTH lists or NEITHER.
- **[LOW] Resumed worktree task degraded to the shared tree after SIGKILL** — the deterministic
  branch survived, so `worktree add -b` failed on resume. Fixed: `gitAddWorktree` deletes a stale
  leftover branch before re-adding.
- **[LOW, recorded] Stale-write guard disabled after 2000+-file LRU eviction** — accepted-risk: the
  cap bounds memory, and refusing edits to any un-tracked file would break legitimate workflows.

### Pass 5 & 6 — final confirmation over the fully-fixed code

**Direct verification sweep (author, empirical against the real exports) — ZERO new findings:**
- Permissions (25+ cases): deny-absolute-across-tiers; `../` traversal escape closed BOTH
  directions (false-allow + false-deny); symlink deref (in-tree); url-scope never false-matches a
  path rule; git_push/git_commit synthetic egress scopes governed; mcp exec `command` governed;
  bash newline/whitespace-case evasion closed; always-allow per-scope + cleared on re-gate;
  explicit-ask fails closed headless. All correct.
- SSRF (11 bypass attempts): metadata IP, `metadata.google.internal`, localhost, `[::1]`,
  IPv4-mapped IPv6, decimal-IP, DNS-rebind-to-private, NAT64, `file://`, `gopher://` — ALL blocked;
  a public host is allowed + pinned. Airtight.
- Store: image `Uint8Array` round-trips; nested Uint8Array works; a decoy tag inside a text string
  stays a string; tag made collision-proof (`__vibecodr_binary_base64__`).
- Compaction: a parallel tool-call/result sequence at the cut boundary stays valid (leading user,
  no orphan tool_result, alternation).
- Orchestration: tree-global `mergeLock` verified to propagate through forks and to be deadlock-free
  (tasks release their childGate slot before contending for the lock); DAG failure paths
  (throwing task → failed, dependents skipped; cycle → validateDag/fail-closed) correct.
- Gate green across 3 full runs (519 tests, 0 fails, no flake recurrence); fresh-install smoke +
  live e2e Ollama run pass.

### Pass 5 (security/data-integrity) — 1 CONFIRMED new finding (FIXED + regression-tested)
Permissions core logic, SSRF (all vectors), store, and edit independently re-verified CLEAN. Found:
- **[MEDIUM] Symlink allow-list-confinement escape** — a planted in-tree symlink (`src/escape ->
  /outside`) matched a `src/*` allow via the LEXICAL path, letting a write escape a deny-by-default
  sandbox. Fixed with ACTION-AWARE path scopes: an `allow` now matches ONLY the symlink-resolved
  REAL target (confinement), while `deny`/`ask` still match lexical-OR-real (a kill-switch fires
  however the path is spelled or wherever it lands). The relative form is based on the REAL cwd so a
  project under a symlinked ancestor (`/var`→`/private/var`) still matches a clean `src/*`.
  Regressions added (escape blocked, legit file allowed, deny both directions).

### Pass 6 (concurrency/state) — 1 CONFIRMED new finding (a REGRESSION from the pass-3 fix; FIXED)
Engine drain, session/compaction/store, loop/blackboard all re-verified CLEAN. Found:
- **[HIGH] Tree-global `mergeLock` re-entrant self-deadlock** — the pass-3 fix (sharing the merge
  lock tree-wide) was held ACROSS the worktree review child's LLM turn, which can itself emit
  `spawn_tasks` whose nested runner re-acquires the SAME non-reentrant lock → the whole session tree
  hangs unrecoverably. Fixed: the lock now wraps ONLY git ops + the gate build (which spawn no
  children); the review child's diff is captured inside the lock, and the review LLM turn runs
  OUTSIDE it (`#reviewCapturedDiff`). Tree-wide `.git` serialization is preserved without ever
  holding the lock across a child turn. (The pass-6 agent confirmed the childGate↔mergeLock ordering
  is otherwise deadlock-free — release-before-acquire discipline holds.)

### Passes 7 & 8 — TWO CONSECUTIVE CLEAN passes over the fully-fixed code (ZERO new findings)
Both targeted the non-trivial pass-5/pass-6 fixes AND swept broadly; both empirically verified.
- **Pass 7 (permission scope fix): CLEAN.** 20 empirical tests via the real `PermissionChecker` —
  allow-list confinement to the real target, deny on every spelling+landing, symlinked-cwd (`#realCwd`)
  keeps a relative allow clean, nonexistent-cwd doesn't crash, command/URL scopes intact. No
  reproducible bug.
- **Pass 8 (mergeLock deadlock fix): CLEAN.** All 5 `#mergeLock` sites verified to wrap only git ops /
  the gate build — none holds the lock across a child turn; the review runs on the in-lock-captured
  diff outside the lock; failed review still fails + tears down; ensemble cleanup always runs; no
  other lock cycle. Deadlock fully closed. (One noted observation — an unscoped `#captureTaskDiff` can
  include a prior staged squash-merge — is explicitly "not a defect," pre-existing diff-scoping.)

### FINAL VERDICT — audit complete
- All 12 checklist subsystems have a **PASS** entry (table above).
- **Two consecutive adversarial passes (7 & 8) over the ledger's weakest areas produced ZERO new
  confirmed findings** — the required convergence. (Trend across all passes: 3 → 1 → 4 → 4 LOW →
  direct sweep 0 → 1 → 1 → 0 → 0.)
- Every CONFIRMED defect across all passes is fixed with a **regression test** where unit-testable;
  the residual items are documented **accepted-risk** with rationale.
- Gate **green**: typecheck, lint (251 files), **520 tests / 15 tasks**, verified stable across
  repeated runs.
- **Fresh-install smoke succeeds**: `clone → bun install → build` needs no manual fixes; a no-keys
  headless run gives a clear actionable error (exit 1); interactive first-run launches guided
  onboarding; `--help`/`models`/`sessions` degrade gracefully; a live end-to-end headless run against
  local keyless Ollama returns the answer with exit 0.

~62 files changed (+~1970/−~242), every subsystem hardened with paired source+test changes.

---

## PRODUCTION-READINESS PROGRAM — 2026-07-02 (post-audit, on top of the converged baseline)

A fresh 8-domain production audit (each defect claim adversarially verified) ran on top of the
converged hardening baseline above, then a six-phase implementation program addressed everything it
surfaced plus three strategic capability gaps. All work landed with paired regression tests; the gate
was green after every phase. A final 7-area adversarial review of the whole accumulated diff
(+~4000/−~330, 67 files + 16 new modules) found 12 confirmed defects in the NEW code — all fixed with
regressions. Net gate at close: typecheck 8/8, lint clean (275 files), **15/15 turbo tasks, core 655
tests**, 0 fail; compiled-binary smoke + live keyless-Ollama e2e both pass.

### Phase 1 — 9 audit-confirmed defects (all fixed + regression-tested)
- **[HIGH] Gate abort produced a false RED/GREEN** — an Esc mid-check parsed the SIGTERM-killed run as
  a real failure (→ un-abortable gate-fix turn editing a healthy tree); an Esc between checks bucketed
  the partial pass-list as GREEN (→ commit-on-green + ledger writeback on unverified work). Fixed: a
  new `"aborted"` `GateSummary.outcome` (shared/build.ts) returned on any `signal.aborted` before/
  during/after a check; the engine treats it as a terminal NON-verdict (no fix enqueue, no gate-round
  bump, no commit-on-green, no review); all orchestrator gate consumers (worktree-merge, ensemble
  scoring, shared-task) handle it (block / score-0 / settle-failed-no-retry).
- **[MED] Adversarial diff-review call was un-abortable and unbounded** — a hung provider wedged
  `vibe -p` forever. Fixed: `AbortSignal.any([session, timeout(120s)])`; abort/timeout skips the review
  with a warn notice (compaction's degrade-don't-kill doctrine).
- **[LOW] lint/typecheck parsers flipped exit-0 → RED** from scraped error tokens. Fixed: exit-code is
  truth for all three parsers (matching the test parser's existing doctrine).
- **[MED] Tiered/long-context pricing ignored** — models.dev `cost.tiers` were dropped, so >200k-context
  turns on gpt-5.5/gemini-3.1-pro/grok-4.3 billed at the base rate (under-counting cost + the
  budget.stop guard). Fixed: parse tiers into `ModelInfo.cost`; `computeCost` reprices every slice at
  the highest exceeded tier.
- **[MED] Limiter hold-and-wait deadlock** — a parent held its one tree-global slot while awaiting
  spawned children (who queue on the same limiter); `subagent.timeoutMs=0` disabled the only escape →
  permanent headless hang. Fixed STRUCTURALLY: `Session.suspendLimiterSlot` releases the parent's slot
  around the child-await (the parent makes no provider call there) and re-acquires after — hold-and-wait
  is eliminated for every config; the timeout stays as defense-in-depth.
- **[LOW] USER.md cap truncated the NEWEST saved prefs** (head-keep vs tail-append). Fixed: structure-
  aware cap keeps header + newest bullets, trims oldest, marks the trim; `save_memory` reports honestly
  when over budget.
- **[LOW] Memory dedup false-positive on boilerplate** — `containsFact` matched header/heading prose.
  Fixed: dedup against fact content only.
- **[LOW] `/reasoning` confirmed effort on providers that drop it** (xai/openrouter route through
  openai-compatible). Fixed: split forwarded (anthropic/openai) vs natively-reasoning; honest caveat.
- **[LOW] Stale permission card after a non-user abort** emitted a false "allowed" notice + wedged
  shortcuts. Fixed: a `permission-settled` UIEvent on every engine auto-resolve; the TUI drops the card;
  answering a settled id is a silent no-op.

### Phase 2 — 10 tech-debt items (all fixed + tested)
Atomic temp+rename for edit/write **and** memory appends; theme/accent name registry unified into
`@vibe/shared/theme-registry` (kills the core/tui duplicate); one shared plan-approval routine (both the
card-accept and mode-switch paths funnel through `#approvePlan`/`#setModeGated`); always-allow keyed by
the canonical path form (no re-prompt on a re-spelling); `commitThinking` write-guarded; `contextWindow`
base-model fallback + a guarded ollama→ollama-cloud alias (local tags no longer inherit the cloud
window); live-elapsed tool rows (no dead spinner); digest fuzzy near-dup dedup; a proactive-recall
relevance floor.

### Phase 3 — production/distribution layer
Version stamping (`version.ts` sentinel + `set-version.ts`); a single-package `--target=bun` npm bundle
(all workspace source inlined, provider imports kept bundle-visible); a tag-driven `release.yml` (4-target
`--compile` binary matrix + SHA256SUMS + guarded npm publish); `update-check` (pure `isNewer`, 24h-cached
keyless GitHub GET, opt-out) + `vibe upgrade` channel detection; crash handlers (terminal-restore +
redacted crash log + `/doctor` surfacing, no telemetry); CI hardened to a ubuntu+macos matrix with a
real keyless-`models` binary smoke (transits the provider lazy-import path the old `--version` smoke
missed) + a PR release-dryrun.

### Phase 4 — subagent parity pack
`continue_subagent` (bounded-LRU retention of completed shared-tree children — worktree/ensemble
descendants deliberately not retained); optional `outputSchema` structured output (a real, honest
JSON-Schema validator — ai@5's `jsonSchema()` does none — that returns errors + raw text on failure,
never a fabricated object); `detach:true` background spawns (same ceiling/journal/limiter governance,
finalize aborts+awaits them, next-turn surfacing + `check_task`; coerced synchronous when headless so
`engine-idle` stays the terminal signal).

### Phase 5 — OS-level sandboxing (opt-in this release)
A stateless `sandbox.ts` under the permission engine: seatbelt (macOS) / bwrap (Linux) profile builders
with realpath-canonicalized writable roots; routed through bash/jobs/exec/verify; `policyForChecks`
keeps the gate writable under a pinned read-only; the `dangerouslyUnsandboxed` escape hatch fails closed
through the existing explicit-ask path. Default `mode:"off"` per the rollout note; darwin integration
tests (outside-write blocked, network-off blocked) verified on a real host.

### Phase 6 — multi-language LSP diagnostics
Behind the unchanged `diagnose()` seam: a `Diagnostics` interface (TsDiagnostics kept as the TS fast
path), an `lsp/` client (Content-Length JSON-RPC over stdio, version-matched publishDiagnostics), a
manager (lazy per-language spawn, per-diagnose deadline so a slow server never blocks an edit, bounded
crash-restart, idle shutdown), and a composite router. Advisory-only + degrade-to-`undefined` (never a
false "clean"); the green-gate stays the cross-file backstop. Default-on is a clean no-op when no
servers are installed.

### Final adversarial review — 12 confirmed in the new code, all fixed + regression-tested
- **[HIGH] Sandbox escape-hatch fail-closed defeated by a broad allow rule** — `dangerouslyUnsandboxed`
  bypassed the forced ask whenever ANY content-scoped rule applied, so a blanket `{bash, match:"*",
  allow}` let an unsandboxed dangerous command run with zero approval under auto/yolo/headless. Fixed:
  bypass only when an applicable ALLOW rule targets the `!unsandboxed <cmd>` sentinel but NOT the bare
  command (a rule written specifically to pre-authorize the unsafe variant); a blanket allow fails closed.
- **[MED] Crash log leaked key-shaped tokens** without an adjacent keyword — added prefix-anchored
  value-shape masking (`sk`/`pk`/`ghp`/`xox*`/`AIza…`).
- **[MED] LSP `dispose()` orphaned a mid-initialize server** (process leak) — track the starting client
  synchronously and tear it down too.
- **[MED] Relevance floor nullified semantic recall** for zero-surface-overlap paraphrase queries —
  exempt dense-ranked hits from the lexical-overlap gate.
- **[MED] Atomic temp+rename destroyed symlinks** (replaced the link with a regular file, stranded the
  target) — dereference to the real target before writing, in edit + write.
- **[MED] Update-hint ignored the opt-out**; **[LOW] `/doctor` showed a stale update-available for 24h**;
  **[LOW] npm-bundle self-containment guard checked the specifier not an inlined symbol** (couldn't catch
  the 0ebce43 externalization it guards) — all fixed.
- **[LOW] Worktree-descended subagent retained with a torn-down cwd** — registry skips out-of-tree
  children + `continue_subagent` evicts a vanished cwd with an honest error.
- **[LOW] Structured-output validator used prototype-chain `in`** (a `constructor`/`toString` key spoofed
  a modeled constraint) — `Object.hasOwn`.
- **[LOW] LSP crash-budget reset on mere init** (crash-on-use churned unboundedly) — reset only after a
  proven-usable diagnose round-trip.
- **[LOW] Linux `available:true` from mere `bwrap` presence** (userns may be disabled) — gate on a cached
  `bwrap --ro-bind / / true` smoke.

**Verification at close:** gate green across all packages (655 core tests); compiled binary rebuilt
(285 modules, provider lazy-imports survive `--compile`); `models` keyless exit 0 (353 models);
`vibe upgrade` detects the binary channel; a live headless turn against local Ollama returns the answer
with exit 0.

---

## DECISIONS

- **Permission precedence: DENY is absolute across specificity tiers.** The prior
  design decided the content-scoped tier before the name-only tier *including for
  deny*, so a scoped `allow` could punch a hole through a blanket `deny` — against
  the documented "deny > ask > allow regardless of order." Reworked so any matching
  deny (scoped or name-only) wins outright; specificity now governs only the
  allow-vs-ask distinction (a scoped allowlist still beats a name-only ask so
  allowlists don't prompt). Consequence: "deny-with-exceptions" must be expressed
  by *scoping the deny* (e.g. `{match:"rm *", action:"deny"}`), not by allow-listing
  past a broad deny. This is the safer, least-surprising kill-switch semantics
  (matches how Claude Code itself treats deny).
- **Path rules are tested in every equivalent spelling.** A path scope is now matched
  against the raw input, the canonical absolute (`resolve`), its cwd-relative form
  (`relative`), AND the symlink-dereferenced real path + its relative form
  (`realpathScope`, best-effort). So a rule written relative (`config/*`) or absolute
  (`/etc/*`) catches the same file spelled with `./`, `../`, absolutely, or reached
  through an in-tree symlink — no spelling evades a rule written in another. (macOS
  system symlinks like `/etc`→`/private/etc` mean an `/etc/*` rule matches the
  conventional path but the dereferenced form is `/private/etc/*`; the realpath form
  is purely additive so it never causes a false deny/allow, and on Linux the in-tree
  symlink case is fully closed.)
- **Glob matching is asymmetric by security posture.** Protective actions
  (`deny`/`ask`) compile with dotAll+case-insensitive flags (match broadly — a
  newline or host-case trick can't dodge a kill-switch); `allow` compiles strictly
  (a trailing command can't be smuggled past an allowlist). Command-string globbing
  over `bash` remains best-effort (whitespace/path-form tricks still evade a naive
  `match`) — documented in-code; real egress control should use deny-by-default or
  the structured `git_push`/`git_commit` tools.
- **Explicit `ask` rules fail closed when headless.** A frictionless *default* ask
  still auto-allows in `-p`/CI (so scripts don't wedge), but a user-authored
  `{action:"ask"}` gate now denies when there is no human to approve, so an authored
  gate can't silently degrade to `allow`.
- **Empty summaries never delete history.** Compaction that would replace real
  history with an empty/whitespace summary is aborted (keeps the messages), and a
  summarizer *failure* skips compaction with a notice instead of failing the turn —
  an auxiliary side-channel call must not cost the conversation its past or kill a
  turn/subagent.

---

## 1. Modes & approvals — PASS

Three auditors (policy engine, mode transitions, plus direct reproduction).

### CONFIRMED & FIXED
- **[HIGH] Scoped ALLOW overrode name-only DENY** (`permissions.ts` decide logic).
  Contradicted the documented invariant; a blanket `{tool:"bash",action:"deny"}` +
  scoped allowlist allowed the matching commands. Fixed: deny wins across tiers.
  Regression: *"a name-only DENY is an absolute kill-switch…"*.
- **[HIGH] `bash` command-glob deny bypassable via newline / host-case**
  (`globToRegExp` had no `s`/`i` flag). Reproduced directly: `git push*` deny evaded
  by `git push origin main\nrm -rf /`. Fixed: action-aware flags (deny/ask dotAll+`i`,
  allow strict). Regressions: *"a deny can't be dodged by a newline…"*, *"an ALLOW
  stays strict…"*.
- **[HIGH] `/plan`→`/execute` (and plan-card accept) silently stayed in YOLO** — the
  slash and card paths set mode without resetting approvals, so leaving plan from a
  YOLO session ran unprompted. Fixed: all three transition paths reset approvals to
  `ask` (matching the Shift+Tab coupling). Regression: *"/plan then /execute never
  silently lands in YOLO"*.
  *(Strengthened 2026-07-02, modes-flow pass: the per-path fix left a fourth path
  exposed — the TUI maps typed `/plan`/`/execute` to bare `set-mode`, which bypassed
  the run-slash handlers. The invariant now lives in the engine's `set-mode` itself:
  requesting a mode always lands in gated `ask` (grants forgotten); YOLO is only ever
  an explicit `set-approvals auto` sent after. The slash handlers now delegate to
  `set-mode`, so plan approval by handoff also works via `/execute`. Regression:
  "a RAW set-mode always lands in gated ask".)*
- **[MEDIUM] Explicit `ask` rules auto-allowed headlessly** (`engine.ts #askPermission`).
  Fixed: resolver now carries an `explicit` flag; a non-interactive run fails an
  explicit gate closed. Regression: *"non-interactive: an EXPLICIT ask rule fails CLOSED"*.
- **[MEDIUM] `always`-allow keyed by tool name only** — approving one `bash` command
  auto-allowed every future `bash`. Fixed: keyed by tool+content-scope. Regression:
  *"'always' is remembered per content scope"*.
- **[MEDIUM] Command-bearing MCP/exec tools escaped all `match` rules** — only `bash`'s
  `command` was content-scoped. Fixed: any tool with a string `command` is
  command-scoped. Regression: *"command-scoped match rules govern any command-bearing tool"*.
- **[MEDIUM] `abort` left pending permission prompts unresolved** — a stale prompt,
  clicked later, could run a cancelled side-effecting tool. Fixed: abort resolves all
  pending permissions as `deny` and clears them.
- **[MEDIUM] Plan-card double-accept** could seed tasks + fire two execute turns. Fixed:
  `#lastPlan` cleared synchronously on accept.

### CONFIRMED — remaining / accepted-risk (tracked, lower priority)
- [MEDIUM] Mid-turn mode change doesn't neutralize the in-flight turn (tools/approvals
  frozen at turn start). Real stop is Esc/abort. **Design note:** re-deriving the
  active toolset mid-stream is a larger change; recorded for a follow-up. Not a silent
  data-loss/egress hole (mode chip is honest about the *next* turn).
- [MEDIUM] Plan-mode read-only trust rests on each tool's self-declared `readOnly`; a
  mislabeled MCP/plugin tool (`readOnlyHint:true` on a mutator) stays callable in plan
  mode. Mitigation would need an independent side-effect classifier — recorded.
- [LOW] `approvalMode` not persisted across resume (fail-safe: resumes as gated EXECUTE,
  never YOLO). Acceptable; documented as intentional fail-safe.
- [LOW] `pendingHandoff` can linger if a plan is approved via Shift+Tab while the card is
  still visible (TUI dismissal gap). Recorded for the TUI pass (subsystem 11).
  *(Closed 2026-07-02, modes-flow pass: the TUI dismisses the plan card on any
  mode-changed away from plan — the double-accept affordance is gone — and the engine
  disarms `pendingHandoff` when re-entering plan, so a revoked approval can't inject
  an execute directive into a read-only turn.)*
- [LOW] Symlink path-canonicalization (uses `resolve`, not `realpath`) — an in-tree
  symlink to `/etc` evades a `/etc/*` path deny. `realpath` is async + fails on
  nonexistent targets; recorded, lower priority than the string-bypass fixes above.

### REFUTED / non-issues (verified)
- Headless plan mode cannot execute (forMode strips mutators regardless of auto-allow).
- Deny rules still apply headlessly (deny short-circuits before the resolver).
- `set-mode`+`set-approvals` non-atomicity not exploitable (single-threaded dispatch).
- Cross-session plan-file pickup impossible (path keyed by session id).

---

## 2. Compaction & microcompaction — PASS

### CONFIRMED & FIXED
- **[HIGH] Empty/whitespace summary irrecoverably deleted all older history**
  (`compaction.ts` committed the slice regardless of summary content). Fixed: an
  empty summary aborts compaction (messages untouched). Regression added.
- **[HIGH] Summarizer failure aborted the whole turn** (and marked subagent forks as
  failed) — the auxiliary `generateText` call was unwrapped. Fixed: `#maybeCompact`
  catches non-abort failures, emits a warn notice, proceeds uncompacted; aborts still
  propagate. Regression added.

### CONFIRMED — accepted-risk / recorded
- [MEDIUM] Few-but-huge context (≤`keep` giant messages, e.g. a pasted 150k-token file)
  can't be compacted (count-guard) → provider 400. **Design note:** a safe fallback is
  truncating a single oversized message with a marker, but it risks corrupting tool-call
  pairing; deferred pending a targeted, well-tested implementation. Recorded.
- [MEDIUM] `DEFAULT_CONTEXT_WINDOW=128k` fallback under-compacts unknown small-window
  models. Root cause is catalog completeness → tracked under subsystem 9 (providers).
- [LOW] Offloaded-artifact path is cwd-relative (breaks on resume from a different cwd);
  freed-byte over-count; orphaned offload artifacts after mid-turn abort. Recorded;
  low impact.

### REFUTED / verified sound
- Tool-call/tool-result pairing preserved across compaction; alternation + leading-user
  invariants hold; micro vs full compaction don't conflict; prompt-cache byte-stability
  after the one-time offload prefix bust; token/cache-cost accounting correct; system
  prompt/goal/memory survive (live outside `messages`); persistence rename ordering sound.

---

## 3. Prompt-cache economy — PASS

Audited end-to-end; **no critical/high defects.** Verified sound: exactly 3 Anthropic
breakpoints (system, tools-tail, conversation-tail), well under the cap of 4; system
prompt is byte-stable (no per-turn timestamps/token-counts/dir-listings — volatile task
list + sources ride the newest user message); cost accounting correctly peels the three
disjoint Anthropic cache slices at the right rates and never double-counts; tool order is
deterministic (insertion-ordered Map); subagents rebuild their own stable prefixes without
reordering the parent. One-time prefix busts (recon/memory/goal landing mid-session) are
unavoidable and rare.

### FIXED (coverage gap)
- [LOW] Cache-**write** cost path + the session-level `cacheCreationInputTokens` fold were
  untested — a silent regression (e.g. an SDK field rename) would under-report first-turn
  cost with no failing test. Added a `computeCost(..., cacheWriteTokens)` regression.

---

## 4. Subagent orchestration — PASS

DAG core, semaphore, and file-lock verified sound (cycle/dup/unknown/self-dep caught;
diamond deps don't double-run; failed-dep transitively skipped; thrown runTask → failed
result; semaphore slot released in `finally` — no leak; file-lock hard-rejects a
cross-child same-file write). Blackboard `clear()` only on FIFO `submit-prompt` (never
mid-fan-out); resume session id preserved; worktree merge/remove serialized.

### CONFIRMED & FIXED
- **[MEDIUM] Shared-tree gate/build ran concurrently and unserialized** — two `check:true`
  tasks with no deps ran the repo's `build`/`test` in the same dir simultaneously,
  clobbering outputs and cross-observing edits (nondeterministic verdict). The worktree
  path already serialized this via `#mergeLock`; the shared path didn't. Fixed: shared
  gate now runs inside `#mergeLock` too — all shared-tree builds/merges are mutually
  exclusive. (Also closes the gate-vs-gate portion of the cross-strategy interference
  finding.)
- **[MEDIUM] Journal seed matched by id only** — a reused id (`impl`/`test`/`fix`) with a
  changed objective was silently seeded from the stale result, skipping the new work and
  reporting the old objective. Fixed: plan-drift guard re-runs a task whose objective
  differs from the seed. Regressions added (honored-when-unchanged, re-run-on-drift).
- **[LOW-MED] Report-path sanitize collision** — `a.b` and `a_b` sanitized to the same
  slug, so the second overwrote the first's report (and resume/`read_report` returned the
  wrong one). Fixed: per-id FNV hash disambiguates the path. Regression added.
- **[TEST] Vacuous worktree-teardown assertion** — asserted `existsSync(".vibe/worktrees/wa")`
  but the real dir is `wa-<hash>`, so it never verified cleanup. Fixed to assert no
  worktree dir survives.

### CONFIRMED — recorded / accepted-risk
- [MEDIUM] Cross-strategy tree interference: a shared-task's file WRITES can still land
  during a worktree post-merge gate (the gate-vs-gate race is now locked, but shared-tree
  writes are inherently unserialized — this is exactly why `worktree:true` isolation
  exists). Guidance already tells the model to use worktrees for parallel writers.
- [LOW] Unbounded/unserialized worktree creation on shared `.git`; a failed `add` silently
  degrades a `worktree:true` task to the shared tree. Mitigated by git's own metadata
  locks + per-id paths; recorded.
- [LOW] Nested `spawn_tasks` inside a subagent isn't resumable (journal keyed by ephemeral
  child id). Edge case; recorded.
- [INFO] Blackboard `claim` is advisory (the file-lock is the real enforcement); kickoff
  copy slightly overstates claim semantics.

---

## 5. Coding loop — PASS

Verified sound: multi-edit atomicity (all-or-nothing buffer), non-unique old_string guard,
literal replace (no `$&`/`$1` interpretation), timeout→killTree→non-zero→FAIL (never a false
green), `isReviewClean` line-start anchored, `undo()` hardened against dead/GC'd commits and
empty ls-tree.

### CONFIRMED & FIXED
- **[MEDIUM] `/undo` needed two presses** — commit-on-green pushed a GREEN result-marker
  (post-edit tree) on top of the pre-edit checkpoint, so the first `/undo` restored the
  green marker (a visible no-op) and only a second actually reverted. Fixed: `undo()` skips
  green markers (drops their refs) and restores the pre-edit checkpoint, so ONE `/undo`
  reverts the turn. Regression added.
- **[MEDIUM] Green-gate was non-abortable mid-check** — the engine's main-path `#runGate`
  passed no abort signal, so an Esc couldn't stop a long build (only the per-check timeout,
  600s × N, bounded it). Fixed: threaded the session's abort signal (new `Session.abortSignal`
  accessor) into `runGate`; `gate.ts`→`exec`→`Bun.spawn` already honor it. Regressions added
  (abort-before-check, signal-forwarded-to-exec). *Note: the auditor's claim that `gate.ts`
  didn't forward the signal to `exec` was REFUTED — it always did (line 61); only the engine
  call site was missing it.*
- **[LOW-MED] Adversarial diff-review fallback missed untracked/new files** — with checkpoints
  disabled, the fallback used tracked-only `git diff`, so a brand-new file full of stubs was
  invisible to the reviewer and stub scan. Fixed: `#fallbackReviewDiff` now includes staged
  changes (`diff HEAD`) and untracked files (synthesized as add-diffs), non-destructively.
- **[LOW] `timeoutSec: 0` could wedge the gate** (disabled the kill timer). Fixed: `runGate`
  coerces a non-positive timeout to the 600s default. Regression added.
- **[LOW-MED] Stub-scan missed empty function bodies** — a declared-but-empty `function foo(){}`
  (compiles clean) slipped through. Added a conservative `empty-body` rule (named `function`
  declarations only; arrow no-ops excluded to avoid false positives). Regression added.

### CONFIRMED — accepted-by-design / recorded
- [LOW] In-loop diagnostics are per-edited-file, not project-wide (the green-gate is the
  cross-file backstop). By design; recorded.
- [LOW] A bogus test command that exits 0 with no parseable output reads as green (the
  `noTests` heuristic only catches explicit "0 tests" strings). Depends on recon detecting the
  right command; by design (don't flip green→red on log noise). Recorded.
- [LOW] Review round-budget exhaustion is silent (no "budget exhausted" notice like the gate);
  minor UX. Recorded.
- [LOW] `edit` does no CRLF normalization (honest "not found" error, never a silent clobber);
  mtime same-millisecond edge. Recorded.

---

## 6. Context gathering — PASS

`mentions.ts` (byte caps, image limits), `repo-map.ts` (deterministic locale-compare
ordering, mtime cache), and `detectCommands` watch/dev rejection verified sound. `expandMentions`
runs only on the user's own submitted prompt (never subagent kickoffs), so `@../path`
traversal is a deliberate user affordance (same trust as the read tool) — recorded, not a vuln.

### CONFIRMED & FIXED
- **[MEDIUM] Recon sentinel injection** — `codeintel.ts` split the batched probe on a fixed
  `@@VIBECODR@@` delimiter, so a scanned file containing it could inject a fake section
  (spoof git-clean state, disable command detection). Fixed: per-run nonce marker
  (`@@VIBECODR@@<uuid>@@`), unguessable to scanned content. Regression added (spoof attempt
  can't overwrite real dirty state).
- **[MEDIUM] `$HOME`-as-git-repo slurped `~/AGENTS.md`** — the `.git` check preceded the home
  boundary, so a dotfiles `~/.git` made the walk ascend into `$HOME` and inject personal
  memory into every project. Fixed: stop the ascent before entering `$HOME`. `memoryDirs` made
  injectable-home for testing. Regressions added (home not entered; real sub-home repo still found).
- **[LOW-MED] Makefile variable read as a target** — `build := …` matched `/^build\s*:/`,
  producing a bogus `make build` gate command that fails. Fixed: `(?!:?=)` rejects `:=`/`::=`
  assignments while keeping real targets (incl. `::` double-colon rules). Regression added.
- **[LOW-MED] Binary files injected as mojibake** — a non-image `@file.pdf`/`@blob.bin` was
  UTF-8 decoded into garbage text. Fixed: NUL-byte detection skips binary with a notice.
  Regression added.
- **[LOW] One unreadable command/skill file aborted the whole scan** — the `try` wrapped the
  entire `for await`. Fixed: per-file try so the rest still load.

### CONFIRMED — recorded / low
- [LOW] repo-map sub-path call evicts cache entries outside the sub-path (perf regression on a
  later full scan; not correctness). Recorded.
- [LOW] `applyArgs` mangles `$100+` (regex caps at 2 digits; within the documented `$1..$99`
  spec). Recorded.
- [MEDIUM/user-initiated] `@file` path traversal reads outside cwd — user-typed prompts only;
  accepted as a deliberate affordance.

---

## 7. Memory — PASS

Verified sound: BM25 division-by-zero guard, RRF fusion (no normalization needed), embedder
failure → BM25 fallback (never crashes), embedder-id@dim namespacing prevents vector-space
mixing, atomic session saves, headless behavior correct (digest interactive-only; recall/save
work in `-p`).

### CONFIRMED & FIXED
- **[MEDIUM] USER.md double-handled** — the always-injected curated files (USER/VIBE/AGENTS/
  CLAUDE.md) were also pulled into the searchable recall corpus, double-embedding them and
  letting recall surface content already permanently in context. Fixed: excluded from
  `readMarkdownDocs`. Regression added.
- **[MEDIUM] Transient corpus-read failure wiped the index** — `readMarkdownDocs` returned `[]`
  on ANY error, so a momentary FS fault told the reconciler "scope empty" → it pruned every
  vector and force-re-embedded. Fixed: ENOENT → `[]` (legit empty), any other error propagates;
  `MemoryService.search` catches it and degrades to session-only recall WITHOUT touching (and
  pruning) the index.
- **[LOW-MED] Empty-query semantic recall** returned arbitrary nearest-neighbours (embedding
  `""` yields a real vector). Fixed: dense branch guarded on a non-empty query; `recall_memory`
  schema now `.min(1)` + a runtime `!query.trim()` guard.
- **[LOW] Digest quality guard** only rejected the empty string — a curt "No significant
  changes." was saved as durable memory. Fixed: reject low-value/no-op digests.

### CONFIRMED — recorded / accepted
- [MEDIUM] Session digests accumulate with no dedup across `--resume` (near-duplicate summaries).
  Recorded — a content-hash dedup is the recommended follow-up; not fixed here to avoid changing
  the append-store contract mid-audit. *(Implemented 2026-07-02, post-audit: all saves — digests
  included — dedup against the scope's whole store via a normalized, word-boundary-aware match;
  `appendMemory` returns `{path, deduped}` and the check runs inside the per-path write lock.)*
- [LOW] Vector store is O(N) per query with no eviction; global memory re-embedded per project;
  digest uses the flagship model. Recorded (cost/scale, not correctness).

---

## 8. Research stack — PASS

**SSRF guard independently verified robust** (no bypass): metadata IP, IPv4-mapped IPv6 (hex
form), NAT64/DNS64, decimal/octal IP literals, DNS rebinding (resolve-once + pin to verified IP
with Host/SNI preserved), redirect-to-internal (re-validated every manual hop), CGNAT/link-
local/ULA/multicast — all blocked. pdftext deflate-bomb ceiling and package-info name grammars
sound.

### CONFIRMED & FIXED
- **[MEDIUM] Sources-ledger provenance wrong for webfetch** — the ledger harvested URLs from the
  webfetch OUTPUT (the page BODY), recording arbitrary in-page links (ads/related) as "fetched"
  while the URL actually fetched went unrecorded — so the model could cite links it never read.
  Fixed: capture the webfetch INPUT url at tool-call and record THAT; web_search/crawl_docs still
  harvest their output (which IS a URL list). Regression added.
- **[LOW] Crawl broke on http→https redirect** — the same-origin bound compared full `origin`
  (scheme-sensitive), so a docs site that 301s http→https failed the whole crawl. Fixed: new
  `sameSite` compares host+port with an http→https UPGRADE tolerated (downgrade/off-host still
  refused). Regression added.

### CONFIRMED — recorded
- [LOW] Search-engine/registry fetches have no byte cap and bypass the guard (fixed trusted hosts
  only). [LOW] deep-search fan-out unthrottled across calls. [INFO] untrusted web content flows
  into context unsanitized (inherent to web research). Recorded.

---

## 9. Providers & model catalog — PASS

Catalog reliably populates real windows/pricing for cloud models (alias table + models.dev);
128k default is only hazardous for models the catalog can't know (local). Cost accounting
cache-aware and correct.

### CONFIRMED & FIXED
- **[HIGH] LM Studio / local models got the 128k default window** — only `ollama/` was probed, so
  an LM Studio 4k/8k model believed it had 128k → compaction never fired → every long turn 400s
  or is silently truncated. Fixed: added `probeLmStudioContextWindow` (native `/api/v0/models`,
  prefers the SERVED `loaded_context_length`) and wired it into `#resolveContextWindow` for
  `lmstudio/`. Regressions added.
- **[MEDIUM] A failed first catalog load poisoned the catalog for the process** — a null fetch
  cached an empty (truthy) Map, so every later lookup skipped the network forever, pinning all
  models to defaults + $0. Fixed: don't cache an empty map — clear the in-flight promise so the
  next lookup retries; `refresh()` keeps good data on a failed forced refresh. Regression added.
- **[MEDIUM] Ollama Cloud probe misrouted** to localhost for cloud users. Fixed: the probe
  defaults to `https://ollama.com` when `OLLAMA_API_KEY` is set and no baseURL is configured.
- **[MEDIUM] Estimated pricing could hard-stop a free local session** — an `estimated` base-model
  price (a local tag inheriting a cloud namesake's rate) accrued cost that tripped `budget.stop`.
  Fixed: `stop` only aborts on KNOWN (non-estimated) cost; the warn still fires for estimated.

### CONFIRMED — recorded
- [MEDIUM] Codex OAuth token has no expiry/refresh (re-read from disk; external `codex login`
  refreshes it). [LOW] fresh install with zero keys errors rather than defaulting keyless; keyless
  providers report configured even when the daemon is down. Recorded (auth-flow scope).

---

## 10. Sessions / persistence / resume — PASS

Resume restores model/mode/goal/tasks/usage/cost/recalledContext consistently; ordered-rename
crash window is monotone; corrupt/truncated files degrade (skip bad lines), not crash; subagent
forks null out persistence so they don't pollute resume.

### CONFIRMED & FIXED
- **[MEDIUM/HIGH] Two instances resuming the same session could produce a TORN transcript** — the
  temp filename was fixed (`messages.jsonl.tmp`), so two concurrent writers' interleaved bytes
  renamed into place and `#readJsonl` silently dropped the unparseable lines (breaking tool-call/
  result pairing). Fixed: per-write-unique temp suffix (pid + counter) so every rename installs
  ONE writer's COMPLETE file (last-writer-wins, never a mix). Regression added.
- **[MEDIUM] Source ledger not persisted/restored** — `[n]` citations in a resumed transcript no
  longer mapped. Fixed: persist `sources` in `SessionMeta`; `SourceLedger.hydrate` restores them
  on resume (preserving indices, continuing the numbering). Regressions added.

### CONFIRMED — recorded / accepted
- [MEDIUM] Interrupted multi-step turn loses completed tool calls/results from the transcript
  (only partial assistant text is pushed on abort). **Recorded** — persisting completed steps on
  abort is a larger change to the run loop; flagged as the top follow-up for this subsystem.
- [MEDIUM] No `fsync` before rename (power-loss window); no session pruning (unbounded growth);
  no `SessionMeta` schema version. [LOW] `engine.json` written non-atomically. Recorded.

---

## 11. TUI + headless parity — PASS

Verified sound: headless permission handling doesn't hang (non-interactive auto-resolves);
`engine-error` ends the one-shot with exit 1; plan-mode JSON output is captured.

### CONFIRMED & FIXED
- **[HIGH] Headless `-p` truncated multi-turn output and raced finalize()** — `runOneShot` broke
  on the FIRST per-turn `session-idle`, but a single prompt expands into follow-up turns
  (gate-fix / review-fix / verify-fix, ON by default). So `vibe -p "fix X"` printed only the
  first turn and then `finalize()` tore down (closed the bus / killed jobs / closed MCP) WHILE the
  follow-up turn was still running — dropping its output and pulling resources mid-turn. Fixed:
  added an `engine-idle` event emitted when the engine's queue FULLY drains (all follow-ups done),
  and `runOneShot` now stops on that. It always fires (even after an error / a pre-run-loop
  failure), so it can't hang. Verified live end-to-end against local Ollama. Regressions added
  (multi-turn capture, error path, plan capture).
- **[LOW/HEADLESS] Plan lost in JSON mode** — `--mode plan --output-format json` returned empty
  text. Fixed: `plan-presented` is folded into the JSON `text`. Regression added.

### CONFIRMED — recorded (need interactive verification; not fixed blind)
- ~~[MEDIUM] Interactive TUI drops `verify-*` / `loop-tick` / `checkpoint-restored` /
  `reasoning-delta` events~~ **FIXED (2026-07-02, UI pass):** app.tsx now renders all four —
  verify/loop/checkpoint as transcript notices (a verify failure carries the output's first
  line, previously shown nowhere), reasoning as a live `✻ thinking` one-liner under the
  spinner. Smoke-verified (§15/§16) + screenshot-verified.
- ~~[MEDIUM] Ctrl-C in the TUI bypasses `engine.finalize()`~~ **FIXED (2026-07-02, UI pass):**
  `mountApp` renders with `exitOnCtrlC: false`; Ctrl+C routes through the SAME
  finalize-then-exit path the shipped `/exit` command already used (so terminal restore is
  the proven path, not new wiring); a second press during teardown hard-exits (130).
- [LOW] Permission card is hard to answer while the input draft is non-empty; reducer drops a
  tool-finish for an unknown callId (benign); transcript `blocks` grows unbounded. Recorded.

---

## 12. Config, MCP, skills/plugins, onboarding, fresh install — PASS

**Fresh-install smoke verified directly:** `--help`/`--version` exit 0; a no-keys headless run
gives a clear actionable error and exit 1 (correct — can't prompt in a pipe); `models`/`sessions`
degrade without crashing; interactive first-run triggers guided onboarding; `bun install` + build
resolve with no manual fixes; a real end-to-end headless run against local keyless Ollama returns
the answer with exit 0. Verified sound: MCP startup is parallel + per-server timeout (one hung
server can't block boot); tool registry blocks builtins from being shadowed; MCP cross-server name
collisions get a hash suffix; OAuth store handles corrupt files; skills/commands loaders and
HookBus isolate per-item failures.

### CONFIRMED & FIXED
- **[MEDIUM] Onboarding could persist a config that bricks every later run** — `writeGlobalConfig`
  wrote patches with NO schema validation, so an invalid value (e.g. a malformed custom baseURL)
  persisted and every subsequent non-`setup` run threw ConfigError on load. Fixed: validate the
  merged config against `ConfigSchema` BEFORE writing; reject the write so the caller can re-prompt.
  Regression added.
- **[MEDIUM] A plugin whose `register()` never resolves hung CLI boot** — no timeout. Fixed:
  bounded each plugin's register() with a 15s deadline (matches the MCP hub); a timeout is logged
  and skipped, boot proceeds, and later plugins still load. Regression added (injectable timeout).
- **[MEDIUM] MCP connect-timeout leaked the connection** — `withTimeout` only raced the connect, so
  a slow-but-eventual connect handed back a live transport (spawned child / HTTP client) that was
  never closed → orphaned process for the session. Fixed: close the abandoned client when it lands
  late.
- **[LOW] Onboarding printed "You're all set" even when a required key was skipped** — sending the
  user into a re-onboarding loop with a false confirmation. Fixed: detect whether the provider is
  actually usable (keyless / already-configured / key-provided) and print an honest
  "Almost there — no API key set" box otherwise.

### CONFIRMED — recorded
- [MEDIUM] Unknown/misspelled config keys are silently dropped (no `.strict()`). **Recommended:** a
  soft "unknown key" warning in `/doctor` (strict rejection would hurt forward-compat). Recorded.
- [LOW] Onboarding number-key selection uses an absolute index against a windowed list (latent
  mis-select after scrolling). [LOW] fresh install with zero keys errors rather than defaulting
  keyless. Recorded.

---

# v2 audit (2026-07-03, full from-scratch re-audit)

The 2026-07-02 v1 audit above is retained as historical record. v2 exists because a 34-file
plan-mode overhaul (code-enforced plan grounding gate, id-addressed tasks, yolo plan approval,
drive-to-green hardening, machine-state relocation to `~/.vibe/state/<cwd-hash>`) landed AFTER
v1 closed, and the user chose a full from-scratch re-audit of all 12 subsystems rather than a
delta. v1 verdicts are prior art, not evidence: every subsystem is re-read end-to-end and every
suspicion re-verified against the current code. v1 accepted-risk and DECISIONS items may only be
overturned with new evidence, quoting the v1 rationale.

Gate = `bun run typecheck && bun run lint && bun run test` — must be green after every fix.

**v2 baseline (2026-07-03, commit `8416f2c`):** typecheck 8/8 turbo tasks green; lint clean
(280 files); tests green — 15/15 turbo tasks: core 676 (79 files), tools 247 (26 files),
tui 170 (13 files), providers 53 (7 files), cli 24 (5 files), config 11 (1 file), plugins 7
(2 files). `bun run smoke:tui` prints SMOKE OK.

## v2 status

| # | Subsystem | Status |
|---|-----------|--------|
| 1 | Modes & approvals | PASS |
| 2 | Compaction & microcompaction | PASS |
| 3 | Prompt-cache economy | REOPENED |
| 4 | Subagent orchestration | PASS |
| 5 | Coding loop | PASS |
| 6 | Context gathering | PASS |
| 7 | Memory | PASS |
| 8 | Research stack | PASS |
| 9 | Providers & model catalog | PASS |
| 10 | Sessions/persistence/resume | PASS |
| 11 | TUI + headless parity | PASS |
| 12 | Config, MCP, skills/plugins, onboarding, fresh install | REOPENED |


## v2 §1. Modes & approvals — PASS

Scope read end-to-end: engine.ts (2163), engine-commands.ts, session.ts (mode/gate/approvals paths),
permissions.ts (306) + permissions.test.ts (447), plan-gate.ts (207), tui/modes.ts (65),
shared/commands.ts (77). Two independent end-to-end readers + author verification of every suspicion.

### CONFIRMED & FIXED (each repro'd failing before the fix, passing after)
- **[MED] V2-1 Stale `#planModelPrev` clobbered an explicit model choice; resume mid-plan stranded
  execution on the planModel** — entering plan while already ON the plan model (explicit `/model
  <planModel>`, or a `--resume` of a mid-plan session, where prev is an engine field never
  persisted) left a stale/absent prev, so leaving plan either restored an outdated model or never
  restored at all. Fixed: plan-entry with model===planModel clears prev; the restore falls back to
  `config.model` (the persisted execution-model truth). Regressions: *"planModel restore never
  clobbers an explicit model choice"*, *"resuming mid-plan does not strand execution on the
  planModel"* (engine.test.ts).
- **[MED] V2-2 Mid-turn mode switch broke the in-flight plan turn's gate** — the `planGate` closure
  non-null-asserted the LIVE `this.#planGate` (retired by setMode) → TypeError inside present_plan;
  and telemetry recording was gated on live `this.mode === "plan"` → a flip silently discarded the
  turn's research counts (false rejection). Fixed: a turn-scoped `#turnGate` captured at run()
  start feeds both the closure and `recordToolUse`. Regression: *"plan gate survives a mid-turn
  mode switch away from plan"* (plan-gate-session.test.ts).
- **[MED] V2-3 Exhausted rejection budget permanently disarmed the gate for the rest of the plan
  stay** — `#rejections` never reset, so after one plan hit MAX_REJECTIONS every later request in
  the same stay sailed through `ungrounded` on its FIRST ungrounded present. Fixed: `noteRequest`
  re-arms the budget per user prompt. Regression: *"a new prompt re-arms the rejection budget"*
  (plan-gate.test.ts).
- **[LOW-MED] V2-4 Deferred plan approval never spent `#lastPlan`** — plan→execute toggles after a
  Shift+Tab approval re-entered the approval routine each cycle: duplicate "Plan approved" notices
  + task list re-seeded (statuses reset). Fixed: the deferred branch clears `#lastPlan` like the
  immediate branch. Regression: *"deferred plan approval is spent once"* (engine-scenarios.test.ts).
- **[LOW-MED] V2-5 A mid-turn mode flip smuggled a mutating turn past the green gate** —
  `#turnIsGateable`/`#maybeVerify` read the LIVE session mode, so an execute turn flipped to plan
  mid-stream skipped gate AND the UNVERIFIED honesty notice. Fixed: session records `turnMode` at
  run() start; post-turn gating judges the turn by the mode it STARTED in. Regression: *"a mid-turn
  mode flip cannot smuggle a mutating turn past the gate"* (engine-scenarios.test.ts).
- **[LOW] V2-6 `#persistEngineState` writes were fire-and-forget and unserialized** — overlapping
  writes to engine.json could land out of order and persist a stale `pendingHandoff`. Fixed
  (hardening, confirmed by inspection — interleave window is real but not deterministically
  reproducible): writes now serialize on a promise chain, value read at write time. Covered by the
  existing deferred-approval/resume persistence tests.

### REFUTED / verified clean
- A second `/execute` after a deferred approval "silently dropping auto": WORKING AS DESIGNED — an
  explicit mode request always lands in gated ask (the engine-owned invariant); deliberate YOLO is
  an explicit set-approvals sent after. (V2-4's fix also makes the second `/execute` a plain
  transition.)
- `resolve-plan.approvals` garbage values: fail SAFE (anything ≠ "auto" falls through to the config
  check; can never escalate).
- Raw `set-mode` invariant, always-grant clearing on re-gate, double-accept guard, plan-mode
  read-only toolset rebuild, permission precedence + all v1 evasion fixes (newline/case/path-form/
  sentinel), headless explicit-ask fail-closed: all re-verified against current code + passing
  regressions.

### Accepted-risk (recorded, consistent with v1)
- Resume never restores YOLO (approvalMode not persisted) — intentional fail-safe; the new
  pendingHandoff persistence composes with it: a resumed deferred approval executes GATED. Safe
  direction; kept.
- Plan-gate telemetry lags for parallel same-step tool calls (research + present_plan batched in
  ONE assistant step can false-reject once; the retry sees the counts). Self-healing, false-reject
  direction only.
- `(plan, auto)` is unrepresentable on the TUI mode chip (`/approvals auto` while planning shows
  PLAN; the setting is dropped by the next Shift+Tab). Read-only mode makes it safety-neutral —
  recorded for subsystem 11's pass.

#
## v2 §2. Compaction & microcompaction — PASS

Scope read end-to-end: compaction.ts (125), compaction.test.ts, microcompaction.ts (+ test),
model-tuning.ts, config compaction block, session.ts regions (#maybeCompact, prepareStep offload,
#writeOffload, #applyDurableOffloads, #persist, constructor). Two independent readers (core
algorithm + offload lifecycle) + author repro/fix.

### CONFIRMED & FIXED
- **[MED] V2-7 Resume under-triggered compaction → possible provider 400** — `#lastInputTokens`
  (the real prior prompt size) was never persisted or seeded, so a resumed session's FIRST turn fell
  to the overhead-blind pre-first-step estimate (`estimate + min(12k, window·0.1)`), which omits the
  ~40k system+tool overhead. A large resumed transcript could ship an over-window prompt straight
  into a 400 before compaction ever fired. Fixed: persist `lastInputTokens` in meta, seed it on
  resume (`initialLastInputTokens`). Regression: *"resume seeds the real prior prompt size…"*
  (session.test.ts).
- **[MED] V2-8 Offload planner over-credited freed bytes → under-offloading** — `planOffloads`
  credited each victim its FULL `chars`, but offloading leaves a `previewBytes` preview inline, so it
  stopped early and a step could stay over threshold. Fixed: credit the NET reduction
  (`chars − previewChars`); wired `previewChars: offload.previewBytes` at the call site. Regression:
  *"planOffloads credits only the NET reduction"* (microcompaction.test.ts).
- **[MED] V2-9 Unbounded offload-artifact growth + orphans from aborted turns** — nothing ever
  pruned `tool-results/`; every offloaded result accumulated forever, and a mid-turn abort left the
  written `.txt` orphaned (durable fold never ran). Fixed: a per-session byte budget
  (`offload.maxArtifactBytes`, default 64 MiB) evicts oldest-first the artifacts NOT in the live
  working set after each write — bounding growth and reclaiming orphans; previews stay in context so
  eviction is graceful. Extracted to a pure `pruneArtifacts` helper. Regression: *"pruneArtifacts
  evicts oldest-first over the cap, never the live working set"* (microcompaction.test.ts).
- **[LOW] V2-10 Config allowed inverted thresholds** — `offload.threshold ≥ threshold` silently
  summarized (lossy) before offloading (lossless), defeating the layering. Fixed: a `.refine`
  rejects it. Regression: *"compaction rejects offload.threshold >= threshold"* (config.test.ts).
- **[LOW] V2-11 Non-iterable user content threw inside the compaction fold** — a malformed/legacy
  persisted user message (content neither string nor array) made the array-spread throw, which
  #maybeCompact mislabeled as a summarizer failure and skipped compaction on an oversized turn.
  Fixed: guard the shape; prepend the summary as its own leading user turn. Regression:
  *"compaction with a non-iterable user content prepends a summary turn instead of throwing"*.

### REFUTED / verified clean
- Cut-boundary tool-result orphan (parallel tool calls, assistant-only-tool-call, keep-sweep):
  walk-back provably keeps recent[0] non-tool AND older never ends on an assistant whose result was
  pulled into recent — re-verified by both readers + the existing sweep test.
- Empty-summary abort, summarizer-failure-proceeds vs abort-propagates, token double-count
  (Anthropic disjoint cache slices folded then peeled), post-compaction `#lastInputTokens=0` reset,
  load-bearing state (goal/tasks/sources/planGate) surviving compaction (lives outside `messages`
  or in the keep window): all re-verified sound.
- Resume rebuild of `#offloaded` (deliberately empty; previews already folded into the transcript),
  per-session artifact dir isolation by session id, creation-failure degradation, tool-boundary
  identity preservation, surrogate-safe preview slice: clean.
- Offload path-traversal via a poisoned transcript pointer: no escalation — `read` already resolves
  any absolute path in-process and the sandbox read-allows the whole FS; the write side sanitizes
  filenames. Non-issue.

### Accepted-risk (recorded)
- **V2-O1 [LOW-MED] Baked absolute artifact path is stale across a state-root change** (VIBE_STATE_DIR
  toggled, different machine/$HOME, or the SAME repo checked out at a different absolute path → a
  different cwd-hash). Degradation is graceful: `read` returns not-found, the 2 KB preview survives,
  and the model can re-run the tool. This is already an IMPROVEMENT over v1's cwd-relative paths (the
  common same-cwd resume now works). Recorded, not fixed — see DECISIONS.
- **V2-F2 [LOW-MED] Nested re-summarization** — a prior `[Summary…]` block landing in `older` is
  re-summarized (summary-of-summary, compounding loss over many compactions). Inherent to
  summarization; recorded with a recommended design in DECISIONS.
- **V2-O5/O6 [LOW]** re-read of a >100 KB artifact is capped by the read tool's MAX_OUTPUT (note now
  tells the model to page with offset/limit); the offload sentinel is content-sniffed, so a result
  literally beginning with the sentinel evades offload (distinctive-by-design). Both low, recorded.
- Few-but-huge messages (≤keep giant messages) still can't compact (count guard) — pre-existing v1
  accepted-risk, unchanged.

Stale docs fixed: `OffloadRecord.path` "cwd-relative" → ABSOLUTE; module header notes the absolute
global-state path.


## v2 §4. Subagent orchestration — PASS

Scope read end-to-end: orchestrator.ts (DAG runDag/validateDag), orchestration/orchestrator-runner.ts
(shared/worktree/ensemble task paths), child-registry.ts, limiter.ts (AIMD + suspend pairing),
blackboard.ts, agents.ts, build/gitops.ts, build/journal.ts, build/handoff.ts. Two independent
readers (scheduler+concurrency / worktree+journal+ensemble) + author repro/fix.

### CONFIRMED & FIXED
- **[MED] V2-12 Orchestration journal + reports still wrote into project cwd `.vibe/`** —
  inconsistent with the deliberate state relocation (sessions/checkpoints/offloads → global state
  dir), re-introducing the exact scaffold-pollution class (`create-next-app .` fails on an existing
  `.vibe/`) for any spawn_tasks run. Fixed: journal + reports moved to
  `globalStateDir(cwd)/orchestration/…`; `taskReportPath` returns an ABSOLUTE path; `readTaskReport`
  handles absolute (current) and cwd-relative (legacy) forms; `loadCompletedTasks` reads the global
  journal then falls back to the legacy in-cwd one. Regressions: *"orchestration state is written OUT
  of the project cwd"*, *"a pre-relocation in-cwd journal + report still resume"* (journal.test.ts).
- **[MED] V2-13 Ensemble winner merged with NO post-merge gate** — #runEnsembleTask squash-merged the
  winner and settled `completed` with no gate on the COMBINED tree, unlike #runWorktreeTask. The
  winner's green was produced in isolation off a baseRef captured at ensemble start, so a `hard`
  task could land a red main tree while reporting success. Fixed: merge + re-gate the merged main
  tree inside one #mergeLock hold (mirrors #runWorktreeTask); red/aborted → task fails, changes
  discarded. Regression: *"ensemble re-gates the merged tree — a winner green in isolation but red
  combined fails"* (orchestration-worktree.test.ts).
- **[LOW] V2-14 `stripHandoffFence` was dead (no call site)** — the child's raw ```handoff machine
  block was stored verbatim in the report and threaded into the planner summary + dependents'
  kickoffs as noise (the structured handoff is surfaced separately). Fixed: strip the fence in the
  three `settle` wrappers so TaskResult.output is fence-free at the source for every consumer.
  Regression: *"a task's handoff fence is stripped from its report prose"*.
- **[LOW] V2-15 (ORCH-1) `suspendParentSlot` dropped on the ensemble→shared-tree fallback** — the
  all-worktree-add-failed fallback called `#runSharedTask(spec, depResults, parentSignal)` omitting
  the 4th arg (defaults `true`), so a DETACHED batch (which released the root's tree-global limiter
  slot) would re-suspend a slot the idle parent no longer holds → a transient over-admit of one
  concurrent turn. Both readers flagged it independently. Fixed: forward `suspendParentSlot`, matching
  the file's three other `#runSharedTask` call sites. Fixed-by-consistency: the exact failure needs an
  injected internal `worktree add` failure that the `#worktreesUsable` pre-check passes — intractable
  to construct cleanly; the one-line fix is verbatim the sibling call sites, and the ensemble path is
  covered by V2-13's + V2-14's end-to-end tests.

### REFUTED / verified clean (both readers)
- Limiter suspend/resume balance (ref-counted release/acquire, N-parallel-spawn, throwing fn, abort
  mid-child, no-signal re-acquire can't wedge); runDag settle-before-race ordering, termination, and
  the (unreachable-but-correct) fail-closed fill; journal seed fixpoint + plan-drift guard;
  tree-global #mergeLock through nested spawn_tasks with no merge/childGate deadlock; ensemble
  sibling-leak fix (attempt never throws) + full teardown on every exit path; gitAddWorktree stale
  worktree+branch cleanup; surgical squash-merge conflict cleanup (no blanket reset); interrupt →
  failed, never merged-as-completed; journal corruption tolerance; concurrent sync journal appends;
  report/worktree path collision hashes; child-registry retention never resumes a torn-down worktree;
  detached cap has no check-then-register await gap; handoff parse never throws.

### Accepted-risk (recorded)
- **V2-F1 [MED] Ensemble in-worktree scoring gate runs in a tracked-files-only checkout** — for a
  project whose deps are gitignored (Python venv, pnpm/turbo workspaces resolving root via a manifest
  absent in the worktree), each attempt's isolated gate can't start its build tooling → all red → no
  winner, so a hard ensemble task can fail even on correct code; and where Node ancestor-`node_modules`
  resolution rescues it, N attempts' gates run concurrently (NOT under #mergeLock) sharing
  `node_modules/.cache` → clobber. See DECISIONS. Ensemble is opt-in and OFF by default
  (`build.ensemble.n` default 0), which bounds exposure. V2-13's post-merge gate now at least verifies
  the COMBINED tree, so a false-green can't land silently — the residual is false-RED (a correct hard
  task reported failed), which fails safe.

#
## v2 §5. Coding loop — PASS

Scope read end-to-end: builtins/edit.ts, write.ts, diff.ts, diagnostics.ts; build/{gate,check,exec,
stubscan,ledger}.ts, checkpoints.ts; engine.ts green-gate orchestration (#afterTurn, #runGate,
#runRecon refresh, #maybeContinueTasks, undo). Two independent readers (edit/write/diff+diagnostics /
gate+checkpoints+stubscan) + author repro/fix. FALSE-GREEN hunted hardest — NONE found (exit-code
authority holds on every check branch; abort windows return aborted/unverified, never green).

### CONFIRMED & FIXED
- **[MED] V2-16 Green auto-complete marked never-done tasks completed** — #maybeContinueTasks
  force-completed in_progress stragglers whenever the gate was green with no pending tasks, but
  greenness (build/tests pass) is ORTHOGONAL to whether a given task's own work was done: a model
  that set a task in_progress and stopped early on an unrelated-green tree had it silently reported
  done. Fixed: removed the green auto-complete; unfinished tasks (pending OR in_progress) now flow
  into the bounded continuation, which asks the model to finish the task or mark it complete if it
  truly is. Regression: *"a GREEN gate does NOT auto-complete an in-progress task the model never
  finished"* (green-gate.test.ts).
- **[MED] V2-17 Plan-execution continuation stalled silently on a non-mutating turn** — both
  #afterTurn early returns (gate off; non-gateable turn) bypassed #maybeContinueTasks, so a
  mid-plan turn that narrated without editing ended the chain with tasks pending and NO warning.
  Fixed: call #maybeContinueTasks(false) from both branches, guarded by `!interrupted` (Esc still
  stops) and no-op outside an active plan chain. Regression: *"a non-mutating handoff turn still
  nudges unfinished tasks"* (green-gate.test.ts).
- **[MED] V2-18 Profile-refresh thrash on genuinely check-less repos** — the scaffold-fix refresh
  fired whenever `!runnable.length`, which is PERMANENTLY true on a docs/script/config repo, so every
  mutating turn re-ran full recon + repo-map. Fixed: a manifest-fingerprint guard
  (`manifestSignature`) re-scans only when a build manifest actually changed (the scaffold signal) —
  a check-less repo re-scans at most once. Regression: *"manifestSignature: stable when unchanged,
  flips when a build manifest appears"* (green-gate.test.ts).
- **[LOW-MED] V2-19 Diagnostics surfaced project-membership noise on tsconfig-excluded files** —
  force-adding an edited file the tsconfig excludes / places outside rootDir triggered TS6059/6307
  "not part of the project" meta-diagnostics, appended as "fix before moving on" though they're about
  membership, not code. Fixed: drop PROJECT_MEMBERSHIP_CODES for files not already in the project.
  Regression: *"a tsconfig-EXCLUDED edited file does not surface project-membership noise"*.
- **[LOW] V2-20 Unbounded diagnostics root-set growth** — every distinct force-added path lived
  forever in the service's fileNames/versions. Fixed: bounded LRU (MAX_FORCE_ADDED=2000) over
  force-added files only; the project's own fileNames are never evicted. Regression: *"force-added
  out-of-project files are bounded"*.
- **[LOW] V2-21 Trailing-newline-only edit misreported as `+0 -0`** — a real byte change with an
  empty line-diff read as a no-op. Fixed: the edit output now says "trailing-newline / whitespace
  change; no line-level diff". Regression: *"a trailing-newline-only edit reports the change
  honestly"* (edit.test.ts). Stale MAX_LCS_CELLS comment (claimed small-edit-to-large-file diffs
  fully — false) corrected.

### REFUTED / verified clean
- No new false-green anywhere; exit-code authority, abort-window handling, timeoutSec<=0 coercion,
  empty-checks→unverified all sound. Multi-edit atomicity, non-unique guard, literal replace, strict
  UTF-8 refusal, symlink deref, atomic temp+rename, stale-write guard, withFileLock TOCTOU-free.
  diff correctness on empty/no-trailing-newline/identical inputs. Diagnostics lazy-load, optional-dep
  absence, tsconfig-change rebuild, post-delete handling. checkpoints undo skips green markers,
  refuses prune on empty ls-tree/read-tree, global-first/legacy-fallback one-way migration. stubscan
  console-only/empty-return scoping. turnMode gating composes with the gate.

### Accepted-risk (recorded)
- **V2-G4 [LOW]** Combined gate × task-continuation budget is worst-case maxRounds² (25 at default 5),
  bounded — separate counters, no infinite loop; flagged, not tightened (a shared budget would starve
  legitimate multi-task plans).
- **V2-G5 [LOW]** Two sessions on one repo share checkpoints.json (global dir keyed by cwd) →
  last-writer-wins can drop a list entry (git refs survive). Pre-existing multi-session edge;
  recorded (same class as no session pruning).
- **V2-G6 [LOW]** stubscan misses multi-line/`def f(): pass`/empty-class-method stub bodies (advisory,
  never hard-blocks). Recorded.
- diff coarse-fallback multiset diff reports +0/-0 on a pure reordering of a huge file; capDiff
  surrogate-split cosmetic; diff.ts 40M-cell cap is memory-aggressive at the boundary. All LOW,
  recorded.


## v2 §6. Context gathering — PASS

Scope read end-to-end: mentions.ts, repo-map.ts, codeintel.ts (batched recon probe), profile.ts,
loaders.ts. One reader + author repro/fix.

### CONFIRMED & FIXED
- **[MED] V2-22 `--watchAll=false` one-shot test scripts wrongly rejected → CRA/Jest CI loses its
  test gate** — the un-anchored `--watch` in NON_TERMINATING is a substring of `--watchAll=false`, so
  the canonical `react-scripts test --watchAll=false` / `jest --watchAll=false` were classified
  non-terminating and dropped, leaving those repos with NO test gate. Fixed: an ONE_SHOT_OVERRIDE
  (`--run` / `--no-watch` / `--watch(All)?=(false|0)`), checked first in isNonTerminating, treats an
  explicit watch-disable flag as terminating — also covers `vitest --watch=false`. Regression: 4 new
  rows in *"non-terminating test scripts are rejected, one-shot forms kept"* (codeintel.test.ts).
- **[LOW-MED] V2-23 buildRepoMap slurped every file whole (no per-file byte cap)** — `readLimit`
  bounds the file COUNT but each was read via `.text()` with no size guard, so a tracked multi-MB
  generated/bundled `.ts` spiked memory on every non-cached build (and several can be in flight when a
  gate refresh overlaps a subagent build). Fixed: skip files over MAX_FILE_BYTES (512 KiB) using the
  already-available statSync size. Regression: *"skips a file larger than the per-file byte cap"*
  (repo-map.test.ts).
- **[LOW] V2-24 mentions TOCTOU defeated the pre-read size guard** — the oversize branch keyed on the
  STAT size, so a file that grew between stat and read was fully slurped (the exact blowup the
  slice-read prevents). Fixed: always slice-read the byte budget (cap+1 to detect overflow) off the
  ACTUAL bytes, for both text and image paths. Regression: *"an over-cap image is skipped by the
  bounded read"* + the existing over-cap text test now exercises the stat-independent path.
- **[LOW] V2-25 empty `ls -A` misclassified as greenfield** — `looksGreenfield([])` is true, and the
  probe suppresses ls errors, so a dir whose listing failed (EACCES/odd mount) with git + a manifest
  present was reported greenfield → ALL command detection suppressed. Fixed: an empty listing WITH
  other evidence (inside a work tree, or any manifest section) is not greenfield. Regression: *"an
  empty ls listing with other signals is NOT reported greenfield"* (codeintel.test.ts).

### REFUTED / verified clean
- Recon re-entrancy: reconRepo holds no shared state (per-call marker, pure detectors, fresh profile)
  — two overlapping runs can't corrupt each other or the profile. buildRepoMap mapCache mutated only
  in synchronous loops; a concurrent build causes eviction (perf), not stale symbols. Recon sentinel
  nonce unspoofable; no shell injection (section names are literals). State relocation: recon /
  repo-map / mentions / loaders write NOTHING into cwd .vibe (read-only) — fresh scaffold stays clean.
  @typescript-eslint false-positive avoided; Makefile `:=` rejected; vitest run/-run carve-out;
  mentions NUL-binary skip + byte-accurate cap + @-after-whitespace; loaders per-file isolation;
  applyArgs single-pass 2-digit cap. All sound.

### Accepted-risk (recorded)
- repo-map sub-path build evicts cache outside the sub-path (perf, v1 accepted-risk, unchanged);
  repo-map `truncated` flag conflates budget-cut with count-cut (cosmetic — only the "…more files"
  note); applyArgs `$100+` caps at 2 digits (documented spec). All LOW.


## v2 §7. Memory — PASS

Scope read end-to-end: memory-service.ts, memory-store.ts (396), memory-search.ts, recall.ts,
bm25.ts, embeddings.ts, vector-store.ts, memory.ts. One reader + author repro/fix. The NEW recall
relocation (global-then-legacy fallback) verified CLEAN.

### CONFIRMED & FIXED
- **[MED] V2-26 Dedup matched ACROSS the boundary between two stored facts → silently dropped a
  new save** — `containsFact` collapsed the whole scope's facts into one space-joined blob (newlines
  → spaces via normalizeText), so a new fact straddling fact A's tail and fact B's head read as
  already-stored and was dropped though it was never saved. Fixed: match within each stored fact LINE
  individually (each fact is one line in factContent), preserving within-fact substring dedup.
  Regression: *"dedup does not match ACROSS the boundary between two stored facts"* (memory-store.test.ts).
- **[LOW] V2-27 A NaN embedding component made top-k ordering nondeterministic** — cosineSimilarity
  guarded zero vectors but not NaN, so a degenerate/corrupt embedding returned NaN and the
  `b.score - a.score` sort became spec-undefined. Fixed: non-finite similarity → 0. Regression: *"a
  NaN component yields 0, not NaN"* (embeddings.test.ts).
- **[LOW] V2-28 A newline in a fact or tag injected a fake dated heading** — the fact/tags were written
  verbatim into the `## HH:MM:SS — <fact>` heading, so an embedded `
## …` wrote a line the
  fact-heading parser reads as a spurious dated fact (skewing dedup + chunk boundaries). Fixed:
  collapse whitespace/newlines in both the fact and each tag to one line. Regression: *"a fact with an
  embedded newline (or a tag with one) can't inject a fake dated heading"*.

### REFUTED / verified clean
- Recall relocation (the main NEW area): SessionStore.list() dedups ids across [global, legacy] with
  GLOBAL winning; loadHistory returns global-else-legacy; loadHistoryCached keys the cache by the
  resolved path — all three consistently pick global for an id in both roots (no double-count, no
  miss). A relocated session forces a cache miss that re-reads correctly. Stat-cache across two roots
  sound (legacy read-only, global write bumps mtime). Torn session → last line dropped, never crash.
- BM25 div-zero + non-negative IDF + length-norm; RRF needs no normalization, empty retriever
  skipped, k=60, deterministic tie-break; relevance floor exempts dense ids; empty-query dense-skip;
  embedder-failure BM25 fallback; model@dim namespace isolation + 4-byte-aligned decode; corpus-read
  ENOENT→[] else propagate+degrade-without-prune; curated-file exclusion; atomic saves + per-path
  dedup lock; dedup fail-open; headless digest-interactive-only + save/recall in -p; no path
  traversal (scope enum, ISO-date filenames); memoryDirs stops before $HOME. All sound.

### Accepted-risk (recorded)
- **V2-M2 [LOW]** Two overlapping `MemoryService.search()` calls with a `save_memory` interleaved: the
  older call's stale-corpus `pruneSourcesExcept` can transiently delete the just-saved source's dense
  chunks (self-healing on the next reconcile; lexical recall masks it). See DECISIONS.
- **V2-M4 [LOW]** exact-substring dedup has no minimum length, so a terse new fact equal to a word-run
  inside ONE longer stored fact is deduped — this is the intended "the knowledge is already in that
  fuller note" behavior (within a single fact, unlike V2-26's cross-fact bug). Recorded, by-design.
- Wrong-dim vector silently mis-scored via Math.min truncation (the @dim namespace pins the PROBE dim,
  not per-vector); vector store O(N)/query no eviction; global memory re-embedded per project. LOW.
- USER.md pushed at global precedence so a project VIBE/AGENTS note can override a user preference —
  mixed-signal, likely intentional; recorded for design confirmation.

#
## v2 §8. Research stack — PASS

Scope read end-to-end: net-guard.ts (SSRF), webfetch.ts, crawl-docs.ts, fetch-cache.ts, web-search.ts,
search-engines.ts, searchcore.ts, package-info.ts, present-plan.ts, plan-gate.ts (triage/telemetry).
Two readers (SSRF/fetch/crawl + search/plan-gate) + author repro/fix. **SSRF guard: NO new bypass** —
every v1 vector re-verified plus 0.0.0.0, IPv6 zone-id, uppercase-hex, IPv4-in-brackets, multi-IP
pinning, redirect-to-internal, CRLF-in-Location — all blocked; fail-closed on unparseable.

### CONFIRMED & FIXED
- **[HIGH] V2-29 Plan-gate triage over-fired on ordinary dev vocabulary** — CURRENT_EVENTS
  (`match`/`score`/`release`/`launch`/`announce`), TIME_SENSITIVE (`breaking`/`ongoing`), and
  STACK_NAMES (`node`/`react`/`solid`/`spring`/`express`) matched common code words, so ~24/28 benign
  in-repo plan requests were taxed with a forced present_plan bounce demanding web/version research
  they didn't need. Fixed: dropped the dev-overloaded words; a greenfield BUILD_REQUEST still triggers
  needsVersions so the real signal survives. Regression: *"ordinary dev vocabulary does NOT force
  web/version research"* (plan-gate.test.ts).
- **[MED] V2-30 Plan-gate false negatives** — genuine time-sensitive asks slipped ungated (`recent`
  vs only `most recent`; `super bowl`/`world series`/`grand prix`/`nba finals` absent). Fixed: added
  `(most )?recent` and the missing sports terms. Regression: *"genuine time-sensitive asks are still
  caught"*.
- **[MED-HIGH] V2-31 Gate evidence never validated — junk search + fake sources satisfied it** —
  `Source.url` was `z.string()`, `evaluate` only checked `sources.length`, and a zero-result
  web_search still counted toward telemetry. Fixed three ways: evaluate counts only real http(s)
  source URLs; a `No results for` web_search no longer increments the gate's webSearches. Regressions:
  *"junk/non-URL sources do NOT satisfy the web-evidence requirement"* (plan-gate.test.ts), *"a
  zero-result web_search does not satisfy the grounding requirement"* (plan-gate-session.test.ts).
- **[MED] V2-32 `recencyDays` schema overstated enforcement** — it is only a coarse per-engine native
  filter (Bing applies none for >31 days), never a hard post-filter, but the description said "Only
  return results from the last N days." Fixed: honest best-effort/coarse description (no silent
  behavior change — a real date post-filter would drop the many undated results).
- **[LOW/MED] V2-33 Crawl dropped absolute https links after an http→https upgrade** — extractLinks
  used strict `.origin` equality, so a site force-upgrading http→https had its absolute nav links
  judged cross-origin, collapsing the crawl to one page. Fixed: use the scheme-tolerant `sameSite`
  (host+port, upgrade allowed) — matching the fetch bound. Regression: *"extractLinks keeps absolute
  https links when the page URL is http"* (crawl-docs.test.ts).
- **[LOW] V2-34 expandQueries hardcoded stale years `2024 OR 2025`** — biases recall toward stale
  years from 2026 on. Fixed: computed `${y-1} OR ${y}`. Regression: *"recency variant uses the CURRENT
  year"* (searchcore.test.ts).
- **[LOW] V2-35 scorePage host boosts/penalties missed `www.` hosts** — `domain === "github.com"`
  never matched `www.github.com` (safeHost keeps www). Fixed: strip leading `www.`. Regression:
  *"scorePage applies host boosts/penalties to www-prefixed hosts too"*.
- **[LOW] V2-36 detectDate/freshnessBoost accepted impossible + future dates** — `2025-13-45` was
  silently normalized and a future year (`2099`) got the MAX freshness boost. Fixed: bound month
  01-12 / day 01-31 in detectDate; a future date scores 0. Regressions: *"detectDate rejects an
  impossible ISO date"*, *"freshnessBoost does not award a future date the max boost"*.
- **[LOW] V2-37 null-body fetch fallback buffered the whole body** — readBodyCapped's non-stream path
  `arrayBuffer()`'d the entire body before truncating (latent — Bun exposes res.body). Fixed: refuse
  when content-length already exceeds the cap. Regression: *"a null-body response with an oversized
  content-length is refused"* (webfetch.test.ts).
- **[cleanup] V2-38** Removed dead exported `rankBonus` (zero references).

### REFUTED / verified clean
- SSRF guard — no new bypass (see header). fetch-cache no cross-URL collision / no error-poisoning /
  coalesced inflight / LRU-bounded / stale-on-failure-only-good-copy. Decompression-bomb cap on the
  decompressed stream. Wayback leak-gate re-checks the input under default-deny; the archive.org fetch
  targets a constant host and its result is re-fetched guarded. package-info name grammars sound;
  web_search all-engines-throw→isError, one engine failing never sinks the batch; search-engine
  parsers reject non-http/bad-base64; classifySource("")→secondary. plan-gate greenfield waiver +
  MAX_REJECTIONS ungrounded escape intact. `resultQualityScore`'s arxiv/crossref branch is
  correct-but-unreachable forward-compat (NOT the always-true bug an earlier read suspected).

### Accepted-risk (recorded)
- Search-engine/registry fetches have no byte cap + bypass the SSRF guard for FIXED trusted hosts only
  (v1); deep-search fan-out unthrottled (v1); untrusted web content flows into context unsanitized
  (inherent). crawl stores the page under the pre-redirect URL (same-origin redirects only → minor).
  With a cache configured, an aborted webfetch that has a prior good entry returns the cached copy
  rather than the abort message (cosmetic; content still returned). All LOW/INFO.


## v2 §9. Providers & model catalog — PASS

Scope read end-to-end: registry.ts, resolve.ts, catalog.ts, defs.ts, openai-compat.ts, ollama-probe.ts,
lmstudio-probe.ts, auth-file.ts, index.ts, types.ts + the core pricing/context-window wiring. One
reader + author repro/fix. planModel resolution verified CLEAN (never bricks the session).

### CONFIRMED & FIXED
- **[MED] V2-39 Pre-turn budget gate hard-stopped on ESTIMATED spend** — the in-turn abort correctly
  guards `!estimated`, but the PRE-turn refusal (blocks the next turn once costUSD ≥ limit) had no such
  check, so an estimated base-model price (a local ollama/lmstudio tag that fuzzy-matched a cloud rate)
  would hard-refuse every future turn of a possibly-free session — exactly what the "estimated never
  hard-stops" invariant forbids. Fixed: the pre-turn gate now also requires `!this.#price?.estimated`.
  Regression: *"spend guard with onExceed=stop does NOT block the next turn on ESTIMATED spend"*
  (session.test.ts).
- **[LOW-MED] V2-40 A malformed models.dev 200 poisoned the catalog (memory + disk, 24h)** — the
  no-poison guard only covered a fetch FAILURE; a wrong-shaped 200 (schema change / error envelope)
  parsed to an empty map that was set as truthy #metadata AND written to the disk cache, pinning every
  model to the 128k default + $0 for the full TTL across restarts. Fixed: a parse of size 0 is treated
  like a failure — never set as #metadata, never cached to disk. Regression: *"a malformed 200 does NOT
  poison the catalog (memory or disk)"* (catalog.test.ts).
- **[LOW] V2-41 Probe failures were memoized forever** — ollama/lmstudio context-window probes cached
  `undefined` on ANY non-ok/throw, so a transient failure (daemon still starting, momentary timeout)
  permanently pinned that model to the default even after the daemon came up. Fixed: only a SUCCESSFUL
  response is memoized; a non-ok status / network error / timeout is left uncached so the next turn
  re-probes. Regression: *"probeOllamaContextWindow does NOT memoize a transient failure"*
  (ollama-probe.test.ts); lmstudio-probe fixed symmetrically.

### REFUTED / verified clean
- planModel: entering plan mode only setModel(planModel) (no network/validation); a bad/unauthenticated
  planModel surfaces on the next turn via #resolveWithFallback (fails over through modelFallbacks, else
  errors and restores busy=false — session usable). Routes through the same pricing/context path.
  modelFallbacks skips self + switches visibly. resolve.ts parsing (empty/no-slash/leading/trailing/
  multi-slash) correct. LOCALLY_PROBED no-fuzzy-window asymmetry right; ollama→ollama-cloud alias gated
  on OLLAMA_API_KEY; LM Studio prefers loaded_context_length; extract guards >0 + min(configured,arch).
  catalog #load failure no-poison + refresh-keeps-good-data intact. selectTier/parseTiers robust;
  computeCost Math.max(0)/cached-clamp/undefined→0 guards; schema nonnegative/positive. one dead
  provider never breaks the catalog; header precedence safe; custom-endpoint no-baseURL actionable
  error; static PROVIDER_MODULES preserves --compile; auth-file missing/empty→undefined. All sound.

### Accepted-risk (recorded)
- **V2-P4 [LOW]** refresh() racing a slower in-flight #load: the older load's late `.then` can clobber
  the just-refreshed catalog (both valid catalogs, small window) — recorded, not fixed (a load-vs-refresh
  generation guard adds complexity for a benign same-data race).
- Corrupt (valid-file/invalid-JSON) auth credential sent as an opaque Bearer token → 401 rather than a
  "malformed auth file" message (diagnosability footgun); listConfiguredModels swallows a present-but-
  invalid key to an empty /models with no signal. Both LOW, recorded. v1 accepted-risk (Codex OAuth no
  refresh; zero-keys errors vs keyless-default; keyless reports configured when daemon down) unchanged.
  Model-id/version defaults NOT churned (memory constraint) — none were actual bugs.


## v2 §10. Sessions / persistence / resume — PASS

Scope read end-to-end: store.ts, state-dir.ts, checkpoints.ts, session.ts persist/resume/abort paths,
engine.ts engine-state + resume wiring. One reader + author repro/fix. The recall side of the
relocation was verified clean in v2 §7; this pass focused on store/checkpoints/engine-state + the
re-evaluation of v1 deferred items.

### CONFIRMED & FIXED
- **[MED] V2-42 Interrupted multi-step turn lost completed tool-call/result pairs** (v1's flagged top
  follow-up — CONFIRMED-still, now FIXED) — on abort/error `result.response` rejects, so only the
  partial assistant TEXT was committed; a COMPLETED step's tool_use + tool_result (e.g. an edit
  already applied) never reached #modelMessages, so a resumed session didn't know the work was done.
  The transcript stayed VALID (no orphan), but diverged from disk reality. Fixed: buffer each
  completed step's cumulative response.messages in onStepFinish; on the failure path commit those
  matched pairs before the partial-text tail (a turn-ending step has no successor, so a buffered step
  always ends on a tool result → alternation stays valid; no duplication since REPLACE, not append).
  Regression: *"an interrupted turn keeps completed tool steps in the transcript"* (session.test.ts).
- **[LOW-MED] V2-43 Corrupt GLOBAL meta.json stranded an intact LEGACY copy** — load() returned null
  on a torn global meta.json instead of falling back to legacy, so it DISAGREED with list() (which
  surfaces the legacy copy) — /resume listed an id load() then refused. Fixed: `continue` to the
  legacy root; null only after BOTH fail. Regression: *"a corrupt GLOBAL meta.json falls back to an
  intact LEGACY copy"* (store.test.ts).
- **[MED] V2-44 checkpoints.json concurrent-clobber + torn-write** (the v2 §5-recorded risk, now
  fixed) — the cwd-keyed file was rewritten wholesale with a bare Bun.write, so two sessions in one
  repo clobbered each other's checkpoint metadata (and interleaved writes could tear it). Fixed:
  #save re-reads + merges by id (our view wins for shared ids) and writes via a per-write-unique temp
  + atomic rename (mirrors the session store). Regression: *"two managers on one repo merge
  checkpoints instead of clobbering"* (checkpoints.test.ts).
- **[LOW] V2-45 No SessionMeta schema version** — a future format change would misparse silently.
  Fixed: added `SESSION_META_VERSION = 1`, stamped at save (forward-compat, no migration needed yet).
  Regression: *"a persisted session stamps the SessionMeta schema version"* (session.test.ts).
- **[cleanup]** Stale `.vibe/plans` / `.vibe/sessions` path comments corrected to the global state dir.

### REFUTED / verified clean
- #persistEngineState promise-chain (v2 §1 fix) correct — the inner write swallows errors so the
  chain never breaks, ordering preserved under rapid toggles, no unhandled rejection. engine.json /
  plans are per-session-id (no cross-session collision, unlike checkpoints). Resume round-trip
  complete: model/mode/goal/tasks/usage/cost/recalledContext/sources/lastInputTokens all persist +
  consume, CLI-override precedence correct, #proactiveRecallDone guards re-derivation. Store legacy
  merge consistent (global wins) except the corrupt-global edge (V2-43, fixed). v1 torn-transcript
  fix + subagent-fork null-store + corrupt-line-skip + source-ledger hydrate all intact.

### Re-evaluated v1 accepted-risk (verdicts)
- Interrupted-turn tool-call loss → **FIXED** (V2-42).
- **No fsync before rename** → CONFIRMED-still, KEEP accepted-risk: the ordered-rename makes every
  crash window monotone (degrades to "start fresh," never corruption), the trigger is rare, and Bun
  has no ergonomic path-level fsync (would need fs.open+fdatasync+dir-fsync). Recorded.
- **No session pruning (unbounded growth)** → CONFIRMED-still, KEEP accepted-risk: deleting
  user-resumable sessions is user-hostile (unlike the bounded offload artifacts inside each session
  dir, capped in v2 §2); a manual/age-based prune is the safe follow-up. Recorded.
- SessionMeta schema version → **FIXED** (V2-45).

### Accepted-risk (recorded)
- **V2-S3 [LOW]** VIBE_STATE_DIR changing mid-process splits state (store/checkpoints cache the dir at
  construction; engine/session recompute per call) — exotic (tests set it before start); recorded.
- **V2-S4 [LOW]** A symlinked/non-canonical explicit cwd hashes to a different state dir (resolve()
  canonicalizes relative/trailing-slash but not symlinks); process.cwd() returns the physical path so
  the common case is safe, and switching to realpath would orphan existing resolve()-hashed state —
  recorded rather than churn the hash. ensureVibeIgnored no-ops in a git worktree (.git is a file)
  and doesn't recognize a `!.vibe` negation — both LOW, recorded (post-relocation .vibe/ holds only
  user-facing config).


## v2 §11. TUI + headless parity — PASS

Scope read end-to-end: app.tsx (3356 lines — plan-card math, key handler, reducer), modes.ts,
markdown-blocks.ts, reducer.ts, themes.ts; headless.ts, cli/index.ts, engine.ts headless paths. Two
readers (TUI plan-card / headless parity) + author repro/fix.

### CONFIRMED & FIXED
- **[HIGH] V2-46 Headless exited 0 on a persistently-red gate — CI ships broken builds** — a gate
  still RED after maxRounds emitted only a warn NOTICE, never an engine-error, so runOneShot returned
  success and the CLI exited 0. `vibe -p "impl X" && deploy` proceeded on a broken tree. Fixed:
  engine-idle now carries the terminal `gate` verdict (tracked per prompt across fix rounds);
  runOneShot returns false on `gate:"red"`. Regressions: *"returns FALSE on a persistently-red gate"*
  (headless.driver.test.ts), *"engine-idle carries the terminal RED verdict"* (green-gate.test.ts).
- **[HIGH] V2-47 Plan grounding (sources/assumptions/ungrounded) invisible in headless** — the v2
  grounding pipeline that the TUI renders (⚠ ungrounded banner, sources, assumptions) was dropped in
  BOTH headless text and JSON — a CI plan run had zero signal a plan was ungrounded. Fixed: text mode
  prints the banner + Sources/Assumptions blocks; JSON carries `sources`/`assumptions`/`ungrounded`.
  Regression: *"surfaces plan grounding metadata"* (headless.driver.test.ts).
- **[MED-HIGH] V2-48 JSON output dropped gate outcome + task list** — a `--output-format json`
  consumer couldn't tell GREEN from RED/UNVERIFIED or see the final checklist. Fixed: OneShotResult
  gains `gate` + `tasks`. Regression: *"JSON carries gate outcome + tasks"*.
- **[LOW-MED] V2-49 Esc aborted the turn instead of clearing a revision draft while a plan is up** —
  working() stays true during the plan card, so an Esc on a half-typed revision fell through to the
  abort branch (draft + card lingered) instead of the shadowed clear-draft branch. Fixed: a
  plan-pending Esc with a draft clears the draft (first Esc discards the revision, second keeps
  planning).
- **[LOW] V2-50 Ungrounded banner used the destructive-red `del` token, not the warning `notice`
  (amber)** — a caution rendered as an error/destructive event. Fixed: `palette().notice`.
- **[LOW] V2-51 Invalid --mode / --output-format silently defaulted** — `--mode plann` ran in the
  wrong mode with no diagnostic. Fixed: error on an unrecognized enum value (exit 1). **[LOW] V2-52
  `-p ""`/`-p -` on a TTY blocked on EOF (looked like a hang)** — now errors with a pipe-or-pass hint.
- **[cleanup]** Fixed the stale "blank rhythm row" plan-card chrome comment (app.tsx:454).

### REFUTED / verified clean
- ^Y is a true ctrl chord (`key.ctrl && key.name==="y"`); the whole plan-shortcut block is gated on an
  empty draft, so a typed "yes…" revision can't fire accept, and plain y/Y falls through to the
  textarea. Enter/^Y/Esc all preventDefault (no double-fire). Plan card always dismissible (setPlan
  null on every resolution + user-message + /clear); mode-change survival doesn't strand it. Zero- and
  many-source overflow math exact at CONTENT_MAX. Reducer ordering/unknown-id handling, reasoning
  bounded, mode colors from the palette. engine-idle always terminates the loop (no headless hang);
  non-interactive permissions never hang; JSON valid on every path; multi-turn follow-ups captured;
  unknown flag → clean exit 1; --continue+--resume (resume wins). All sound.

### Accepted-risk (recorded)
- **V2-T1 [LOW]** Plan-card height undercounts WRAPPED chrome (banner/hint) at narrow widths
  (≲68 cols) — a minor 1-row clip; the scrollbox handles content overflow and the math is exact at
  CONTENT_MAX. Recommended follow-up: estimate wrapped rows for the banner/hint. Recorded.
- Unbounded transcript blocks (v1 accepted-risk, unchanged — only /clear resets); permission card
  hard to answer with a non-empty draft (v1); reducer drops a tool-finish for an unknown callId
  (benign, v1). All recorded.

## v2 DECISIONS (this subsystem)
- **Concurrent index-prune staleness (V2-M2) recommended design:** serialize `SemanticMemory.index()`
  per MemoryService (a single-flight lock or a corpus-version check before prune) so an older call's
  stale prune can't delete a newer call's upsert. Deferred: the window is narrow, self-heals on the
  next read, and lexical recall covers the gap; a lock adds contention to the hot recall path. Revisit
  if dense-recall staleness is observed in practice.

## v2 DECISIONS (this subsystem)
- **Ensemble isolated-scoring gate (V2-F1) recommended design:** score attempts by a cheaper isolated
  signal (child success + diff size), then merge the top candidate to main and gate THERE (reusing the
  V2-13 post-merge gate), trying the next candidate on red — so the SCORING gate never runs in a
  dep-less checkout. Deferred: a real redesign of the ensemble scoring loop, not safely testable
  without running a true multi-attempt ensemble against a dep-heavy repo; ensemble is off by default,
  and V2-13 already closes the silent-false-green hole. Alternatively, provision gitignored deps into
  each worktree (symlink node_modules), but that is fragile across ecosystems.

## v2 DECISIONS

- **Offload artifacts keyed by absolute path under the cwd-hashed global state dir (V2-O1):** kept.
  The alternative — a resolver that, on a not-found offload pointer, remaps the state-root prefix to
  the current `globalStateDir(cwd)` — helps only the VIBE_STATE_DIR-toggle case (not cross-machine or
  cross-checkout-path, which change the cwd-hash itself). Given graceful degradation (preview + a
  re-runnable tool) and that transcript portability across machines was never a guarantee, the
  resolver's coupling of the generic `read` tool to offload internals isn't worth it. Revisit only if
  a concrete same-machine resume-loss is reported.
- **Nested re-summarization (V2-F2) recommended design:** tag the summary note with a structural
  marker (e.g. a dedicated metadata field, not just the "[Summary…]" text prefix) and have
  `#summarize` pass prior-summary blocks through VERBATIM instead of re-summarizing them. Deferred:
  it needs a summary-provenance channel through persistence and careful prompt changes; the current
  loss is gradual and only bites very long single sessions.
 (this subsystem)
- **Plan-approval approvals invariant (revised deliberately 2026-07-02):** v1's "every mode
  transition re-gates to ask" still holds for RAW transitions; plan approval now COMPOSES with it —
  #approvePlan captures wantAuto (explicit ^Y or the user already in auto) BEFORE #setModeGated,
  re-gates, then re-applies auto EXPLICITLY. Yolo after approval is always an explicit
  re-application, never an inherited flag. Do not "fix" this back.
- **Plan-gate triage union never subtracts** (a pivot inside one plan stay inherits the earlier
  request's research requirements): kept — it fails toward MORE research, pivot-vs-revision can't
  be told apart deterministically, and rejection messages state exactly what's demanded. Leaving
  plan mode resets everything.

Stale docs fixed: duplicated JSDoc above `#persistConfig` (engine.ts); MODE_COLORS "aligned to the
brand accent" claim (modes.ts — the accent is royal violet, ASK blue is just ASK blue).

## v2 DECISIONS

(populated as subsystem audits record design pushback)

## v2 ADVERSARIAL PASSES

(populated by the adversarial phase after all 12 subsystems close)
