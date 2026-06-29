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
| `@vibe/core` | Agent loop (`Session.run`), `Engine`, slash commands, MCP, checkpoints, project/global memory + cross-session **recall** (`recall.ts`), context-window tracking |
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
- Provider SDKs, OpenTUI, and `@modelcontextprotocol/sdk` are **optional peer
  deps** — import them via non-literal specifiers and fail with a clear,
  actionable error rather than at startup.
- **Provider spec invariant:** the repo is pinned to **AI SDK v5** (provider spec
  `"v2"`). Only providers with a v2-compatible dedicated SDK use it directly
  (anthropic `^2`, openai `^2`, deepseek `^1`, codex via openai); **every other
  provider routes through `@ai-sdk/openai-compatible` (`^1`, spec v2)** —
  minimax, ollama, lmstudio, baseten, xai, openrouter, fireworks. Their dedicated
  packages have moved to AI SDK v6/v7 (spec v3/v4) and `ai@5` rejects those with
  "unsupported model version". Don't wire a provider to a dedicated SDK unless you
  confirm it resolves `@ai-sdk/provider@^2`; otherwise use openai-compatible with
  its base URL. `registry.test.ts` asserts the rerouted providers stay spec-`v2`.
- Tools declare `readOnly` and `concurrencySafe`. Only read-only tools are exposed
  in plan mode; non-read-only tools pass through the permission gate. The AI SDK
  runs a step's tool calls in parallel, so `Toolset.aiTools` serializes every
  non-`concurrencySafe` (mutating) tool behind a shared FIFO lock — never bypass
  it, or parallel edits/writes to one file will race.
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
    existing leading user message) to keep strict alternation.
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
  width and garbles wrapped/streamed replies (that was the corruption bug).
  `<code>`/`<diff>` intrinsics also exist; all renderables accept `onMouseDown`
  (used for click-to-expand of tool output), and `useTerminalDimensions()` drives
  the responsive rail. A mouse click blurs the focused input, so any click
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
- **Layout invariant (don't regress scrolling):** the body is a flex *row* — a
  `<scrollbox flexGrow={1} flexShrink={1} stickyScroll stickyStart="bottom">`
  transcript beside a fixed-width **context rail** (`flexShrink={0}`, shown only
  when `dims().width >= RAIL_MIN_COLS`; below that, tasks fall back to a bottom
  panel). Every panel *below* the body (working spinner, plan, tasks fallback,
  permission card, menu, input, footer) must set `flexShrink={0}`, or the
  scrollbox steals their space and they collapse to one overlapping row (the
  permission card did exactly this before the fix). Long conversations must
  scroll inside the box, never overflow onto the input. The transcript is a list
  of `Block`s rendered with `<Index>` (stable per position, append-only); tool
  output is condensed to one clickable row and expands in place. Expand/collapse
  goes through `anchoredToggle`: when the turn is **idle** it disengages the
  scrollbox's `stickyScroll` (so growing content doesn't snap to the bottom) and
  freezes `scrollTop`, so the clicked row stays put and content reveals *below* it;
  while a turn is **streaming** it leaves sticky alone so new output keeps
  following. Auto-follow re-engages next turn (`runText` sets `stickyScroll=true`).
  Don't toggle a block outside `anchoredToggle` or it jumps.
  **Turn folding:** an assistant message owns the tool/notice blocks that follow
  it, computed by POSITION (nearest preceding assistant) via the `grouping` memo —
  robust to a tool emitted before the assistant's first text; do NOT reintroduce
  an emission-time `turn` field on blocks. Clicking a message folds its work
  (`collapsedTurns` + `isHidden`, "N steps hidden" affordance); **Ctrl+O**
  (`toggleAllTurns`) folds/unfolds every turn — leaving just prose.
  The rail itself is an `elevated`-bg (charcoal) panel with its OWN `<scrollbox>`
  of stacked, adaptive sections: **Tasks** (the to-do list, hides once all done) →
  **Subagents** (prompt + running/done + one-line `result`) → **Changed** (session
  edits) → **Git** (branch · dirty · ↑ahead ↓behind · worktree marker) →
  **Session** (model · ctx% · usage · goal, last). Each hides when empty so the
  rail only shows what's relevant — do NOT add a tool-call "Activity" feed back; it
  duplicated the transcript and was deliberately removed. Git state comes from
  `Engine.#gitInfo()` (the `#git` runner) via the `git-updated` event + the
  snapshot `git` field, recomputed at bootstrap and turn end. Item text uses
  `wrapMode="word"` (filenames `truncateLeft`) so nothing is silently cut.
  Modeled on opencode's `routes/session/sidebar.tsx` + `feature-plugins/sidebar/*`. User
  message blocks reuse the input bar's EXACT frame (heavy `brand` gutter,
  `elevated` bg, `❯` caret, matching padding) so a sent message and the input
  read as one element. The footer is a flex row: key-binding hints on the left,
  `metricsLine()` (context-window %, token usage, cost — `metrics()` signal) on
  the right, shown only when there's data; goal lives in the rail / narrow header.
- **Spacing (uniform rhythm):** the body row sets `gap={2}` so the transcript
  never butts against the rail surface. Every region stacked below the body
  (working spinner, plan, tasks fallback, permission card, menu, input, footer)
  carries `marginTop={1}` — one blank row between every area, top to bottom. Keep
  that single-row rhythm; don't special-case a region to 0 or 2.
- **Color discipline (charcoal + monochrome + one accent):** the `DEFAULT` theme
  is neutral **charcoal** surfaces (`panel`/`elevated`/`selBg`/`border`) and
  **monochrome** text (`assistant` near-white, `muted` grey). One **configurable
  accent** — `brand()` = `accentColor() || palette().primary` (lavender `#bb9af7`
  by default, set live with `/accent <hex>` or the `accentColor` config) — paints
  ALL chrome: brand mark, user gutter, `❯` carets, spinner, rail headers/active
  items, plan box, menu selection. **Mode color (`accent()` = `modeColor`) is
  scoped to exactly two spots:** the input's left **border line** and the header
  **mode pill** (text+icon) — plan `tool`/cyan, execute `primary`/lavender, yolo
  `del`/salmon. The input caret/cursor stay the accent (NOT the mode). The input
  border line also flips to the green `subagent` hue while the draft exactly
  matches an invocable `/name` (`isExactCommand` against `snapshot().commandNames`
  — built-ins + custom commands + skills) as a "command registered" cue. (Skills
  run as `/skillname`, dispatched in the engine's `#handleSlash` default case.)
  Transcript prose is `assistant`, tool rows `muted`. The only other colors are
  functional: `add`/`del` on expanded diff lines and `notice` (amber) on
  warnings/permissions.
  Don't reintroduce per-kind hues (blue user, cyan tools, green dots) — that's the
  rainbow we removed; don't widen mode color beyond the input line + pill (use
  `brand()` for chrome). `border={["left"]}` boxes can't host a `title` (no top
  edge), so don't put one there.
- Match the surrounding code's style; comments explain *why*, not *what*.

## Before you finish

Run `bun run typecheck && bun test && bun run lint` — all must pass.
