# Changelog

All notable changes to vibe-codr are documented here.

## Unreleased

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
  current mode, **Y** accepts and runs **unattended in yolo**. `#approvePlan`
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
