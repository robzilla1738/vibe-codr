# vibe-codr — Bug & Weakness Audit

**Status:** Fresh production-readiness audit complete (2026-07-13) — **0 active** Critical/High/Medium  
**HEAD:** post-fix BUG-110–118 + prior BUG-097–109 + BUG-051–096  
**Method:** Adversarial re-review of production-critical subsystems (modes/approvals, providers/context, session/tools/orch/MCP/CLI) against AGENTS.md invariants; confirmed defects fixed with regressions.  
**Gate at close:** `bun run typecheck` 9/9 · `bun test` 1805+ pass · `bun run lint` clean · launch smoke OK (real config untouched)

---

## Summary

| Severity | Active | Fixed 2026-07-13 | Fixed 2026-07-11 | Fixed 2026-07-09 | Prior closed |
|----------|--------|-------------------|-------------------|-------------------|--------------|
| Critical | **0** | 0 | 0 | 0 | 1 (BUG-084) |
| High | **0** | 4 | 0 | 3 | 6 |
| Medium | **0** | 5 | 2 | 8 | 22 |
| Low | **0** | 0 (deferred with rationale) | 0 | 0 | 14 |
| **Total active** | **0** | **9** | **2** | **11** | — |
| Prior fixed catalog | — | — | — | — | BUG-001–096 |
| Refuted | 2 | — | — | — | BUG-033, 035 |

---


---

## Fixed this remediation (2026-07-13) — BUG-110+

| ID | Sev | Fix |
|----|-----|-----|
| **BUG-110** | High | `bash` destructive-pattern backstop skipped when `background:true` — YOLO could start `rm -rf /` / force-push as a job. Unconditional hard refuse (fg + bg). |
| **BUG-111** | High | Worktree squash-merge conflict restored only unmerged paths; clean auto-merges stayed staged (half-merged tree). Full restore of post-staged \ pre-staged ∪ unmerged. |
| **BUG-112** | High | Between-turn compaction undercounted a just-pushed large user turn when `#lastInputTokens` was set (stuck at stale prior prompt size). Prefer `estimate + #overheadTokens`. |
| **BUG-113** | High | `meta.offloaded` persisted but never restored on `--resume` — prune could delete live artifacts. Wire `initialOffloaded` through Session + engine resume. |
| **BUG-114** | Medium | `always-project` wrote disk only; re-gate to ask cleared `#alwaysAllow` and re-prompted same process. Install rule into live `config.permissions`. |
| **BUG-115** | Medium | Session lease used read-then-write (not O_EXCL); dual `--continue` race both got ok. Exclusive create + steal-if-dead. |
| **BUG-116** | Medium | Microcompaction supersession ignored path aliases (`file_path`/`filePath`/`file`). |
| **BUG-117** | Medium | browser-verify wall-clock abort did not cancel hung chromium.launch / page.goto. `raceAbort` helper. |
| **BUG-118** | Medium | Resume restored `lastInputTokens` but left `#overheadTokens` at 0 (mid-turn fill under-projected). Recompute from lastInput − message estimate. |
| **BUG-119** | Medium | `Session.fork()` cleared `initialCostUSD`/`initialOffloaded` but not BUG-103 seeds `initialActualCostUSD`/`initialCostEstimated` — resumed parent leaked hard-stop spend + estimated flag into children (`#enforceBudget` early gate is `costUSD` while stop uses `actualCostUSD`; child `costEstimated` polluted parent via `||=`). |

### Deferred Low / accepted-risk (2026-07-13)

| Item | Rationale |
|------|-----------|
| Same-step present_plan + concurrent RO tools | No write escape; next-step freeze holds |
| Whitespace-only env credentials | Low; opaque auth failures only |
| Hard-link file-lock aliasing | Path locks by design |
| Lease remains advisory | Documented dual-terminal warning, non-blocking |

## Fixed this remediation (2026-07-11) — BUG-108+

| ID | Sev | Fix |
|----|-----|-----|
| **BUG-108** | Medium | Browser-verify internal wall-clock timeout returned `null` (silent skip) instead of `couldNotRun` — a timeout is NOT a user cancellation (the check was attempted). Track `externallyAborted` vs internal timer; only external abort → null. Fixed flaky test (~20% failure under load). |
| **BUG-109** | Medium | Codebase formatting not idempotent — 204 files didn't match `bun run format` with biome 2.5.1 (one-element-per-line arrays vs committed fill style). Applied formatter output so `bun run format` is a no-op. |

---

## Fixed this remediation (2026-07-09) — BUG-097+

| ID | Sev | Fix |
|----|-----|-----|
| **BUG-097** | High | Security notices survive structuredClone into the engine worker (`SECURITY_NOTICES_KEY` on config + WeakMap); TUI warns about stripped untrusted project config |
| **BUG-098** | High | Plugin API seals after timeout/fail so late-settling `register()` cannot re-mutate registries |
| **BUG-099** | High | Plugin rollback unregisters tools/providers/skill dirs (`unregisterTool`/`unregisterProvider`/`removeSkillDir`) |
| **BUG-100** | Medium | Failed plugin trims hooks to pre-plugin counts (`HookBus.trimTo`) — does not wipe earlier plugins in the batch |
| **BUG-101** | Medium | Untrusted filter keeps name-only always-project grants only for no-scope tools (`todo_write`/`save_memory`); bare allows on bash/edit/write/… still dropped; still drops `tool:"*"` and `match` |
| **BUG-102** | Medium | Local ollama/lmstudio pricing mirrors window guard — no cloud-slug real rates / no fuzzy local prices without cloud signal |
| **BUG-103** | Medium | Persist `actualCostUSD` + `costEstimated`; resume never promotes estimated total into hard-stop actual |
| **BUG-104** | Medium | TinyFish uses `readCappedResponseText` stream path (not full `res.text()` then slice) |
| **BUG-105** | Medium | `package_info` stream-caps registry JSON; regression asserts cancel + bytes bound (not theater) |
| **BUG-106** | Medium | `resolveEngineWorkerPath` probes `vibecodr-engine-worker.exe` (Windows release sibling) |
| **BUG-107** | Medium | Hydrate waits for snapshot RPC; `session-start` settles ready; App uses `seedChromeFromSessionStart` (unit-tested) |

### Deferred Low / accepted-risk (2026-07-09)

| Item | Rationale |
|------|-----------|
| `cachedInputTokens` contract comment (shared) | Doc-only; live cost path folds Anthropic correctly |
| AsyncQueue post-close drop | Intentional SPSC design |
| Config atomic tmp pid+time naming | writeChain serializes writers |
| Misleading `verify.command` notice label | Diagnostics only |
| `parseTiers` non-finite size | Edge upstream; prices already finiteNum-guarded |
| RESERVED_SLASH accepted at register | Dispatch already refuses shadow |
| grep `git ls-files` / ls full readdir | Output caps exist; network stream caps prioritized |
| npm worker missingInlinedSymbols | Defense-in-depth; main bundle already guarded |

---

## Fixed prior remediation (2026-07-08)

---

## Fixed this remediation (2026-07-08)

### Critical / High

| ID | Fix |
|----|-----|
| **BUG-084** | `WorkerEngineClient` awaits first real snapshot (`ready()` / `beginHydrate`) before return; CLI never mounts TUI on placeholder |
| **BUG-085** | `EventBus` late-join history (64); worker entry subscribes **before** bootstrap + `engine.start()`; in-process path calls `start()` after bootstrap |
| **BUG-086** | Worktree dirty post-merge review restores `mergedFiles` under `#mergeLock` |
| **BUG-087** | Re-bind `userMsgRef`/`histRef` after `#maybeCompact` so orphan rollback survives emergency keep=1 fold |
| **BUG-054** | `git_push` rejects dash-prefixed remote/branch, blocks force/delete refspecs, passes `--` before positionals |
| **BUG-061** | `localEmbedder` wall-clock timeout on pipeline load + each embed (`EMBED_TIMEOUT_MS`) |
| **BUG-075** | `/loop` routes built-in slash + skills through `#handleSlash` |
| **BUG-093** | `isReviewClean` rejects `path:line:`, `path:line ` and dash-separated findings |

### Medium

| ID | Fix |
|----|-----|
| **BUG-051** | `resolveContainedDir` + glob path containment; `scopeString` exposes glob cwd |
| **BUG-053** | Observe-only config hooks (`session.start/end`, `step.finish`, `assistant.message`) default fire-and-forget |
| **BUG-055** | `repo_map` non-git scan uses contained dir |
| **BUG-056** | Config hooks accept session `signal` + compose with timeout |
| **BUG-057** | Dual command+url hooks warn |
| **BUG-060** | HTTP hooks log non-2xx via `onWarn` |
| **BUG-062** | LSP replies to server requests (registerCapability, configuration, …) |
| **BUG-063** | Vector store `PRAGMA busy_timeout = 5000` |
| **BUG-064** | Memory dedup fail-closed on unreadable scope |
| **BUG-066** | Vector search `LIMIT 50000` newest-first |
| **BUG-070** | Plugin register timeout rolls back commands/hooks |
| **BUG-072** | `loadAgents` per-file try/catch |
| **BUG-073** | Empty agent `name:` falls back to filename |
| **BUG-074** | `formatSessions` skips incomplete meta |
| **BUG-076** | `parseLoopArgs` trailing/quoted `--until` only (no prose steal) |
| **BUG-080** | Editor non-zero exit keeps prior draft |
| **BUG-088** | `write` stale-guard uses existence, not empty content |
| **BUG-089** | Search HTML stream/capped read path |
| **BUG-090** | `readCappedLines` byte-bounds single-line buffer |
| **BUG-091** | `webfetch` `maxChars` schema max + hard clamp 500k |
| **BUG-092** | Global/project config atomic temp+rename write |

### Low

| ID | Fix |
|----|-----|
| **BUG-058** | `redirectUri` uses strict `httpUrl()` |
| **BUG-059** | Exported `runVerify` kills process tree on abort |
| **BUG-065** | `LspClient.dispose` settles pending via `#handleExit` first |
| **BUG-067** | `tool-call-progress` includes optional `subagentId` |
| **BUG-068** | (related) history + close semantics clarified; late join works |
| **BUG-069** | `CappedText` clamps `headRatio` to [0,1] |
| **BUG-071** | Plugin reload clears hooks at batch start |
| **BUG-077** | Loop flag warnings only for failed flag applications |
| **BUG-078** | Crash logs include pid+seq uniqueness |
| **BUG-079** | `update-check.json` atomic write |
| **BUG-081** | Value palette prefix+substring match |
| **BUG-094** | `package_info` clips registry fields / output |
| **BUG-095** | TinyFish response body capped before parse |
| **BUG-096** | `detectChannel` treats `node` as package install |

---

## Refuted (unchanged)

- **BUG-033** — bash permission globs best-effort by design  
- **BUG-035** — superseded by BUG-083 FreshnessRegistry  

---

## Prior fixed catalog (BUG-001–050, 052, 082, 083)

See `CHANGELOG.md` and `git show bbb7cdf^:bugs.md` for historical prose. Not re-opened.

---

## Verification evidence

| Gate | Result |
|------|--------|
| `bun run typecheck` | 8/8 |
| `bun test` | 1613 pass / 0 fail |
| `bun run lint` | clean |
| `bun run smoke:tui` | SMOKE OK |

Scratch logs (implementer): `gate-test.log`, `gate-lint.log`, `gate-typecheck.log`, `gate-smoke.log`, `high-regressions.log`.

---

*All previously-active inventory IDs are fixed. Future defects get new BUG-IDs starting at BUG-097.*
