# Changelog

All notable changes to vibe-codr are documented here.

## Unreleased

### Added
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
- **Keyless web search + code intelligence.** `web_search` now works with **no
  API key** (DuckDuckGo), with TinyFish as an optional booster. A new `repo_map`
  tool returns a ranked file→symbol map so the model can orient on a codebase in
  one call. `@`-mentions resolve directories and honor byte-accurate caps.
- **MCP parity.** Added the **Streamable HTTP** transport (config `transport:
  http|sse`), MCP **resources** (`read_mcp_resource`), and **prompts**
  (`get_mcp_prompt`), on top of parallel timeout-bounded connects, live
  connection status, and `readOnlyHint`-aware permission gating.
- **Declarative hooks + extensibility.** A config `hooks` block runs shell
  commands / HTTP endpoints on lifecycle events (deny a tool, rewrite its input,
  or notify). Skills and commands now also load from `~/.config/vibe-codr/
  {skills,commands}` (project overrides global), and named agents can declare a
  tool allowlist/denylist. Plans are persisted to `.vibe/plans/`, and switching
  plan→execute injects an explicit approval directive.

### Fixed
- **Correctness hardening (24 verified bugs).** Token-accurate + image-aware
  compaction (long sessions no longer 400 on `context_length_exceeded`); Esc /
  steer is reported as a cancel, not a red error; cache-read tokens are billed at
  the cache rate; `webfetch` is SSRF-guarded with a timeout + streaming size cap;
  a denied/failed tool call renders as an error, not a success; MCP servers
  connect in parallel and report live status; the dead `step.finish` hook now
  fires; and more.

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
