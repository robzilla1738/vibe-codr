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
| `@vibe/tui` | OpenTUI app + headless/REPL renderers, themes |
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

# Regenerate the README screenshots (drives the real engine with a mock model
# + bundled Playwright Chromium). Re-run after any TUI/output change.
bun packages/core/scripts/screenshot.ts docs/screenshots
```

## Conventions

- Keep the **core/TUI boundary** intact: core must not import from `@vibe/tui`;
  UIs communicate only through `UIEvent` / `EngineCommand`.
- Provider SDKs, OpenTUI, and `@modelcontextprotocol/sdk` are **optional peer
  deps** — import them via non-literal specifiers and fail with a clear,
  actionable error rather than at startup.
- Tools declare `readOnly`; only read-only tools are exposed in plan mode, and
  non-read-only tools pass through the permission gate.
- Every behavior change ships with a test. Prefer mock-model integration tests
  (`ai/test`'s `MockLanguageModelV2`) over hitting the network.
- `packages/tui/src/app.tsx` is excluded from `tsc` (OpenTUI is an optional
  native dep) and can't run in CI, so it's verified visually through
  `screenshot.ts`, which mirrors its render logic. Keep the two in lockstep:
  any visible app.tsx change gets the matching change in the screenshot reducer,
  and never use an OpenTUI prop you can't confirm exists.
- Match the surrounding code's style; comments explain *why*, not *what*.

## Before you finish

Run `bun run typecheck && bun test && bun run lint` — all must pass.
