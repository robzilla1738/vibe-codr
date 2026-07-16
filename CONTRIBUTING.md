# Contributing to Vibe Codr

Thanks for looking into this. Bug reports, small fixes, and provider additions
are all welcome. For anything bigger, open an issue first so we can talk it
through before you sink time into it.

## Setup

You need Bun 1.3.11 and Node.js 22+. Then:

```bash
git clone https://github.com/robzilla1738/vibe-codr.git
cd vibe-codr
bun install --frozen-lockfile
npm --prefix apps/desktop ci
bun packages/cli/bin/vibecodr.ts --help   # run from source
```

## Before you open a PR

Run the gate that matches your change:

```bash
bun run verify
npm --prefix apps/desktop run verify:ci  # required for desktop changes
```

If you touched the TUI (`packages/tui/src/app.tsx` in particular), also run
the render smoke test — it drives the real OpenTUI app with a mock engine:

```bash
bun run smoke:tui
```

A few things reviewers will look for:

- New behavior comes with a test. The codebase has 1,800+ engine/CLI tests and
  600+ desktop tests; most bugs that
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
terminal UI in `@vibe/tui`, the entrypoint in `@vibe/cli`, and the desktop
presentation shell in `apps/desktop`.

## Adding a provider

Most providers are OpenAI-compatible and take about ten lines: add a
`BuiltinSpec` entry in `packages/providers/src/defs.ts` (id, env vars, base
URL), a menu entry in `packages/cli/src/providers-catalog.ts` if it should
show up in onboarding, and a row in the README table. Model metadata comes
from models.dev automatically, so don't hardcode context windows or pricing.

## Releases

Vibe Codr uses one committed version and one `vX.Y.Z` tag across the root,
workspace packages, and `apps/desktop`. The release workflow compiles the CLI,
worker, and TUI bundles, publishes npm, builds the locked cloud runtime, signs
and notarizes macOS Desktop, builds Windows Desktop, and creates one GitHub
release with updater metadata and checksums. A `-rc.N` tag dry-runs npm publish
and marks the GitHub release as a prerelease. User-visible changes belong under
`## Unreleased` in the root changelog and, when desktop-specific, the desktop
changelog too.
