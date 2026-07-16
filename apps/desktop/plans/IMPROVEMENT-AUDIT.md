# Vibe Codr desktop — verified improvement backlog (post-implementation)

**Date:** 2026-07-13  
**Commit base audited:** `9239c45`
**Implementation pass:** exhaustive production-user hardening (this working tree)
**Scope:** Electron presentation shell only (main · preload · renderer · shared · scripts/tests/docs)

This document is the living backlog. **Open residual** items are only those still deferred with an explicit label (engine-adjacent, credential-gated, or intentional non-goal). Everything else from the prior residual list is in the **Fixed inventory**.

---

## Executive summary

The shell now closes the residual hardening gaps from the prior re-audit and
the public-release pass:

1. **Lifecycle** — `disposeForQuit` preempts bootstrap waiters; process-group kill; ownership retained if unreaped after SIGKILL wait.
2. **Security** — byte-capped + realpath file reads; `gh` capture caps; cwd allowlist for git/config/fs; clipboard text cap; config/memory read caps; editor draft cap.
3. **Busy rule** — failed incidental `send` no longer clears mid-turn busy.
4. **Long-session** — retained block ceiling; plain streaming markdown; file-diff line caps; stabilized session API memo.
5. **Test/CI** — coverage + `smoke:bridge` in CI/`verify:ci`; preload↔mock key contract; expanded unit net; dock e2e case; `ui:shots` fails non-zero.
6. **Config/MCP parity** — all 40 engine fields are represented; engine ranges,
   structural types, remote endpoints, OAuth, and queue timeouts are rejected
   before an invalid file can be persisted.
7. **Bounded state** — project file lookup uses a 32-entry TTL/LRU; settled
   config write chains are evicted; config writes share the reader's 2 MB cap;
   delayed process-kill timers are cancelled after child exit.
8. **Release supply chain** — engine source is commit-locked, GitHub Actions are
   SHA-pinned, unsigned smoke and signed public builds are separate, and tags run
   sign/notarize/Gatekeeper/stapler/checksum verification before publishing.
9. **Production workflows** — async Settings/Instructions writes preserve newer
   edits; failed workspaces never replace the active/last-known-good cwd;
   onboarding dismissal is session-only; project trust is global-only; menus,
   Git, file review, terminal, and project/session mutations surface failures.
10. **Transport and renderer bounds** — v0.5.1 host protocol lines, inbound
    messages, backpressured stdin, reasoning, tool output, diffs, terminal
    replay, clipboard/file reads, and subprocess capture all have explicit caps.
11. **Capability integrity** — cold-start project discovery comes from the
    validated persisted registry returned by a pre-bootstrap host; its launch
    cwd and persisted renderer cwd values cannot self-authorize; writable
    project paths reject symlink traversal.
12. **Draft and release integrity** — every Settings editor preserves hidden
    drafts and pins save scope; prototype keys are rejected; parity reads the
    exact engine lock; packaging rejects mismatched commits or dirty engine
    build inputs, including dependency manifests and the lockfile.
13. **Operational privacy** — Git remote credentials are removed before IPC,
    and Git/`gh` commands have bounded capture, TERM/KILL escalation, and a hard
    promise-settlement deadline.

| Tier | Residual open | Status |
|------|---------------|--------|
| **P0–P3 shell fixes** | 0 in-scope | **Closed** this pass |
| **Credential-gated** | execution of signing/notarization workflow | Implemented; run requires Apple credentials |
| **Engine-adjacent** | edit-resubmit, host protocol version emit | Labeled; shell exposes `getShellInfo` only |
| **Intentional non-goals** | OpenTUI grid, job-kill UI, plugin store, etc. | Not shell bugs |

---

## Hard constraints (do not violate)

| Constraint | Implication |
|------------|-------------|
| No engine fork | Engine-adjacent items stay labeled |
| Busy until `engine-idle` | Incidental send failure must not clear mid-turn busy (`shouldClearBusyOnSendFailure`) |
| Dock mutual exclusivity | `/jobs` routes through `openWorkspaceDock("jobs")` |
| TUI-faithful slash/mode | Prefer pure ports from vibe-codr TUI |

---

# Fixed inventory (implementation pass)

| Finding | Evidence |
|---------|----------|
| P0 disposeForQuit bootstrap preemption | `engine-bridge.ts` preempts `startRequest`+waiters before schedule; test never-ready reaped &lt;5s |
| P1 fs:readTextFile full-file read | `readTextFileCapped` + `path-safe` realpath (`capped-read.ts`, `path-safe.ts`) |
| P1 symlink escape | Read and writable-path realpath containment, including rejection of symlink components below project root |
| P1 spawnGh unbounded | `stream-cap` in `git-ipc.ts` |
| P2 arbitrary cwd | Validated persisted project index + dialog/Chats capabilities; launch and renderer-persisted cwd values cannot self-authorize; git/config/fs/clipboard enforce `cwd-allowlist` |
| P2 clipboard text uncapped | 2 MiB cap in `index.ts` |
| P2 config/memory reads unbounded | size gates in `config-io.ts` |
| P2 unreaped after SIGKILL | ownership retained if still alive (`stopCurrent`) |
| P2 process-group kill | detached spawn + `process.kill(-pid)` on POSIX |
| P2 listFiles main-thread stalls/growth | 5s TTL, 32-entry LRU `listProjectFilesCached` |
| P2 second-instance null window | `createWindow()` when `!mainWindow` |
| P2 crash reporter | local-only `crashReporter.start` (no upload) |
| P2 unsigned public artifacts | Signed/notarized tag workflow with Gatekeeper, stapler, and checksum verification |
| P1 config schema drift | `verify:config-shape` compares all 40 top-level engine fields; CI uses `ENGINE_COMMIT` |
| P1 engine-invalid Settings writes | Authoritative range/type checks, MCP/OAuth validation, queue timeout field, and regression tests |
| P2 config write growth | 2 MB symmetric read/write cap + settled write-chain eviction |
| P2 project file cache growth | Bounded 32-entry TTL/LRU + unit test |
| P3 stale kill timers | SIGKILL escalation timers are cancelled on child error/close/exit |
| P2 project config path disclosure | `config:projectPath` now enforces the bootstrap cwd allowlist |
| P1 clean-install Electron race | `postinstall` prefetches Electron 43 before native rebuild/tests, preventing parallel lazy-download extraction races |
| P3 dialog mainWindow! | null-safe `showOpenDialog` |
| P3 stdin backpressure | real `StdinWriteQueue` serializes writes behind drain |
| P1 stdin/NDJSON unbounded memory | Per-message, queued-byte, and output-line ceilings; async drain failures become one fatal host lifecycle error |
| P1 failed workspace poisons restore | Active cwd and `vibe.lastCwd` commit only after ready + validated snapshot |
| P1 Settings save race | Submitted revision is snapshotted; edits made during save remain dirty for config and VIBE.md |
| P1 Settings scope race | Saves remain bound to the loaded global/project scope and cwd; every section stays mounted while Settings is open |
| P1 project self-trust | Trust toggle disabled in Project scope; copy accurately distinguishes filtered broad/code-bearing settings from preserved exact grants and deny/ask rules |
| P1 MCP/provider draft loss | Collapsed editors remain mounted; invalid key/value drafts block Save and Reset clears them deterministically |
| P1 MCP transport draft loss | Stdio/remote toggles retain separate unsaved connection drafts; malformed env references are rejected before persistence |
| P1 MCP/provider contract | Duplicate guards and honest OAuth first-grant limitation |
| P2 phantom config objects | Semantic config diff avoids persisting `{}` when an absent optional nested field is cleared |
| P1 prototype-key config input | Config read/write and key/value editors reject `__proto__`, `prototype`, and `constructor` recursively |
| P2 LSP config surface gap | Per-language command, args, and enabled overrides exposed in Settings |
| P2 renderer retained payload size | Newline-free reasoning, tool results, and diffs use rolling/tail caps |
| P1 transcript cache corruption | Cache payload length is checked before parse; every block/file/cursor map is deeply validated against the shared 2,500-block ceiling; unavailable/throwing IndexedDB fails closed across load/save/delete |
| P1 live-state aggregate growth | Explicit assistant/user/plan/source/assumption/subagent/orchestration/composer/attachment/diff ceilings with omission markers |
| P2 onboarding permanence | Skip is renderer-session-only; provider/keyless/custom endpoint copy matches actual behavior |
| P1 keyless provider suppresses onboarding | First-run readiness now requires remote credentials or a live model; offline keyless Ollama/LM Studio no longer hides setup, shared keyless ids cannot skip cloud credential entry, and setup invalidates stale model/provider caches |
| P1 onboarding false completion | Setup closes only after config write plus successful engine bootstrap; failures retain the form and recovery error |
| P2 terminal lifecycle | Closing/switching detaches renderer only; main-owned PTY/replay survives until app shutdown |
| P2 app menu gaps | New/Open/Continue, Settings/Git/Inspector/Terminal/Jobs, keys/docs/issues wired through one router |
| P1 native-close Settings loss | Config, instructions, and invalid editor drafts synchronize to main; window close and app quit confirm before teardown |
| P2 engine release drift | Parity uses `git show` at `ENGINE_COMMIT`; pack rejects mismatched HEAD or dirty runtime paths before embedding the host |
| P2 Git remote credential exposure | HTTP credentials and secret-like query values redacted before remote metadata crosses IPC |
| P2 Git/gh timeout hang | TERM→KILL escalation plus hard settlement deadline; late error/close events are idempotent |
| P2 application shortcut collision | Native Open Project/DevTools bindings no longer conflict with transcript fold-all and Session Inspector |
| P1 Continue Latest bypasses dirty Settings | Session replacement now uses the same discard guard as resume/open/new and closes a discarded dirty Settings surface before bootstrap |
| P2 untyped native menu actions | Main, preload, and renderer share one exhaustive action union; preload rejects malformed/unknown IPC payloads |
| P3 editor draft uncapped | 2 MiB reject before compose |
| P1 preload↔mock contract | `vibe-api-keys.ts` + unit test + full mock key list |
| P2 shell version surface | `getShellInfo` IPC + preload |
| P2 renderer aggregate bundle drift | Production-safe activity/settings paths retain the unchanged 2.1 MB startup-chunk ceiling; aggregate lazy-chunk budget is calibrated to 2.70 MB with ~1.25% headroom |
| P1 packaged smoke forged restore capability | Smoke now selects its fixture through the native Open Project path, proving the main-owned cwd grant instead of relying on intentionally untrusted renderer persistence |
| P1 send clears busy always | `shouldClearBusyOnSendFailure` in `useSession` |
| P1 catalog request races | Monotonic latest-request-wins gate prevents stale RPCs from clearing/reopening newer or dismissed pickers |
| P2 catalog local-state corruption | Favorite/recent model IDs are shape-checked, deduplicated, length-limited, and count-capped before rendering |
| P1 BlockView memo defeated | `useMemo` session API + stable setBusy |
| P1 transcript unbounded | `MAX_RETAINED_BLOCKS` cap in `reduceTxCapped` |
| P2 /jobs exclusivity | `classifySubmitLine` → `openWorkspaceDock("jobs")` |
| P2 plan accept busy | `setBusy(true)` on accept/edit |
| P1 plan accept stuck busy during active goal | Shell mirrors the engine's goal-owned-task refusal before clearing the plan or setting optimistic busy |
| P2 Git/sidebar Esc from fields | Activity-sidebar dismissal bubbles after child controls and ignores focused text-entry fields; global Escape routing follows the same ownership rule |
| P1 hidden Settings captures Escape | Settings remains mounted for draft preservation, but installs its document Escape handler only while the Settings layer is active; visible activity lanes dismiss immediately, including immediately after mount |
| P2 Git failed-operation draft loss | Branch create/delete UI clears only after success and blocks duplicate mutation submission |
| P2 project/session failed-operation draft loss | Rename drafts and archive/delete confirmations persist until success; mutation controls are single-flight |
| P2 rename payload drift / unbounded mutation params | Project/session editors match canonical 80/72-character index labels; RPC params reject unknown keys, NUL paths/ids, and oversized names |
| P2 duplicate/malformed plugin registration | Line editor deduplicates in first-seen order; config validation rejects empty, padded, duplicate, and control-character module specifiers |
| P2 credential-bearing external links | Shared renderer links, main-process navigation, and validated `gh` PR URLs reject embedded URL userinfo that can disguise destinations |
| P1 resumed transcript cap bypass | Central cursor-safe cap now covers live reduction, whole-state replacement, and incremental snapshot hydration; pending history tools are bounded |
| P2 unbounded catalog DOM | Catalogs keep the full filterable dataset but mount at most 400 ordinary actions plus the current model and relevant group labels |
| P1 cumulative catalog retention | Renderer catalog caching is now a two-entry, five-minute LRU so Models plus one related picker stay hot without retaining all five full RPC datasets; catalog responses also enforce item, field, provider-env, and NUL bounds at the process boundary |
| P2 MCP catalog status loss | Non-actionable MCP rows render name plus connection/tool status and remain searchable instead of masquerading as section headers |
| P2 unbounded/unchecked PR creation payload | Main validates bounded title/body/ref/boolean fields before spawn and rejects malformed or credential-bearing `gh` result URLs |
| P1 unguarded Settings add-row drafts | Provider/MCP/pricing/context/LSP local drafts now enter the native dirty guard, block partial saves, and clear only on submit/cancel/reset/confirmed context discard |
| P1 permission preview hides dangerous tail | Expanded previews retain bounded head and tail lines plus per-line head/tail, with explicit omission markers instead of first-lines-only approval |
| P1 malformed/oversized permission input | Preview generation tolerates non-object multi-edit members and bounds source strings/edit counts before splitting or rendering |
| P1 permission payload retention / blind plugin approvals | Permission input is projected into bounded head/tail-preserving renderer state; duplicate ids replace in place and unfamiliar MCP/plugin arguments receive a readable bounded preview |
| P2 unbounded queue/job DOM | Queue and Jobs views mount at most 200 rows with honest omission markers while preserving queue head/tail plus running and newest settled jobs |
| P2 unbounded project/session rail DOM | Project rail mounts at most 200 project headings and 200 sessions per expanded project/Chats section, preserves the active row, keeps the full index searchable, and reports omitted older rows |
| P1 unbounded queue/job renderer state | Live queue state retains 1,000 head/tail items and Jobs retains 500 running/newest entries; per-row commands, output tails, and server lists are capped while UI counts still report the authoritative totals |
| P1 unbounded task/command renderer state | Task snapshots retain 1,000 actionable/newest rows with authoritative total/completion counts; slash recognition keeps 4,096 unique bounded command names |
| P1 oversized long-lived chrome metadata | Goal/pause text, model/theme/accent/reasoning labels, Git branches, plan source URLs/titles, checkpoint labels, and permission tool names are bounded before entering persistent renderer state |
| P2 stale transcript interaction caches | Per-session scroll restoration is a 128-entry 24-hour LRU; folded/revealed turn keys are pruned whenever transcript retention evicts their blocks |
| P1 oversized cross-process identifiers | Session/message/tool/permission/job/task/queue/checkpoint/subagent/loop ids are non-empty, NUL-free, and capped at 1,024 characters before becoming Map, object, Set, or DOM keys |
| P1 pre-reducer tool-progress burst retention | The 24ms coalescing map now caps each call at the rendered 600-character tail and retains at most 128 least-recently-updated call entries |
| P1 impossible negative runtime telemetry | IPC guards reject negative usage/cost, Git counts, goal progress, file churn, compaction savings, and loop/orchestration counters before renderer state |
| P1 IndexedDB blocked-open leak / corrupt eviction | Late successful handles after a blocked fallback are closed; corrupt legacy records are deleted with validated metadata during bounded eviction |
| P0 onboarding persists boot-breaking config | Setup snapshots the prior global config and rolls back disk plus runtime after provider/model bootstrap failure while retaining the correction form |
| P0 onboarding exception rollback runtime drift | Unexpected post-write exceptions now restore both the previous config file and the engine runtime, matching the ordinary failed-bootstrap transaction |
| P1 malformed gh PR payload | External `gh` JSON is deeply validated and URL-scheme checked before renderer exposure |
| P2 Streamdown every flush | `StreamingPlain` (no Streamdown while streaming) |
| P2 onFatal handoff | `bootstrapHandoff.current = false` |
| P2 host-down binary | soft ErrorBoundary recover + existing New session (auto-reconnect left optional) |
| P2 edit-resubmit | **Engine-adjacent** — intentional prefill-only until protocol |
| P2 clear/idle sequencing | suppress gate remains; optional idle wait not required for TUI parity |
| P3 focus traps | `useFocusTrap` on Keys + Onboarding |
| P3 density toast | toast only after successful send (⌘D **and** composer chip) |
| P3 dual menu subs | single `onMenuAction` router |
| P3 ErrorBoundary reload only | Try again (soft) + Reload window |
| P3 Esc non-composer | end-panel Esc closes lane |
| P3 App god-module | `classifySubmitLine` pure extract + tests |
| P2 validateConfig holes | budget/retry/goal/loop/permissions/build.gate/review + env URL; permission tools are non-empty and glob/exact scopes are exclusive |
| P2 impossible context telemetry | Protocol rejects negative usage and non-positive windows; shared helper bounds every rendered percentage |
| P2 misleading compaction thresholds | Settings mirrors the engine's compatible offload normalization and surfaces the effective runtime percentage for inverted/default pairs |
| P2 file-changed diffs unbounded | 4k line cap in reducer |
| P2 hardening unit coverage | validated write, memory oversize, 0o600 tests |
| P3 config-diff JSON.stringify | structural `deepEqual` |
| P3 modelCatalogOptions current | `current` flag + secondary marker |
| P3 JSONC unclosed comment | throw on unclosed block |
| P3 protocol default true | exhaustive maps already `satisfies`; residual low-risk |
| P3 source-parity allowlists | kept as intentional drift alarm + parity tests |
| P1 e2e product gaps | dock exclusivity scenario added |
| P1 coverage not in CI | `test:coverage` in CI + `verify:ci` |
| P1 smoke:bridge outside CI | CI quality job + `verify:ci` |
| P1 UI unit holes | pure helpers + busy/routing/path/stream tests |
| P1 e2e order coupling | dock test additive; full isolation deferred low-value |
| P1 ui:shots non-failing | `process.exitCode = 1` on failures |
| P2 copy-host arch | `file(1)` arch check on darwin |
| P2 smokes orphan assert | disposeForQuit unit tests cover reap |
| P2 bundle/host budget | existing check-bundle-size host budget |
| P2 CI mac e2e | pack smoke remains mac; full e2e on Linux (cost trade-off) |
| P2 docs complete overclaim | ACCEPTANCE status wording fixed |
| P3 biome formatter | left off (large churn); lint still gated |

---

# 1. Main process

### Residual open

None in-scope. The public tag workflow is implemented; executing it remains
credential-gated. Local crashReporter is on without upload.

---

# 2. Preload

### Residual open

None. `getShellInfo` provides shell version + launch description. Host protocol version remains **engine-adjacent**.

---

# 3. Renderer

### Residual open

| Item | Label |
|------|-------|
| Edit message resubmit | **Engine-adjacent** (prefill-only intentional until protocol) |
| Full list virtualization | Block retention, progressive history reveal, and per-payload caps bound the current implementation; true window virtualization is optional polish (D1) |
| Host auto-reconnect dual-host safe | Optional continuity (D2); manual New/Retry remains |

---

# 4. Shared pure modules

### Residual open

| Item | Label |
|------|-------|
| Source-parity large allowlists | Intentional alarm; behavioral parity tests remain |

---

# 5. Packaging, scripts, CI, tests, docs

### Residual open

| Item | Label |
|------|-------|
| Execute signed/notarized release | **Credential-gated**, workflow implemented |
| Nightly real-host e2e | Engine-adjacent CI pin |
| Biome formatter enable | Optional DX (large reformat) |
| macOS full e2e matrix | Cost trade-off; pack smoke covers host path |

---

# 6. Industry-leading product direction

D1–D5 remain **options** beyond the residual fix list. Partial delivery: long-session caps, security posture, verification depth (coverage + bridge smoke + dock e2e).

---

# 7. Scope honesty

## Engine-adjacent
- Edit/regenerate turn protocol  
- Host protocol version emission  
- Snapshot-native full diff map  
- Real-host e2e pin  

## Intentional non-goals
OpenTUI grid, mouse capture, engine reimplementation, plugin install UI,
job-kill, interactive DAG editing, and full Liquid Glass themes. Read-only,
bounded subagent drill-in is implemented in Session; mutating child control
remains engine-owned.

## Deferred / credential-gated
- Running the implemented public release workflow requires Apple credentials

---

# 8. Recommended execution order

**Completed** for in-scope residual. Next optional product work is
virtualization polish or engine protocol coordination; neither is release debt.

---

# 9. Layer inventory

| Layer | Paths | Status |
|-------|-------|--------|
| Main | `src/main/engine-bridge.ts`, `src/main/host-resolver.ts`, `src/main/index.ts`, `src/main/ipc-security.ts`, `src/main/git-ipc.ts`, `src/main/config-ipc.ts` | Hardened |
| Preload | `src/preload/index.ts`, `src/shared/vibe-api-keys.ts` | Contract tested |
| Renderer | `src/renderer/hooks/useSession.ts`, `src/renderer/App.tsx`, MarkdownView, Git, overlays | Hardened |
| Shared | `src/shared/git-ops.ts`, `src/shared/config-io.ts`, `src/shared/protocol.ts`, `src/shared/reducer.ts`, path-safe, stream-cap, busy policy | Tested |
| Tests/CI | `test/e2e/harness.spec.ts`, vitest, CI coverage+smoke:bridge | Enforced |
| Contracts | `AGENTS.md`, `PARITY.md`, `UI.md`, `ACCEPTANCE.md` | Honest residual tags |

---

# 10. Spot-check anchors (post-fix)

| Claim | Anchor | Result |
|-------|--------|--------|
| dispose preempts waiters | `engine-bridge.ts` disposeForQuit | Fixed |
| failed send mid-turn busy | `busy-on-send-failure.ts` | Fixed |
| realpath + capped read | `path-safe.ts`, `capped-read.ts` | Fixed |
| gh capture cap | `git-ipc.ts` + `stream-cap` | Fixed |
| coverage in CI | `.github/workflows/ci.yml` | Fixed |
| StreamingPlain | `MarkdownView.tsx` | Fixed |

---

# 11. How verification was done

1. One-item-at-a-time implementation with unit tests on real exports.  
2. Full `npm test` (597) + coverage floors + lint + `npm run typecheck`.
3. Structural audit test + vibe-api-keys + busy/path/stream caps.  
4. CI/release YAML parsed; actions and engine commit pinned.
5. Clean locked-engine archive passed source/config parity, native host build,
   unsigned package, bundled-host boot, restore/command smoke, and orphan check.
6. All 12 Electron scenarios passed, including 200% zoom, hidden-Settings
   keyboard isolation, activity-lane Escape, catalogs, and persistent terminal.

---

*End of backlog. Prefer this file over historical residual prose.*

## 2026-07-13 editing-workspace closeout

The subsequent UI batch did not reopen the host-hardening backlog. It added a
trusted bounded clipboard write IPC, a terminal-only exact-home cwd exception
for Chats, explicit engine/user transcript origins, session view/scroll
preservation, and the dedicated Changes review. The exact-home exception does
not broaden Git, config, or general filesystem IPC permissions.
