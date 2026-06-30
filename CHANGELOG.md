# Changelog

All notable changes to vibe-codr are documented here.

## Unreleased

### Fixed
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
- **Context rail "Git" section** — branch, dirty count, ahead/behind, and a
  worktree marker, from a new `Engine.#gitInfo()` + `git-updated` event (refreshed
  at startup and after each turn). The rail is now adaptive: **Tasks → Subagents →
  Changed → Git → Session**, each shown only when relevant. The redundant tool-call
  "Activity" feed (a duplicate of the transcript) was removed.
- **Configurable accent color** — `/accent <hex>` (live) and an `accentColor`
  config field set the single UI accent (lavender `#bb9af7` by default).
- **Skills are now invocable as `/skillname [task]`** (the user-initiated analogue
  of the model's `use_skill`): the engine loads the skill body and runs it like a
  prompt. Built-ins and custom commands still take precedence.

### Changed
- **Black canvas + full-height grey sidebar.** The TUI sits on a pure-black
  backdrop (new `background` palette field) with a **full-height grey sidebar**
  (`elevated`) pinned to the right edge, top-to-bottom. The brand mark, mode pill,
  and cwd moved out of the old black header bar into the sidebar's **identity
  block** (so there's no header strip on wide terminals; it falls back to a top bar
  only on narrow terminals where the sidebar is hidden). The layout root became a
  flex *row* — transcript and input affordances live in a left column, so the
  **input bar shrinks** to that column's width instead of spanning under the
  sidebar. Sidebar sections (Tasks/Subagents/Changed/Git/Session) are plain text on
  the one grey surface.
- **Charcoal + monochrome theme.** The default theme now uses neutral charcoal
  surfaces and monochrome white/grey text with a single purple accent (the old
  blue-tinted palette is gone). Mode (plan/execute/yolo) color is now scoped to
  exactly the input border line and the header mode pill (text+icon) — the caret,
  cursor, and the rest of the chrome stay on the fixed accent.

### Improved
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
  deliberately (no redundant reworded queries). The context rail is rebuilt as a
  clean live summary of subagents, tasks, changed files, and session info instead
  of a mostly-empty box (see the rail's final adaptive section list under *Added*).
- **Real context window & cost for any model.** Context window now resolves via a
  `config.contextWindow` override → a live Ollama `/api/show` probe (local + cloud)
  → the catalog → a 128k default, so local/cloud models report a real window. Cost
  is always shown: `$0.00` for free/local, and a `~$` estimate for models priced by
  a base-model catalog match (e.g. Ollama Cloud `glm-5.2`), with a per-model
  `config.pricing`/`contextWindow` pin taking precedence.
- **TUI palette & spacing.** The light lavender `#bb9af7` is now the single fixed
  brand hue across all chrome (header, rail, spinner, user gutter, plan box,
  menu); the **text-input area is the only region that recolors with the mode**
  (plan/execute/yolo) — switching mode no longer repaints the whole screen. Added
  a `gap={2}` gutter between the transcript and the context rail (message blocks
  no longer touch the rail) and a uniform `marginTop={1}` rhythm below the body,
  so the working line and footer no longer hug their neighbors.
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
