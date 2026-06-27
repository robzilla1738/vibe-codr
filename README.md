# vibe-codr

A cutting-edge, **model-agnostic** CLI coding agent for the terminal — in the
class of Claude Code / opencode, but able to drive coding and agentic tasks on
*any* model: local models via **LM Studio**, aggregators (**OpenRouter,
Fireworks, Baseten**), and first-party providers (**OpenAI, Anthropic, DeepSeek,
xAI/Grok**).

> Status: **feature-complete core (Phases 0–7).** Multi-provider agent loop,
> live model catalog, plan/execute modes with a permission layer, subagents,
> slash commands / skills / plugins, `/goal` + `/loop`, and session persistence
> with context-aware compaction — all covered by 50+ tests (including
> mock-model integration tests of the agent loop with zero network).

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
cp .env.example .env          # add the provider key(s) you use

# one-shot (headless / pipeable)
bun packages/cli/bin/vibe.ts -p "list the TS files and read package.json" \
  --model anthropic/claude-opus-4-8

# interactive
bun packages/cli/bin/vibe.ts

# other entry points
bun packages/cli/bin/vibe.ts models           # list models for configured providers
bun packages/cli/bin/vibe.ts --continue        # resume the most recent session
bun packages/cli/bin/vibe.ts --resume <id>     # resume a specific session
```

### In-session commands

`/help` · `/model <id>` · `/models` · `/plan` · `/execute` · `/goal <text>` ·
`/agents` · `/loop [interval] <prompt> [--until <cond>] [--max N]` (`/loop stop`) ·
`/compact` · `/clear` · `/init`. Custom commands live in `.vibe/commands/*.md`,
skills in `.vibe/skills/*/SKILL.md`, named subagents in `.vibe/agents/*.md`, and
plugins are listed in config.

### Features

- **Plan vs execute** — plan mode exposes only read-only tools (it cannot edit
  or run commands); the model calls `present_plan`, and you approve via
  `/execute`. A glob-based allow/deny/ask **permission layer** gates
  side-effecting tools.
- **Subagents** — `spawn_subagent` forks an isolated child with its own context
  that returns only its final answer; depth-capped and parallel-safe.
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
