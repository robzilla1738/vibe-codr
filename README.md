# vibe-codr

A cutting-edge, **model-agnostic** CLI coding agent for the terminal — in the
class of Claude Code / Codex / opencode, but able to drive coding and agentic
tasks on *any* model: local models via **Ollama** and **LM Studio**, aggregators
(**OpenRouter, Fireworks, Baseten**), and first-party providers (**OpenAI,
Anthropic, DeepSeek, xAI/Grok, MiniMax**).

> Status: **feature-complete.** Multi-provider agent loop, live model catalog,
> **plan / execute / yolo** modes (Shift+Tab to cycle) with a permission layer, a
> live **task list**, an observable **prompt queue**, subagents, an interactive
> **slash-command menu**, skills / plugins, `/goal` + `/loop`, MCP client, web
> search, checkpoints/undo, self-verify, cost tracking, and session persistence
> with context-aware compaction. A full slash-command surface (`/status` `/cost`
> `/config` `/diff` `/review` `/doctor` `/export` …) makes every setting and bit
> of session state reachable. All covered by 222 tests (including mock-model
> integration tests of the agent loop with zero network) plus a TUI render
> smoke test.
>
> The terminal command is **`vibecodr`** (`vibe` works as an alias).

## Screenshots

An opencode-inspired terminal UI on vibe-codr's own engine, with a deliberately
restrained palette: **one accent at a time** (the current mode's color — purple
for execute, cyan for plan, red for yolo) carries all the chrome (brand, mode
pill, user gutter, spinner, input bar, menu selection, rail headers), everything
else is neutral text/muted, and the only other colors are functional — green/red
on diffs, amber on warnings. The layout is two columns: a scrolling **transcript**
beside a **context rail** that tracks the plan's task list, live subagents, and
session info (model, context %, token/cost). Each user turn sits in a heavy
left-gutter panel block; assistant replies render real Markdown; tool calls read
as a distinct icon + action (`$` bash, `→` read, `←` edit, `✱` glob/grep,
`◈` websearch, `±` git…) and **condense to one line you click to expand**, while
edits fold into a single diff row with the hunk shown beneath it; a braille
spinner shows live work; the slash-command menu highlights the selection; and the
text input is a raised field with a `❯` caret.

| Chat + tool calls | Live diff |
|---|---|
| ![chat](docs/screenshots/01-chat.png) | ![diff](docs/screenshots/02-diff.png) |

| Plan mode | Context rail: tasks, subagents, session |
|---|---|
| ![plan](docs/screenshots/03-plan.png) | ![tasks](docs/screenshots/04-tasks.png) |

| Permission card | Slash-command menu |
|---|---|
| ![permission](docs/screenshots/07-permission.png) | ![menu](docs/screenshots/09-menu.png) |

<sub>Regenerate with `bun packages/core/scripts/screenshot.ts docs/screenshots`
(drives the real engine with a mock model; bundled Playwright Chromium).</sub>

## Stack

- **Runtime:** TypeScript + [Bun](https://bun.sh) (workspaces + Turbo).
- **Models:** [Vercel AI SDK v5](https://ai-sdk.dev) (`streamText` + `tool()` +
  `stopWhen: stepCountIs`) as a unified, always-current provider abstraction.
- **Catalog:** live provider `/v1/models` merged with the
  [models.dev](https://models.dev) capability/pricing catalog — never hardcoded.
- **TUI:** [OpenTUI](https://github.com/anomalyco/opentui) (Solid) for the
  interactive UI, with a guaranteed readline + headless fallback.

## Architecture

A hard **core/TUI boundary**: the engine emits a typed `UIEvent` stream and
accepts `EngineCommand`s; no UI type leaks into core, so the UI is swappable and
the engine is fully testable headless.

| Package | Owns |
|---|---|
| `@vibe/shared` | Contracts: `UIEvent`, `Message`/`Part`, `ToolDefinition`, `EngineClient`, errors, logger |
| `@vibe/config` | Zod config schema, file discovery + deep-merge, auth resolution |
| `@vibe/providers` | `ProviderRegistry`, `resolveModel`, `CatalogService` (models.dev + `/v1/models`) |
| `@vibe/tools` | Built-in tools with `readOnly` flags + the AI-SDK `tool()` adapter / `Toolset` |
| `@vibe/core` | Agent loop (`Session.run`), mode gating, subagent fork, event bus, `Engine` |
| `@vibe/plugins` | `HookBus`, `PluginApi`, slash-command + skill runtimes |
| `@vibe/tui` | OpenTUI app + headless/REPL renderers |
| `@vibe/cli` | `bin/vibe` entrypoint (argv, config, headless `-p` vs TUI) |

## Quick start

```bash
bun install
# Install the providers you'll use + the rich TUI (optional peer deps):
bun add -D @ai-sdk/anthropic @ai-sdk/openai @opentui/core @opentui/solid solid-js
bun link                      # makes `vibecodr`/`vibe` available on your PATH

# interactive — on first run, a guided setup lets you pick a provider
# (Anthropic, OpenAI, Ollama Cloud, …), keys you already have in your env are
# auto-detected, and it fetches the live model list so you just pick one.
# Saved to ~/.config/vibe-codr/config.json. Re-run it anytime with `vibe setup`.
vibecodr

# one-shot (headless / pipeable)
vibecodr -p "list the TS files and read package.json" \
  --model anthropic/claude-opus-4-8

# machine-readable output (for scripting) and prompt-from-stdin
vibecodr -p "summarize this" --output-format json
cat task.md | vibecodr -p -            # read the prompt from stdin
cat task.md | vibecodr -p ""           # empty -p also reads stdin (no onboarding)
# Headless exits non-zero on engine error, so `vibecodr -p … && next` is safe in CI.

# other entry points
vibecodr setup                # (re)run the guided provider/model setup (alias: login)
vibecodr models               # list models for configured providers
vibecodr --continue           # resume the most recent session
vibecodr --resume <id>        # resume a specific session

# (without linking, run from source: `bun packages/cli/bin/vibecodr.ts ...`)
```

### Ollama Cloud (subscription)

Run big open models on ollama.com with your subscription — no local GPU:

```bash
export OLLAMA_API_KEY=...      # from https://ollama.com/settings/keys
vibecodr setup                 # pick "Ollama Cloud" (it's preselected when the key is set)
# or skip setup and go straight in:
vibecodr --model ollama/gpt-oss:120b
```

With a key set, vibecodr automatically targets `https://ollama.com/v1`. Run
`vibecodr models` to list the exact ids your subscription exposes (e.g.
`ollama/gpt-oss:120b`, `ollama/qwen3-coder:480b`, `ollama/deepseek-v3.1:671b`).

### In-session commands

Type `/` to open the **command menu** — it filters as you type, `↑`/`↓` to
highlight, `Tab` to complete, `Enter` to run, `Esc` to dismiss. Commands with a
fixed set of values (`/approvals`, `/reasoning`, `/theme`) drill into a second
menu so you can pick the value. Or type `/help` for the full, grouped list.
Highlights:

- **Session** — `/status` (model, mode, cwd, context %, tokens, cost), `/cost`,
  `/context` (window usage + compaction threshold), `/clear` (alias `/new`),
  `/compact`, `/resume`, `/recall <text>` (search past sessions), `/export [path]`,
  `/init`, `/exit`.
- **Model & mode** — `/model <id>`, `/models`, `/plan`, `/execute`,
  `/approvals <ask|auto>`, `/reasoning <low|medium|high|off>`,
  `/theme <default|light|contrast|opencode>`.
  Press **Shift+Tab** to cycle the mode pill: **plan → execute → yolo → plan**.
- **Steering** — `/goal <text>`,
  `/loop [interval] <prompt> [--until <cond>] [--max N]` (`/loop stop`),
  `/queue` (`/queue clear`).
- **Code & safety** — `/diff`, `/review`, `/verify`, `/undo`, `/checkpoints`.
- **Extensions & config** — `/config` (effective settings, secrets masked),
  `/memory` (loaded project/global notes), `/permissions`, `/tools`, `/agents`,
  `/skills`, `/commands`, `/mcp`, `/doctor` (environment health check).

Custom commands live in `.vibe/commands/*.md`, skills in `.vibe/skills/*/SKILL.md`,
named subagents in `.vibe/agents/*.md`, and plugins are listed in config.

### Features

- **opencode-inspired terminal UI** — built on vibe-codr's own engine, with a
  disciplined palette: a **single accent** (the active mode's color) is the only
  hue on screen at a time; content is neutral and green/red/amber are reserved for
  diffs and warnings. A two-column layout pairs a scrolling transcript with a
  **context rail** that tracks the plan's task list, live subagents, and session
  info (model, context %, token/cost). User turns render in a heavy left-gutter
  panel block; assistant replies render real Markdown via OpenTUI's native
  renderer; tool calls read as a distinct icon + action label (`$` bash, `→` read,
  `←` edit/write, `✱` glob/grep, `◈` websearch, `±` git, `✦` subagent…) and
  **condense to one line you click to expand**, while edits fold into a single
  diff row (tinted add/remove backgrounds) with the hunk shown beneath it. A
  braille spinner with elapsed time shows live work (**Esc** interrupts the turn);
  the slash menu draws a full-row selection highlight; the text input is a raised
  field with a `❯` caret; and permission prompts surface as a bordered `△` card
  answerable with `y`/`a`/`n`. Four themes ship — `default` (Tokyo Night),
  `light`, `contrast`, and `opencode` (warm peach).
- **Plan / execute / yolo** — three modes, cycled with **Shift+Tab** (or
  `/plan`, `/execute`, `/approvals auto`). **Plan** exposes only read-only tools
  (the model calls `present_plan`; you approve to proceed). **Execute** allows
  edits/commands, each gated by a glob-based allow/deny/ask **permission layer**.
  **Yolo** runs side-effecting tools without prompting. The header pill and the
  input border are color-coded so the active mode is unmistakable.
- **Resilience & git/process tools** — provider calls retry transient failures
  (network / 429 / 5xx) with exponential backoff (`retry` config) and surface a
  notice instead of failing silently. Structured `git_status` / `git_diff` /
  `git_log` / `git_commit` / `git_push` tools avoid hand-parsing porcelain and
  let the agent commit and publish to GitHub end-to-end, and `bash background:true`
  starts long-running commands you poll with `job_status` / stop with `job_kill`.
  For richer GitHub workflows (issues, PRs, reviews), connect the official
  [GitHub MCP server](https://github.com/github/github-mcp-server) under
  `mcp.servers` (see the MCP example below).
- **`@file` mentions & images** — reference files inline (`summarize @src/app.ts`)
  and their contents are injected as context; image mentions (`@shot.png`) are
  attached for vision models (with a notice when the model lacks vision). The
  REPL supports multi-line input (end a line with `\`) and **Ctrl-C aborts the
  current turn** instead of killing the process. Assistant text renders Markdown
  (headings, bold/italic, code, lists) in the interactive UI.
- **Surgical edits with live diffs** — the `edit` tool replaces exact text
  (`replaceAll` for non-unique matches) and accepts an `edits` array applied
  **atomically** (all-or-nothing); every `edit`/`write` returns a unified diff and
  emits a `file-changed` event, so the UI shows what changed in green/red as it
  happens. Mutating tools are **serialized within a step** — when a model emits
  parallel tool calls (most do), edits/writes/bash to the same files can't race;
  read-only tools still run concurrently.
- **Task list** — for any multi-step request the agent maintains a live
  checklist via the `update_tasks` tool (pending / in-progress / completed),
  rendered in the UI and persisted with the session so it survives `--resume`.
  The list can be seeded while planning and carries into execution.
- **Prompt queue** — type-ahead while a turn is running; submitted prompts form
  a visible, ordered backlog that drains one at a time so history stays
  consistent. `/queue` shows it, `/queue clear` (or aborting) drops what's
  waiting.
- **Web search** — a `web_search` tool powered by [TinyFish](https://tinyfish.ai)
  (free tier, no card) is on by default; the model can search the live web and
  follow up with `webfetch`. Set `TINYFISH_API_KEY` (or `search.apiKey`); disable
  with `search.enabled: false`.
- **MCP client** — connect [Model Context Protocol](https://modelcontextprotocol.io)
  servers under `mcp.servers` (stdio or SSE/HTTP); their tools register as
  `mcp__<server>__<tool>` and flow through the same permission gate. Requires the
  optional `@modelcontextprotocol/sdk` peer dep; failures are skipped, not fatal.
- **Interactive permissions** — side-effecting tools prompt for approval
  (**allow once / always / deny**) under `approvalMode: "ask"` (the default);
  `always` is remembered for the session. Headless runs auto-allow. `auto` mode
  or explicit allow/deny rules skip the prompt.
- **Checkpoints & undo** — in a git repo, the workspace is snapshotted before
  each edit turn (a hidden `refs/vibecodr/*` ref — your branch/history untouched);
  `/undo` rolls back, `/checkpoints` lists them.
- **Self-verify** — set `verify.command` (e.g. `"bun run typecheck && bun test"`)
  and run it with `/verify`; with `verify.auto`, failures after an edit turn are
  fed back so the agent self-corrects (capped by `verify.maxRetries`).
- **Live token & cost tracking** — cumulative input/output tokens and an
  estimated USD cost are tracked every step and shown in the status bar / footer.
  Prices come from the live catalog (models.dev); override or pin a rate per
  model in config under `pricing` (USD per 1M tokens). Cached input tokens are
  surfaced when the provider reports them.
- **Prompt caching, reasoning & spend guard** — the stable system prefix is sent
  with Anthropic cache markers by default (`caching.enabled`) so repeated turns
  reuse it; `reasoning.budgetTokens` / `reasoning.effort` drive extended thinking
  per provider; `budget.limitUSD` warns (or, with `onExceed: "stop"`, halts the
  turn) when a session's cost crosses the cap.
- **Subagents** — `spawn_subagent` forks an isolated child with its own context
  that returns only its final answer; depth-capped and parallel-safe. Set a
  default subagent model with `subagent.model` (named agents in `.vibe/agents/`
  can override per agent).
- **`/goal`** injects a north-star into every system prompt; **`/loop`** reruns a
  prompt on an interval until a `--until` condition (checked with a structured
  model call) or `--max` is reached.
- **Persistence & compaction** — every turn is saved to
  `.vibe/sessions/<id>/`; long conversations auto-compact against the active
  model's context window (from the catalog), preserving the system prompt, goal,
  and most recent turns. The status bar shows live context fill (`ctx 45%`) and
  `/context` reports the window plus the compaction threshold so you always know
  how close you are to the limit.
- **Session memory (recall)** — past sessions become searchable long-term
  memory. `/recall <text>` does a fast, offline lexical search across every saved
  session and shows the matching turns (with session id, date, and goal); the
  agent can do the same mid-task via the `recall_memory` tool when you reference
  earlier work or ask "what did we decide?". No embeddings or vector store
  required — it just works on the session files already on disk.
- **Project & global memory** — `VIBE.md`, `AGENTS.md`, or `CLAUDE.md` are
  injected into every system prompt, so the agent follows your stack and
  conventions out of the box. Discovery **walks up from the working directory to
  the git root**, so running from a subdirectory still picks up the repo-root
  notes; a user-global `~/.config/vibe-codr/VIBE.md` applies everywhere. Precedence
  is explicit (global < repo-root < closer dirs; closest wins), each block is
  labelled with its source, files are byte-capped so a huge note can't bloat every
  request, and `/memory` shows exactly what's loaded. Drop-in compatible with
  repos already carrying Codex's `AGENTS.md` or Claude Code's `CLAUDE.md`.

Model strings are `<provider>/<model-id>` (split on the first slash):
`anthropic/claude-opus-4-8`, `openai/gpt-...`, `deepseek/...`, `xai/grok-...`,
`minimax/MiniMax-M1`, `codex/gpt-...`, `openrouter/anthropic/claude-...`,
`fireworks/...`, `baseten/...`, `lmstudio/<id>`, `ollama/llama3.1`.

#### Providers & subscription auth

All providers run on **AI SDK v5**. anthropic/openai/deepseek use their dedicated
v5 SDKs; every other provider (xai, openrouter, fireworks, baseten, minimax,
ollama, lmstudio) is driven through `@ai-sdk/openai-compatible` so it works out of
the box without chasing incompatible SDK majors.

| Provider | Auth | Notes |
|---|---|---|
| `anthropic` `openai` `deepseek` `fireworks` `baseten` `openrouter` | `*_API_KEY` env or `providers.<id>.apiKey` | first-party + aggregators (the OpenAI-compatible ones via the shared compat driver) |
| `xai` (**Grok**) | `XAI_API_KEY` (console.x.ai) | OpenAI-compatible; point `XAI_BASE_URL` at a gateway if your subscription is brokered elsewhere |
| `minimax` (**MiniMax**) | `MINIMAX_API_KEY` | OpenAI-compatible; your MiniMax subscription token. `MINIMAX_BASE_URL` overrides region |
| `codex` (**OpenAI Codex**) | reuses `~/.codex/auth.json` | uses the credential the Codex CLI already stored — an OpenAI API key works directly; for **ChatGPT-subscription OAuth** set `CODEX_BASE_URL` (and any `providers.codex.headers`) to your Codex backend, since that token targets a different endpoint than `api.openai.com` |
| `lmstudio` | none (keyless) | local; `LMSTUDIO_BASE_URL` (default `:1234`) |
| `ollama` | none (local) or `OLLAMA_API_KEY` (cloud) | **Local:** run `ollama serve` (`OLLAMA_BASE_URL`, default `:11434`); keyless. **Ollama Cloud:** set `OLLAMA_API_KEY` (from ollama.com/settings/keys) and it auto-targets `https://ollama.com/v1` — model ids are plain (no suffix), e.g. `ollama/gpt-oss:120b`; run `vibecodr models` to list yours. Override the host with `OLLAMA_BASE_URL`. |

**Any** provider can authenticate from a credential file or with extra headers —
useful for subscription/OAuth tokens another CLI obtained:

```jsonc
"providers": {
  "codex":   { "tokenFile": "~/.codex/auth.json", "headers": { "chatgpt-account-id": "acct_…" } },
  "minimax": { "apiKey": "mm-…" },
  "xai":     { "baseURL": "https://your-grok-gateway/v1", "tokenFile": "~/.grok/token" }
}
```

A JSON `tokenFile` is searched for common fields (`OPENAI_API_KEY`,
`tokens.access_token`, `api_key`, …) or a `tokenPath` you specify; a plain-text
file is used verbatim. Resolution order is **env → `apiKey` → `tokenFile`**.

Provider SDKs (`@ai-sdk/*`, `@openrouter/ai-sdk-provider`) and OpenTUI are
**optional** peer deps — install the ones you use; a missing one yields a clear
error rather than blocking startup.

### Config

Config is JSONC, deep-merged low→high: defaults → `~/.config/vibe-codr/config.json`
→ `.vibe/config.json` → env → CLI flags. Beyond `model`, `mode`, `maxSteps`,
`permissions`, and `plugins`:

```jsonc
{
  "model": "anthropic/claude-opus-4-8",
  "subagent": { "model": "anthropic/claude-haiku-4-5", "maxDepth": 3 },
  "search": { "enabled": true, "apiKey": "tf-..." },   // TinyFish web search
  "pricing": {                                          // USD per 1M tokens
    "anthropic/claude-opus-4-8": { "input": 5, "output": 25 }
  },
  "approvalMode": "ask",                                // ask | auto
  "theme": "default",                                   // default | light | contrast | opencode
  "caching": { "enabled": true },                       // Anthropic prompt caching
  "reasoning": { "effort": "high", "budgetTokens": 8000 }, // thinking controls
  "budget": { "limitUSD": 5, "onExceed": "warn" },      // spend guard: warn | stop
  "checkpoints": { "enabled": true },
  "verify": { "command": "bun run typecheck && bun test", "auto": true, "maxRetries": 2 },
  "mcp": {
    "servers": {
      // GitHub: issues, PRs, reviews, code search. Needs a personal access
      // token; tools register as mcp__github__* and flow through the permission gate.
      "github": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }
      }
    }
  },
  "providers": { "anthropic": { "apiKey": "sk-..." } }
}
```

API keys belong in env vars or this file; keys entered during first-run setup
are written to the user-global config.

## Develop

```bash
bun run lint          # biome lint across packages
bun run format        # biome format --write
bun run typecheck     # tsc across all packages
bun test              # unit tests
bun run smoke:tui     # drive the real OpenTUI app (mock engine) — input, streamed
                      # output, tool icons, working spinner, the command menu, and
                      # the permission card — via the test renderer
bun packages/core/scripts/screenshot.ts docs/screenshots  # regenerate README shots
bun run build:binary  # standalone binary -> dist/vibecodr (bun --compile)
```

`vibecodr sessions` lists saved sessions (resume one with `--resume <id>`).
`vibecodr setup` re-runs the guided provider/model setup at any time.

## Status

All planned phases are implemented and tested:

0. ✅ Full scaffold (monorepo, contracts, core/TUI boundary)
1. ✅ Agent spine — `streamText` loop with multi-step tool execution
2. ✅ Multi-provider + live model catalog (models.dev + `/v1/models`)
3. ✅ Permission layer + plan/execute gating
4. ✅ Subagents (isolated, depth-capped, parallel) + named agents
5. ✅ Slash command files, skills (progressive disclosure), plugins
6. ✅ `/goal` steering + `/loop` (interval, `--until`, `--max`)
7. ✅ Session persistence (`--continue`/`--resume`) + context-aware compaction
8. ✅ Parity & polish — full introspection/settings command surface, project
   memory (VIBE.md/AGENTS.md/CLAUDE.md), JSON headless output + stdin, themes,
   `/doctor`, `/export`, Ollama + structured `git_log`/`git_push` for GitHub.
9. ✅ TUI UX — header with color-coded plan/execute/yolo mode pill (Shift+Tab to
   cycle), an interactive slash-command menu, first-class Ollama Cloud, and a
   guided `vibecodr setup`; the OpenTUI app is covered by `bun run smoke:tui`.
10. ✅ opencode-inspired UI — two-column layout (transcript + a context rail for
    tasks/subagents/session), left-gutter message blocks, native Markdown replies,
    per-tool icons + action labels, condensed tool output that expands on click,
    edits folded into one diff row (tinted backgrounds), a braille working spinner
    (Esc to interrupt), a bordered permission card, full-row menu highlight, and
    the `opencode` theme.
11. ✅ Hardening audit — every provider runs on AI SDK v5 (OpenAI-compatible
    routing); parallel tool calls serialized; subagent isolation on `--resume`;
    memory walks to the git root (byte-capped); atomic, corruption-tolerant
    session store; loop runs serialized + abortable; alternation-safe compaction;
    plugin hooks wired (incl. a working `deny` gate) and isolated; MCP auth
    headers; tool-name/safety-command shadow guards; `/undo` rewinds files +
    history without touching your git index; non-zero headless exit on error.

To run interactively against real models, install the provider SDKs you use
(`@ai-sdk/*`, `@openrouter/ai-sdk-provider`), OpenTUI for the rich UI
(`@opentui/core`, `@opentui/solid`, `solid-js`), and `@modelcontextprotocol/sdk`
for MCP servers. Each is an optional peer dep — a missing one yields a clear,
actionable error (and the readline REPL fallback) rather than blocking startup.
