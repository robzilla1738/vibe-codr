# vibe-codr — project notes for agents

A model-agnostic CLI coding agent for the terminal (in the class of Claude Code
and Codex). TypeScript + Bun monorepo. This file is read as project memory by
vibe-codr itself, Codex (`AGENTS.md`), and Claude Code (`CLAUDE.md`).

## Stack & layout

- **Runtime:** Bun (workspaces + Turbo). **Models:** Vercel AI SDK v5.
- Hard **core/TUI boundary:** the engine emits a typed `UIEvent` stream and
  accepts `EngineCommand`s; no UI type leaks into core, so the engine is fully
  testable headless.

| Package | Owns |
|---|---|
| `@vibe/shared` | Contracts: `UIEvent`, `Message`/`Part`, `ToolDefinition`, `EngineSnapshot`, errors, logger |
| `@vibe/config` | Zod config schema, file discovery + deep-merge, auth resolution |
| `@vibe/providers` | `ProviderRegistry`, `resolveModel`, `CatalogService` (models.dev + `/v1/models`) |
| `@vibe/tools` | Built-in tools (`read`/`edit`/`bash`/`grep`/`git_*`/…) + the AI-SDK `tool()` adapter |
| `@vibe/core` | Agent loop (`Session.run`), `Engine`, slash commands, MCP, checkpoints, context-window tracking, and **long-term memory**: injected project/global notes (`memory.ts`), an agent write-path (`save_memory` → `memory-store.ts`), and **hybrid recall** — BM25 (`bm25.ts`) fused with optional semantic search (`embeddings.ts` + `vector-store.ts` over `bun:sqlite` + `semantic-memory.ts`) and past-session recall (`recall.ts`) via RRF (`memory-search.ts`), behind `MemoryService` |
| `@vibe/plugins` | `HookBus`, slash-command + skill runtimes, `PluginHost` |
| `@vibe/tui` | OpenTUI app + headless/REPL renderers, themes, tool icons, spinner |
| `@vibe/cli` | `bin/vibecodr` entrypoint (argv, config, headless `-p` vs TUI) |

## Commands

```bash
bun install
bun run typecheck     # tsc across all packages (turbo)
bun test              # bun test across packages
bun run lint          # biome lint
bun run format        # biome format --write
bun run build:binary  # standalone binary -> dist/vibecodr
bun packages/cli/bin/vibecodr.ts --help   # run from source

# Smoke-test the OpenTUI app's render + input + command-menu paths by driving the
# REAL App component with a mock engine via OpenTUI's deterministic test renderer
# (the only way to exercise app.tsx outside a terminal). Run after app.tsx edits.
bun run smoke:tui

# Regenerate the README screenshots (drives the real engine with a mock model
# + Playwright Chromium). Re-run after any TUI/output change.
bun packages/core/scripts/screenshot.ts docs/screenshots
```

## Conventions

- Keep the **core/TUI boundary** intact: core must not import from `@vibe/tui`;
  UIs communicate only through `UIEvent` / `EngineCommand`.
- Provider SDKs, OpenTUI, `@modelcontextprotocol/sdk`, and
  `@huggingface/transformers` (on-device embeddings for semantic memory) are
  **optional peer deps** — import them via non-literal specifiers and fail with a
  clear, actionable error rather than at startup. Semantic memory degrades to
  lexical BM25 recall when no embedder (local dep or configured cloud model) is
  available, so `bun add @huggingface/transformers` is opt-in.
- **Provider spec invariant:** the repo is pinned to **AI SDK v5** (provider spec
  `"v2"`). Only providers with a v2-compatible dedicated SDK use it directly
  (anthropic `^2`, openai `^2`, deepseek `^1`, codex via openai); **every other
  provider routes through `@ai-sdk/openai-compatible` (`^1`, spec v2)** —
  minimax, ollama, lmstudio, baseten, xai, openrouter, fireworks, google, groq,
  mistral, together, cerebras, perplexity, custom. Their dedicated packages have
  moved to AI SDK v6/v7 (spec v3/v4) and `ai@5` rejects those with "unsupported
  model version". Don't wire a provider to a dedicated SDK unless you confirm it
  resolves `@ai-sdk/provider@^2`; otherwise use openai-compatible with its base
  URL. `registry.test.ts` asserts the rerouted providers stay spec-`v2`.
- **Adding a provider = one `BuiltinSpec`** in `packages/providers/src/defs.ts`
  (`id`, `env`, `baseURL`, optional `baseURLEnv`/`keyless`/`tokenFile`,
  `module:"@ai-sdk/openai-compatible"`, `factory:"createOpenAICompatible"`). No new
  SDK package, no `PROVIDER_MODULES` change. Then add a `ProviderChoice` to
  `packages/cli/src/providers-catalog.ts` (onboarding). **Match the `id` to its
  models.dev slug** so `CatalogService.enrich` lands metadata; where they differ,
  add the exception to `PROVIDER_SLUG_ALIASES` in `catalog.ts` (e.g. `together →
  togetherai`, `fireworks → fireworks-ai`, `codex → openai`). The generic `custom`
  provider has no default base URL — it requires `config.providers.custom.baseURL`
  (or `$CUSTOM_BASE_URL`) and errors clearly otherwise.
- **Model freshness is automatic:** metadata is a live `models.dev/api.json` fetch
  with a 24h disk cache (no vendored snapshot to go stale); availability is each
  provider's live `/v1/models`. `/models refresh` force-pulls past the cache.
- **"Via auth" = token reuse, no OAuth in-repo.** `resolveAuth`→`#resolveKey`
  resolves env → config `apiKey` → token file (`tokenFile`/`tokenPath`, default
  e.g. codex's `~/.codex/auth.json`) → keyless, **re-read every turn** so a token
  another CLI refreshes is picked up. `codex` reuses `OPENAI_API_KEY` or
  `tokens.access_token` from `~/.codex/auth.json` (`auth-file.ts` `COMMON_KEYS`);
  the ChatGPT-subscription backend is configurable (`CODEX_BASE_URL` + provider
  `headers`), not hard-wired. Any provider can reuse another CLI's creds via
  `config.providers.<id>.tokenFile`/`tokenPath`. There is **no OAuth/refresh
  flow** — don't add one without an explicit ask.
- **The models.dev cache honors `$XDG_CACHE_HOME`** (default `~/.cache`), read at
  `CatalogService` construction — same rationale as the config's
  `$XDG_CONFIG_HOME` (Bun's `os.homedir()` caches at startup; XDG is read live, so
  `test-preload.ts` isolates both off the developer's real files).
- Tools declare `readOnly` and `concurrencySafe`. Only read-only tools are exposed
  in plan mode; non-read-only tools pass through the permission gate. The AI SDK
  runs a step's tool calls in parallel, so `Toolset.aiTools` serializes every
  non-`concurrencySafe` (mutating) tool behind a shared FIFO lock — never bypass
  it, or parallel edits/writes to one file will race. That lock is **per session**,
  so cross-_subagent_ same-file safety comes from a separate **tree-wide per-file
  write lock** (`createFileLock`, threaded through `SessionDeps.fileLock` →
  `ToolContext.lockFile`): `edit`/`write` wrap their read-modify-write in
  `withFileLock(ctx, absPath, …)` so two parallel subagents editing the same path
  serialize while disjoint paths stay parallel. Lock keys are **canonicalized**
  (`realpathSync.native` — resolves symlinks and on-disk casing) so different
  spellings of one file (`src/App.ts` vs `SRC/app.ts` on case-insensitive APFS)
  still share a lock; idle locks are pruned race-free. Don't add a file-mutating
  built-in without taking that lock.
- **Every context-producing tool caps its output.** A tool's output lands in the
  prompt verbatim, so none may return an unbounded blob — `grep` caps at 500
  matches, `glob` at 1000, `git_*` at 20k chars, `verify` at 8k, `webfetch` at
  `maxChars`, `read` at 100k chars, and `edit` caps the diff it echoes back at
  20k chars (`write` keeps its diff out of the output entirely — both still emit
  the full diff on the `file-changed` event for the UI) (all with an explicit
  `…(truncated …)` marker). **`spawn_subagent` is no exception:** a child's final
  answer lands verbatim in the *parent's* prompt (and a parent can fan out
  `maxParallel` of them in one step), so it's capped at 32k chars
  (`MAX_SUBAGENT_OUTPUT`) before the model sees it while the full text still rides
  the `subagent-finished` event for the UI — same head-cap pattern as `edit`.
  `read` additionally sniffs the leading bytes for a NUL and refuses a
  binary file rather than dump mojibake. Any new tool that surfaces file/command
  content must cap likewise — an uncapped read defeats the engine's context
  accounting and can 400 the next turn on an over-long prompt.
- **Multi-agent coding.** Delegation is the model's own job (vibe-codr has no
  separate orchestrator process), so the execute-mode system prompt carries a
  delegation doctrine (when/how to fan out, self-contained child prompts,
  disjoint-file ownership, consolidate+verify) — injected by `composeSystemPrompt`
  only when `subagentsAvailable` (`depth < subagent.maxDepth`, either mode), the
  same gate that registers `spawn_subagent`. **Plan mode can fan out too** — the
  parent is read-only, so every subagent it spawns is **coerced to plan**
  (`childMode = this.mode === "plan" ? "plan" : …`), giving parallel read-only
  exploration while planning without ever risking a write; plan mode gets a
  read-only doctrine variant and the roster is filtered to read-only agents.
  That filter is enforced at the call site too: a **plan-mode parent rejects an
  execute-only named agent** (`named.mode !== "plan"`) rather than coerce it —
  coercing a writer to read-only would hand the child a write-oriented brief
  with no write tools and burn a turn; the error points at the read-only agents
  it can use (an explicit `mode:"execute"` *without* a named agent is still
  safely coerced). `spawn_subagent` is `readOnly: true` so the orchestration itself never prompts
  for permission — the child's own tools gate their side effects individually
  (auto-verify still counts a spawn turn as mutating via a special-case). Three
  coding agents ship by default (`agents.ts` `defaultAgents()`: `explore`/`review`
  are plan-mode/read-only, `test` is execute); `loadAgents` layers
  `.vibe/agents/*.md` over them so a user file overrides a default by name. The
  roster is injected into the prompt for capability routing. Per-fan-out
  concurrency is bounded by a **per-session** semaphore (`#childGate` =
  `createSemaphore(subagent.maxParallel)`) — per-session on purpose: a tree-global
  cap deadlocks a parent awaiting its own children.
- **Web context-gathering is adaptive, by prompt.** The "Gather web context in
  proportion to the question" block in `system-prompt.ts` (part of `BASE`)
  calibrates depth: quick facts answered from `web_search` snippets (one query, no
  `webfetch`), broad/technical questions cross-check 1–3 authoritative sources.
  Version/currency questions route to **`package_info`** (npm/PyPI authoritative
  latest, no key, read-only — `package-info.ts`) and official docs over blogs.
  No engine throttle: `web_search` keeps every result the provider returns by
  default (`maxResults` only TRIMS to the top N — it is a client-side cap, NOT a
  count forwarded to the API, so it can't fetch *more* than the provider's page;
  broader coverage comes from more queries), and `webfetch` takes `maxChars`
  (default 25k, truncation reports the dropped count). Keep it that way — the
  design intent is "fast when simple, exhaustive when needed, model decides." The
  only thing the prompt biases is snippet-first reading (cheaper), never a cap.
- MCP tool names exposed to the model go through `mcpToolName()` (sanitize to
  `[A-Za-z0-9_-]`, cap 64 with a hash suffix); the real MCP name is used only for
  `callTool`. Hosted providers 400 on dotted/over-long function names.
- **Subsystem invariants (don't regress these — each has a test):**
  - `Session.fork()` (subagents) must NOT inherit the parent's `initial*`
    seed/`store`/`extraSystem`/`createdAt` — a resumed parent would otherwise
    leak its whole history + double-count cost into children, and children would
    self-persist and pollute `/resume`/`--continue`.
  - Project memory (`memory.ts`) walks `cwd`→git-root (only with a `.git`
    ancestor), `cwd` highest precedence, each file byte-capped (`MAX_MEMORY_BYTES`).
  - `SessionStore` writes are atomic (temp + `rename`) and reads tolerate a
    corrupt `meta.json` / truncated jsonl line (skip, never throw).
  - `/loop` iterations run **through the engine queue** (`#enqueue`) so they
    serialize with user turns; `LoopController.stop()` aborts the in-flight turn
    via `onStop`.
  - Compaction prepends the summary as a leading **user** turn (folding into an
    existing leading user message) to keep strict alternation, and never cuts the
    kept window across a tool boundary: tool results are their own `role: "tool"`
    messages, so the slice point walks back past any leading `tool` message (and
    bails to null if that leaves nothing older) — otherwise `recent` would start
    with a `tool_result` whose `tool_use` was summarized away, a hard 400. After a
    compaction actually replaces the message set it **resets `#lastInputTokens`**
    (the provider's real prompt size measured the pre-compaction context) and emits
    a fresh `context-updated`, so `contextTokens`/`/context`/the live `ctx %` reflect
    the freed space immediately instead of staying pinned at the old high value.
  - Headless `runOneShot` returns `false` on engine error so the CLI exits
    non-zero; interactivity is gated on `values.prompt === undefined` (so `-p ""`
    reads stdin, not onboarding).
  - `/undo` restores via a throwaway `GIT_INDEX_FILE` (never the user's real
    index), removes only files absent from the snapshot tree (keeps the user's
    pre-existing untracked files), and rewinds the conversation to the
    checkpoint's `conversation` mark.
  - The plugin `HookBus` isolates each handler (one throw doesn't break the turn)
    and the lifecycle hooks are actually wired: `session.start/idle/end` (engine),
    `tool.before.execute` (with a working `deny` gate) / `tool.after.execute` /
    `assistant.message` (session). Safety builtins (`RESERVED_SLASH`) can't be
    shadowed by `.vibe/commands/*.md`, and `Toolset.register` refuses to let an
    extension tool shadow a built-in.
  - **Cost/context are real for any model.** `Engine.#resolveContextWindow` tries
    `config.contextWindow[model]` → an Ollama `/api/show` probe (local + cloud) →
    the models.dev catalog → the 128k default. `#resolvePricing` tries a full
    `config.pricing` pin → `CatalogService.pricing`, which falls back to a
    **base-model match** (`ollama/glm-5.2` inherits a `glm-5.2` price) flagged
    `estimated`. The flag rides `SessionUsage.costEstimated` so `formatUsage` shows
    `~$` for estimates, `$0.00` for genuinely free/local — cost is never hidden.
- Every behavior change ships with a test. Prefer mock-model integration tests
  (`ai/test`'s `MockLanguageModelV2`) over hitting the network.
- `packages/tui/src/app.tsx` is excluded from `tsc` (OpenTUI is an optional
  native dep) and can't run in CI. Verify it two ways: `bun run smoke:tui` drives
  the real `App` with a mock engine through OpenTUI's test renderer (asserts
  input/submit, streamed output, tool icons, the working spinner, the command
  menu, and the permission card actually work), and `screenshot.ts` mirrors its
  render logic for the README shots. Keep all three in lockstep: any visible
  app.tsx change gets the matching change in the screenshot reducer and, where
  behavioral, a smoke assertion — and never use an OpenTUI prop you can't confirm
  exists (the input once silently dropped every keystroke because it lacked
  `focused`, and streamed replies never repainted because `<For>` is
  reference-keyed; both are now covered by the smoke test). OpenTUI box/text
  facts confirmed in the installed 0.4.x: `border` takes `BorderSides[]` and
  `borderStyle:"heavy"` draws `┃`; `<text>` takes `fg`/`bg`/`attributes`
  (`TextAttributes.BOLD`); there is no `<spinner>` intrinsic (we animate a
  signal-driven braille frame instead). Assistant/plan prose renders through the
  native `<markdown content streaming syntaxStyle>` renderable (build the style
  once with `SyntaxStyle.create()`) — **never** pre-style markdown into an ANSI
  string and hand it to `<text>`: the buffer counts the escape bytes as glyph
  width and garbles wrapped/streamed replies (that was the corruption bug). The
  renderable conceals inline markers (`**bold**`, `` `code` ``) via a tree-sitter
  *inline* parser whose worker statically imports **`web-tree-sitter`** — a peer
  dep of `@opentui/core`. It's wired as an optional peer of `@vibe/tui` and
  provided through the root dev env; without it the worker throws `Cannot find
  package 'web-tree-sitter'`, conceal never runs, and every reply shows literal
  `**`/backticks. The smoke test pushes `**42**` and asserts `!frame.includes("**")`
  so a missing peer can't regress silently.
  `<code>`/`<diff>` intrinsics also exist; all renderables accept `onMouseDown`
  (used for click-to-expand of tool output), and `useTerminalDimensions()` drives
  the responsive `contentWidth()` (the centered column reflows on resize). A mouse
  click blurs the focused input, so any click
  handler must restore it via a **deferred** `inputEl.focus()` (queueMicrotask —
  a synchronous call runs before the renderer's own post-click focus pass and is
  immediately undone); the smoke test clicks a tool row then opens the menu to
  guard this.
- Pure UI logic lives in small, unit-tested modules so app.tsx stays thin:
  `tool-icons.ts` (per-tool glyph + action summary), `spinner.ts` (braille
  frames), `themes.ts` (palettes incl. `opencode`), `modes.ts`,
  `commands-catalog.ts`. `screenshot.ts` can't import `@vibe/tui`, so it carries
  a **local copy of the tool-icon/summary logic** — keep it identical to
  `tool-icons.ts` (it has a comment pointing here).
- **Layout invariant (centered single column; don't regress scrolling):** the
  ROOT is a flex *row* on a **black background** (`backgroundColor={palette().
  background}`): a `flexGrow` **left gutter**, the **chat column**
  (`flexDirection="column"`, `width={contentWidth()}`, `flexShrink={0}`,
  `padding={1}`), and a `flexGrow` **right gutter**. The two gutters center the
  column ChatGPT-style; `contentWidth()` = `min(CONTENT_MAX, dims().width - 2)`.
  **There is NO top header and no sidebar/rail.** Inside the column, top to bottom:
  the **body** (`flexGrow={1}`) — when `showJobs()` it's the **`/jobs` sub-view**
  (background shell jobs + detected localhost servers, a scrollbox replacing the
  transcript; Esc or `/jobs` closes it). Otherwise a `<Show>` renders the scrolling
  transcript when there are blocks, else a **centered Vibe Codr wordmark splash**.
  The wordmark is a compact ░██ block face (`packages/tui/src/wordmark.ts`, 80×7)
  rendered as a **clean left→right rainbow gradient** (`RainbowLine`): each row is a
  flex *row* of one `<text fg>` per character, colored by COLUMN position
  (`rainbowSpans`, `rainbow.ts`), so column `i` shares a hue across every row and
  the block reads as one smooth sweep. **Gotcha: per-character color must use a row
  of `<text fg>` (the SegRow mechanism); inline `<span fg>` children DO NOT paint in
  this renderer** (they render the default fg — this is what made the wordmark show
  up white). The smoke test asserts the gradient via `captureSpans()` (counts
  distinct fg colors — `captureCharFrame` is color-blind). Shown when the column has
  room (`showWordmark()`); otherwise it falls back to `<ascii_font text="VIBE CODR"
  font="slick" color={rainbowAt(0.5)}>` (single rainbow-mid hue — the array/gradient
  `color` form is unverified, so a fallback uses one color), then `◆ Vibe Codr`. Below it is a single **centered** prompt-starter line
  (`SegRow center`) — `Try › …` example asks — and nothing else (no tagline, no
  key cheatsheet; the keys live in the under-input status). `SegRow` is a row of
  coloured `<text>` runs (OpenTUI has no inline-markup `<text>`), two-tone: muted
  scaffolding, brighter foreground on the example prompts. The under-input status
  is two **centered** lines:
  `detailsCenter()` (location · git · model · changed · ctx · cost · goal) and the
  `SegRow` key hints — then the stacked status surfaces, the input, and the
  under-input status block. **The slash-command menu is an absolute overlay** —
  the chat column is `position:"relative"` and the menu is `position:"absolute"`
  anchored `bottom={MENU_BOTTOM}` (clears the input + status rows) so opening it
  *overlays* the area above the input instead of taking flow space; that keeps the
  body from shrinking, so the wordmark/transcript never jump up when you type `/`. The transcript is `<scrollbox flexGrow={1}
  flexShrink={1} stickyScroll stickyStart="bottom">`. Every surface *below* the
  transcript (working spinner, plan box, **Tasks** panel, **Subagents** panel,
  permission card, command menu, input, the two status lines) must set
  `flexShrink={0}`, or the scrollbox steals their space and they collapse to one
  overlapping row. Long conversations must scroll inside the box, never overflow
  onto the input. The transcript is a list of `Block`s rendered with `<Index>`
  (stable per position, append-only); tool output is condensed to one clickable
  row and expands in place. Consecutive **tool** rows stack flush (chained — the
  follower drops its top margin when the prior visible block is also a tool), so a
  search→fetch→fetch sequence reads as one group instead of separated fragments;
  the gap is kept only at a boundary with prose, a notice, or a folded turn. A **`spawn_subagent` block is flagged `isMarkdown`** —
  it opens expanded and renders its reply through `<markdown>` (headers, bold,
  lists, code, and **tables**, which OpenTUI renders natively) instead of raw text
  lines; `ToolBlockView` takes the `SyntaxStyle` for this. Expand/collapse goes
  through `anchoredToggle`: when the
  turn is **idle** it disengages the scrollbox's `stickyScroll` and freezes
  `scrollTop` so the clicked row stays put; while **streaming** it leaves sticky
  alone. Auto-follow re-engages next turn (`runText` sets `stickyScroll=true`).
  **Turn folding is anchored on the USER message:** a turn is keyed by its user
  message id; every following block (until the next user message) belongs to it
  (`grouping` memo → `turnKey`/`counts`). **Tapping your message** folds the whole
  exchange under it (`toggleTurn` → `collapsedTurns`; `isHidden` hides every
  non-user block of that turn) down to a `▸ N items hidden · tap to expand`
  affordance; tap again to reopen; **Ctrl+O** (`toggleAllTurns`) folds/unfolds
  every turn. Assistant/tool/notice blocks are NOT click targets — folding is
  driven from the user message only; do NOT reintroduce an emission-time `turn`
  field on blocks.
  **The input is a clean closed box** (`border` all sides, default light style) with a
  **white frame** (`borderColor={brand()}`, and `brand()` is now neutral white — see
  Color discipline). Its top border carries the **mode word** as the title via
  `modeWord()` (` ASK `/` PLAN `/` YOLO ` — no glyph; **execute reads "ASK"** because
  every action is gated by an approval prompt, vs YOLO = no prompts), and the title is
  the **mode CHIP** — the one mode-colored thing — via `accent()` = `modeColor(uiMode())`
  (ASK blue · PLAN green · YOLO red, fixed constants in `modes.ts`). There is **no `❯`
  prompt glyph inside** the input; the placeholder is "Send a message or type / to
  start". The input has **no background fill at all** — just the bordered frame and
  the text on the black backdrop: the box sets no `backgroundColor` and the
  `<input>`'s `backgroundColor`/`focusedBackgroundColor` are **`"transparent"`** (an
  OpenTUI Textarea otherwise paints its whole row, which bled a grey surface past
  the frame; don't reintroduce an `elevated` fill here). **All status
  details live UNDER the input**, not in a
  header: line 1 is `detailsLeft()` / `detailsRight()` = `cwd · git  /  model ·
  changed · ctx · usage · cost`; line 2 is the key hints (left) and the goal `★ …`
  (right). Git state comes from `Engine.#gitInfo()` (the `#git` runner) via the
  `git-updated` event + the snapshot `git` field; `changedSummary()` condenses the
  session's edits (`✎ N files +a -b` — the detail is the inline diff rows). Do NOT
  add a tool-call "Activity" feed — it duplicated the transcript and was removed.
  **Subagents** render ONE truncated line each by default (a big fan-out used to
  dump every full multi-line prompt and flood the screen); tap a row
  (`toggleSub`/`expandedSubs`) to expand its full prompt + result, bounded by
  `truncate(…, 700)` so an expanded row can't run off-screen. User message blocks
  reuse the input's heavy `brand` left-gutter frame (`elevated` bg, `❯` caret) so a
  sent message reads as a quoted echo of where you type.
- **Spacing (uniform rhythm):** the chat column carries `padding={1}` (a one-cell
  inset on every side) and is centered by the two `flexGrow` gutters. Every region
  stacked below the transcript (working spinner, plan, Tasks panel, Subagents
  panel, permission card, menu, input, the details status line) carries
  `marginTop={1}` — one blank row between every area; the second status line (hints
  / goal) hugs the details line with no margin so the two read as one block. Keep
  that rhythm; don't special-case a region to 2.
- **Color discipline (black bg + neutral chrome + four deliberate color zones):**
  the app paints a **black background** (`backgroundColor={palette().background}`,
  `#000` on the default theme), neutral **charcoal** surfaces (`panel`/`elevated`/
  `selBg`/`border`), and **monochrome white/grey** text. The chrome accent `brand()`
  = `accentColor() || palette().primary` is now a **soft neutral white** by default
  (`#e6e6e6`; orange `#ff3503` retired) and paints quiet chrome — panel titles, the
  `❯` user marker, the cursor, the input frame. Override it to a single hue with
  `/accent <hex>`. **Color is reserved for exactly four zones** (`rainbow.ts` +
  `modes.ts`):
  1. **Wordmark** — static per-column rainbow gradient (`RainbowLine`).
  2. **Mode chip** — the input's top-border title, `modeColor(uiMode())` = ASK blue
     `#7aa2f7` · PLAN green `#9ece6a` · YOLO red `#f7768e` (fixed constants).
  3. **Working spinner** — the braille glyph cycles `rainbowAt(tick % CYCLE)`,
     animated only while a turn runs (rides the existing `working()`-gated tick; no
     new idle timer). The elapsed/interrupt label stays muted.
  4. **Per-agent / per-step** — each Subagents-rail row and each tool-step marker
     (`▎`) gets a stable `rotateHue(index)`; the row/header TEXT stays neutral.
  Everything else stays neutral: transcript prose `assistant`, tool headers `muted`,
  with `add`/`del` on diffs and `notice` (amber) on warnings the only functional
  colors. **Rainbow/mode color is for ACCENTS only — never body text or tool
  output.** This IS the intended look (an earlier note said "don't reintroduce the
  rainbow we removed" — obsolete; the curated rainbow is now the design). A `title`
  needs a top edge, so the input uses a full `border` (all sides).
- **Interactive submenus (the `/` menu):** one normalized `menuModel` memo in
  `app.tsx` drives three shapes — `command` (the flat list), `value` (enum submenus
  like `/theme`/`/approvals`/`/reasoning`, current value marked `●`), and `models`
  (the live picker). `/model ` / `/models` / `/model sub ` open the picker:
  `EngineClient.listModels()` (fetched once, cached) → filter by the trailing text →
  click/Enter dispatches the typed `set-model` / `set-subagent-model` (no text
  round-trip). Rows are mouse-clickable (`chooseAt(idx)`) with hover highlight. To
  add a command submenu, extend `menuModel` — don't dump output into the transcript
  via `#notice`.
- **Persisted settings + test isolation (FOOTGUN — already bit once):**
  `/model`, `/model sub`, `/model key`, `/accent`, `/theme`, `/reasoning` persist via
  `#persistConfig` → `writeGlobalConfig` → `globalConfigPath()`. That path honors
  **`$XDG_CONFIG_HOME`** (read live), NOT `HOME` — because **Bun's `os.homedir()`
  caches at startup and ignores a runtime `process.env.HOME`**. Any test that runs a
  persisting command MUST isolate via `XDG_CONFIG_HOME` (the `test-preload.ts` Bun
  `preload` does this suite-wide; per-test helpers set it too). Setting `HOME` does
  nothing and silently clobbers the developer's real `~/.config/vibe-codr/config.json`.
- Match the surrounding code's style; comments explain *why*, not *what*.

## Before you finish

Run `bun run typecheck && bun test && bun run lint` — all must pass.
