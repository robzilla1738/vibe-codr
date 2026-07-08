# vibe-codr — Bug & Weakness Audit

**Status:** Remediation complete (2026-07-08) — **0 active** Critical/High/Medium/Low from the open inventory  
**HEAD:** post-fix (all BUG-051–096 actives closed); shipping as **v0.4.14**  
**Method:** Full inventory close-out with behavior changes + regressions where unit-testable.  
**Gate at close:** `bun run typecheck` 8/8 · `bun test` green · `bun run lint` clean · `bun run smoke:tui` SMOKE OK  

---

## Summary

| Severity | Active | Fixed this pass | Notes |
|----------|--------|-----------------|-------|
| Critical | **0** | 1 | BUG-084 |
| High | **0** | 6 | BUG-085, 086, 087, 054, 061, 075 |
| Medium | **0** | 22 | BUG-051, 053, 055–057, 060, 062–064, 066, 070, 072–074, 076, 080, 088–093 |
| Low | **0** | 14 | BUG-058, 059, 065, 067–069, 071, 077–079, 081, 094–096 |
| **Total active** | **0** | **43** | |
| Prior fixed catalog | — | 53 | BUG-001–050, 052, 082, 083 |
| Refuted | 2 | — | BUG-033, 035 |

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
