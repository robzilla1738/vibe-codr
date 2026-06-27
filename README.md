# vibe-codr

A cutting-edge, **model-agnostic** CLI coding agent for the terminal — in the
class of Claude Code / opencode, but able to drive coding and agentic tasks on
*any* model: local models via **LM Studio**, aggregators (**OpenRouter,
Fireworks, Baseten**), and first-party providers (**OpenAI, Anthropic, DeepSeek,
xAI/Grok**).

> Status: **Phase 0 — full scaffold.** The monorepo, all package interfaces, the
> agent loop, the provider/model abstraction, the tool system, and a working
> headless UI are in place. Later phases layer in the live model catalog,
> plan/execute gating polish, subagents, skills/plugins, and `/loop` + `/goal`.

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
```

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

## Roadmap

Phase 0 scaffold → 1 agent spine → 2 multi-provider + live catalog → 3 full
tools + permissions + plan/execute → 4 subagents → 5 extensibility (commands,
skills, plugins) → 6 `/goal` + `/loop` → 7 persistence + compaction + polish.
