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
> context-aware compaction — all covered by 55+ tests (including mock-model
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

# other entry points
vibecodr models               # list models for configured providers
vibecodr --continue           # resume the most recent session
vibecodr --resume <id>        # resume a specific session

# (without linking, run from source: `bun packages/cli/bin/vibecodr.ts ...`)
```

### In-session commands

`/help` · `/model <id>` · `/models` · `/plan` · `/execute` · `/goal <text>` ·
`/agents` · `/loop [interval] <prompt> [--until <cond>] [--max N]` (`/loop stop`) ·
`/queue` (`/queue clear`) · `/compact` · `/clear` · `/init`. Custom commands live
in `.vibe/commands/*.md`, skills in `.vibe/skills/*/SKILL.md`, named subagents in
`.vibe/agents/*.md`, and plugins are listed in config.

### Features

- **Plan vs execute** — plan mode exposes only read-only tools (it cannot edit
  or run commands); the model calls `present_plan`, and you approve via
  `/execute`. A glob-based allow/deny/ask **permission layer** gates
  side-effecting tools.
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
- **Live token & cost tracking** — cumulative input/output tokens and an
  estimated USD cost are tracked every step and shown in the status bar / footer.
  Prices come from the live catalog (models.dev); override or pin a rate per
  model in config under `pricing` (USD per 1M tokens).
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

Model strings are `<provider>/<model-id>` (split on the first slash):
`anthropic/claude-opus-4-8`, `openai/gpt-...`, `deepseek/...`, `xai/grok-...`,
`openrouter/anthropic/claude-...`, `fireworks/...`, `baseten/...`,
`lmstudio/<id>`.

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
  "providers": { "anthropic": { "apiKey": "sk-..." } }
}
```

API keys belong in env vars or this file; keys entered during first-run setup
are written to the user-global config.

## Develop

```bash
bun run typecheck     # tsc across all packages
bun test              # unit tests
```

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
