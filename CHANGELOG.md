# Changelog

All notable changes to vibe-codr are documented here.

## Unreleased

## 0.4.29 — 2026-07-12

## 0.4.28 — 2026-07-12

### Improved — 9 new providers from opencode + menu popup visual polish

**9 new OpenAI-compatible providers** (routed through `@ai-sdk/openai-compatible`
to stay on the pinned `ai@5` / spec v2), bringing the total to 31 first-class
providers — every provider opencode supports that has a working
OpenAI-compatible endpoint:

- **NVIDIA NIM** (`nvidia`) — hosted open models (Llama, Qwen, Phi, Mistral…)
  via NVIDIA's NIM API.
- **DeepInfra** (`deepinfra`) — fast, cheap hosted open models.
- **Venice AI** (`venice`) — uncensored and private open models.
- **Cohere** (`cohere`) — Command A / Command R+ via the compatibility endpoint.
- **Kilo Gateway** (`kilo`) — one key, hundreds of premium models.
- **LLM Gateway** (`llmgateway`) — unified multi-model gateway.
- **ZenMux** (`zenmux`) — unified multi-model gateway.
- **Snowflake Cortex** (`snowflake-cortex`) — managed LLMs on Snowflake
  (requires an account-specific base URL via `SNOWFLAKE_CORTEX_BASE_URL`).
- **Cloudflare Workers AI** (`cloudflare-workers-ai`) — serverless open models
  via Cloudflare (requires an account-scoped base URL via `CLOUDFLARE_BASE_URL`).

The `isConfigured` check now validates the base URL for `requiresBaseURL`
providers even when they're non-keyless, so `/providers` doesn't falsely report
"configured" when only the key is set.

**Menu popup visual polish:**

- The command menu / submenu popup now shows a bold title on the left with a
  muted `esc` dismiss hint on the right (mirroring opencode's dialog headers).
- A thin divider line (border tone) separates the header from the menu rows.
- A thin divider above the `+N more` pagination indicator visually separates it
  from the rows above.

### Fixed — duplicate mode label, spinner, and model name in the input block

The opencode-style footer row inside the input block (added in 0.4.27)
duplicated three pieces of information already shown elsewhere:

- **Mode label** (AGENT/PLAN/YOLO): already in the prompt row (`MODE ❯`) —
  the footer row repeated it below the textarea.
- **Spinner + elapsed label**: already in the working indicator above the
  input — the footer row repeated it inside the block.
- **Model name**: already in the under-input status bar (or the sidebar
  session card on wide panes) — the footer row repeated it on the right.

- **Fix:** removed the footer row entirely. Every piece of info it showed is
  already displayed in its canonical location.

## 0.4.27 — 2026-07-12

### Improved — TUI polish + subagent dedup + orchestration doctrine

A focused pass on the TUI's rendering and the multi-agent delegation doctrine:

- **Narrower chat column:** `CONTENT_MAX` 130→100, `SIDEBAR_MIN_TERM` 140→120,
  giving the transcript more breathing room on standard terminal widths.
- **Splash cleanup:** removed suggestion starters from the splash screen (the
  wordmark stands alone).
- **Opencode-style footer row:** a footer inside the input block shows the mode
  label + model name + spinner when active (hidden when the sidebar owns it).
- **Subagent dedup:** `subagent-started` now deduplicates by `subagentId`, so
  `continue_subagent` no longer creates duplicate rows in the Subagents panel.
- **Transcript cleanup:** `spawn_subagent`/`spawn_tasks` no longer render full
  markdown in the transcript — the Subagents panel is the primary surface. The
  dead `isMarkdown` render path is removed entirely (no tech debt).
- **Delegation doctrine (agentswarm-inspired):** enhanced DELEGATION guidance
  (task DAGs, model tiers, react-to-evidence, size-to-problem), enhanced
  PLAN_DELEGATION (research missions: go wide + cross-check + consolidation;
  codebase missions: scaffold + disjoint + integration), and a stronger
  GATHER step (cross-check scout findings, 3–6 parallel scouts, consolidation).
- **New `implement` agent** (execute mode) for self-contained features, added to
  the default roster alongside `explore`/`review`/`test`.

### Added — macOS bridge: renameProject RPC + project display names

- **`renameProject` RPC method:** the macOS bridge protocol now supports
  renaming a project. The host writes a `name` file into the project's global
  state directory and returns the clipped display name.
- **Project display names:** `listProjects` summaries now read a display name
  from `globalStateDir/<cwd>/name` (falling back to `basename(cwd)` for legacy
  projects that haven't been named).

## 0.4.26 — 2026-07-11

### Fixed — flaky browser-verify test (internal timeout vs external abort)

The browser-verify wall-clock timeout and the external (Esc) signal both
aborted the same `AbortController`, so the catch block returned `null` (silent
skip) for both. But a timeout is NOT a user cancellation — the check was
attempted and just didn't finish. Under system load (when browser launch was
slow), the 8s timeout fired during `page.goto` against a dead port, making
the test flaky (~20% failure rate).

- **Fix:** track whether the abort came from the external signal
  (`externallyAborted`) vs the internal timer. Only the external abort maps to
  `null` (silent skip — the user cancelled); the internal timeout maps to
  `couldNotRun` (honest — the check was attempted). All signal-aborted
  checkpoints in the function now distinguish the two paths consistently.

### Fixed — codebase formatting (biome 2.5.1 idempotency)

The repo was committed with multi-element-per-line arrays (fill style from an
earlier biome version), but `bun run format` with biome 2.5.1 (the declared
version in `package.json`) expands arrays to one element per line. Running
`bun run format` produced a 204-file diff — the codebase wasn't consistently
formatted with its own formatter.

- **Fix:** applied the formatter output so `bun run format` is now a no-op
  (idempotent). All 1746 tests, typecheck, lint, and smoke TUI still pass
  after the reformat.

### Fixed — npm TUI fallback to REPL + peer dep warning

The npm package was falling back to the basic readline REPL instead of the
rich OpenTUI TUI, and showed a `solid-js` peer dependency warning:

- **Root cause:** `app.tsx` (the Solid JSX TUI app) uses a non-literal dynamic
  import in `tui.ts` (to keep OpenTUI / solid-js as optional peer deps), so
  `bun build` couldn't resolve it into the npm bundle. The `.tsx` file wasn't
  shipped, and the runtime `import("./app.tsx")` failed — degrading to REPL.
  The compiled binary had the same issue.
- **Fix:** (1) `build-app.ts` — a new build script that passes
  `@opentui/solid`'s Solid transform plugin directly to `Bun.build()` (the
  preload's `Bun.plugin()` registration doesn't propagate to `Bun.build()`),
  producing a pre-compiled `app.js` bundle with properly transpiled JSX. (2)
  `build-npm.ts` — builds `app.js` into `dist/npm/` and ships it in the
  package's `files` list. (3) `build:binary` — builds `vibecodr-app.js` as a
  sibling of the compiled binary. (4) `tui.ts` — `resolveAppPath()` finds the
  app module at runtime (npm `app.js` → binary `vibecodr-app.js` → source
  `app.tsx`), mirroring `resolveEngineWorkerPath`.
- **Peer dep:** widened `solid-js` from `^1.9.13` to `^1.9.12` to satisfy
  `@opentui/solid@0.4.3`'s peer dependency.

### Fixed — TUI "TextBuffer is destroyed" crash

An OpenTUI/Solid timing race that crashed the TUI mid-session:

- **Root cause:** a `tick()`-driven spinner computation (the animated braille
  spinner on running tool steps / subagents) could fire as an
  `unhandledRejection` AFTER the text element it targeted was destroyed by a
  `setBlocks` batch (e.g. on `/clear`, turn transitions, or transcript
  windowing). The process-level crash handler treated this non-fatal render
  race as a fatal crash and exited.
- **Fix:** (1) `commit()` now wraps its `batch()` in a try/catch that discards
  the "TextBuffer is destroyed" error (the element is being removed — the
  failed property update is harmless, and the next render cycle is correct).
  (2) `installCrashHandlers` now ignores "TextBuffer is destroyed" errors in
  both `uncaughtException` and `unhandledRejection` paths, so the microtask
  rejection variant doesn't exit either.

### Improved — TUI visual polish (opencode-parity diff bands, tool hierarchy, code blocks)

A focused pass on the TUI's rendering to match opencode's visual quality:

- **Diff background tints:** additions and deletions now render on subtle
  `addBg` / `delBg` colored bands (the palette already defined these per theme
  but they were unused). Diffs read as colored bands like opencode's, not just
  colored text on flat black. Applied to both the transcript's tool-step diff
  expansion and the permission card's edit preview.
- **Tool step visual hierarchy:** running tool steps now show their icon in the
  vivid tool (teal) tone and their summary in the body white — they read as
  "alive." Completed steps dim both to muted so a long run of finished tool
  calls scans as quiet chrome instead of a wall of teal. Matches opencode's
  `textMuted`-when-complete vs `text`-when-running approach.
- **Code block polish:** the language label is now bold muted with a thin
  border-tone separator line beneath it, and the block has vertical padding —
  so a fenced code block reads as a labeled, structured header (opencode-style)
  rather than a faint line of text followed immediately by code.
- Regenerated all 21 README screenshots to reflect the new styling.

### Added — macOS bridge + session management

A new `@vibe/macos-bridge` package powers the SwiftUI and Electron desktop
shells with an embedded in-process `Engine`, plus session lifecycle APIs the
desktop clients need:

- **`@vibe/macos-bridge`:** NDJSON stdio host (`bun run macos-bridge` /
  `build:macos-bridge` → `dist/vibecodr-engine-host`). Same `EngineCommand` /
  `UIEvent` contracts as the TUI; in-process `Engine` (no worker thread — the
  desktop UI already runs in a separate process, so the TUI freeze class does
  not apply). Runtime-validated protocol: malformed inbound produces a `fatal`
  response, never a TypeScript cast.
- **Engine `listMcp()`:** MCP server roster (name, connected, tool/resource/
  prompt counts, configured flag, error) for the macOS `/mcp` picker and bridge
  RPC.
- **`SessionStore` session lifecycle:** `setTitle` (user-facing display title
  override, 120-char cap, persisted in `meta.json`), `delete` (permanent remove
  of global + legacy session dirs + plan sidecar), and `archive` (soft-delete to
  `sessions-archive/` with EXDEV-safe cross-device fallback). All gated through
  `isSafeSessionId` — directory-name-only ids; traversal segments and path
  separators are rejected before any filesystem access.
- **`isSafeSessionId`:** format-agnostic validation (rejects `..`, `.`,
  separators, NUL, > 200 chars) on every `SessionStore` path — `save`, `load`,
  `setTitle`, `delete`, `archive` — so a malformed or hostile id can never
  escape the session directory.
- **Core export:** `globalStateDir` / `stateRoot` now exported from
  `@vibe/core` so the bridge can locate the state registry without re-deriving
  paths.

### Fixed

- **Worker placeholder snapshot frozen** to prevent accidental mutation before
  `ready()` resolves (also fixed a stray indentation in the literal).
- **`web_search`:** `detectDate(r.snippet)` called once (was called twice per
  result row — same value, minor waste).

### Docs

- AGENTS.md: `@vibe/macos-bridge` package table row + commands; store
  invariants (safe session id, title/delete/archive).
- README.md: `@vibe/macos-bridge` package table row.

## 0.4.21 — 2026-07-11

### Added — Meta Model API (Muse Spark 1.1)

First-class provider for Meta's hosted Muse Spark coding model:

- **Provider `meta`:** OpenAI-compatible Chat Completions at `https://api.meta.ai/v1`
  (AI SDK v5 / `@ai-sdk/openai-compatible`). Auth via `MODEL_API_KEY` (official)
  or `META_API_KEY`; optional `META_BASE_URL`. Persist with `/model key meta <key>`
  or `providers.meta.apiKey`.
- **Model `meta/muse-spark-1.1`:** onboarding choice **Meta · Muse Spark**; default
  model string for the provider.
- **Published known-model defaults** (`known-models.ts`): 1,048,576 context,
  pricing $1.25 / $0.15 cache-read / $4.25 output per 1M tokens, vision on —
  so cost and `ctx %` work before models.dev lists Meta.
- **`/reasoning`:** forwards `reasoning_effort` (`low` | `medium` | `high`); never
  sends `"none"` (Muse Spark returns HTTP 400).
- **Plan gate:** after `present_plan`, Meta sessions strip tools with `activeTools: []`
  only — Meta rejects `tool_choice` values other than `"auto"`. `toolsDisabled`
  still hard-refuses execute.

### Fixed — proactive memory hijacks + bare image attach

Stops unrelated long-term notes (e.g. a prior website digest) from derailing a
"clone these screenshots" session, and makes vision work without `@`:

- **Bare image paths:** absolute / relative `.png`/`.jpg`/… paths in the prompt
  (including shell-escaped multi-word screenshot names) auto-attach as vision
  attachments (max 4), deduped with `@` mentions.
- **Clean proactive seed:** strips filesystem paths, URLs, and date/screenshot
  noise before hybrid search so path tokens don't pollute BM25.
- **Strict proactive mode:** higher token-overlap floor, stronger BM25 fraction,
  min dense cosine, no past-session-transcript fusion. Explicit `/recall` stays
  permissive.
- **Framing:** system prompt says **PRIOR NOTES** (ignore if unrelated) instead of
  asserting "RELEVANT PAST CONTEXT"; the TUI notice no longer claims relevance.

### Docs

- README: Meta provider table, model string, known-model fallback note; memory
  proactive-recall wording.
- AGENTS.md: `meta` in openai-compatible list, known-model fallback, proactive
  recall + bare-image invariants.

## 0.4.20 — 2026-07-09

### Fixed — path aliases + structured goal/loop assessment

Hardening for weaker / local models that miss tool-schema field names or lack
native JSON `response_format`:

- **Path field aliases:** file tools (`read` / `write` / `edit` / `grep` / `ls` /
  `git_diff` / `git_log`) accept `path` under the documented name **and** common
  model aliases (`file_path`, `filePath`, `file`). Normalization runs at schema
  validation and **before** permission matching so path-scoped deny/allow still
  fires. Empty-string `path` no longer blocks a usable alias. Content-only
  writes (no path under any name) still fail honestly.
- **`generateStructuredObject`:** `/goal` self-assess and `/loop --until` try
  native `generateObject` when the model supports structured outputs, else
  prompt-JSON + extract + Zod parse. Local `ollama/*` and `lmstudio/*` skip
  native structured mode up front (avoids AI SDK `responseFormat` warning spam
  and "assessment unavailable — continuing"). **Abort/Esc is not converted into
  a second model call.**
- **AI SDK warnings:** default-off in-process so residual SDK warnings do not
  paint over the TUI footer.

### Docs

- AGENTS.md notes path-alias + structured-assess invariants.

## 0.4.19 — 2026-07-09

### Added — skill invocation control + terminal plan approval

Industry-standard agent governance so free-form plans and unsolicited skill
hijacks cannot bypass the human gate:

- **Skill frontmatter (Claude Code / VS Code Agent Skills parity):**
  `disable-model-invocation: true` makes a skill **user-only** (`/name` or
  `/skill name`) — omitted from progressive disclosure and rejected by
  `use_skill`. `user-invocable: false` hides a skill from the `/` menu while
  still allowing model load (background knowledge). `/skills` marks user-only
  skills; slash autocomplete excludes non-user-invocable ones.
- **Mode-aware skill doctrine** in the system prompt: plan mode treats skills as
  informational (name as post-approval steps); execute loads only when needed.
  Plan-mode `use_skill` prefixes bodies with a hard "do not run init/setup"
  banner.
- **Terminal `present_plan`:** free-form chat is not approval. After a successful
  present, `prepareStep` sets `toolChoice: "none"` and the tool adapter's
  `toolsDisabled` gate **hard-refuses every further tool execute** that turn
  (covers models/mocks that ignore toolChoice). Success copy and plan HARD RULES
  say STOP and wait for the plan card / `/execute`.
- **Present nudge:** non-trivial plan cycles that research but never call
  `present_plan` get one bounded engine follow-up to present (not implement).
- **PlanGate** tracks `presented` / `needsPresentNudge` across the plan cycle
  (revision prompts re-arm present).

### Docs

- README skills + plan sections document invocation flags and terminal present.
- AGENTS.md subsystem invariants for skill invocation and present-plan hard stop.

## 0.4.18 — 2026-07-09

### Fixed — adversarial audit (BUG-097–107)

Fresh multi-package adversarial re-sweep against `AGENTS.md` invariants. **0 active**
Critical/High/Medium in `bugs.md`. Ship-path regressions for every item:

- **BUG-097 (High):** untrusted project-config security notices survive
  structured-clone into the engine worker (`SECURITY_NOTICES_KEY`) so the default
  interactive TUI path actually warns about stripped hooks/plugins/providers.
- **BUG-098/099/100 (High/Medium):** plugin load seals the API after timeout/fail,
  rolls back tools/providers/skill dirs, and trims hooks to pre-plugin counts
  (no wiping earlier plugins in the same batch).
- **BUG-101 (Medium):** untrusted bare `allow` rules on scoped tools (`bash` /
  `edit` / `write` / …) are dropped; name-only always-project grants keep only for
  no-scope tools (`todo_write`, `save_memory`).
- **BUG-102 (Medium):** local `ollama` / `lmstudio` pricing mirrors the window
  guard — no cloud-slug rates or fuzzy local prices without a cloud signal.
- **BUG-103 (Medium):** sessions persist `actualCostUSD` + `costEstimated`;
  `--resume` never promotes estimated spend into the hard budget stop.
- **BUG-104/105 (Medium):** TinyFish + `package_info` stream-cap registry bodies
  during read (not full-buffer then slice); regressions assert cancel + byte bounds.
- **BUG-106 (Medium):** `resolveEngineWorkerPath` finds Windows
  `vibecodr-engine-worker.exe` siblings.
- **BUG-107 (Medium):** hydrate waits for the snapshot RPC (not an early race to
  PLACEHOLDER); `session-start` settles ready and re-seeds chrome via
  `seedChromeFromSessionStart` (unit-tested).

### Changed — TUI UX polish

- **Mode chip:** execute mode reads **`AGENT`** (not `ASK`) — permission-gated
  agent work vs YOLO unattended.
- **Transcript density:** `/details quiet|normal|verbose` (and `details` config /
  Ctrl+D) control tool verbosity; verbose force-opens spawn markdown.
- **Width-safe hints:** `fitHintSegs` priority-drops footer/plan/permission hints
  on narrow terminals (deny-with-feedback wraps instead of clipping).
- **`@` file picker:** fuzzy path attach menu when the draft ends with `@…`.
- **`/keys` + `/mouse`:** keys help card; mouse capture toggle (persisted).
- **Sidebar status-first:** session card (`◆ session`) owns vitals; context ≥80%
  paints amber via `sessionMetricsTone` on the card and footer.
- **Spawn collapse:** `spawn_subagent` / `spawn_tasks` start collapsed (panel owns
  fan-out); tool icons cover the full built-in roster with long-output fail meta.
- **Working spinner:** monochrome brand braille (no rainbow).

### Docs

- README + AGENTS.md updated for AGENT mode, spawn collapse, density, and audit
  inventory; `bugs.md` closed at 0 active C/H/M through BUG-107.

## 0.4.17 — 2026-07-09

### Fixed — plan mode + subagent orchestration honesty

- **Subagent cost no longer double-counts on `continue_subagent` or structured-
  output retries.** Parent `/cost` and budget accounting fold only the delta
  of each child run (the same retained Session accumulates totals; re-adding
  the cumulative figure was triangular).
- **Plan-mode `spawn_tasks` is scout-only.** `worktree` / `hard` / `check` /
  `verify` are rejected while planning — a read-only child cannot honestly
  satisfy implement-and-verify flags (vacuous green on an unchanged tree).
- **Detached (background) honesty:** a task batch that had any failed/skipped
  task reports `isError` (not a silent success); a mutating background child
  notices and sets sticky dirt so the next gateable turn still verifies;
  **Esc aborts background children** as well as the foreground turn (and the
  `/undo` notice says so).
- **`continue_subagent` serializes per child id** so two parallel continues
  cannot interleave `Session.run` on one retained child.
- **Plan approve UX:** headless plan hint says `/execute` starts immediately
  (not “next message”); dead deferred `#approvePlan(false)` path removed —
  live surfaces always approve-and-run. `#pendingHandoff` remains for
  deny-rearm / `--resume` only.

### Changed — goal / loop / plan thoroughness defaults

- **`goal.maxRounds` default 25 → 10.** Autonomous goal runs stay thorough via
  stronger plan/execute/verify prompts (success criteria, anti-slop, pessimistic
  assess); the bound is a cost ceiling — `/goal resume` re-arms a fresh budget.
  Raise in config for large migrations.
- **`/loop` defaults to max 12 iterations** when `--max` is omitted. Use
  `--unlimited` for intentional forever; `--max 0` remains a usage error.
  Persistent `--until` evaluator failures stop after 5 in a row. The until
  judge now sees gate outcome + git status, not only the last assistant text.
- **PlanGate evidence floors raised:** `needsWeb` requires webfetch (not
  search-only) + harvested sources; `needsVersions` requires `package_info`;
  `needsCode` requires ≥3 code-touch tools or a scout. Non-trivial plans must
  include checklist steps and verification (and decisions for version choices).
  `present_plan` accepts optional `verification` / `decisions` / `files`.
- **Natural-language config** for these knobs (live + persisted):
  `/config goal max rounds 15`, `/goal max 15`, `/goal plan first off`,
  `/loop default max 20`, `/config plan min code touches 5`,
  `/config plan require webfetch on`, `/config show goal`. New schema blocks
  `loop.*` and `plan.*` back the phrases.

### Fixed — worker snapshot re-RPC after mode/model changes (BUG-084)

- **After `mode-changed` / `model-changed` / etc., `WorkerEngineClient.snapshot()`
  no longer stuck on the empty placeholder.** Invalidation used to clear the
  cache and never re-fetch, so `refreshStatus()` wiped slash `commandNames` and
  mid-turn `busy` looked idle. State-change events now re-RPC; the last-good
  cache is kept until the new snapshot lands. Regression covers mode-changed →
  real `commandNames` + `busy`.

### Fixed — full inventory close-out (BUG-051–096, 43 defects)

Closed the open bug ledger end-to-end with paired regressions. Root `bugs.md`
now reports **0 active** Critical/High/Medium/Low. Highlights:

- **Worker TUI chrome honesty (BUG-084):** `WorkerEngineClient` awaits the first
  real engine snapshot before the TUI mounts — model, YOLO/`approvalMode`, and
  theme no longer stick on the empty placeholder.
- **Bootstrap notices reach the UI (BUG-085):** `EventBus` late-join history;
  worker subscribes before bootstrap; `engine.start()` emits session identity.
- **Worktree verify honesty (BUG-086):** dirty post-merge review restores the
  squash-merge on main (same discard contract as a red gate).
- **Orphan user after emergency compact (BUG-087):** re-bind identity after
  keep=1 fold so pre-assistant abort rolls back correctly (strict-provider 400
  class). Anti-theater regression proves the rebind is required.
- **git_push option/refspec injection (BUG-054):** reject dash-prefixed
  remote/branch; pass `--` before positionals; block force/delete refspecs.
- **Local embed hang (BUG-061):** wall-clock timeout on load + embed.
- **/loop built-ins (BUG-075):** loop iterations run built-in slash handlers
  (`/status`, `/diff`, …) instead of feeding the raw slash line to the model.
- **Reviewer detector (BUG-093):** `isReviewClean` rejects common `path:line`
  finding shapes that previously mixed with `REVIEW-CLEAN`.
- **Also:** glob/repo_map path containment, empty-file write stale-guard, search
  HTML / grep / webfetch / package_info caps, config atomic writes, config-hook
  abort + observe-only async, memory fail-closed dedup, vector busy_timeout +
  bounded search, LSP server-request replies, plugin register rollback, editor
  non-zero exit keeps draft, crash-log uniqueness, update-check atomic write,
  upgrade channel detects `node`, and remaining medium/low items in `bugs.md`.

### Changed — sidebar is reasoning-only; tool work stays in the chat

- **No more redundant “Activity” trail in the wide-terminal sidebar.** Tool
  steps already render as scannable rows in the transcript (icon + summary,
  expand for output/diff/sources). Mirroring the same labels into a second
  sidebar log was clutter. The sidebar now hosts session vitals, **Tasks**,
  **Subagents**, and a **Thinking** panel only when the model emits
  reasoning — never a duplicate tool-action feed.
- **Bottom alignment is preserved without empty chrome:** when Thinking is
  absent, the last real block (Tasks → Subagents → rare session filler)
  grows so the sidebar still spans the chat column height.
- **Tool rows are more scannable (opencode-style):** absolute paths collapse
  to `~/…` and long paths prefer a readable tail (`…/pkg/src/file.ts`);
  failed calls show a collapsed **`error`** meta instead of a line count;
  fenced code language tags use the quieter gutter tone.

### Fixed — plan approval, modes, and post-turn verify are contract-honest

- **Bare mode switches no longer approve a waiting plan.** Shift+Tab /
  `set-mode` without `start:true` stays in plan and notices how to approve
  (plan-card Enter or `/execute`). Only an explicit start runs
  `#approvePlan` and begins implementation immediately.
- **Quiet YOLO is ignored while a plan is waiting** so cycling past YOLO
  after a refused bare set-mode cannot accidentally leave unattended
  approvals armed for the next accept.
- **TUI mode chip stays honest with a live plan:** `cycleModeAction` does
  not optimistically flip the chip or flip approvals when approval is
  still required.
- **Engine-owned fix turns (gate / dirty-review / verify) hold plan and
  goal continuations** via `#fixPending` until the fix job starts —
  a green parent cannot advance the chain while a fix is still queued,
  and a held dirty-review no longer theater-continues before the fix
  runs.
- **User Esc/stop clears pending fix state** so a stopped turn does not
  leave a zombie fix job that steals the next turn.
- **Plan hard-deny in the toolset** remains absolute in live plan mode;
  mutation recording and live approval checks stay aligned with the
  permission engine.

### Fixed — file freshness is per-tree, no LRU cap, no module-level singleton

- **The stale-write guard is now scoped to the session tree, not a global
  module-level `Map`.** A subagent that reads a file can no longer be
  blind to its sibling's (or parent's) edit just because the underlying
  `sessionId` key differs. The `freshness` registry is a `FreshnessRegistry`
  class instance held on the engine, threaded through `SessionDeps` and
  `ToolContext` as a **required** field, and torn down on
  `engine.finalize()`. Per-session entries are dropped on subagent
  settle (`clearSession(child.id)` in `#foldChildUsage`), so the
  per-tree footprint is bounded by the active session set — not the
  lifetime of the process. The structural `FreshnessRegistryLike` interface
  lives in `@vibe/shared` (no `@vibe/tools` import, no circular
  dependency).
- **No LRU cap. The silent-degradation bug is gone.** The previous
  `MAX_PATHS_PER_SESSION = 2000` cap evicted the least-recently-touched
  path, so a long refactor silently lost tracking and the next edit to
  that path bypassed the guard. The class is unbounded; the tree's
  lifetime bounds its growth; `clear()` runs at engine teardown.
- **`write` no longer races `statSync` against a concurrently deleted
  file.** The `exists` check and the mode-preserving `statSync` are no
  longer a TOCTOU pair. A `statSync` that fails with `ENOENT` (the
  file was deleted between the check and the stat) is now treated as
  "fresh create" — same path as a brand-new file. No more unhandled
  crash on a race with external deletion.

### Fixed — interactive TUI visual freeze (the freeze class)

- **The rich TUI no longer visually freezes mid-coding or mid-planning.** The
  root cause was thread-coupling: the engine, the render loop, and OpenTUI's
  stdin/scroll pump all shared one JS event loop on the main thread, and
  `AsyncQueue`'s async iterator drained its buffer with synchronous microtask
  yields — so a dense engine burst (a fast/buffered provider stream, a tool
  touching hundreds of files, a subagent fan-out's `subagent-activity`, a
  chatty `bun test` output) drove the TUI's `for await (const event of
  engine.events())` as a microtask run that pre-empted every macrotask (the
  24ms paint timer, the 90ms spinner interval, the stdin pump). Screen, keys,
  and scroll stalled until the buffer emptied; mid-coding/planning bursts are
  densest, which is exactly when the freeze struck. Existing producer-side
  gates (`makeYieldGate` in `session.ts` and `stream.ts`) only mitigated —
  every new burst source re-triggered it because the consumer drain stayed
  structurally unbounded.

  The structural fix moves `@vibe/core`'s `Engine` into a `worker_threads`
  Worker on the interactive TUI path, keeping the TUI on the main thread.
  Cross-thread `postMessage` landings are **macrotasks** — the renderer + stdin
  pump get the loop back between every event — so an engine burst can never
  again starve paint/stdin. Communication is unchanged: `EngineCommand`s
  (UI→core) and `UIEvent`s (core→UI) cross the boundary verbatim and are plain
  structured-cloneable POJOs (`Uint8Array` for image parts clones too); RPC
  over `{ __req, op }`/`{ __resp, ok, value }`; a `{ __fatal__: true, message }`
  sentinel funnels an in-worker crash back to the main thread so the existing
  `crash.ts` `handleCrash` owns terminal restore + exit (workers can't
  `process.exit` the parent nor restore its raw-mode stdin). The `EngineClient`
  interface and `@vibe/core` itself are byte-unchanged — all new code lives in
  `@vibe/cli` (`WorkerEngineClient` + the worker entry script), so the
  core/TUI seam the project already enforces is *exactly* the seam this uses.

  The headless `-p` path and `vibe models` stay in-process (single-shot, no
  real-time consumer to starve, no serialization tax on throughput). `VIBE_NO_WORKER=1`
  OR a missing worker binary silently fall back to in-process `Engine` so a
  packaging hiccup never bricks the CLI; in that fallback the
  cooperative-yield gate now on `app.tsx`'s `for await`
  (`makeYieldGate(50)` — mirrors `session.ts`'s producer gate) still bounds
  the freeze as defense-in-depth. `build:binary` produces a second compile
  target `dist/vibecodr-engine-worker`; the npm bundle ships a sibling
  `vibecodr-engine-worker.js` so npm users get the same thread isolation. This
  mirrors how VS Code's extension host and Electron's main/renderer split work
  — the seam between engine and UI already exists for exactly this.

### Fixed — bug ledger remediation pass

- **Session persistence and resume paths now fail more honestly.** Truncated
  session JSONL files stop replay at the first malformed line and surface a
  resume warning instead of silently stitching later partial state into the
  conversation.
- **The rich TUI is steadier across clear, follow-up, streaming, and clipboard
  paths.** `/clear` suppresses late aborted-turn events, streamed Markdown now
  stays in streaming mode, detached subagent spinners keep animating after the
  parent turn idles, clipboard success toasts wait for a confirmed write, file
  change folding preserves duration/tail metadata, and automated follow-up
  turns keep the working indicator active until `engine-idle`.
- **Orchestration, budgeting, and file freshness are harder to misread.** Resumed
  report fallback keeps the original task objective, budget enforcement uses
  actual accrued spend when models switch between priced and estimated pricing,
  and large file reads now detect mid-read external writes before recording a
  stale-write baseline.
- **Plugin, skill, config hook, and provider setup errors are now explicit.**
  Hook payload merges preserve required fields, malformed skill frontmatter is
  rejected, `whenToUse` frontmatter is honored, invalid plugin slash commands
  throw a clear load error, hooks without a `command` or `url` fail config
  validation, malformed known-provider model strings reopen onboarding, and the
  generic `custom` provider is not considered configured until a base URL exists.
- **Provider and MCP edge cases no longer masquerade as unrelated failures.**
  Non-auth provider configuration/SDK/unsupported-capability failures now carry
  specific error codes instead of `ProviderAuthError`, and duplicate MCP resource
  URIs require an explicit `server` argument instead of reading whichever server
  was registered first.

### Fixed — audit closeout and release hardening

- **Untrusted project config can no longer smuggle approval bypasses through
  glob-scoped allow rules.** Repo-authored `permissions` allows with `match`
  are now dropped unless project config is explicitly trusted; only literal
  `matchExact` grants survive in untrusted project config, preserving the app's
  own "always allow for this project" persistence without letting a cloned repo
  broaden `bash`/`git` approvals with `match:"*"` or `match:"git *"`.
- **CLI `--mode` now matches the product's three real user-facing modes.**
  `--mode yolo` is accepted, and explicit `--mode plan` / `--mode execute`
  reset approvals back to gated `ask` instead of inheriting a persisted
  `approvalMode:auto`.
- **Timed-out shell hooks now reap their whole process tree.** A trusted hook
  that backgrounds a child process can no longer survive the timeout after the
  hook runner has returned.
- **The rich TUI no longer emits false EventEmitter leak warnings for large
  selectable transcripts.** The app raises the renderer listener ceiling for
  legitimate selectable/markdown surfaces, and the OpenTUI smoke harnesses now
  destroy their test renderers explicitly.
- **The npm package no longer installs the heavy semantic-memory transformer
  stack by default.** `@huggingface/transformers` is now a true optional peer:
  users who want local semantic recall can install it explicitly, while fresh
  CLI installs stay lighter and avoid its transitive install warnings.
- **The npm package no longer installs provider SDKs it already bundles.**
  Dedicated provider packages remain inlined into `vibecodr.js` and covered by
  the release guard, avoiding duplicate optional installs and their transitive
  advisory surface.
- **The release workflow no longer depends on stale Node 20 action runtimes.**
  `setup-node` and `upload-artifact` are pinned to Node 24-compatible majors,
  and the release job downloads build artifacts through `gh run download`
  instead of a JavaScript artifact-download action.

### Fixed — OpenTUI bracketed-paste input freeze

- **The rich TUI no longer permanently swallows keyboard and mouse input after a
  broken bracketed-paste sequence.** OpenTUI's stdin parser could enter paste
  mode on `ESC[200~` and wait forever for `ESC[201~`; after that, spinners kept
  rendering but normal typing, Enter, and scroll events were consumed as paste
  payload. The bundled `@opentui/core@0.4.2` install is now patched to abandon
  an unterminated paste after a bounded timeout and on excessive pending paste
  bytes, while complete bracketed paste still submits normally.
- **The npm runtime package carries the dependency patch instead of relying on a
  local checkout.** The generated npm package pins patched `@opentui/core` to
  `0.4.2`, includes the `patches/` directory, and emits `patchedDependencies`
  so fresh installs receive the same production fix.
- **Regression coverage now drives the real OpenTUI app through the deterministic
  test renderer.** The new test proves complete bracketed paste still works and
  an unterminated paste start no longer blocks scroll or prompt submission.

### Fixed — drain race, microcompaction performance, and URL canonicalization dedup

- **A prompt submitted during an async `session.idle` hook's await is no longer
  stranded.** The outer drain loop exited on `{continue:false}` without
  re-checking `#pending` — a prompt enqueued during the hook's async yield (an
  HTTP/shell config hook, or any async in-process handler) sat in the queue
  forever: `#enqueue`'s `void #drain()` was a no-op against `#draining` still
  true, the `finally` cleared the latch and emitted `engine-idle`, and nothing
  re-triggered the drain. The outer loop condition now also checks
  `#pending.length`, so items that arrived during the idle consultation are
  drained before settling idle.
- **`planOffloads` supersession check is O(n) instead of O(n²).** The
  `isSuperseded` predicate used `refs.indexOf(r)` per eligible item, making the
  filter O(n²) for a turn with many tool results. A pre-computed
  `Map<ToolResultRef, number>` index makes each lookup O(1).
- **`canonicalizeUrl` is no longer duplicated between `@vibe/tools` and
  `@vibe/core`.** The searchcore implementation (now with input `.trim()` for
  robustness with harvested URLs) is exported from `@vibe/tools`'s root and
  imported by `source-ledger.ts`, eliminating the maintainability risk of two
  copies drifting.

### Fixed — freeze/stall/interaction hardening pass

- **The engine no longer wedges on stalled control paths.** Queue draining now
  clears its latch in a `finally`, shutdown aborts the live turn and cancels
  queued work, permission prompts settle on abort/steer, verify commands inherit
  timeout + abort-aware process-tree cleanup, and boundary calls for model lists,
  embeddings, plugin imports, hooks, git, bash, and config HTTP hooks are
  bounded.
- **Headless and goal runs fail honestly instead of going silent.** Root provider
  streams have a headless idle watchdog, auxiliary summarize/digest calls are
  bounded, genuine no-output provider failures surface as errors, and mid-run
  plan-mode flips or stale plan accepts pause/refuse instead of burning goal
  rounds or reseeding the goal task spine.
- **MCP is more robust.** `list_changed` notification storms coalesce into one
  in-flight refresh plus one trailing rerun, and interactive MCP OAuth now has a
  one-shot loopback callback listener that exchanges the authorization code and
  retries the connection.
- **TUI interaction and performance fixes.** Slash commands work while a
  permission card is pending, Shift+Tab mode cycling uses optimistic local state,
  clean event-stream termination clears the working latch, large single turns are
  render-windowed, streaming markdown parsing is incremental, clipboard writes
  flush before closing, and terminal restore paths cover fatal signals,
  onboarding Ctrl+C, and REPL fallback.

### Fixed — deferred-backlog burn-down (production-readiness pass)

- **Project "always allow" path grants survive symlinked paths.** On macOS,
  grants for files under `/tmp`/`/var` (symlinks to `/private/...`) silently
  re-prompted every session; path grants are now persisted realpath-canonical
  as `matchExact`, and a filename containing a literal glob char no longer
  broadens the grant to sibling files.
- **`/undo <n>` no longer loses the conversation tail** when the newest
  checkpoint's turn made no file edits.
- **Branch mode reviews before it commits.** With checkpoints disabled, the
  green commit used to blank the adversarial review's diff — the review now
  sees the turn's changes first (still advisory and bounded; the green tree
  commits either way).
- **`/loop` warns on a mistyped interval or an unapplied `--max`/`--until`**
  instead of silently folding them into the prompt.
- **Custom command/skill bodies are read at invocation** (edits picked up
  live, vanished files reported honestly) and capped at 32KB with a marker.
- **Long-running background jobs no longer rescan their whole output buffer**
  on every chunk when detecting server URLs (linear scan with a boundary
  overlap).
- **MCP OAuth tokens for similarly-named servers no longer share a file**
  (`gh/api` vs `gh_api`); existing token files migrate automatically.
- **A re-submitted orchestration plan can't inherit stale task results** from
  an earlier plan in the same session that reused a task id — journal entries
  are stamped with a plan identity; crash-resume of the identical plan still
  seeds.
- **A prompt submitted at the wrong moment no longer wipes the orchestration
  blackboard** out from under a detached agent batch that was about to start.
- **The TUI stays inside narrow terminals**: charts, sparklines, and pies clamp
  to available columns (sparklines resample instead of overflowing), and all
  user-visible truncation measures display cells — CJK, emoji (including VS16/
  ZWJ sequences and flags), and surrogate pairs no longer misalign boxes or get
  split mid-character.

### Security & hardening — whole-project excellence sweep

- **Untrusted project config can no longer execute code or touch credentials.**
  A cloned repo's `.vibe/config.json` used to be able to set `hooks` (shell exec
  on `session.start`), `plugins` (module import), `approvalMode: auto`, and
  redirect `providers.*.baseURL` — arbitrary code execution or credential
  exfiltration just by running `vibe` in the directory. The untrusted project
  layer now drops (with a startup warning) every vector of that class: `hooks`,
  `plugins`, `approvalMode: auto`, the whole `providers` block, all
  `mcp.servers`, command-bearing `lsp` servers, `verify.command`/`verify.auto`,
  repo-authored permission allow-globs (literal `matchExact` grants survive),
  `sandbox` weakening, webfetch SSRF loosening, and the project's own
  `security` block. Set `security.trustProjectConfig` in your
  **user-global** config to honor a repo's config verbatim.
- **The build gate can't wedge on Esc.** Aborting a gate used to orphan the
  test/build subprocess tree (grandchildren held the output pipe), hanging the
  queue forever; the abort now kills the whole process tree.
- **The OS sandbox now covers orchestrator gates and `run_check`** — repo build
  scripts run by subagents or the model were previously unconfined even with the
  sandbox enabled.
- **An aborted turn no longer runs a queued mutating tool.** A parallel tool
  batch interrupted by Esc could still land a write/`git_push` after "stop"; the
  tool now bails before its permission gate and execute.
- **Checkpoints are correct from a repo subdirectory.** `/undo`/`/redo` from a
  session rooted in a subdir used to revert only that subtree while rewinding the
  whole conversation; all snapshot/restore git ops now run from the repo
  toplevel. A restart after a rewind no longer resurrects rewound edits (a bare
  `/undo` could move the tree *forward*), and a partial `git add` no longer
  records a lossy snapshot.
- **Parallel worktree tasks can't clobber each other.** The worktree directory
  is now session-scoped (like its branch), so two runners reusing a task id no
  longer force-remove a live sibling's worktree mid-edit.
- **`/loop stop` stops immediately** (it used to queue behind a pending
  iteration and let one more full turn run); loop and goal queue items are swept
  by provenance, so a typed prompt that happens to start with `loop:`/`goal:` is
  never dropped. A persistently failing `--until` check now warns instead of
  looping silently forever.
- **MCP resilience:** a `${VAR}` server URL no longer bricks config load
  (validated after expansion; a bad URL degrades just that server with a clear
  message); a live tool/resource/prompt re-list that races a disconnect can no
  longer register tools against a dead client.
- **Smaller fixes:** a malformed catalog context-window (0/negative/NaN) can no
  longer break compaction; `ls` output is capped like `grep`/`glob`; `Ctrl+G`
  external-compose survives a temp-write failure instead of going permanently
  dead; the `/model` picker keeps its menu open on a zero-match filter and
  refuses to persist a typo'd model id; `/plan <text>` / `/execute <text>` now
  switch mode **and** submit the text instead of dropping it; a UTF-8 BOM no
  longer defeats `SKILL.md` frontmatter.

### Added — `/goal` is now an autonomous plan → execute → verify driver

- **`/goal <text>` starts a run, not just a header.** The engine plans first
  (a read-only investigation turn that seeds a task checklist — engine-verified,
  with parse and single-task fallbacks so the run always has a task spine), then
  executes the tasks, then self-assesses after every turn (structured
  `{met, gaps, reason}` verdict on the task list, a capped diff, and the live
  gate result). The first "met" buys an **adversarial verify turn**; the run
  ends only after **2 consecutive clean passes**.
- **Honest verdicts.** Unfinished tasks are a deterministic "not met" (no model
  call spent), and a red gate hard-overrides a "met" verdict — the model can't
  talk its way past failing checks.
- **Bounded and steerable.** `goal.maxRounds` (default 10) caps the run on a
  unified budget shared with task continuations; typing mid-run steers it (the
  round budget re-grants); Esc pauses it (the ★ goal stays); `/goal clear`
  stops it and sweeps queued goal turns; a provider error pauses the run
  instead of burning the remaining rounds.
- **Survives restarts.** A live run persists its phase and round; `--resume`
  re-enters it where it left off. `goal.planFirst: false` keeps the legacy
  single blended turn.
- **One parser.** Bare `/goal` now *shows* the goal (it used to silently
  clear); `clear`/`none`/`off`/`stop`/`reset` clear it; `/goal` from plan mode
  auto-switches to execute with approvals preserved.
- **The run is visible and resumable.** The ★ header carries a live suffix
  (`· planning` / `· 7/25` / `· paused` / `· met`, via the new `goal-run`
  event + snapshot field), engine-driven rounds render as one compact
  `★ goal — …` bubble instead of repeating the full directive every round,
  and bare `/goal` reports the run's actual state. Every non-terminal stop is
  now an announced **pause** with the reason — Esc, an errored turn, a gate
  that stays red after its fix budget (previously that path silently wedged
  the run armed-but-idle), an exhausted round budget, `/clear`, or removing
  the run's queued turn from the queue — and the new **`/goal resume`**
  re-arms the stored goal at the paused phase with a fresh budget.
- **Run-integrity fixes.** The run owns its task spine (a leftover task list
  from an earlier plan is cleared at arm instead of hijacking the execute
  contract); replacing the goal mid-run sweeps the old run's queued turns;
  goal turns are matched by provenance, not label text (a typed prompt
  starting with `goal: ` is never swept); an Esc landing during the
  self-assessment can no longer launch one more turn; a steer's round-budget
  re-grant is persisted (a kill mid-steer resumes with the refreshed budget);
  every goal turn (not just the plan turn) carries a stop-invariant guard — a
  turn that throws, or is vetoed by a `user.prompt.submit` hook, pauses the
  run instead of leaving it armed with nothing queued (and a denied plan turn
  no longer marches into execute on a fabricated task spine); `/queue clear`
  pauses the run when it drops the run's queued turn (same contract as ✕ on
  the row); resuming into the plan phase clears a stale partial task seed;
  compact `★ goal` bubbles survive `--resume` (history stores the display
  line, the model context keeps the full directive); and `- [x]` checked
  boxes in a narrated plan no longer seed phantom pending tasks.

### Added — hooks get real feedback channels (Claude Code Stop/PostToolUse parity)

- **`session.idle` handlers can force a follow-up turn.** Returning
  `{continue:true, reason}` injects one more turn built from `reason` instead of
  settling idle (Stop-equivalent) — **bounded to 3 per user prompt**, then the
  engine warns and settles regardless so a runaway hook can't loop forever. A turn
  that was Esc-aborted or budget-stopped is **never** resurrected this way (the
  guard reads `session.interrupted` before the injected turn is enqueued), so the
  engine-idle terminal invariant a headless one-shot relies on still holds.
- **`tool.after.execute` handlers can shape the result** (PostToolUse parity):
  `{additionalContext}` is appended (delimited) to the result the model reads
  next step; `{deny:true, reason}` overrides the already-run result with an error.
  The tool still ran — deny here changes only what the model is told.
- **`user.prompt.submit` handlers can rewrite or veto.** `{text}` (or a string
  `{input}`) rewrites the prompt; `{deny:true}` cancels the turn **before** any
  state mutation — before the handoff plan-discard and before the checkpoint
  snapshot, so a denied handoff keeps the approved plan and a denied prompt seeds
  no checkpoint. Declarative config hooks map the same fields; the full per-event
  response contract is documented once in `packages/config/src/schema.ts`.

### Added — checkpoint rewind & redo

- **`/undo` takes an optional index or id** (as shown by `/checkpoints`, newest =
  1) to rewind multiple steps at once, stacking the skipped ones for redo.
- **`/redo` re-applies the most recent undo** — files *and* conversation. The
  pre-rewind working tree is captured as a phantom redo step so redo-to-exhaustion
  recovers the newest edits byte-for-byte. The conversation tail is **position-
  aware**: it is re-appended only while the context still sits at the rewound mark;
  a `/clear` or any intervening turn skips the append (files still restore, with an
  honest notice), and `/clear` drops stashed redo payloads so a cleared
  conversation can't be resurrected.
- **`/checkpoints` lists numbered entries with relative age.** Any new snapshot
  clears the redo stack. `/redo` joined the help catalog and TUI autocomplete.

### Added — persistent per-project permission grants

- **The interactive permission card gained "always (project)"** — `Ctrl+P`, or
  type `p`/`project` + Enter — which persists a scoped allow rule into the project
  config (validated merge, dedup, degrade-to-session-grant on write failure).
  The chord is deliberate: moved off the bare `p` key so the first keystroke of a
  typed deny can't invert into a durable allow.
- **Command and URL scopes persist as the new `matchExact` rule field** — a
  literal string match with no glob semantics, so approving `rm build/*` persists a
  rule that allows exactly `rm build/*` and never a glob-broadened
  `rm build/../secret.env`. Path scopes persist as `match`. `matchExact` shares
  the same scope forms and deny>ask>allow precedence as an equivalently-scoped
  `match` rule.

### Added — clipboard image paste & external-editor compose

- **`Ctrl+V` pastes a clipboard image** (macOS `pngpaste`/`osascript`, Linux
  `wl-paste`/`xclip`), landing as an `@`-mention of a validated temp PNG that flows
  through the existing image pipeline and is cleaned up on exit. No image is a
  silent no-op; text paste (bracketed) is untouched.
- **`Ctrl+G` opens the draft in `$VISUAL`/`$EDITOR`** (renderer suspend/resume) and
  reads it back on save; an empty save keeps the prior draft.

### Changed — MCP env expansion, live catalog refresh, governed resources/prompts

- **`${VAR}` and `${VAR:-default}` expansion** over server `command`/`args`/`env`/
  `url`/`headers`, so a migrated Claude Code entry can reference secrets by env var
  instead of inlining them. An unresolved `${VAR}` with no default is left literal
  and warned about — never silently blanked; a bare `$` is untouched.
- **`resources`/`prompts` `list_changed` notifications refresh their catalogs
  live**, matching the existing `tools/list_changed` behavior.
- **`read_mcp_resource` and `get_mcp_prompt` are now network-flagged**, so deny/ask
  permission rules govern them like any other egress.

### Changed — planning grounding & long plans

- **The plan grounding gate accepts `webfetch` and `crawl_docs` as web grounding**,
  not only `web_search` (the fetch counter was previously dead).
- **A plan longer than 12 steps seeds a catch-all tail task** for the remainder
  instead of silently dropping steps beyond the cap.

### Changed — orchestrator output & subagent mode fidelity

- **`outputSchema` on `spawn_tasks` is now enforced on worktree and ensemble
  (`hard`) tasks too** — validated JSON or an honest failure, never silently
  dropped, matching the inline path.
- **A subagent continued during plan mode is restored to its original mode** when
  continued during execute (the registry remembers the pre-coercion mode).

### Fixed — tool correctness

- **`read`'s `offset` is now 1-based**, matching the line numbers shown in its
  output.
- **`grep`'s no-ripgrep fallback matches ripgrep's multi-extension types** — a
  `fileType:"ts"` search now covers `.tsx`/`.mts`/`.cts`, not just literal `.ts`,
  so the fallback no longer silently misses `.tsx` files.
- **Web-search date detection no longer misdates a page** from an incidental year
  in the body — a bare year only reads as a date when it heads the text or follows
  a date cue.

### Added — experimental native Windows

- An experimental **`bun-windows-x64`** release binary with checksum, an advisory
  (continue-on-error) Windows CI job, and a README note recommending WSL2 and
  documenting that the OS sandbox is unavailable on native Windows.

### Fixed — skill file resolution

- **Every skill load now discloses the skill's directory**, so `SKILL.md`-
  referenced bundled files (helpers, catalogs) are resolvable by the model.

### Fixed — orchestration, ledger, compaction, and accounting (BUG-046–050)

- **`/clear` now resets all token and offload accounting.** `#lastInputTokens`,
  `#overheadTokens`, `#lastSentEstimate`, and `#offloaded` are cleared alongside
  the transcript, so `/context` and `context-updated` correctly report 0 tokens
  instead of stale pre-clear fill. (BUG-046)
- **Orchestrator `check`/`verify` tasks no longer treat `unverified` gate results
  as success.** Shared-tree and worktree task paths now fail on any gate outcome
  other than `green` — matching the root engine path. (BUG-047)
- **`#runWorktreeTask` now checks `commitWorktree`'s return value.** A failed
  commit rejects the task instead of silently merging an empty delta and reporting
  `completed` while the child's edits are orphaned when the worktree is removed.
  (BUG-048)
- **Build-ledger records are now stored as atomic per-record files** (temp+rename
  under `.vibe/ledger/`) instead of a shared JSONL append that could interleave
  across concurrent sessions. The legacy `.vibe/ledger.jsonl` is still read for
  migration. (BUG-049)
- **Ensemble with a missing `repoProfile` no longer scores attempts as passable.**
  Missing profile → score 0, verdict `"no-profile"`, winner filter requires
  `score >= 2` (green-only). No checks run → no merge. (BUG-050)
- **`engine.finalize()` is bounded to 5 seconds.** `awaitAllDetached(5_000)` caps
  the time spent awaiting detached children, so a stuck subagent can't hang
  shutdown indefinitely.
- **Compaction handles the emergency overrun case.** When the context is over the
  threshold but fewer messages exist than the keep window normally preserves, the
  keep window is shrunk to 1 (or the safe minimum) so there's an older prefix to
  summarize. An `overrun` flag is surfaced to the caller so it can warn the user
  that the context may still be near the limit. Fewer than 3 messages returns null
  for manual `/clear` intervention.

## v0.4.1 — 2026-07-04

### Changed — the session card earns its place

- **The card's wordmark is now the real brand mark, scaled down** — the `tiny`
  half-block ascii face (same family as the splash's block wordmark, 2 rows)
  in the chrome accent, replacing the plain `◆ vibe codr` text line.
- **No more label words** — `dir` / `model` / `usage` are gone; the values are
  self-evident and now read as clean bare lines (dir and model bright, git /
  usage / goal muted).
- **No more double-printing** — while the card is up it OWNS the session
  facts: the chat column's top-left context line goes blank (the row stays,
  height-pinned, so nothing reflows) and the under-input status keeps only
  the changed-files delta. Each fact renders in exactly one place.

## v0.4.0 — 2026-07-04

### Added — the sidebar gets a session card, and subagents get room to breathe

- **Session card at the top of the right sidebar**: the small `◆ vibe codr`
  wordmark in the white chrome accent (follows `/accent`), over muted
  label rows for the session's vitals — working dir (tail-truncated so the
  deep segments survive), model, git branch + dirty count, live
  tokens/cost/context, and the goal when one is set. The sidebar now reads
  as a complete at-a-glance dashboard instead of floating work panels.
- **Subagent rows word-wrap instead of hard-clipping mid-word** — a 42-col
  card used to cut "fundamental analysis" to "fundamental analysi". Prompt
  titles and the activity/result detail line each wrap to ~2 lines
  (pre-capped so a chatty child can't grow the panel unbounded), and the
  windowing budget accounts for the taller rows.
- Uniform 1-row gaps between all sidebar blocks; the Thinking/Activity block
  still grows to keep the sidebar's bottom level with the input.

## v0.3.0 — 2026-07-04

### Fixed — approving a plan with Shift+Tab now actually starts implementation

- **The plan card is dismissed when you switch modes away from plan.** Approving
  a plan via Shift+Tab (or `/execute`, `/yolo`) arms the deferred handoff and
  promises "your next message starts implementation" — but the card used to
  survive the switch and capture that next message as a plan *revision*,
  silently revoking the approval and re-planning instead. Its leftover
  affordances were stale too (Enter was a spent no-op; Ctrl+Y's run-in-yolo
  intent was dropped). Engine hardening to match: a `keep-planning` answer now
  returns the session to plan mode if a scripted resolve-plan arrives from
  execute, so "Kept planning" is never a lie.

### Fixed — `/model refresh` no longer sets your model to the literal id "refresh"

- The `/model` picker advertises `refresh` to re-pull the model catalog, but
  only `/models refresh` implemented it — the singular spelling fell through to
  the model-switch path and **persisted `model: "refresh"` to the global
  config**, failing every later turn until fixed by hand. `/model refresh` now
  refreshes the catalog, with a regression test pinning the model unchanged.

### Fixed — /loop lifecycle

- **A queued loop iteration that got dropped no longer kills the loop
  silently.** If a tick landed in the queue behind an active turn and was then
  removed (Esc-abort, dequeue, `/queue clear`), the loop hung forever while
  still reporting active. Cancellation now settles the iteration and the loop
  stops with a visible "iteration cancelled (…)" reason.
- **`/loop stop` sweeps an already-queued iteration** instead of letting it run
  one more full model turn after you said stop.
- `--max 0` is a usage error instead of silently unbounding the loop; `0s`
  intervals are rejected (they re-ticked back-to-back with no pacing).
- `/help` and the palette now show the full grammar:
  `/loop [interval] <prompt> [--until <cond>] [--max N]` · `/loop stop`.

### Fixed — `/goal` survives quitting before the next turn

- The goal was only persisted after a completed turn, so `/goal <text>`
  followed by exiting lost it (`--resume` restored none). It now persists
  eagerly on set/clear.

### Added — the input shows when a command is real

- A slash draft whose command word is a registered invocable (built-in, custom
  command, or skill) now renders in the heading hue; typos stay body-colored.
  This wires the long-documented "registered command" cue to the engine's
  `commandNames` snapshot for real.

### Added — command-surface parity (TUI palette ⇄ engine ⇄ /help)

- `/providers [filter]` has a real engine handler (headless/REPL used to get
  "Unknown command" for a palette-advertised command) and is listed in `/help`.
- `/jobs` gained an engine handler (headless parity with the TUI sub-view) and
  a `/help` entry; `/quit` joined the recognized-name set.
- `/sources` is discoverable from the `/` palette.
- `/skills <filter>` honors its advertised filter argument engine-side, and the
  TUI skills picker shows an explanatory empty-state row instead of rendering
  nothing on zero matches.

### Fixed — skills authoring edge

- A SKILL.md with a bare `name:`/`description:` frontmatter line registered a
  ""-named skill (unreachable via `/skill`, blank line in the system prompt's
  skills block). Empty fields now fall back exactly like absent ones (directory
  / file name).

### Onboarding — first screen matches the product

- The setup wizard now speaks the TUI's default design language: white chrome
  accent, the violet selection band (same `selBg`/`selFg`), and a white→violet
  wordmark sweep — no more periwinkle/cyan that vanished after setup.
- The "Other / advanced" path re-prompts until a model string is entered —
  pressing Enter on the empty field used to persist `model: ""`, which neither
  ran nor re-triggered onboarding on the next launch.
- `/init`'s config template and the empty `/models` message no longer point at
  a `.env.example` that doesn't exist in user projects.

### Release tooling

- GitHub release notes extraction tolerates `## v0.2.0`-style changelog
  headings (the v0.2.0 release body shipped as the "See CHANGELOG.md."
  fallback because of the strict bare-version match).

## v0.2.0 — 2026-07-03

### Security — a repo can no longer strip your global permission rules

- **`permissions` now UNIONS across config layers** (global → project → CLI)
  instead of the project array replacing the global one. Previously a repo-local
  `.vibe/config.json` — which travels with a cloned, possibly untrusted repo —
  that declared *any* `permissions` array silently discarded every user-global
  rule, **including deny kill-switches** (`deny git push`, `deny rm -rf*`).
  Layers can now only ADD rules; deny stays absolute wherever it sits in the
  merged array, and a lower-trust layer can't relax a global `ask` to `allow`.

### Added — `/skill <name> [task]` + the skills menu prefills it

- **`/skill <name> [task]`** runs a skill by name and can never be shadowed by a
  built-in or custom command (it's in the reserved set). Previously a skill named
  `review`, `init`, `verify`, or `loop` was uninvocable as `/<name>` — the
  built-in of the same name silently ran instead — and the `/skills` menu
  prefilled exactly that broken spelling. The menu now prefills
  `/skill <name> `; longest-name-prefix matching also makes skills with spaces
  in their names reachable.
- The `/skills` picker matches only the plural, so choosing a skill closes the
  menu and Enter submits (it used to re-open the picker and trap Enter in a
  prefill loop).

### Fixed — grounded planning verifies its citations

- **`present_plan` citations are now checked against the session's source
  ledger**: a URL the research never actually surfaced (a hallucinated link)
  no longer satisfies the grounding gate — only genuinely-fetched/searched
  sources ground a plan. Equivalent spellings (www/trailing-slash/utm/fragment)
  still match via canonical-URL comparison.
- A mid-turn plan→execute switch can no longer un-coerce a subagent spawned
  later in the same plan turn: child read-only coercion now follows the mode
  the turn *started* in (or the live mode — whichever is plan), so a precisely
  timed flip can't fork a writable child inside a plan turn.

### Fixed — skills & plugins polish

- Project-local skills/commands override plugin-registered ones again (plugins
  used to load last and silently win); precedence is global → plugins → project.
- YAML block scalars with indentation indicators (`>2`, `|1`, `>2-`, `>-2`)
  parse correctly instead of leaking the literal marker as the description.
- Each skill's prompt-resident summary line is capped (500 chars, code-point
  safe) so a folded multi-line description can't permanently tax every request;
  the on-demand body cap is unchanged.
- The sidebar activity trail no longer double-spaces consecutive tool lines for
  non-reasoning models; reasoning paragraph breaks are preserved.

### Changed — skills menu, white-first opencode palette, sidebar subagents

- `/skills [filter]` opens a searchable skills menu (name + description match);
  Enter prefills the runnable `/skill <name> ` invocation.
- The default theme's chrome is white-first (#eeeeee) on opencode graphite, with
  violet reserved for the selection band and headings.
- The right sidebar hosts live subagent activity alongside Tasks and Thinking.

## v0.1.1 — 2026-07-03

### Fixed — the mid-session freeze (structural)

Tool-heavy sessions (a scaffold generator, `ls -R` in a big tree) could wedge
the whole TUI: scrolling, live updates, and keyboard input all dead, no crash.
The engine and UI share one thread, and each engine event synchronously
re-laid-out an unbounded transcript — cost × rate eventually starved stdin.
Four structural changes, no bandaids:

- **One batched commit per frame.** Tool-start/finish, file-changed, and
  notice events now reduce immediately (state stays in exact event order) but
  paint on the shared 24 ms frame timer, wrapped in Solid's `batch` — a burst
  of hundreds of events costs at most one relayout per frame. User-initiated
  toggles, permission cards, plan cards, turn end, and errors still paint
  the same tick.
- **Transcript render windowing.** The layout tree holds only the newest 40
  turns; older ones fold behind a tappable "▸ N earlier turns" row that pages
  them back in scroll-anchored (20 at a time). Windowing is render-only —
  the reducer keeps full history, so `/export`, expansion, and `--resume`
  rehydration (which now renders only the window instead of the whole
  session) lose nothing. Plus `viewportCulling` on the scrollbox so
  off-screen rows skip paint.
- **Reasoning coalescing.** Reasoning tokens buffer and land once per frame;
  the sidebar trail appends incrementally (only new bytes are ever split,
  never the whole log — the old path re-split up to 64 KB per token).
- **Cooperative yields on the hot producers.** The bash output pump yields a
  macrotask every ~64 KB drained and the stream consumer every 50 parts, so
  stdin and timers get serviced mid-flood; event order is untouched.

Separately hardened: the UI event loop now survives a throwing handler (it
lands an error notice and keeps consuming) — previously any handler throw
silently killed all live updates while the keyboard stayed alive.

### Fixed — thinking during planning (and any non-reasoning model)

- **Inline `<think>` reasoning becomes real reasoning.** OpenAI-compatible
  providers (ollama, lmstudio, and the rest of the compat family) are wrapped
  with the AI SDK's `extractReasoningMiddleware`, so hosted open reasoning
  models' `<think>…</think>` streams to the Thinking panel instead of leaking
  into the visible reply. Dedicated-SDK providers are untouched.
- **An activity trail when there is no reasoning.** Models that never emit
  reasoning (gemma and friends) used to leave the sidebar panel empty while
  tools ran for 15+ seconds. Tool actions (`◈ search …`, `% fetch …`) now
  join the same trail chronologically, and the panel header reads
  "Activity" until real reasoning arrives.

### Changed — sidebar alignment is exact

- The sidebar's first block starts on the transcript viewport's first content
  row, and its bottom edge lands exactly on the input block's bottom edge
  (it used to run two rows past, level with the status footer). Covered by a
  new wide-terminal render smoke: `bun run smoke:sidebar`.

## v0.1.0 — 2026-07-03

First public release.

### Changed — sidebar spans the full column height

- **The right sidebar is now the same height as the chat column.** The
  Thinking block grows to fill every row under the Tasks panel, so the
  sidebar's top block sits level with the first transcript block and its
  bottom lands level with the input — one continuous column instead of a
  short box floating over empty space.
- **The thought trail reads as paragraphs and keeps the whole turn.** Blank
  lines between reasoning bursts are preserved (collapsed to one) instead of
  stripped, and the caps are much deeper (64 KB / 512 lines) now that the log
  fills a scrollable column. As before, the trail persists after the turn
  ends and clears only when the next message is sent.

### Fixed — open-source release prep

- **Onboarding: the custom-endpoint flow can no longer save a broken model.**
  An empty model id used to persist as `custom/` and print "You're all set",
  then fail to resolve on the next launch. The model-id prompt now re-asks
  until it gets a name, and skipping the base URL skips the whole branch
  (nothing half-configured is written).
- **Onboarding: Codex is badged as detected.** The provider menu now marks
  any provider that's configured without its env var — a `codex login`
  session (`~/.codex/auth.json`) or a previously saved config key — and
  preselects it, instead of only recognizing env-var keys.
- **A missing provider SDK now says so.** Loading a provider without its
  `@ai-sdk/*` package used to raise "Provider … is not configured. Set one
  of: install …" — an auth error wearing a dependency problem. It now names
  the provider, the package, and the exact `bun add` command.
- **`listConfiguredModels` resolves credentials once per provider** instead
  of twice (the old filter + map each re-read token files like
  `~/.codex/auth.json` from disk).
- README corrections: `subagent.maxParallel` default is 8 (not 4), proactive
  recall and session digests are on by default (not opt-in), the Codex row
  documents `CODEX_API_KEY`, and the USER.md injection byte-cap is stated.
- Community files for the public repo: CONTRIBUTING, SECURITY,
  CODE_OF_CONDUCT, FUNDING, npm keywords + `funding` metadata, and README
  badges. Removed two stray demo HTML files.

### Added — right sidebar (Tasks + Thinking), Ctrl+T, real-time task fix

- **Right sidebar on wide terminals.** At ≥140 columns, the Tasks panel and a
  new **Thinking** block move into a fixed-width right sidebar, freeing the chat
  column's vertical space. Both are drawn in the same block language as the
  transcript (filled panel surface, thin left rail, identical padding, uniform
  1-row gaps) and align level with the first transcript block. The sidebar
  persists once work exists — completed task lists and the finished turn's
  thinking stay up instead of vanishing (and reflowing the layout) the moment
  everything is done. Narrow panes keep the old inline layout untouched.
- **The Thinking block shows the whole thought process.** It streams the turn's
  reasoning as one continuous, word-wrapped log in a bottom-sticky scrollbox
  (newest always in view, history scrollable). Unlike the inline 3-line
  preview, it does **not** clear each time a burst lands as a `✻ thought` row —
  it accumulates for the turn and lingers until the next one starts.
- **Ctrl+T expands/collapses every `✻ thought` row at once** — the keyboard
  companion to click-per-row (and to Ctrl+O's whole-turn fold): expands all if
  any is collapsed, otherwise folds them all back.

### Fixed

- **The Tasks panel updates in real time again.** The id-addressed
  `update_tasks` path patched task objects in place and re-emitted the *same*
  array reference on the in-process bus, so the TUI's reference-equality signal
  saw "no change" and the counter froze at 0/N until a full-list replace.
  `tasks-updated` (and the engine snapshot) now carry fresh copies; a
  regression test pins the emission identity.

### Changed — royal violet theme, rainbow spinner, wider column, real input wrapping, grounded planning

- **The default theme is now royal violet** — `#8b5cf6` accent on the same
  near-black graphite surfaces, replacing the opencode peach (which lives on as
  `/theme opencode`). The wordmark sweep, markers, mode chip, and chart ramp all
  follow; a new `purple` entry in `ACCENT_PRESETS` makes `/accent purple` the
  default brand. Tests and the smoke render now assert violet dominance.
- **Rainbow thinking spinner.** The live working spinner (and the `✻` glyph on
  the streaming reasoning stack) hue-cycles through the full wheel (~3.6s/rev,
  starting on the brand violet) via a new `rainbow(tick)` in `gradient.ts` — a
  deliberate exception to the single-hue rule so "the model is thinking" has its
  own signature. All other spinners stay in the flat brand accent.
- **Wider chat column.** `CONTENT_MAX` 100 → 130.
- **The prompt input finally wraps for real.** The prompt field is now an
  OpenTUI `<textarea>` — the old `<input>` renderable is single-line *by design*
  (height 1, no wrapping), so long drafts horizontally scrolled out of the box
  with the tail hidden and the cursor painting past the panel edge. The textarea
  wraps natively and owns its height (auto-grows 1 → 10 rows, then scrolls
  internally), killing the estimated-row-count drift entirely. **Enter** still
  submits; **Shift+Enter** now inserts a real newline. Verified by a
  9-terminal-width × 163-keystroke sweep; smoke guards added.
- **The `❯` prompt arrow and text cursor follow the mode color** (PLAN green,
  YOLO red) like the chip and rail — they were stuck on the brand accent.
- **A long plan card no longer buries the transcript.** The approval card caps
  at `dims−20` (was `dims−12`), so ~8 transcript rows stay visible and
  scrollable — you can re-read your own message while deciding on the plan.
- **Planning is grounded now — and it's code-enforced, not just prompted.** The
  system prompt injects **today's date** (with a "your training data predates
  this" warning), the always-on web doctrine forbids stating "latest" versions
  from memory, and PLAN mode carries a research pipeline modeled on agentswarm's
  grounded-research phase: **triage** (self-contained work skips research) →
  **gather** (parallel `web_search` with recency, `webfetch` of authoritative
  docs, `package_info` for real versions, subagent scouts) → **ground** (verified
  facts with sources and real dates; unverified needs marked *inferred — verify*)
  → **adversarial self-critique** → `present_plan` last. A new **plan-readiness
  gate** (`plan-gate.ts`) makes this a contract: a deterministic triage of the
  request decides what evidence the plan needs, and the engine **rejects an
  ungrounded `present_plan`** with concrete instructions (bounded at two bounces,
  then presented stamped *⚠ ungrounded*) — so a weak local model that skips
  straight to presenting is forced back into GATHER instead of shipping a
  20-second hallucinated plan. An optional `planModel` config routes plan-mode
  turns to a dedicated model. Fixes plans that called yesterday's event "today"
  and specified stale majors from memory.
- **The task list actually updates during execution.** Approving a plan seeds an
  **id-addressed task list** (`t1`…`tN`); `update_tasks` takes partial
  `{id,status}` patches (no fragile verbatim-title matching, legacy full-list
  shape still accepted), the handoff prompt tells the model the tasks already
  exist with their ids, and a turn-end **reconciliation fallback** flips
  finished work even when the model forgets to call the tool — so the counter no
  longer stalls at 0/N.
- **Plan approval works in yolo.** The plan card survives a mode switch, and
  approving composes with your approval preference: **Enter** runs with the
  current mode, **Ctrl+Y** accepts and runs **unattended in yolo**. `#approvePlan`
  no longer force-resets approvals to `ask`, so an approved plan can execute
  hands-off.
- **Drive-to-green execution.** The green gate now **re-derives the repo profile**
  when a mutating turn changes the build manifest (a `create-next-app` in a
  formerly-empty dir is now actually built + gated, instead of staying
  "UNVERIFIED" forever), the fix-round cap defaults to **5** (was 2) and its
  exhaustion is a loud "needs your attention" notice rather than a silent stop,
  and EXECUTE mode carries an explicit persistence doctrine (never end a turn on
  a broken build).
- **Machine state moved out of the project.** Session transcripts, engine state,
  and checkpoints now live under **`~/.vibe/state/<cwd-hash>/`** (session-id
  scoped), so a fresh scaffold target (`create-next-app .`) stays truly empty and
  `.vibe/` is gitignored when created in a repo. Only user-facing artifacts
  (`config.json`, `VIBE.md`, saved plans, commands/skills/agents) stay in-project.
- **Output polish.** A single-datum `chart` block renders as a stat line
  (bold value + muted label) instead of one meaningless always-100% bar; diff
  sign columns align across hunks (`diffPad`); the `/accent` hex hint shows the
  new brand. README screenshots regenerated in the new theme.

### Fixed — full subsystem hardening audit

A from-scratch audit of all 12 subsystems (modes/approvals, compaction,
prompt-cache, subagent orchestration, coding loop, context gathering, memory,
research, providers/catalog, sessions/resume, TUI+headless parity, config/MCP/
onboarding), each read end-to-end and every suspected defect reproduced before
fixing, then hardened by **twelve adversarial verification passes** until two
consecutive passes over the weakest areas produced zero new confirmed findings.
Full findings/verdicts trail in [`docs/audit-ledger.md`](docs/audit-ledger.md).
Every fix carries a regression test; the gate (typecheck, lint, full suite) is
green, and a simulated fresh-install smoke (clone → install → first run, incl. a
keyless Ollama end-to-end) passes with zero manual fixes. Highlights:

- **Closed an O(n²) regex class over untrusted input.** Several HTML/markdown/
  search parsers used a lazy `[\s\S]*?</tag>` that rescans to end-of-string per
  unclosed opener — running synchronously after a fetch, so no timeout bounded it
  (a 703 KB page froze `webfetch` ~31 s). Rewrote `htmlToText`, the DuckDuckGo &
  Bing result parsers, `stripInline`, and `stripHandoffFence` as linear
  unrolled-loops; all now complete in single-digit ms.
- **`htmlToText` no longer deletes `<…>` spans inside `<pre>` code** (generics
  `Vec<T>`, comparisons `i < n`, shell redirects `cmd > out`) — fence content is
  protected from the tag-strip pass.
- **Web search is resilient to a malformed booster.** A garbage TinyFish response
  (non-array, or entries missing `url`/`snippet`) no longer sinks the whole
  keyless DuckDuckGo + Bing fan-out.
- **Cost/budget integrity.** A non-numeric/NaN price from a malformed catalog
  upstream can no longer produce a `NaN` running cost that silently disables the
  `budget: {onExceed:"stop"}` cap.
- **Parallel-writer safety.** The post-merge red-gate revert reverts only its own
  merge delta (renames and non-ASCII paths included), never a sibling task's
  already-staged work; `/undo` checkpoints are scoped to their own session across
  a restart.
- **Fresh-install trap fixed.** A scheme-less custom base URL (`localhost:1234`)
  is now rejected up front (schema + onboarding re-prompt) instead of persisting a
  config that shows "you're all set" then fails every request.

### Changed — default theme is the opencode look, wider column, overflow fixes

- **The default theme is now the opencode look** — peach (`#fab283`) accent on
  near-black graphite surfaces (`#0a0a0a` / `#141414` / `#1e1e1e`), replacing
  the black + Blue 300 palette. The wordmark sweep, markers, spinner, and mode
  chip all follow; the smoke test now asserts the default is peach-accented AND
  dark, so a light-mode (or blue) regression fails CI. `light` remains an
  explicit `/theme light` opt-in only.
- **Wider chat column.** `CONTENT_MAX` 84 → 100 — code, diffs, tables and tool
  output show meaningfully more per row; narrow terminals still just fill.
- **No more gutter "ghost" strips.** Every `wrapMode="none"` line — fenced code
  blocks, expanded tool output, diffs, permission previews, notices — is now
  clamped (ellipsis) to the panel width. One long unbroken line (a minified
  bundle, a long log line) used to widen the panel past the column and paint
  stray filled strips into the side gutter.
- **Input wraps exactly at the edge.** The input's height estimate now measures
  the field's true width (it ignored the `ASK ❯ ` prefix, so text near the edge
  horizontally scrolled for a few chars before the box grew, then over-reserved
  blank rows) and reserves a cell for the cursor.
- **Tool rows breathe.** Panel cards use symmetric padding (right 2, was 1), and
  a tool row's summary is pre-truncated with an ellipsis against its meta column
  instead of hard-clipping mid-word into `2.1s · 5 results`.
- **Menu columns align.** The slash-menu/model-picker label column cap (12 → 32)
  collapsed to a zero gap on real model ids (`openai/o4-mini200k`); labels now
  always keep a 2-space gap and descriptions ellipsize instead of hard-clipping
  at the right edge.
- **Tables hang wrapped list items** under the item text (not the `•` marker),
  and input/plan height math is display-width aware (CJK/emoji).

### Added — production & distribution layer

- **Two install channels.** Prebuilt **standalone binaries** (darwin/linux ×
  arm64/x64) attached to each GitHub Release with an aggregate `SHA256SUMS`, and
  an **npm/bun package** (`bun add -g vibe-codr`) built by
  `scripts/release/build-npm.ts` — a single `bun build --target=bun` bundle that
  inlines all `@vibe/*` source and keeps the `PROVIDER_MODULES` literal imports
  bundle-visible (verified by grepping the output), with a generated
  `package.json` whose `optionalDependencies` (provider SDKs, OpenTUI, MCP SDK,
  on-device transformers) are copied from the workspace versions.
- **Version stamping.** A committed `0.0.0-dev` sentinel in
  `packages/cli/src/version.ts` is the single source of truth;
  `scripts/release/set-version.ts` stamps the pushed tag across `version.ts` +
  every workspace `package.json` and promotes the changelog's `## Unreleased`
  section to `## <version> — <date>` (pure, tested rewrites).
- **`vibe upgrade`.** Detects the install channel from `process.execPath` (a bun
  runtime → `bun add -g vibe-codr@latest`; a compiled binary → the Releases URL +
  checksum) and PRINTS the right steps — honest, never self-mutating.
- **Quiet startup update check.** The interactive CLI reads a cached (24h TTL)
  latest-release lookup and prints a one-line hint when a newer version exists,
  then refreshes the cache in the background — never blocking, no user data in the
  request, opt-out via `update.check: false` or `$VIBE_NO_UPDATE_CHECK`. Also a
  `/doctor` line. `isNewer` treats a `-dev` build as never behind its own base.
- **Crash visibility.** `installCrashHandlers` binds `uncaughtException` +
  `unhandledRejection` (SIGINT stays the TUI's): it restores the terminal with
  raw ANSI, writes a **redacted** crash log (api-key/token/authorization/secret
  values masked) to `~/.config/vibe-codr/crashes/<iso>.log`, prints the path, and
  exits 1 — each step individually guarded. `/doctor` surfaces recent crashes.
- **Release + CI automation.** A tag-driven `release.yml` (cross-compiled
  binaries, guarded `npm publish` that dry-runs `-rc` tags, a GitHub Release with
  notes pulled from the changelog) and a hardened `ci.yml` (Linux + macOS matrix,
  the compiled-binary smoke now runs `models` keyless, a PR-only release dry-run).
- This cycle also landed a **9-defect correctness wave** and **10 tech-debt
  items** across modes, memory, providers, and the TUI (tracked in
  `docs/audit-ledger.md`).

### Added — subagent parity pack (continuation, structured output, background spawns)

- **`continue_subagent`.** A parent can now send a follow-up message to a
  completed subagent and resume its full context instead of re-spawning a blank
  child. Completed **shared-tree** children are held in a bounded-LRU
  `ChildRegistry` (config `subagent.retainCompleted`, default 16); a
  worktree/ensemble descendant (whose cwd is torn down) is never retained, and a
  resume into a vanished cwd fails with an honest error rather than an ENOENT.
- **Structured subagent output.** An optional `outputSchema` (JSON Schema) on
  `spawn_subagent` / a task forces the child's final message through a real
  JSON-Schema validator (a bounded validate→re-run-with-errors loop, config
  `subagent.structuredMaxAttempts`, default 2). On success the report is the
  validated JSON; on exhaustion it returns the errors + raw text — **never a
  fabricated object**. (The AI SDK's `jsonSchema()` does no validation, so the
  validator is hand-written and own-property-safe.)
- **Background spawns.** `detach:true` fires a subagent/task fan-out and returns
  a handle immediately; detached children obey the same spawn ceiling, journal,
  and tree-global limiter, are aborted+awaited at `finalize()`, surface a
  "background subagents finished" line into the next turn, and are collected via
  a new `check_task` tool. Detach is **interactive-only** — coerced synchronous
  headlessly so `engine-idle` stays the true terminal signal for `-p`.

### Added — OS-level sandboxing (opt-in)

- **Kernel-enforced FS/network isolation under the permission engine** (which
  stays the policy brain; the sandbox is the backstop). `packages/tools/sandbox.ts`
  generates a macOS **Seatbelt** profile / Linux **bubblewrap** args with
  realpath-canonicalized writable roots (cwd, tmp, state dirs, configured extras),
  routed through `bash`, background jobs, the gate's `exec`, and `verify`.
  `policyForChecks` keeps the gate writable even under a pinned `read-only`.
- **Config** `sandbox: { mode: off | read-only | workspace-write, network: on |
  off, writablePaths[] }` — **default `off` this release** (opt-in per the audit's
  rollout note), plus a `$VIBE_SANDBOX` override. Unsupported platforms / a
  missing (or userns-disabled) `bwrap` warn once and run unsandboxed, never
  silently. A `dangerouslyUnsandboxed` escape hatch **fails closed** through the
  existing explicit-ask path (a blanket allow rule can't authorize the unsafe
  variant). `/doctor` reports the active backend + mode.

### Added — multi-language LSP diagnostics

- **In-loop diagnostics for any language with a server on `PATH`**, generalized
  behind the unchanged `diagnose()` seam (the TS fast path is kept). A new
  `packages/core/src/lsp/` speaks Content-Length JSON-RPC over stdio
  (`initialize` → `didOpen`/`didChange` → version-matched `publishDiagnostics`),
  lazy-spawns one server per language (basedpyright/pyright, gopls,
  rust-analyzer, clangd, jdtls, ruby-lsp, …), **never auto-installs**, bounds
  every diagnose by a deadline so a slow server can't wedge an edit, does bounded
  crash-restart + idle shutdown, and disposes every server at `finalize()`.
- **Advisory + honest**: any timeout / crash / protocol error degrades to
  `undefined`, never a false "clean"; the green-gate remains the cross-file
  backstop. Default-on is a clean no-op when no servers are installed. Config
  `lsp: { enabled, timeoutMs, idleShutdownMs, disabledLanguages[], servers{} }`;
  `/doctor` lists detected / configured-but-missing / crashed servers.

### Fixed — final adversarial review (12 findings in the above)

A 7-area adversarial review of the whole cycle's diff found and fixed 12 verified
defects, most-severe first: a **HIGH** sandbox escape-hatch hole (a broad `bash`
allow rule defeated the `dangerouslyUnsandboxed` fail-closed gate); crash-log
leakage of key-shaped tokens; an LSP `dispose()` that orphaned a still-initializing
server; a relevance floor that nullified semantic recall for paraphrase queries; an
atomic write that destroyed symlinks; the update-hint ignoring its opt-out; and six
lower-severity items (stale `/doctor` version, a toothless npm-bundle guard, a
worktree-descended child retained with a dead cwd, a prototype-chain schema-key
bypass, an unbounded LSP crash-restart, and `bwrap` reported available without a
userns smoke). All fixed with regression tests. See `docs/audit-ledger.md`.

### Added — named accents (orange is back) + eleven ported classic themes

- **`/accent <name>`** — named presets alongside the hex form: `orange`
  (opencode's signature peach `#fab283`), `blue`, `ember`, `amber`, `green`,
  `teal`, `violet`, `rose`, `white`. The submenu renders each preset as a **live
  swatch** (the row painted in the hue it sets), the engine resolves names to hex
  so `accent-changed` needs no UI-side map, and the wordmark fade + markers +
  input rail all follow. The **ASK mode chip now follows the accent** (PLAN
  green / YOLO red stay fixed), so a warm accent recolors the whole input
  coherently instead of clashing with a fixed blue.
- **Eleven ported classic themes** mapped onto the full semantic palette (own
  backdrop, raised surfaces, series ramp): `tokyonight`, `catppuccin`,
  `gruvbox`, `nord`, `one-dark`, `dracula`, `rosepine`, `kanagawa`,
  `everforest`, `flexoki` (burnt-orange primary), `vesper` (peach primary). The
  `/theme` menu + engine validation + help text all derive from one registry, so
  a new theme can't drift out of any list.

### Fixed — TUI event parity, tool-call display, graceful Ctrl+C

- **The TUI no longer drops engine events the headless printer showed** (the
  audit ledger's deferred subsystem-11 item): `reasoning-delta` renders as a
  live one-line `✻ thinking` preview under the working spinner (cleared when
  answer text streams), `verify-started`/`verify-finished` land as notices (a
  failure now carries the check's first output line — previously shown nowhere),
  and `loop-tick` / `checkpoint-restored` mark iterations and `/undo` reverts in
  the transcript.
- **Ctrl+C exits gracefully** (the ledger's other deferred item): the renderer's
  built-in exit (which skipped `engine.finalize()` — dropping the session digest,
  orphaning background jobs, leaking MCP connections) is disabled; Ctrl+C routes
  through the same finalize-then-exit path as `/exit`, clears a non-empty draft
  first, and a second press during teardown hard-exits.
- **Tool rows now describe every tool truthfully**: `save_memory` shows the fact
  it stores (it read schema fields that don't exist — the row was always blank),
  `glob` shows its real `cwd`, `spawn_tasks` reads as its DAG shape
  (`3 tasks: recon → impl → verify`, opens expanded + renders its report as
  markdown) instead of `[object Object]`, `read_mcp_resource`/`get_mcp_prompt`
  get the `⊕` MCP glyph and list/read summaries, and `use_skill`/`run_check`/
  `read_report`/`post_note`/`crawl_docs`/`package_info`/`job_*` all gained
  bespoke icons + summaries. Object args in the generic fallback digest as JSON.
- **The TUI smoke suite is green again and wider**: five click assertions had
  silently staled against the padded-panel geometry (clicks landed in padding),
  two assertions tested retired renderings (permission-card text, glyph-drawn
  bars); all fixed, plus new sections covering the reasoning preview, the
  verify/loop/checkpoint notices, the accent swatch menu, and the spawn_tasks
  label.
- **`build:binary` compiles again** (CI on main had been red): optional peers
  were imported with a literal-cast specifier (`import("playwright" as string)`)
  — the cast erases at transpile time, so `bun build --compile` statically
  bundled playwright-core (whose optional `chromium-bidi` requires then failed
  the build) and silently bundled typescript/linkedom/readability (binary
  bloat). All four now load through a runtime variable specifier; absent peers
  still degrade gracefully.

### Hardened — full subsystem-by-subsystem audit

A read-every-line adversarial audit across all 12 subsystems (tracked in
`docs/audit-ledger.md`), with every confirmed defect reproduced, fixed, and
regression-tested, followed by two adversarial verification passes over the
weakest areas. Highlights:

- **Permissions.** DENY is now absolute across specificity tiers (a blanket deny
  can't be punched through by a scoped allow); glob matching is action-aware so a
  newline/whitespace-case/host-case trick can't dodge a deny kill-switch; an
  explicit `ask` rule fails closed when headless; `always`-allow is keyed per
  tool+content-scope and cleared when approvals re-gate to `ask`; a command-bearing
  MCP/exec tool is now governable by `match` rules; abort resolves pending
  permission prompts so a stale card can't run a cancelled tool.
- **Modes.** `/plan`→`/execute` and plan-card accept now reset approvals to `ask`
  (no more silent YOLO); plan-accept is idempotent (no double-execute).
- **Compaction.** An empty/failed summary never deletes history — it skips
  compaction (with a notice) instead of dropping the conversation or failing the turn.
- **Headless parity.** A one-shot (`-p`) now prints ALL turns of a prompt — including
  gate-fix/review-fix follow-ups — via a new `engine-idle` terminal signal, and no
  longer races `finalize()`; a plan is captured in `--output-format json`.
- **Orchestration.** The shared-tree gate is serialized (no concurrent-build clobber);
  journal seeds respect objective drift and cascade a re-run to dependents; report
  paths disambiguate ids that sanitize-equal.
- **Providers.** LM Studio / local models are probed for their real context window
  (no more 128k default → truncation); a failed catalog load no longer poisons the
  process; estimated pricing can't hard-stop a free local session.
- **Sessions.** Concurrent saves use unique temp files (no torn transcript); the web
  source ledger is persisted and restored on resume.
- **Fresh install.** Onboarding validates config before persisting (can't brick a
  later run) and is honest when a required key is skipped; a hung plugin can't block
  boot; an MCP connect-timeout no longer leaks the connection.

### Changed — TUI visual polish pass

A screenshot-verified sweep over every view of the OpenTUI app (all 17 render
scenes were rasterized, audited, and re-verified after each change):

- **Thin, ghost-free rails.** Every block accent (user/reply cards, input, plan,
  permission, toast, quotes) is drawn by a new `Rail` component — a thin `▎`
  quarter-block glyph column clipped to the block — replacing every
  `border={["left"]}`. The border renderable painted outside content flow: it
  gapped `│` into dashes on terminals with line spacing and could leave stray
  ghost segments behind on reflow/scroll. Glyph content in flow is always
  clipped, cleared, and repainted with its block. Chrome borders are now banned
  by the design-language header.
- **Plan & permission approvals are proper cards** — the same filled panel +
  rail language as the turns and input (PLAN green / amber), with bright-key
  hints (`Enter accept & run · type to revise · Esc keep planning`, `y/a/n`)
  and a scroll affordance only when the plan actually overflows.
- **Heading underlines removed.** Both the filled-band rule (which read as a
  stray grey bar) and any `─` rule are gone; accent color + bold + spacing
  carry h1/h2.
- **Slash menu reformatted.** Two-tone rows (aligned name column, muted
  description), a full-width selection band instead of a ragged text-length
  tint, the `●` current-marker column only in menus that have a current value,
  a `↑↓ move · Tab complete · Enter run` hint, and a tightly capped name column.
- **Sources are calm and everywhere.** Card numbers no longer rotate through
  the series palette; expanded `web_search` tool output now renders as the same
  clean source cards (title / underlined domain link / muted snippet) via a new
  `parseSearchResults`, instead of a raw text dump.
- **Charts.** Bar fills paint as one seamless background band (no per-glyph
  hairlines) with an eighth-block fractional tail; the pie is a larger coherent
  disc with a percentage-aligned legend.
- **Status lines never hard-clip.** The top-left context line (cwd · git ·
  goal) and the under-input status drop their least-important trailing segments
  first, then ellipsize; the git summary is now font-safe `on main 3● ↑1 ↓0`
  (the `⎇` glyph has spotty terminal-font coverage).
- **Layout & feel.** The chat column is capped at 84 columns (was 96); the copy
  toast matches the input block's height and language; streamed tokens flush at
  ~40fps (was ~25) while staying frame-coalesced.
- **Faithful screenshots.** The README screenshot rasterizer pins every
  non-ASCII glyph to its terminal cell (no more font-fallback drift clipping
  line tails) and paints block elements (`▎ ▀ ▄ █`, sparkline eighths) as true
  fractional cell fills, exactly like a terminal.

### Fixed — post-release adversarial review (46 verified defects) + token economy

A multi-agent adversarial review (one finder per subsystem, every finding
cross-examined by three independent refuters) surfaced 46 confirmed defects;
all are fixed, each with a regression test. Highlights:

- **Prompt-cache economy.** The system prompt is now byte-stable across a
  session: the volatile task list and gathered-sources block moved out of it
  into a `<workspace-state>` reminder folded into the newest user turn. A
  changing task list no longer invalidates the whole cached conversation prefix
  every turn. The conversation cache breakpoint now trails the current message
  on **every** step (not just turn start), so a long multi-step turn caches its
  growing tail instead of re-billing it. Mid-turn offload projection no longer
  double-counts the within-turn tail (it fired microcompaction far too early).
  Cumulative cache-read tokens now survive `--resume`.
- **Worktree safety.** `.vibe/` is excluded from the repo via `.git/info/exclude`
  when a worktree is created (it was leaking into `git status`, checkpoints, and
  diffs); task ids that sanitize to the same fragment get distinct worktree
  paths/branches (a collision used to force-remove a sibling's live worktree);
  an interrupted/aborted child now fails its task instead of being journaled
  "completed" and squash-merged (silent partial-work loss on resume); the gate +
  review for a worktree task run inside the merge lock; worktree/branch are torn
  down on every exit path; a hard/ensemble task falls back to the shared tree
  when worktrees can't be created (e.g. unborn HEAD).
- **Recon correctness.** Non-terminating test scripts (`--watchAll`,
  `react-scripts test`, aliased watches) are rejected so the gate can't hang;
  a passing multi-package run that prints "no test files" is GREEN, not RED;
  Python `pytest`/`pip` and a `tsc` typecheck are injected only on real evidence
  (no more bogus commands for a build-backend-only pyproject or `@typescript-eslint`).
- **The cross-run ledger is now actually written** on a green gate (it had no
  caller — the whole feature, and its `build.recon.ledger` toggle, were inert).
- **Egress & SSRF.** Dedicated `git_push`/`git_commit` tools are now governable
  by `match` deny rules; path-scoped rules canonicalize the path (no dodging a
  deny by spelling); MCP tool calls are permission-gated and output-capped, and
  their resource/prompt reads honor abort + a deadline; the NAT64 `64:ff9b::/96`
  prefix is blocked; `isPrivateV4` no longer over-blocks `192.0.0.0/16`
  (it's `/24`); Wayback never receives a private URL; `crawl_docs` re-checks the
  same-domain bound after redirects.
- **Process lifecycle.** Gate-check timeouts and aborted bash now kill the whole
  process tree; shutdown awaits the SIGKILL escalation so a dev server can't be
  orphaned; `read`/`grep`/`repo_map` stream and bound their I/O instead of
  slurping whole files/outputs into memory.
- **UX.** A `/`-line that isn't a command is sent as normal text, not discarded;
  the Tasks/Subagents/Queue panels cap their rows so a big fan-out can't push the
  input off-screen; `/doctor` reports keyless web search as healthy; `/review`
  and `/<skill>` cap what they inject; new TS files written mid-session are
  diagnosed and the language service is rebuilt when tsconfig changes.

### Added — engine-owned build intelligence, industry-leading agentic core

- **Deterministic repo recon, injected everywhere.** At startup the engine
  probes the working directory ONCE (one batched shell round-trip) and detects
  the repo's REAL build / typecheck / test / lint commands (parsing
  `package.json` scripts — watch/dev scripts rejected — pyproject, Cargo,
  go.mod, Makefile), language, framework, and conventions. The profile is
  injected into every prompt as a `REPO FACTS` block, inherited by every
  subagent, fills `verify.command` automatically, and is bootstrapped by a
  **cross-run ledger** (`.vibe/ledger.jsonl`) of confirmed-green commands with
  per-command invalidation (a dep bump doesn't discard still-valid commands).
  No agent in the tree ever guesses how to build the project again.
- **`run_check` — one step to a verdict.** Runs a detected command and returns
  a parsed `PASS 142/142` / `FAIL 3/142 + first failures` instead of raw log
  spew, with honesty guards ("no tests ran" is never green; an unparseable
  passing run is never "no tests").
- **An engine-owned green-gate.** After a mutating turn the ENGINE runs the
  repo's real checks (fail-fast order: typecheck → test → build); red output
  feeds back for bounded fix rounds (`build.gate.maxRounds`); no detected
  command → the work is reported **unverified**, never silently green. On
  green: **commit-on-green as GREEN checkpoints** (hidden-ref snapshots that
  never touch your branch/index — dirty-tree-safe by design; agentswarm-style
  work-branch commits are opt-in via `build.commit.mode: "branch"`), then an
  **adversarial diff review** — a reviewer that sees the REAL diff (untracked
  files included) plus a deterministic **stub scan** (dead handlers,
  `href="#"`, console-only handlers, "not implemented") and must answer
  `REVIEW-CLEAN` or concrete `path:line` issues that trigger a bounded fix turn.
- **Browser / visual verification** (`build.visualVerify`, optional
  `playwright` peer): for web repos the green-gate boots the detected dev
  server on a deterministic port, screenshots the app, captures console
  errors, and **clicks every visible control** — controls with no observable
  effect are flagged as dead and fed into the review. Degrades to a silent
  skip without the peer dep; a server that never comes up reports "could not
  run", never a pass.
- **Orchestration is now the flagship** (`orchestration.enabled` default ON):
  `spawn_tasks` gains **structured handoffs** (children end with a fenced
  `handoff` block — `key_facts` / `files_touched` / `open_questions` — whose
  fields propagate verbatim to dependents, replacing the old 1,000-char prose
  slice), a **`read_report` tool** (full task reports persisted and pullable,
  surviving `--resume`), **model tiers** per task (`tier: "cheap" | "strong"`
  → `build.models`), **executable task verify** (`check: true` runs the real
  gate before any LLM review; the reviewer now receives the actual `git diff`,
  never the child's self-report), an **orchestration journal** (an interrupted
  DAG re-runs only unfinished tasks), a per-tree **spawn ceiling**
  (`subagent.maxTotal`), and **live child activity** — a running subagent's
  current tool call streams to the Subagents panel ("· $ bun test").
- **Worktree isolation + best-of-N.** `worktree: true` tasks run in isolated
  git worktrees (commit → squash-merge → cleanup, merges serialized; a
  conflict fails the task honestly). `hard: true` tasks can run as a
  **best-of-N ensemble** (`build.ensemble.n`, default 0 = off) — N attempts
  with distinct strategy directives, judged by their own gate results, only
  the winner merges.
- **Mid-turn microcompaction (context editing).** Long turns no longer blow
  the window: when fill crosses `compaction.offload.threshold`, bulky and
  superseded tool results are offloaded to session artifacts — a 2KB preview
  + the path stays in context, the full text is retrievable via `read` — with
  a durable end-of-turn pass so persisted sessions carry the previews. The
  LLM summarizer (now a **sectioned contract**: STATE / DECISIONS / FILES
  TOUCHED / VERIFIED FACTS / OPEN THREADS, with a capped input) remains the
  between-turn last resort. The live task list is **re-injected into the
  system prompt every turn**, so it survives compaction deterministically.
- **TypeScript diagnostics in the loop** (optional `typescript` peer): after
  every `edit`/`write` to a TS/JS file, real compiler errors are appended to
  the tool result in the SAME step — "you broke the types" no longer waits
  for a test run.
- **Research is coding-grade.** `web_search` retries once with a reformulated
  keyword core on zero results; `deep: true` now **fetches the top pages**
  (through the same SSRF-pinned pipeline) and returns dated, quotable
  passages — plus a `github.com/<owner>/<repo>` → raw-README rewrite. A new
  **`crawl_docs`** tool does a bounded same-domain BFS over a docs site with
  relevance-ranked excerpts. `webfetch` sends a browser-like UA, detects
  charsets (no more mojibake), preserves document structure as markdown
  (headings/lists/fenced code), detects paywall/anti-bot shells, and recovers
  4xx/5xx pages from the **Wayback Machine** (clearly labeled; never consulted
  for SSRF-blocked URLs). A per-session **source ledger** tracks every URL the
  research tools touch, injects a numbered `SOURCES` block into the prompt for
  stable `[n]` citations, and is browsable via **`/sources`**. Concurrent
  identical fetches coalesce into one network call.
- **Egress is governable + content-scoped permissions.** Network tools
  (webfetch/web_search/crawl_docs/package_info) now honor permission rules
  (they used to bypass the gate entirely; their default stays frictionless
  allow). Permission rules gain a **`match` glob over the call's content** —
  `{tool: "bash", match: "git push*", action: "deny"}` — with
  specificity-then-deny-precedence semantics (a targeted deny can never be
  shadowed by a broad allow, and a scoped allowlist entry beats a generic ask).
- **Resilience:** a **model failover chain** (`modelFallbacks`) switches
  visibly to the first resolvable fallback when the primary can't resolve;
  MCP tool calls are now **abortable with a 120s deadline** (Esc works on a
  hung server); Anthropic **cache-write tokens** are folded into context +
  cost (they were invisible to both) and billed at the cache-write rate;
  prompt caching gains **tool-block + conversation breakpoints** (3 of the 4
  Anthropic slots); timeout/`job_kill` now reap the **whole process tree**
  (no more orphaned dev servers, and background jobs are reaped at exit);
  thrown tool errors land in the same `ERROR:` contract as returned ones;
  session saves use ordered renames (crash-consistent); `--resume` restores
  the recalled-memory block and an armed plan approval; a `/loop` job that
  throws can no longer hang the loop.
- **Memory & blackboard:** `memory.proactiveRecall` and `memory.sessionDigest`
  are ON by default (digests only for interactive sessions — headless `-p`
  runs never pay an extra model call); saved memories are chunked per-fact
  for sharper recall; the coordination blackboard has **typed notes**
  (`claim`/`decision`/`conflict`) that trim transient notes first and resets
  per top-level prompt (no stale claims leaking across turns).
- **File freshness guard:** an `edit`/`write` to a file that changed on disk
  since the session last read it errors with "re-read first" instead of
  silently clobbering the external change.
- **`repo_map` upgraded:** files now ranked by **import-graph in-degree**
  (load-bearing files first) with an incremental mtime cache, and the engine
  injects a token-budgeted symbol map into every subagent kickoff.
- **grep/glob parity:** `ignoreCase`, `context` lines, and a `fileType`
  filter on grep (rg and fallback paths now agree on the file set); glob
  excludes `node_modules`/`.git` and sorts by mtime.

### Changed
- `engine.ts` and `session.ts` were split into focused modules
  (`engine-commands.ts`, `orchestration/orchestrator-runner.ts`,
  `session-tools.ts`, `build/*`); six duplicated capped-stream readers were
  unified into `@vibe/shared`'s `stream.ts` — and `bash`/`git` truncation now
  keeps **head + tail**, so a failing command's trailing error lines survive.
- `/config` no longer masks `tokenFile`/`tokenPath` (paths, not secrets).

### Fixed
- A raw NUL byte in `mcp.ts` made grep/ripgrep treat the whole file as binary
  (now an escape sequence + a workspace-wide guard test).
- Session tools (`save_memory` et al.) now share the turn's mutation lock
  instead of racing `edit`/`write`.
- The `--until` loop condition evaluator now rides the retry/limiter rails
  with a hard deadline (it could previously wedge a loop forever).

### Added — earlier in this cycle
- **Rich, out-of-the-box data views for assistant replies.** A new pure engine
  (`rich-blocks.ts`) renders fenced blocks tagged with a view language into real
  visualizations: ` ```chart ` / ` ```bar ` → horizontal bar charts (eighth-block
  sub-cell precision, value-labeled), ` ```line ` → a braille line chart (2×4-dot
  canvas with min/max axis) or colored block sparklines for multi-series,
  ` ```pie ` → a solid circular pie/donut with a `■ label pct%` legend (percentages
  summed to exactly 100 via largest-remainder), ` ```weather ` → a weather card
  (glyph + temp + hi/lo/humidity/wind chips + a multi-day forecast), and
  ` ```sources ` → numbered citation cards (title · domain · snippet). Charts use a
  per-theme `series` color ramp. Everything falls back to a plain code block when
  the body doesn't parse.
- **Long-term memory — hybrid semantic + lexical recall with an agent
  write-path.** A new `save_memory` tool lets the agent persist durable facts
  (project or global, dated markdown), and `recall_memory` / `/recall` now fuse
  BM25 (`bm25.ts`) with optional on-device semantic embeddings (a `bun:sqlite`
  vector store; keyless ONNX or a configured cloud embedder) and past-session
  recall via reciprocal-rank fusion. A curated global `~/.config/vibe-codr/
  memory/USER.md` is injected everywhere; opt-in `memory.proactiveRecall` injects
  relevant past context at session start and `memory.sessionDigest` writes a
  cross-session digest at the end. Everything degrades to lexical when no embedder
  is available — nothing cloud or native is required at startup.
- **Multi-agent orchestration (agentswarm-style).** Parallel subagents now get
  **exclusive per-file write ownership** (a concurrent write to a file another
  agent owns is hard-rejected instead of silently clobbering), a shared
  coordination **blackboard** (`post_note` / `read_notes`), a tree-global
  **AIMD adaptive concurrency limiter** in front of every provider call, and a
  per-subagent wall-clock timeout. An opt-in (`orchestration.enabled`)
  deterministic **task-DAG scheduler** — `spawn_tasks([{objective,deps,files,
  verify,agent}])` — runs a dependency-ordered plan the engine schedules, with a
  per-task verify→retry pass.
- **Keyless web search + code intelligence.** `web_search` works with **no API
  key** and now **fans out across DuckDuckGo + Bing in parallel**, then dedupes by
  canonical URL and quality-ranks the merged pool (ported search-intelligence
  core); `deep:true` widens the query into complementary phrasings. TinyFish stays
  an optional booster. `webfetch` extracts **PDFs** (zero-dep) and uses **Mozilla
  Readability** when installed (degrading to the built-in tag stripper), and both
  it are backed by a **cache-through store** (per-URL TTL + stale-on-failure). A
  `repo_map` tool returns a ranked file→symbol map so the model can orient on a
  codebase in one call. `@`-mentions resolve directories and honor byte-accurate caps.
- **MCP full parity.** Added the **Streamable HTTP** transport (config `transport:
  http|sse`), MCP **resources** (`read_mcp_resource`), **prompts**
  (`get_mcp_prompt`), **OAuth 2.1** (authorization-code + PKCE with locally
  persisted, auto-refreshed tokens), **auto-reconnect with backoff**, and
  `tools/list_changed` re-registration — on top of parallel timeout-bounded
  connects, live connection status, per-server `enabled`/`timeoutMs`/`cwd`, and
  `readOnlyHint`-aware permission gating.
- **Interactive plan-approval modal.** A presented plan is now an interactive gate:
  **Enter accepts & executes** (switching to execute mode, seeding the task list
  from the plan's checklist, and starting a turn against the approved plan), typing
  a message **revises** the plan, and **Esc keeps planning**.
- **Declarative hooks + extensibility.** A config `hooks` block runs shell
  commands / HTTP endpoints on lifecycle events (deny a tool, rewrite its input,
  or notify). Skills and commands now also load from `~/.config/vibe-codr/
  {skills,commands}` (project overrides global), and named agents can declare a
  tool allowlist/denylist. Plans are persisted to `.vibe/plans/`, and switching
  plan→execute injects an explicit approval directive.

### Changed
- **Transcript rebuilt as uniform, opencode-style message blocks — flat chrome,
  filled content.** Each turn now renders as clean filled panel blocks (a raised
  surface with top/bottom/left padding and a thin left accent edge): the prompt in
  one block, the answer + tool steps + notices in another. This replaces the older
  bordered-panel + heavy-rail design, which broke up on terminals that add
  line/letter spacing (box-drawing `│─┼` glyphs render as dashes; sized-to-content
  fills read as ragged floating rectangles). The one structural rule: **structural
  chrome is flat or filled-uniform, never line-drawn** — the input is a flat
  `MODE ❯` prompt with the command menu as flat rows above it; status sections
  (Tasks/Subagents/Queued) are flat accent titles + rows; tool steps are a clean
  `chevron · icon · label … right-aligned meta` row; diffs are fg-only. Only data
  views (bar/line/pie) and a message block's own fill use background color, which
  fills the whole cell and stays solid on any terminal. Tables render as a flat,
  aligned grid (bold accent header, no lines/bands). `layout.ts` was removed.
- **Menus rebuilt into real, configurable settings.** The `/model` and `/models`
  redundancy collapses into one searchable picker that configures **both** agents —
  Tab flips the target Main ⇄ Subagents (the current model for each is marked). New
  **`/providers`** menu lists every provider with ✓ configured / ○ needs-a-key and the
  env var to set (choosing an unconfigured one prefills the key entry; a configured one
  browses its models). New interactive **`/agents`** menu lists each named subagent with
  its model + mode: selecting one opens a model picker targeting **that** agent
  (persisted to `.vibe/agents/<name>.md`), and `/agents new <name>` scaffolds a new one —
  so you can define as many subagents as you want, each with its own model/provider.
  Subagent concurrency default raised (maxParallel 4 → 8; total count was already
  unbounded). Esc now clears a half-typed draft.
- **Markdown tables render as a light "ledger".** Columns are separated by a calm
  ` │ ` and the header rule gets `─┼─` junctions, both drawn in the border tone
  (kept out of the cell text so they never compete with content) — a real grid to
  scan, far more legible than the flat borderless block when cells wrap, without the
  clutter of a full box. Inline `**bold**` / `` `code` `` markers are still concealed
  in cells; overflowing cells **wrap** (no data loss); and every assistant block
  shares one left edge — quote/code markers on the gutter column, prose/heading/table
  content one column in.
- **Chrome relayout: path top-left, a justified status bar under the input.**
  Location · git · goal moved to a muted TOP-LEFT context line; the under-input
  footer is a justified status **bar** (model · changed · ctx · cost on the left,
  aligned with the top-left line; key hints on the right — shown only on the splash
  / while a job runs, and dropped to their own row when they don't fit) rather than
  a centered block — so the input sits lower and the working screen is quieter. The
  empty-state splash's prompt starters are now a **block-centered list** with
  aligned `›` markers under a quiet "Try asking", instead of a cramped one-liner.
- **README screenshots render the real UI (no more HTML mirror).** The generator
  moved to `packages/tui/scripts/screenshot.ts`: it drives the actual OpenTUI `App`
  through the test renderer and rasterizes its real cell grid (`captureSpans()`) to
  PNG, so the shots are pixel-for-pixel what the live app paints. This retires the
  hand-maintained HTML/CSS mock in `@vibe/core` that had to be kept "in lockstep"
  (and had drifted — wrong brand color, stale chrome) along with its duplicated
  tool-icon/glyph copies.
- **TUI redesign — one Blue 300 accent, no rainbow.** The full-spectrum rainbow
  (wordmark, spinner, per-step/per-subagent gutters) is replaced by a single
  **Blue 300 (`#70cbf4`)** accent reserved for titles + markers. The wordmark is now
  a calm single-hue **light→deep blue fade** (`gradient.ts`, `brandRamp`/`brandSpans`,
  derived from the live accent so `/accent <hex>` recolors it); the spinner is flat
  blue; tool-step and subagent gutters share one **calm muted tone**; box borders
  (input frame + panels) stay neutral grey so blue reads as the accent, not the whole
  UI. **Richer text output:** markdown **headings** (accent, bold, h1/h2 underline)
  and **blockquotes** (gutter bar) are peeled out and styled explicitly; code blocks
  gain a left gutter + accent language tag in a dedicated `code` tone; GFM tables put
  the header row in the accent. The **slash/model menu now docks flush to the input**
  as one connected control (shared divider, aligned edges) instead of a floating
  popup. New palette tokens (`gutter`/`heading`/`code`) across all five themes.
- **Testable core (god-object reduction).** The transcript `UIEvent→Block`
  transform (streaming coalescing, tool-block creation, diff folding, cumulative
  file deltas) is extracted from `app.tsx` into a pure, unit-tested `reducer.ts`;
  git introspection moves to a `git-info.ts` runner tested against fixed porcelain
  output; the TUI's bordered panels share one `layout.ts` chrome token. Behavior
  and render are unchanged (smoke-verified).

### Fixed
- **TUI interaction polish (reported issues).** The `/` menu no longer fast-scrolls
  when you move the mouse — hovering just highlights the row under the cursor; only
  arrows (and the initial highlight) scroll the window. Markdown **tables** are
  redesigned borderless (accent header + one rule + aligned wrapped columns) instead
  of the cluttered heavy box. A **presented plan** is now bounded and scrollable, so a
  long plan scrolls in place while the approval hint + input stay on-screen (they used
  to be pushed off). Selecting text **copies it to the clipboard** (OSC52 + platform
  `pbcopy`/`clip`/`wl-copy`). `/clear` no longer prints "Conversation cleared." twice.
  The internal plan→execute handoff directive no longer leaks into the transcript as a
  user message (it's sent to the model silently, with an "Executing the approved plan…"
  notice). The **"Working…" elapsed clock** is live again (it had frozen because the
  label wasn't reactively tied to the tick). Esc clears a half-typed draft.
- **TUI surface polish pass — consistency across every panel + block.** The
  **Tasks / Subagents / Queued** panel titles now carry the same ` … ` padding as
  the input/plan/menu, so no title reads cramped against its border. Assistant
  **markdown blocks align on one edge**: quote (`▎`) and code (`│`) markers sit on
  the gutter column while prose, headings, and **tables** share the content column —
  tables used to jut two columns left of the prose and quotes two columns right (a
  visible zig-zag). An **expanded subagent result** now hangs under its `↳` instead
  of wrapping back to the panel edge. **Errors render red** (info/warn stay amber)
  and every system line gets a leading `·` so it doesn't read as assistant prose.
  The **working spinner is hidden while a plan card is up** (the card is the
  affordance, not "working"), and the **`/jobs` view's per-job spinners animate**
  even at idle. The under-input details are **two centered rows** (location · git ·
  goal / model · changed · ctx · cost) instead of one line that wrapped mid-metric.
  Model context windows show **`1M`** (not `1000k`), and cached-token counts use the
  same compact `k` form as the total.
- **The `/` command menu is now part of the input (fluid), and hover no longer
  eats the arrow keys.** The menu (and the `/model`/`/providers`/`/agents` pickers)
  renders INSIDE the input frame — one bordered box whose top border carries the
  mode chip, with the list stacked above a `─` divider and the prompt below, so the
  field grows UPWARD as one control instead of a separate popup floating above it.
  And hovering a menu row while pressing ↑/↓ no longer pins the selection under the
  cursor: hover re-selects only on real pointer movement (`(x,y)` change), so the
  keyboard wins until the mouse actually moves. The in-frame menu's row count
  **adapts to the terminal height** (mirroring the plan panel's cap), so on a short
  pane the prompt you're typing at never scrolls off the bottom — the rest scrolls
  behind a "+N more". And table columns now measure **display width** (CJK/emoji
  count as two cells), so a `语言`/`✅` cell no longer drifts the ` │ ` separators
  off the `┼` rule; wrapping also preserves a cell's internal spacing when it fits.
- **Correctness hardening (24 verified bugs).** Token-accurate + image-aware
  compaction (long sessions no longer 400 on `context_length_exceeded`); Esc /
  steer is reported as a cancel, not a red error; cache-read tokens are billed at
  the cache rate; `webfetch` is SSRF-guarded with a timeout + streaming size cap;
  a denied/failed tool call renders as an error, not a success; MCP servers
  connect in parallel and report live status; the dead `step.finish` hook now
  fires; and more.
- **Adversarial review sweep (21 verified defects across every subsystem).**
  - *Security:* closed an **IPv4-mapped IPv6 SSRF bypass** — `new URL()`
    normalizes `[::ffff:169.254.169.254]` to the hex form `::ffff:a9fe:a9fe`,
    which the guard's dotted-decimal-only matcher missed, letting a
    prompt-injected page reach cloud-metadata/loopback; the guard now fully
    expands the address and judges the embedded v4. **DNS rebinding is also
    closed**: the guard resolves a hostname once and returns the verified public
    IP, and `webfetch` connects to *exactly* that IP (bracketing IPv6, preserving
    the original `Host` header and TLS SNI so routing + cert validation are
    unchanged) — so an attacker who returns a public IP to the check and a private
    one to the connection can no longer slip through the window, on every redirect
    hop too. Reachability is preserved: the resolver uses `ADDRCONFIG` and the pin
    prefers a verified IPv4 (IPv6 is often configured-but-unroutable in containers/
    CI), so pinning doesn't regress `webfetch` on IPv4-only hosts. Embedded URL
    credentials (Basic auth) are kept through the rewrite.
  - *Orchestration:* the tree-global provider limiter no longer **deadlocks a
    deep subagent fan-out** — an ancestor held its slot across nested child
    execution, so a chain deeper than the (AIMD-lowered) ceiling could starve its
    own leaf. `acquire()` is now abort-aware (a timed-out/cancelled child stuck
    waiting unwinds) and the ceiling floors at `maxDepth + 1`.
  - *Cost/context:* Anthropic reports `cache_read` tokens **disjoint** from
    `input_tokens`; they're now folded into a superset so cost, the live context
    %, and the compaction trigger reflect the true prompt size.
  - *Data safety:* `/undo` no longer **deletes all untracked files** when the
    snapshot commit is missing (a failed `read-tree`/`ls-tree` read as an empty
    snapshot); it refuses and advances to an older checkpoint. Concurrent
    `save_memory` writes and concurrent global-config persists are now atomic
    (each was a lossy read-modify-write).
  - *Resource bounds:* `bash`, `git_*`, `diff` (LCS matrix), and `@`-mention
    reads are all capped **during** streaming/allocation, not after — a
    high-volume command, a multi-GB `git diff`, a huge-file edit, or a giant
    `@file` can no longer OOM the turn.
  - *Planning/loops:* a prompt queued ahead of plan-accept can no longer **steal
    the plan→execute handoff** (it's bound to its job, not a shared flag); Esc /
    steer now interrupts an in-flight **`/loop` iteration** (it targets the loop's
    session, not the idle main one).
  - *Smaller:* Ollama's context probe prefers the served `num_ctx` over the
    architectural max; markdown rendering keeps intraword underscores
    (`max_retry_count`); `glob` no longer mislabels exactly-1000 matches as
    truncated; MCP tool names that sanitize to the same string are disambiguated;
    an MCP reconnect that resolves after shutdown closes its transport instead of
    leaking it; a custom `/redo` command works (it was a phantom reserved name);
    the cross-agent file-write lock is case-correct for new files on
    case-insensitive filesystems.
- **Second review pass (8 more verified defects; the first-pass fixes verified
  regression-free).**
  - A **config shell/HTTP hook can no longer hang the turn**: the wall-clock
    timeout is enforced on the read (with the shell killed and the read
    cancelled), so a hook that backgrounds a child holding the stdout pipe returns
    within `timeoutMs` instead of blocking indefinitely.
  - **Orchestration verify→retry is honest**: the reviewer's `REVIEW-CLEAN`
    verdict must be on its own line (an adversarial "NOT REVIEW-CLEAN — …" no
    longer reads as a pass that discards the feedback), and a retry that makes no
    edits no longer marks the previous rejected work as completed.
  - A turn that **fails before any assistant reply** (model resolve / pricing /
    compaction throw or abort) now **rolls back its user message**, so the next
    turn doesn't open with two consecutive user messages (a 400 on strict
    providers, and a corrupt `--resume` seed).
  - `/undo` **advances past a stale (GC'd) checkpoint** to the next valid one
    instead of reporting "nothing to undo".
  - MCP: a transient transport `onerror` no longer **latches a still-working
    server "down" forever** (only `onclose` drives the down/reconnect transition);
    resources/prompts first exposed on a **reconnect** now register their
    aggregate tool; and the OAuth token store writes **atomically** (temp +
    rename) and sets a corrupt file aside instead of silently dropping the grant.
- **Third exhaustive pass (10 more verified defects across the previously
  less-scrutinized surface — TUI app, parsers, CLI, config, shared).**
  - **Config defaults are no longer a shared mutable singleton**: `defaultConfig`
    / `loadConfig` deep-clone, so one config's mutation (e.g. `/model key` writing
    `providers[id]`) can't leak into another (or pollute tests).
  - Hardened parsers/tools against hostile or runaway input: a **deflate-bomb
    PDF** stream is size-capped instead of inflating to hundreds of MB; the
    builtin `grep` fallback **skips pathologically long lines** (no
    catastrophic-backtracking hang); `verify` reads its output **incrementally**;
    and a detected dev-server URL is now **sticky** in `/jobs` instead of
    vanishing once the job's output scrolls past the buffer.
  - CLI/TUI: a `-m <model>` flag no longer **discards the provider you just
    configured in first-run onboarding** (which failed the run right after setup);
    the onboarding provider menu is **windowed** so it can't spam scrollback; the
    TUI **`/model` and `/providers` pickers refresh** after a key is added or
    `/model refresh` (they were cached for the whole session); `/exit` **awaits
    the session digest/teardown** before quitting; and a GFM **escaped pipe**
    (`\|`) in a table cell renders as a literal `|`, not a broken column.

### Added (providers)
- **Seven more providers + a generic bring-your-own endpoint — use vibe with
  almost any model.** Added Google Gemini (via its OpenAI-compatible endpoint),
  Groq, Mistral, Together AI, Cerebras, and Perplexity, plus a generic **`custom`**
  provider that points at ANY OpenAI-style API (`config.providers.custom.baseURL`
  or `$CUSTOM_BASE_URL` + an optional key). All ship through `@ai-sdk/openai-
  compatible` (no new SDKs, stays on `ai@5`). They — and the previously-hidden
  minimax/fireworks/codex — now appear in onboarding. (OpenRouter and Codex already
  shipped.)
- **`/models refresh`** — force-pull the models.dev catalog past its 24h cache, so
  a just-released model's context window/pricing shows up immediately.
- **First-class token reuse for `codex` / ChatGPT login.** If you've run `codex
  login` (official CLI), vibe reuses `~/.codex/auth.json` — onboarding detects it
  and skips the key prompt, `/doctor` shows it configured, and the token is re-read
  every turn so a refresh is picked up. The ChatGPT-subscription backend is
  configurable (`CODEX_BASE_URL` + provider `headers`). Any provider can reuse
  another CLI's credentials via `config.providers.<id>.tokenFile`/`tokenPath`.
- **A deliberate rainbow color language for the TUI.** Color is now reserved for
  four tasteful zones instead of one flat orange accent: the **wordmark** is a
  clean left→right rainbow gradient (per-column hue, so it reads as one smooth
  sweep, not per-letter confetti); the input's **mode chip** carries the mode
  color (ASK blue · PLAN green · YOLO red); the **thinking spinner** glyph cycles
  through the rainbow while a turn runs; and **each subagent / tool-step** gets a
  stable rainbow hue so a fan-out or a sequence of steps is visually
  distinguishable. Accents only — body text and tool output stay neutral and
  readable. New `rainbow.ts` helpers (`rainbowAt`/`rainbowSpans`/`rotateHue`); no
  always-on timer (the wordmark/agent colors are static, the spinner rides the
  existing working-only tick). Per-character color uses a row of `<text fg>` (the
  reliable mechanism) — inline `<span fg>` children don't paint in this renderer.
- **Interactive submenus — a live, searchable model picker and clickable
  toggles.** Slash submenus are no longer text dumped into the transcript. Typing
  `/model ` opens a picker of the real models across your configured providers:
  filter by typing, the current model is marked `●`, and a **click** (or Enter)
  sets it — `/model sub ` targets the subagent model the same way. Menu rows are
  now mouse-clickable with hover highlighting, and the enum submenus
  (`/theme`, `/approvals`, `/reasoning`) mark the current value. Backed by a new
  typed `set-subagent-model` command and `EngineClient.listModels()`.
- **A visible message queue with per-item steer + remove.** Prompts you type while
  a turn is running already queued and ran in order — but you couldn't see or
  control them. There's now a **Queued** panel above the input listing each waiting
  prompt, each with two actions: **steer** (jump it to the front and interrupt the
  running turn so it runs *now* — redirect the agent mid-flight) and **✕** (drop
  it). New `steer`/`dequeue` engine commands back them; nothing is dropped on a
  steer, the rest keep their order.
- **The message input grows and wraps instead of scrolling text off-screen.** A
  long message used to scroll horizontally — the start of what you typed vanished
  off the left edge. The input now soft-wraps on word boundaries and the framed
  box grows downward as you type (up to 10 rows, then it scrolls internally), so
  the whole message stays visible. (Two parts: `wrapMode="word"` on the input, and
  flipping its frame to a column so it grows vertically rather than only widening.)
- **`/model` is now a full, persistent provider/model control center — switch
  everything from chat, cross-provider, and it's remembered.** Previously `/model
  <id>` only changed the session model and forgot it on exit. Now:
  - `/model <provider/id>` switches the **main** model (any provider) and persists
    it to `~/.config/vibe-codr/config.json`.
  - `/model sub <provider/id>` sets a dedicated **subagent** model (e.g. a cheaper
    or faster model for delegated work); `/model sub clear` reverts to inheriting
    the main model. Persisted, and applied live to the running session.
  - `/model key <provider> <key>` saves/replaces a provider API key, persisted and
    remembered across sessions — no editing JSON by hand.
  - `/model` with no args shows the current main + subagent model and a cheatsheet.
  Switching to a provider with no key yet prints a one-line hint telling you to add
  one. `writeGlobalConfig` gained `null`-deletes-key semantics so settings can be
  cleared, not just set.

### Changed
- **Onboarding/default models refreshed to current flagships** (e.g. OpenAI
  `gpt-4o` → `gpt-5.2`, xAI `grok-4` → `grok-4.3`) and the new providers seeded
  with current defaults. The live picker remains the source of truth; these are
  just the preselects.
- **The models.dev cache honors `$XDG_CACHE_HOME`** (default `~/.cache`), mirroring
  the config's `$XDG_CONFIG_HOME` — so the test suite no longer risks overwriting
  the developer's real catalog cache.
- **Neutral white/grey chrome — the orange brand accent is retired.** Panel
  titles, borders, the `❯` marker, the cursor, and the input frame are now a quiet
  white/grey, so color reads as intentional where it appears (the four rainbow/mode
  zones above). The DEFAULT palette's `primary`/`accent` are neutral; `/accent
  <hex>` still recolors the chrome to a single hue.
- **`/theme`, `/accent`, and `/reasoning` now persist** to the global config (like
  `/model` already did), so a toggled preference sticks across sessions. (Mode and
  approvals stay session-only by design — safer to start fresh in ask/plan.)
- **`globalConfigPath()` honors `$XDG_CONFIG_HOME`** (the XDG Base Directory spec —
  `~/.config` is just its default). Read at call-time, so it's also what makes the
  config path overridable for test isolation (see Fixed).

### Fixed
- **Replies that mixed prose with a code block or table lost the prose.** OpenTUI's
  `<markdown>` renderable has a layout bug where a code/table block blanks its
  *sibling* prose (even across separate `<markdown>` instances) — so in every
  code-containing reply, the explanation around the code silently vanished. vibe now
  splits each reply into blocks and renders **prose via `<markdown>`** (inline
  bold/italic/code still conceal) while rendering **code blocks and tables as native
  `<box>`/`<text>` primitives** — clean box-drawing tables with aligned columns
  (GFM alignment respected) and panel-backed code blocks. All the prose survives.
- **Streaming was laggy/janky on long replies.** Every token did a full re-render +
  markdown re-parse (O(n²)). Streamed tokens are now coalesced and flushed ~25×/s,
  so a long reply stays smooth while inline markers still conceal live.
- **The colored step markers didn't line up with the message gutter.** The per-step
  rainbow was an inline `▎` at a different x than the user-message left border; it's
  now a left-border gutter anchored at the column edge, so the user gutter, the
  rainbow tool-step gutters, and the input frame all align — with the reply text on
  one consistent column beside them.
- **Fireworks (and now Together) models showed no context/pricing in the picker.**
  Their provider ids didn't match their models.dev catalog slugs (`fireworks` vs
  `fireworks-ai`, `together` vs `togetherai`), so enrichment silently missed. A
  provider-id→slug alias map in `CatalogService` fixes it; `codex` models now
  enrich from `openai` too. `config.providers.<id>.headers` are also now sent on
  the `/v1/models` listing call (gateways that need them can list, not just chat).
- **Replies leaked raw markdown markers (`~*$58,400-58,700 USD*`) and read clumsily.**
  Diagnosed empirically (rendered the exact string through the real OpenTUI
  `<markdown>`): conceal is healthy — `**bold**`, `` `inline code` ``, and
  word-flanked `*italic*` all hide their markers — but OpenTUI's strict tree-sitter
  grammar (unlike lenient parsers) does **not** treat `~*$…*` as emphasis, so it
  prints literally. It's a model-output problem, not a renderer bug. The system
  prompt now carries an always-on **terminal output-formatting doctrine**: lead with
  the answer; wrap every literal (prices, paths, ids, flags, versions, quoted
  errors/output) in `` `inline code` `` (verbatim, never mangles) rather than bold;
  never put `*`/`_`/`~` against a digit/`$`/punctuation; real pipe tables fine,
  hand-drawn ASCII tables not; no strikethrough (`~~` shows its tildes here).
- **The test suite was overwriting the developer's real
  `~/.config/vibe-codr/config.json`.** Tests that exercise persisted settings
  (`/model`, `/accent`, `/theme`, `/reasoning`, provider keys) had no working
  isolation: they set `process.env.HOME`, but Bun's `os.homedir()` caches at
  startup and ignores a runtime HOME change, so every run clobbered the real config
  (e.g. flipping the theme to `light` → a white UI, overwriting API keys with test
  placeholders). Now a Bun test `preload` redirects `XDG_CONFIG_HOME` to a throwaway
  dir (read live by `globalConfigPath`), and the suite is verified to leave the real
  config byte-for-byte untouched.
- **On Ollama Cloud, the model spawned "gpt-4" subagents it had no provider for.**
  `spawn_subagent` exposed a `model` parameter, so a model would *invent* a
  subagent model string (e.g. `"gpt-4"`) pointing at a provider the user never
  configured — the turn then failed trying to reach OpenAI. The subagent model is
  now strictly a **setting**, never model-chosen: the `model` parameter is removed,
  and a subagent uses the named agent's own model → the `subagent.model` config →
  the parent's model. With nothing custom set, subagents run on exactly the model/
  provider you're using.
- **The model wasn't told its working directory — it ran `pwd` to orient and
  hallucinated absolute paths.** The system prompt never injected the cwd
  (`composeSystemPrompt` ignored it), so on a "make me a website" task the model
  wrote to a *guessed* `/Users/<someone-else>/…` path, then burned a whole slow
  step running `pwd && ls` to discover where it actually was. The prompt now
  carries an `ENVIRONMENT:` block with the cwd and an explicit "you already know
  this — don't run `pwd`, don't invent absolute paths" directive. Removes a tool
  round-trip per task and the wrong-path writes.
- **A transient empty `web_search` result cost a whole extra model step.** TinyFish
  occasionally returns a flaky empty array for a query that has results; the tool
  reported a clean "No results", so the (slow, thinking) model treated it as a
  dead end and re-searched a reworded variant — one wasted ~10-18s reasoning step.
  `web_search` now does one cheap in-tool retry (~0.6s) on an empty array before
  giving up, and wraps its fetch in an 8s wall-clock timeout (layered on the
  caller's abort) so a stalled connection can't hang the turn. Its description was
  also softened to stop nudging the model into reflexive multi-search.
- **Markdown inline markers (`**bold**`, `` `code` ``) rendered raw in the TUI.**
  OpenTUI's `<markdown>` renderable conceals syntax markers via a tree-sitter
  *inline* parser, which is loaded by a worker that statically imports
  `web-tree-sitter` — a **peer** dependency of `@opentui/core` that was never
  installed. The worker failed with `Cannot find package 'web-tree-sitter'`, so
  the inline parser never ran and every reply showed literal `**`/backticks
  (e.g. `**BTC ≈ $58,954**` instead of bold). Added `web-tree-sitter@0.25.10`
  (pinned to the peer range) as an optional peer of `@vibe/tui`, provided through
  the root dev environment. The smoke test now asserts the bold markers are
  concealed (`!frame.includes("**")`) so the missing peer can't regress silently.
- **A subagent's answer could flood the parent's context window.** Every
  context-producing tool caps its output (`read`/`grep`/`git_*`/`edit`/…) because
  it lands verbatim in the prompt — but `spawn_subagent` returned the child's
  *entire* final answer uncapped, straight into the **parent's** context. A
  verbose or runaway child (and a parent can fan out `subagent.maxParallel` of
  them in a single step) could dump tens of thousands of tokens into the parent,
  defeating the engine's context accounting and risking a hard 400 on the parent's
  next turn. `spawn_subagent` now caps the model-facing result at 32k chars
  (`MAX_SUBAGENT_OUTPUT`) with an explicit `…(subagent output truncated …)` marker
  that nudges the model toward a more focused subtask; the UI still receives the
  complete answer via the `subagent-finished` event, so nothing is lost on screen
  (the same split `edit`/`write` use for their diffs).
- **`edit` could flood the context window with an unbounded diff.** Every other
  context-producing tool caps its output (`grep`/`glob`/`git_*`/`read`/…), but
  `edit` echoed the *entire* unified diff of its change back into the model
  prompt with no limit — so a large `replaceAll` or a multi-edit across a big
  file dumped thousands of lines verbatim, defeating the very context accounting
  the engine maintains and risking a 400 on the next over-long turn. `edit` now
  caps the diff it returns at 20k chars (matching `git_diff`) with an explicit
  `…(diff truncated at 20000 chars)` marker; the UI still receives the complete
  diff via the `file-changed` event, so nothing is lost on screen. (`write`
  already kept its diff out of the output — only `edit` inlined it.)
- **A `bash` timeout looked like a generic command failure.** When a command
  exceeded its `timeoutMs`, the tool killed the process and returned the bare
  SIGTERM exit code (`exit 143`) — indistinguishable from a real non-zero exit.
  An autonomous agent couldn't tell a hang apart from an error, so it couldn't
  decide to raise the timeout, switch to `background:true`, or stop retrying.
  The tool now tracks that it killed the process for exceeding the deadline and
  reports `timed out after <N>ms (process killed; rerun with a larger timeoutMs
  or background:true)` instead, while still surfacing the partial output it
  captured before the kill.
- **Planning could waste a subagent turn on a write-oriented agent.** In plan
  mode the parent is read-only and every subagent it spawns is coerced to plan,
  so the named-agent roster only advertises read-only (`mode: "plan"`) agents.
  But `spawn_subagent` still *accepted* an execute-only agent (e.g. the default
  `test`) if the model named one anyway — coercing it to plan handed the child a
  write-oriented brief (`"write and run tests, leave it green"`) with none of the
  write/run tools plan mode exposes, so the child could only report that it
  couldn't act, burning a full (cost-bearing) turn. A plan-mode parent now
  **rejects an execute-only named agent up front** with an error that points at
  the read-only agents it can delegate to instead; an explicit `mode:"execute"`
  request *without* a named agent is still safely coerced (unchanged).
- **`read` could flood the context window with a binary file or a giant line.**
  Unlike every other context-producing tool (`grep`/`git`/`webfetch` all cap
  their output), `read` returned whatever it found verbatim — so reading an
  image, an executable, or a minified bundle (often a single multi-megabyte
  line) dumped thousands of mojibake or junk tokens straight into the prompt,
  blowing up the very context accounting the engine works to keep accurate.
  `read` now (1) sniffs the leading bytes for a NUL and refuses a binary file
  with a clear message instead of dumping garbage, (2) caps returned content at
  100k chars with an explicit `…(truncated at 100000 chars; use offset/limit to
  page)` marker, (3) returns a distinct `(empty file)` for a genuinely empty
  file rather than a bare `1\t`, and (4) flags an `offset` past the end of a
  non-empty file instead of silently returning nothing.
- **Context % stayed pinned at the pre-compaction fill after `/compact`.** The
  live context indicator (and `/context`/`/status`) report the provider's real
  last-step input-token count, but that count measured the prompt *before*
  compaction dropped the older half — so right after a manual or auto compaction,
  `contextTokens` kept returning the stale, high number until the next turn ran a
  step, hiding the very space the compaction just freed. Compaction now clears the
  cached count (so `contextTokens` falls back to a fresh estimate of the surviving
  messages, refined by the next step's real count) and emits a `context-updated`
  carrying that lower number, so the freed space shows immediately.
- **Compaction could orphan a tool result and 400 the next turn.** The kept-window
  slice cut by message count alone, but `response.messages` records each tool result
  as its own `role: "tool"` message — so when the boundary landed on one, `recent`
  began with a `tool_result` whose `tool_use` had just been summarized away into the
  older half. Anthropic/OpenAI reject that orphan with a hard 400, killing the very
  next turn after an auto- or `/compact`. The boundary now walks back past any
  leading `tool` message so the owning assistant turn stays whole (and returns null
  rather than emit an invalid window when that swallows everything older).
- **The accent color was stuck on lavender regardless of the theme.** The config
  schema *defaulted* `accentColor` to `#bb9af7`, so `brand() = accentColor() ||
  primary` always resolved to that lavender even when you never set it — the theme's
  own `primary` (and any new default) could never show. `accentColor` now defaults
  to **empty**, so the active theme's `primary` is the brand and `accentColor` only
  applies when you explicitly set it (config or `/accent <hex>`).
- **Context-window % read far too low.** `ctx N%` (and `/status`/`/context`)
  estimated usage by `JSON.stringify`-ing the message array and dividing by 4 —
  which **excluded the system prompt and tool schemas** (routinely thousands of
  tokens) entirely. It now uses the **provider's real `inputTokens`** from the last
  step (the true prompt size, including system prompt, tools, and cache), surfaced
  live after every step via `context-updated`; the old estimate remains only as a
  pre-first-step fallback. The window denominator chain is unchanged
  (`config.contextWindow` → Ollama `/api/show` probe → models.dev catalog → 128k).
- **Parallel subagents could corrupt a shared file.** The mutating-tool serial
  lock was created per session, so two concurrent subagents editing the same file
  got different locks and raced. A **tree-wide per-file write lock**
  (`createFileLock` → `SessionDeps.fileLock` → `ToolContext.lockFile`, taken by
  `edit`/`write`) now serializes same-path writes across the whole session tree
  while disjoint paths stay parallel. Lock keys are canonicalized
  (`realpathSync.native`), so different spellings of one file — including
  case-variants on case-insensitive filesystems like macOS APFS — share a lock
  instead of racing.
- **Expanding a tool/diff row no longer jumps to the bottom.** On an idle turn,
  expand/collapse now disengages the scrollbox's sticky auto-follow and freezes
  the scroll position, so the clicked row stays put and revealed content drops in
  below it (auto-follow re-engages on the next prompt).
- **Clicking a message to fold its work now works reliably.** Turn ownership is
  computed by transcript position (nearest preceding assistant message) instead of
  a fragile emission-time turn id, so a tool emitted before the assistant's first
  text no longer escapes the fold.
- **Standalone binary could not load any provider.** Provider SDKs were imported
  with a dynamic `import(variableSpecifier)` that `bun build --compile` can't
  bundle, so the "standalone" binary failed on every provider with
  `Cannot find module '@ai-sdk/...'`. Provider modules are now loaded through a
  static `import()` map, so the binary is genuinely self-contained (verified
  end-to-end against a live HTTP model and across all bundled providers).
- **Multibyte UTF-8 output corruption** in `bash` and background jobs: streamed
  output now uses one streaming `TextDecoder` per stream with a final flush, so
  a multibyte character split across a chunk boundary is no longer mangled.
- **Unhandled promise rejections** in the background-job output pumps are now
  caught and recorded on the job instead of escaping.
- **CRLF-authored `SKILL.md` / agent / command files** lost all frontmatter
  because the parser's fence regex was LF-anchored; line endings are now
  normalized before parsing.
- **JSONC config corruption**: a `//` or `/* */` inside a string value (a URL,
  path, or regex) was stripped as if it were a comment. Comment stripping is now
  string-aware.
- `glob` (1000-file) and `grep` (500-line) output caps now show an explicit
  truncation marker instead of silently dropping results.

### Added
- **`git_diff` can target a commit, branch, or range.** Previously the tool only
  showed unstaged or (with `staged:true`) staged changes, so the agent had no
  structured way to review committed work — it had to fall back to raw `bash` to
  see `git diff HEAD` or a branch's full diff. `git_diff` now takes an optional
  `ref` (`"HEAD"`, `"main"`, a commit hash, or a range like `"main...HEAD"`),
  composable with `path`, so the agent can review everything it has committed this
  session or a whole branch's diff. Refs that begin with `-` are rejected so a ref
  can't smuggle in a git option.
- **`/jobs` sub-view — running shell commands + localhost servers.** Background
  bash jobs (started with the bash tool's `background` mode) are now visible: the
  Engine owns the `BackgroundJobs` registry and pushes a `jobs-changed` event, and
  `/jobs` opens a full sub-view (in place of the transcript) listing each job's
  command, pid/exit status, **auto-detected localhost URLs** (scanned from the
  job's output — e.g. a Vite/Next dev server's `http://localhost:5173`), and a few
  lines of recent output. Esc or `/jobs` closes it; the footer hint advertises it
  while any job is running.
- **`package_info` tool** — authoritative latest-version + metadata lookup from
  npm or PyPI (no key required). The fast, reliable way to check dependency
  currency: read the manifest, then compare against the real latest instead of
  scraping the web. Read-only, so it's usable while planning too.
- **Adaptive web-search — the model controls depth, nothing throttles it.** The
  search guidance calibrates effort to the question: quick facts (price, date,
  version) are answered straight from the `web_search` snippets — one query, no
  `webfetch`, stop — while hard or high-stakes questions go deep (more queries,
  more sources, full-page fetches, cross-checking). No engine throttle: `web_search`
  now keeps every ranked result the provider returns by default (the old hardcoded
  8-result cap is gone), with an optional `maxResults` to trim to the top N for a
  quick fact; `webfetch` takes `maxChars` (default 25k, raise to read a long page
  in full, and truncation now reports how much was dropped). Broader coverage comes
  from issuing more queries. Version questions are pointed at `package_info` and
  official docs over blogs.
- **Multi-agent coding, dialed in.** The execute-mode system prompt now carries a
  **delegation doctrine** (when/how to fan out, self-contained child prompts,
  disjoint-file ownership, consolidate + verify), injected only when subagents are
  actually available. Three **default coding agents** ship out of the box —
  `explore` (read-only research), `review` (adversarial code review), `test`
  (write/run tests) — and the named-agent roster is injected into the prompt so
  the model routes by capability; `.vibe/agents/*.md` override them by name. A new
  `subagent.maxParallel` (default 4) bounds each fan-out via a per-session
  semaphore (deadlock-free, unlike a tree-global cap). **Plan mode can now fan out
  read-only subagents** for parallel codebase exploration while planning — they're
  coerced to plan mode so they can never write. `spawn_subagent` no longer prompts
  for permission for the orchestration itself (the child's own tools still gate
  every side effect).
- **Working-tree git status** — branch, dirty count, ahead/behind, and a worktree
  marker, from a new `Engine.#gitInfo()` + `git-updated` event (refreshed at startup
  and after each turn), surfaced in the header's live context line. The redundant
  tool-call "Activity" feed (a duplicate of the transcript) was removed.
- **Configurable accent color** — `/accent <hex>` (live) and an `accentColor`
  config field set the single UI accent (vivid orange-red `#ff3503` by default).
- **Skills are now invocable as `/skillname [task]`** (the user-initiated analogue
  of the model's `use_skill`): the engine loads the skill body and runs it like a
  prompt. Built-ins and custom commands still take precedence.

### Changed
- **Centered, single-column chat UI (ChatGPT-style) on black.** The TUI is one
  capped-width conversation column centered in the terminal — it fills a narrow
  terminal and gets quiet side gutters on a wide one (two `flexGrow` gutters do the
  centering; `contentWidth()` = `min(96, width − 2)`), with **no sidebar/rail and no
  top header**. A fresh screen shows a **centered VIBE CODR wordmark** (OpenTUI's
  native `<ascii_font>`, the sleek `slick` face, in the brand color); once you
  start, the column is just the scrolling transcript, the live
  status panels (working · plan · **Tasks** · **Subagents** · permission · command
  menu), the input, and a two-line status block. The input is a **border-only field
  (no fill — just the frame + text on black)** with the **mode word on the top
  border** (`┌─ ASK ─┐`; **execute reads "ASK"** since it prompts before each
  action, vs YOLO), colored by mode (execute brand · plan cyan · yolo red); no
  prompt glyph inside; placeholder "Send a message or type / to start". **All the
  details moved UNDER the input** — line 1 `cwd · git  /  model ·
  changed · ctx · cost`, line 2 `hints / goal`. The empty-state wordmark and the
  tips are each centered independently (a height guard swaps in a compact brand on
  short terminals).
- **Tap your message to fold the whole turn.** Folding is now anchored on the user
  message: tap it to collapse the entire exchange beneath it (reply + tool work) to
  a `▸ N items hidden · tap to expand` affordance; tap again to reopen. **Ctrl+O**
  still folds/unfolds every turn at once.
- **Tidy subagents panel.** A fan-out now renders **one truncated line per
  subagent** (it used to dump every subagent's full multi-line prompt and flood the
  screen); tap a row to expand its full prompt + result (bounded so it can never run
  off-screen), tap again to collapse.
- **Black + monochrome theme with one vivid accent.** The default theme is **black
  background + white/grey text** with a single signature accent — **`#ff3503`
  (orange-red)** — on the wordmark, the input frame, the gutters, and carets;
  everything else stays monochrome. The mode word on the input border carries the
  mode hue (plan cyan · yolo salmon · execute the accent). Green/red/amber remain
  reserved for diffs and warnings.

### Improved
- **Slash menu opens as a fluid overlay — the view no longer jumps.** Typing `/`
  used to insert the command menu in the layout flow above the input, shrinking
  the `flexGrow` body so the centered wordmark/transcript jumped upward. The chat
  column is now `position:"relative"` and the menu is `position:"absolute"`
  anchored just above the input (`MENU_BOTTOM`), so it *overlays* the space above
  the input (opencode-style) instead of taking flow space — the wordmark and
  transcript stay put and the menu reads as an extension of the input box.
- **Compact ░██ block wordmark + minimal, fully-centered splash & footer.** The
  empty-state splash renders "Vibe Codr" in a compact ░██ block face
  (`packages/tui/src/wordmark.ts`, 80×7) — smaller and more legible than before —
  falling back to the `slick` ascii-font logo, then `◆ Vibe Codr`, on narrow/short
  terminals. The splash is now decluttered to just the wordmark + one centered
  "Try ›" prompt-starter line — the tagline and the `shift+tab`/`@`/`/` key
  cheatsheet were removed (the keys already live in the under-input status). That
  status is two centered lines (location · git · model · changed · ctx · cost on
  one, key hints on the other) instead of edge-justified, so the model no longer
  floats off alone on the far right and the frame reads as one uniform centered
  column.
- **Consecutive tool steps now chain instead of floating apart.** A run of tool
  calls (search → fetch → fetch) used to render each row in its own one-line gap,
  reading as unrelated fragments. A tool row that follows another *visible* tool
  row now stacks flush (no top margin), so a sequence reads as one connected
  group; the gap is kept only at the boundary with prose, a notice, or a folded
  turn. Hidden (folded) rows don't count as the predecessor, so an expanded turn
  still chains correctly.
- **Cleaner splash + under-input status line.** The wordmark tagline, sample
  prompts, and key hints are now one tidy left-aligned block (centered as a
  whole, shared left edge) with a calm muted subtitle and the actionable tokens —
  the example prompts and the `shift+tab`/`@`/`/` keys — in the brighter
  foreground. The under-input key hints get the same two-tone treatment, and the
  middot separators are unified to a single `·` rhythm across the splash and
  footer so nothing reads as raggedly centered or randomly spaced.
- **Subagent replies + web-search results render as rich markdown.** A
  `spawn_subagent` result used to print as raw text (literal `##`, `**bold**`,
  `|table|`); it now opens expanded and renders through the native `<markdown>`
  renderable — real headers, bold, lists, fenced code, and **tables** (OpenTUI draws
  box-ruled tables) — so a research subagent's report is actually readable.
  **`web_search` results** are now emitted as a markdown numbered list and render the
  same way, so each result's URL + snippet stay cleanly indented (even when wrapped)
  instead of the ragged raw text. (The main assistant reply already rendered
  markdown; tables now render there too.)
- **The `/command` "registered" cue now covers everything invocable.** It matches
  the authoritative name set from the engine snapshot (`commandNames` = built-ins +
  custom `.vibe/commands` + skills), not just the static built-in list — so a
  custom command or skill turns the input bar green too.
- **TUI interaction overhaul.** A recognized `/command` now turns the input bar
  green as a "registered" cue. Expanding a tool row keeps the clicked row in place
  (anchored scroll) instead of jumping to the middle. Clicking an assistant message
  folds its tool/output work away (just the prose remains), and **Ctrl+O** folds/
  unfolds every turn at once. Search rows truncate the query and show `N results`
  instead of a raw line count, and the system prompt now tells the model to search
  deliberately (no redundant reworded queries). Live status — subagents, tasks,
  changed files, git, and session info — is surfaced in the header, the Tasks/
  Subagents panels, and the footer (see *Changed* for the centered single-column
  layout).
- **Real context window & cost for any model.** Context window now resolves via a
  `config.contextWindow` override → a live Ollama `/api/show` probe (local + cloud)
  → the catalog → a 128k default, so local/cloud models report a real window. Cost
  is always shown: `$0.00` for free/local, and a `~$` estimate for models priced by
  a base-model catalog match (e.g. Ollama Cloud `glm-5.2`), with a per-model
  `config.pricing`/`contextWindow` pin taking precedence.
- **TUI palette & spacing.** A single brand hue (now `#ff3503`) paints all chrome
  (panel titles, spinner, user gutter, plan box, menu, input frame); the **mode word
  on the input border is the only region that recolors with the mode**
  (plan/execute/yolo) — switching mode no longer repaints the whole screen. A
  uniform `marginTop={1}` rhythm separates every region below the transcript, so the
  working line, status panels, input, and footer no longer hug their neighbors.
- **System prompt** strengthened on the dimensions that drive output quality on
  real codebases: convention-matching, scope discipline, verification rigor, and
  concise terminal-appropriate communication.
- Removed a stale `outputs` entry from the Turbo `build` task (no more spurious
  "no output files found" warnings).
- Aligned optional-`AbortSignal` handling across the codebase.

### Tests
- Test suite expanded from 251 to 301 (line coverage ~86% → ~91.5%), adding:
  engine end-to-end and scenario tests (edit, plan, auto-verify self-correction,
  subagent delegation); robustness tests for imperfect-model behavior (non-unique
  edits, parallel edits to one file, failing commands, malformed args); a
  full-stack integration suite driving the real CLI against an in-process
  OpenAI-compatible server (file edits, JSON output, error handling, resume);
  and unit coverage for bash, ls, glob, grep, webfetch, loadAgents, parseModelsDev,
  and frontmatter parsing.
