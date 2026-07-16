# AGENTS.md — Vibe Codr desktop

Desktop-specific notes for the canonical [Vibe Codr repository](https://github.com/robzilla1738/vibe-codr).

## What this is

Electron **presentation shell** in `apps/desktop`. Do **not** reimplement `@vibe/core`. Talk to the engine only via the NDJSON host protocol (`bootstrap` / `send` / `rpc` / `shutdown`) from the repository-root `packages/macos-bridge`.

## Hard rules

1. **No engine fork.** Features that belong in the agent loop stay in vibe-codr; this repo only renders `UIEvent`s and sends `EngineCommand`s.
2. **TUI-faithful behavior + themes.** Layout constants: content ~130ch, sidebar ~42ch, and a shared transcript/approval/composer measure of `40rem`; wide breakpoint ~1280px (`BREAKPOINTS.wide` in `src/shared/breakpoints.ts`). Themes from `src/shared/themes.ts`. macOS Liquid Glass may tint chrome (rails/topbar/composer); do not replace CLI theme semantics.
3. **Busy until `engine-idle`.** Do not clear `busy` on `session-idle` / `turn-finished` alone — follow-up turns must not flicker idle. Incidental failed `send` (density, steer, mode) must not clear mid-turn busy; use `shouldClearBusyOnSendFailure` / `commandsExpectBusy`.
4. **`/clear` / `/new`:** abort if busy → `clearSessionLocal()` (transcript + overlays + `suppressAfterClear`) → forward slash to engine.
5. Prefer porting pure modules from `vibe-codr/packages/tui` (`reducer`, `slash`, `modes`, `density`, `file-fuzzy`, `commands-catalog`) over rewriting behavior.
6. Development host resolution must prefer the canonical monorepo root and reject a compiled `vibecodr-engine-host` when runtime source is newer, then fall back to Bun source execution. This prevents stale host behavior from being reported as a generic renderer failure.
7. **Workspace dock stays on the chat surface** (equal top/side inset with a quiet `var(--surface-subtle)` rounded enclosure inside `content-inset` / `main-column`). Session, Changes, Git, Terminal, and Jobs open in one mutually exclusive, edge-attached right-side activity sidebar; the main column reserves that column instead of letting panels cover chat. Do not reintroduce a full-height rail tint, floating desktop panels, decorative white section lines, or topbar duplicates of Session/Changes/Git/Terminal/Jobs/Files.

## Key paths

| Concern | File |
|---------|------|
| Host spawn + NDJSON | `src/main/engine-bridge.ts` (disposeForQuit preemption, stdin write queue), `host-resolver.ts` (freshness-checked compiled host) |
| App icon | `assets/icon.png` → `npm run build:icon` → `assets/icon.icns`; unpackaged dock via `src/main/index.ts` |
| IPC surface | `src/preload/index.ts` → `window.vibe` (`getShellInfo`, full key list in `src/shared/vibe-api-keys.ts`) |
| Path / capture safety | `src/shared/path-safe.ts`, `capped-read.ts`, `stream-cap.ts`, `cwd-allowlist.ts` |
| Native dropped-file paths | `src/preload/index.ts` → `window.vibe.getPathForFile`; `src/renderer/composer/Composer.tsx` fallback parsing |
| Session / event wiring | `src/renderer/hooks/useSession.ts` |
| Keyboard + submit routing | `src/renderer/App.tsx` |
| Composer attachments | `src/renderer/composer/Composer.tsx` |
| Project rail (Projects + Chats) | `src/renderer/layout/ProjectRail.tsx`, `src/shared/project-index.ts` |
| Workspace dock | `src/renderer/layout/WorkspaceDock.tsx` |
| Activity sidebar | `src/renderer/layout/ActivitySidebar.tsx`; view bodies in `src/renderer/panels/` and `src/renderer/git/GitPanel.tsx` |
| Persistent contextual terminal | `src/main/terminal-manager.ts`, `src/renderer/panels/TerminalPanel.tsx`, `src/shared/terminal.ts`, `src/shared/project-index.ts` |
| Changed-files footer chip | `src/renderer/panels/TurnChangesCard.tsx` |
| Changed files / diff view | `src/shared/changed-files.ts`, `diff-view.ts` |
| Resizable rails | `src/renderer/layout/SidebarResizeHandle.tsx` |
| Session review | `src/renderer/panels/Inspector.tsx` |
| Boot / fatal New session | `src/renderer/layout/WelcomeGate.tsx` |
| Icons (Lucide wrappers) | `src/renderer/icons.tsx`, `tool-glyph.tsx` |
| Contracts | `src/shared/commands.ts`, `events.ts`, `protocol.ts` |
| Breakpoints | `src/shared/breakpoints.ts` (`wide` JS-only; laptop→narrow sync CSS `@media`) |
| Settings panel | `src/renderer/settings/SettingsPanel.tsx`, sections in `src/renderer/settings/sections/` |
| Instructions dirty mount | `InstructionsSection.tsx` + keep-mounted in `SettingsPanel.tsx`; `settings-instructions-mount.test.ts` |
| Settings load guard | `src/shared/settings-load-guard.ts` |
| Git panel | `src/renderer/git/GitPanel.tsx` |
| Config I/O (JSONC read/write) | `src/shared/config-io.ts`, `config-schema.ts` |
| Config diff patch builder | `src/shared/config-diff.ts` |
| Config pre-write validation | `src/shared/config-validate.ts` |
| Config shape parity gate | `scripts/check-config-shape.mjs`, locked engine revision in `ENGINE_COMMIT` |
| Bounded main-process cache | `src/shared/ttl-lru-cache.ts` |
| Provider catalog (onboarding) | `src/shared/providers-catalog.ts` |
| Onboarding modal (first-run) | `src/renderer/panels/OnboardingModal.tsx` |
| Error boundary | `src/renderer/ErrorBoundary.tsx` |
| Application menu + dev CSP | `src/main/index.ts` |
| Git operations | `src/shared/git-ops.ts`, `git-types.ts` |
| Config + git IPC | `src/main/config-ipc.ts`, `git-ipc.ts`, `ipc-security.ts` |
| Release automation | repository-root `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `build/entitlements.mac*.plist` |
| Parity checklist | `PARITY.md` |
| UI contract | `UI.md` |

## Commands

```bash
npm run dev            # launch Electron
npm test               # unit tests (Vitest; 606 at the current baseline)
npm run test:coverage  # coverage floors (shared + bridge)
npm run typecheck
npm run verify         # lint + unit + source/config parity + typecheck + build + bundle
npm run verify:ci      # verify + coverage + smoke:bridge + e2e
npm run test:e2e       # Playwright Electron harness (12 scenarios)
npm run ui:preview     # renderer in a browser, mocked window.vibe (no engine)
npm run ui:shots       # headless screenshots (non-zero exit on capture failure)
npm run smoke:bridge   # host NDJSON smoke (needs vibe-codr dist host)
npm run smoke:packaged # launch packaged app against its bundled host
npm run copy-host      # embed host for pack (freshness + arch checks)
```

Engine host (repository root):

```bash
cd ../.. && bun run build:macos-bridge
```

## When changing UI behavior

- Mirror TUI `packages/tui/src/app.tsx` semantics first; then macOS `PARITY.md` for GUI-adapted cases.
- Update `PARITY.md` checkboxes when you close a gap.
- Add a Vitest case in `src/shared/parity.test.ts` (or adjacent `*.test.ts`) for pure logic.
- Keep interaction contracts current:
  - Session inspector is explicitly toggled (dock / ⇧⌘I / Review); not auto-opened on send.
  - Project menus: rename/archive/delete; subagent rows are static status summaries.
  - User turns fold from the message itself; **user Copy/Edit/time sit under the bubble**; assistant Copy stays below assistant output.
  - Finder drops resolve native paths with URI/plain-text fallback.
  - Changed files: footer chip beside Jump to latest + dedicated master-detail Diff/File review + Reveal.
  - Desktop rails resize with pointer/keyboard and persisted widths.
  - Workspace dock: Session / Changes / Git / Terminal / Jobs / Files on the chat surface.
  - Activity sidebar geometry: Session / Changes / Git / Terminal / Jobs share
    one edge-attached right-side column; switching views must not replace the chat
    workspace or change the conversation scroll position. Files is the Finder reveal action.
  - Terminal close/switch detaches the renderer only. The main-owned PTY and
    bounded replay buffer survive until app shutdown; projects use their root,
    while Chats use the user's home directory.
  - Custom Instructions stay mounted (hidden) across settings section switches.

## When changing UI presentation (design system)

All renderer styling lives in `src/renderer/styles.css`, token-first. The
canonical visual reference is [design-system.md](./design-system.md). Keep it,
`UI.md`, `README.md`, `VERIFICATION.md`, and the relevant parity/acceptance rows
current whenever layout, styling, or interaction contracts change.

Rules:

1. **No literal hex outside `:root` fallbacks.** Every color is `var(--token)`
   or a `color-mix(in oklab, var(--token) …)` derivation so all TUI themes and
   the light scheme keep working. The `:root` fallback values mirror the
   Graphite default in `src/shared/themes.ts` (first paint must match what
   `applyPalette` writes) — keep them in sync if the default palette changes.
2. **Motion is tokenized and property-scoped.** Use `--ease-enter/exit/standard`
   and `--dur-micro/fast/standard/moderate`; transition only
   transform / opacity / color / box-shadow (never layout); press-down is a
   fast 60ms; the global `prefers-reduced-motion` collapse must keep working.
3. **Focus is keyboard-only and two-layer.** Use `--focus-ring` via
   `:focus-visible`; inputs whose wrapper carries the focus treatment opt out.
4. **Elevation grammar.** Resting surfaces: hairline border + `--edge-highlight`
   (light scheme uses a stronger `--edge-lit` inset so white surfaces still read
   raised). Real layered shadows (`--shadow-menu`,
   `--shadow-modal`) only on true overlays. Menus/popovers sit on `--overlay`.
   Light floating chrome may use soft frost; the shell stays opaque to avoid
   desktop wash. The composer’s frost must cover its full surface so transcript
   text never remains readable through the top edge.
5. **Sans is the UI voice; mono is code.** Electron chrome (tool headers,
   paths, model/metrics, kbd chips, section labels, thinking/notices) uses
   `--font-sans`. Reserve `--font-mono` for real code: fenced blocks, inline
   `` `code` ``, terminal/tool/diff/job output bodies, ASCII wordmark, and rich chart
   glyphs. (TUI still uses mono machine-voice labels in the CLI.)
6. **Verify visually with the preview harness** (no engine needed):
   `npm run ui:preview`, then `?scenario=welcome|splash|chat|table|docs|sources|busy|permission|plan|gate|mode|queue|onboarding|slash|catalog|catalog-draft|mention|attachments|jobs|inspector|toast|density-quiet|density-verbose|ctx-hot`
   plus `settings` and `git`; plus `&theme=<name>`; `npm run ui:shots` captures the matrix headlessly
   (`npx playwright install chromium` once). Screenshot before/after when
   touching shared primitives.

## Intentional non-parity

- OpenTUI cell grid / mouse capture
- Pixel-perfect terminal metrics
- Reimplementing or forking the engine inside `apps/desktop`
