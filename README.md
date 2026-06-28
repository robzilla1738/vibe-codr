# vibe-codr

A cutting-edge, **model-agnostic** CLI coding agent for the terminal — in the
class of Claude Code / opencode, but able to drive coding and agentic tasks on
*any* model: local models via **LM Studio**, aggregators (**OpenRouter,
Fireworks, Baseten**), and first-party providers (**OpenAI, Anthropic, DeepSeek,
xAI/Grok**).

> Status: **feature-complete core (Phases 0–7).** Multi-provider agent loop,
> live model catalog, plan/execute modes with a permission layer, a live
> **task list**, an observable **prompt queue**, subagents, slash commands /
> skills / plugins, `/goal` + `/loop`, and session persistence with
> context-aware compaction — all covered by 170+ tests (including mock-model
> integration tests of the agent loop with zero network).
>
> The terminal command is **`vibecodr`** (`vibe` works as an alias).

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
bun link                      # makes `vibecodr` available on your PATH

# interactive — on first run, vibecodr walks you through entering your
# provider key and an (optional, free) TinyFish web-search key, saved to
# ~/.config/vibe-codr/config.json. Or set keys yourself: cp .env.example .env
vibecodr

# one-shot (headless / pipeable)
vibecodr -p "list the TS files and read package.json" \
  --model anthropic/claude-opus-4-8

# machine-readable output (for scripting) and prompt-from-stdin
vibecodr -p "summarize this" --output-format json
cat task.md | vibecodr -p -            # read the prompt from stdin

# other entry points
vibecodr models               # list models for configured providers
vibecodr --continue           # resume the most recent session
vibecodr --resume <id>        # resume a specific session

# (without linking, run from source: `bun packages/cli/bin/vibecodr.ts ...`)
```

### In-session commands

Type `/help` for the full, grouped list. Highlights:

- **Session** — `/status` (model, mode, cwd, tokens, cost), `/cost`, `/clear`
  (alias `/new`), `/compact`, `/resume`, `/init`, `/exit`.
- **Model & mode** — `/model <id>`, `/models`, `/plan`, `/execute`,
  `/approvals <ask|auto>`, `/reasoning <low|medium|high|off>`, `/theme <name>`.
- **Steering** — `/goal <text>`,
  `/loop [interval] <prompt> [--until <cond>] [--max N]` (`/loop stop`),
  `/queue` (`/queue clear`).
- **Code & safety** — `/diff`, `/review`, `/verify`, `/undo`, `/checkpoints`.
- **Extensions & config** — `/config` (effective settings, secrets masked),
  `/permissions`, `/tools`, `/agents`, `/skills`, `/commands`, `/mcp`.

Custom commands live in `.vibe/commands/*.md`, skills in `.vibe/skills/*/SKILL.md`,
named subagents in `.vibe/agents/*.md`, and plugins are listed in config.

### Features

- **Plan vs execute** — plan mode exposes only read-only tools (it cannot edit
  or run commands); the model calls `present_plan`, and you approve via
  `/execute`. A glob-based allow/deny/ask **permission layer** gates
  side-effecting tools.
- **Resilience & git/process tools** — provider calls retry transient failures
  (network / 429 / 5xx) with exponential backoff (`retry` config) and surface a
  notice instead of failing silently. Structured `git_status` / `git_diff` /
  `git_commit` tools avoid hand-parsing porcelain, and `bash background:true`
  starts long-running commands you poll with `job_status` / stop with `job_kill`.
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
  happens.
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
  and most recent turns.
- **Project memory** — `VIBE.md`, `AGENTS.md`, or `CLAUDE.md` in the project
  root (plus a user-global `~/.config/vibe-codr/VIBE.md`) are injected into every
  system prompt, so the agent follows your stack and conventions out of the box.
  Drop-in compatible with repos already carrying Codex's `AGENTS.md` or Claude
  Code's `CLAUDE.md`.

Model strings are `<provider>/<model-id>` (split on the first slash):
`anthropic/claude-opus-4-8`, `openai/gpt-...`, `deepseek/...`, `xai/grok-...`,
`minimax/MiniMax-M1`, `codex/gpt-...`, `openrouter/anthropic/claude-...`,
`fireworks/...`, `baseten/...`, `lmstudio/<id>`.

#### Providers & subscription auth

| Provider | Auth | Notes |
|---|---|---|
| `anthropic` `openai` `deepseek` `fireworks` `baseten` `openrouter` | `*_API_KEY` env or `providers.<id>.apiKey` | first-party + aggregators |
| `xai` (**Grok**) | `XAI_API_KEY` (console.x.ai) | premium/Grok models via an xAI API key; point `XAI_BASE_URL` at a gateway if your subscription is brokered elsewhere |
| `minimax` (**MiniMax**) | `MINIMAX_API_KEY` | OpenAI-compatible; your MiniMax subscription token. `MINIMAX_BASE_URL` overrides region |
| `codex` (**OpenAI Codex**) | reuses `~/.codex/auth.json` | uses the credential the Codex CLI already stored — an OpenAI API key works directly; for **ChatGPT-subscription OAuth** set `CODEX_BASE_URL` (and any `providers.codex.headers`) to your Codex backend, since that token targets a different endpoint than `api.openai.com` |
| `lmstudio` | none (keyless) | local; `LMSTUDIO_BASE_URL` |

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
  "theme": "default",                                   // default | light | contrast
  "caching": { "enabled": true },                       // Anthropic prompt caching
  "reasoning": { "effort": "high", "budgetTokens": 8000 }, // thinking controls
  "budget": { "limitUSD": 5, "onExceed": "warn" },      // spend guard: warn | stop
  "checkpoints": { "enabled": true },
  "verify": { "command": "bun run typecheck && bun test", "auto": true, "maxRetries": 2 },
  "mcp": {
    "servers": {
      "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }
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
bun run build:binary  # standalone binary -> dist/vibecodr (bun --compile)
```

`vibecodr sessions` lists saved sessions (resume one with `--resume <id>`).

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

Next: install the provider SDKs you use (`@ai-sdk/*`, `@openrouter/ai-sdk-provider`)
and OpenTUI (`@opentui/core`, `@opentui/solid`, `solid-js`) for the full
interactive experience; wire up CI.
