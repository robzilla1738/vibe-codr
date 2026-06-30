# Changelog

All notable changes to vibe-codr are documented here.

## Unreleased

### Fixed
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
