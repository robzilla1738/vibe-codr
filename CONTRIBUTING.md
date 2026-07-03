# Contributing to vibe-codr

Thanks for looking into this. Bug reports, small fixes, and provider additions
are all welcome. For anything bigger, open an issue first so we can talk it
through before you sink time into it.

## Setup

You need [Bun](https://bun.sh) ≥ 1.2. Then:

```bash
git clone https://github.com/robzilla1738/vibe-codr.git
cd vibe-codr
bun install
bun packages/cli/bin/vibecodr.ts --help   # run from source
```

## Before you open a PR

Run the gate. CI runs the same three commands on Linux and macOS, so if they
pass locally you're in good shape:

```bash
bun run typecheck
bun run lint
bun test
```

If you touched the TUI (`packages/tui/src/app.tsx` in particular), also run
the render smoke test — it drives the real OpenTUI app with a mock engine:

```bash
bun run smoke:tui
```

A few things reviewers will look for:

- New behavior comes with a test. The codebase has 900+ and most bugs that
  got fixed here have a regression test pinning them down.
- Comments explain constraints the code can't express, not what the next line
  does.
- No UI types in `@vibe/core`. The engine talks to the UI only through the
  typed `UIEvent` / `EngineCommand` stream — that boundary is what keeps the
  engine testable headless, and PRs that leak across it will get bounced.

## Where things live

`AGENTS.md` at the repo root has the full package-by-package map (it doubles
as project memory for coding agents, including vibe-codr itself). Short
version: contracts in `@vibe/shared`, config in `@vibe/config`, providers in
`@vibe/providers`, tools in `@vibe/tools`, the engine in `@vibe/core`, the
terminal UI in `@vibe/tui`, and the entrypoint in `@vibe/cli`.

## Adding a provider

Most providers are OpenAI-compatible and take about ten lines: add a
`BuiltinSpec` entry in `packages/providers/src/defs.ts` (id, env vars, base
URL), a menu entry in `packages/cli/src/providers-catalog.ts` if it should
show up in onboarding, and a row in the README table. Model metadata comes
from models.dev automatically, so don't hardcode context windows or pricing.

## Releases

Maintainers cut releases by pushing a `vX.Y.Z` tag. The release workflow
compiles standalone binaries for four platforms, publishes the npm package,
and creates the GitHub release with notes pulled from `CHANGELOG.md`. A
`-rc.N` tag dry-runs the whole path without publishing. If your change is
user-visible, add a line under `## Unreleased` in the changelog.
