# Vibe Codr (Electron)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

macOS-first **Electron** shell for [vibe-codr](https://github.com/robzilla1738/vibe-codr) with **1:1 engine parity** via the existing NDJSON `vibecodr-engine-host`. Same brain as the CLI TUI — presentation and chrome only live here.

Experimental BYO E2B/Vercel execution and verified Local ↔ Cloud handoff are
documented in [CLOUD.md](./CLOUD.md), with trust boundaries and remaining stable
gates in [CLOUD-THREAT-MODEL.md](./CLOUD-THREAT-MODEL.md). Handoff includes the
complete usable project tree (including Git-ignored files) and automatically
snapshots configured model access before Local ownership is released.

**Repo:** [github.com/robzilla1738/vibe-codr](https://github.com/robzilla1738/vibe-codr)

**Privacy:** [PRIVACY.md](./PRIVACY.md)

**Release history:** [CHANGELOG.md](./CHANGELOG.md)

**Visual target:** Codex / Cursor-inspired desktop shell with OpenTUI-faithful behavior — multi-project + chats rail, seamless right workspace dock (Session / Changes / Git / Terminal / Jobs / Files), quiet empty home, terminal themes/accents, resizable sidebars, changed-files chip + master-detail Diff/File review, and one structural activity sidebar for Session / Changes / Git / Terminal / Jobs.

Sibling native shell: [`vbcodrmacos`](https://github.com/robzilla1738/vbcodrmacos) (SwiftUI). This repo is the Electron equivalent.

## Architecture

```
┌──────────────────┐   IPC    ┌─────────────────┐   NDJSON stdio   ┌──────────────────────┐
│ React renderer   │ ◄──────► │ Electron main   │ ◄──────────────► │ vibecodr-engine-host │
│ (OpenTUI layout) │          │ (spawn + dialog)│                  │  (@vibe/core Engine) │
└──────────────────┘          └─────────────────┘                  └──────────────────────┘
```

| Layer | Path | Role |
|-------|------|------|
| Renderer | `src/renderer/` | Transcript, composer, activity sidebar, terminal view, attachments, permissions, plan, themes, review |
| Preload | `src/preload/` | `window.vibe` bridge API, including terminal IPC and native dropped-file path resolution |
| Main | `src/main/` | Host spawn, NDJSON, persistent contextual PTYs, folder picker, bounded clipboard I/O, `@` file walk |
| Shared UI logic | `src/shared/` | Ported from `@vibe/tui`: reducer, slash, themes, modes, file-fuzzy |
| Engine host | vibe-codr `packages/macos-bridge` | In-process Engine over stdio |

Config/state are **shared with the CLI**:

- Config: `~/.config/vibe-codr/config.json`
- Sessions: `~/.vibe/state`

## Requirements (development)

- Node 22.12+ (required by the Electron 43 development runtime)
- Bun 1.3+
- Compiled host preferred:

```bash
bun install
bun run build:macos-bridge
```

Packaged release builds bundle the revision-locked engine host; end users do
not need Node, Bun, `VIBE_CODR_ROOT`, or a sibling vibe-codr checkout.

## Install

Download the latest direct installer from
[GitHub Releases](https://github.com/robzilla1738/vibe-codr/releases):

- macOS Apple Silicon: open the signed and notarized `.dmg`, then drag Vibe Codr
  to Applications.
- Windows x64: run the NSIS `.exe` installer. A signed installer is used when
  the release environment has the Windows code-signing certificate configured.

Installed macOS and Windows builds check GitHub Releases after launch. Updates
are never installed silently: Vibe Codr asks before downloading and again
before restarting, and safely stops the engine and terminal processes first.

### What’s new in 0.6.5

- Model-provider setup remains above the composer at compact window heights.
  The complete footer stays visible while provider choices and details scroll
  inside the dialog.

## Clone

```bash
git clone https://github.com/robzilla1738/vibe-codr.git
cd vibe-codr
```

## Dev

```bash
bun install
bun run build:macos-bridge   # once / after engine changes
bun run desktop:dev
```

The app opens directly into the main workspace. It restores the last authorized
project, falls through recent projects when needed, and uses the dedicated Chats
workspace on a fresh install. The folder picker is a recovery and project-switching
tool, not a launch gate. Use the same providers/keys as `vibecodr`.

### UI preview (renderer only, no engine)

Renderer work doesn't need the engine host. `tools/ui-preview/` serves the real
React renderer in a plain browser with a mocked `window.vibe` bridge and
scripted session states:

```bash
npm run ui:preview                       # http://localhost:4517/?scenario=chat
npx playwright install chromium          # once, for screenshots
npm run ui:shots -- tools/ui-preview/shots
```

Scenarios: `welcome`, `splash`, `chat`, `table`, `docs`, `sources`, `busy`,
`permission`, `plan`, `gate`, `mode`, `queue`, `onboarding`, `slash`, `catalog`,
`catalog-draft`, `mention`, `attachments`, `jobs`, `inspector`, `changes`, `toast`,
`density-quiet`, `density-verbose`, `ctx-hot`, `settings`, `git` — plus
`&theme=<name>` for any TUI theme. See
[tools/ui-preview/README.md](./tools/ui-preview/README.md).

### Host resolution order

1. `$VIBE_CODR_ROOT/dist/vibecodr-engine-host` (`.exe` on Windows) when fresh against the runtime source tree (otherwise Bun source under that root)
2. `~/Code/vibe-codr` (and conventional siblings)
3. Bundled `resources/vibecodr-engine-host` (`.exe` on Windows; after `npm run copy-host` / pack)

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | electron-vite + Electron window |
| `npm run build` | Compile main / preload / renderer → `out/` |
| `npm test` | Vitest unit suite (lifecycle, protocol, security helpers, parity) |
| `npm run test:coverage` | Same suite with V8 coverage floors (shared + bridge) |
| `npm run test:e2e` | Hermetic Electron UI/IPC/bridge parity scenarios |
| `npm run lint` | Biome correctness and maintainability gate |
| `npm run verify` | Lint + unit + source/config parity + types + build + bundle budget |
| `npm run verify:fast` | Lint + unit + typecheck |
| `npm run verify:ci` | `verify` + coverage + bridge smoke + E2E |
| `npm run verify:source-parity` | AST drift gate against live CLI/shared/bridge sources |
| `npm run verify:config-shape` | Top-level Settings schema drift gate against the engine `ConfigSchema` |
| `npm run verify:bundle` | Renderer JavaScript + staged host binary budget |
| `npm run typecheck` | `tsc` for Electron node, web, and packaged relay projects |
| `npm run ui:preview` | Renderer in a browser with a mocked bridge (no engine) |
| `npm run ui:shots` | Headless screenshot matrix (fails non-zero on capture errors) |
| `npm run smoke:bridge` | NDJSON bootstrap → snapshot → shutdown |
| `npm run smoke:packaged` | Packaged app smoke without developer host fallback |
| `npm run smoke:packaged:relay` | Packaged Continue-on-Phone relay + bundled-host ownership round trip |
| `npm run copy-host` | Copy host binary into `resources/` (freshness + arch checks) |
| `npm run pack` / `pack:mac` | Explicitly unsigned macOS dir build for local/CI smoke |
| `npm run pack:win` | Explicitly unsigned Windows x64 dir build for CI smoke |
| `npm run dist` / `dist:mac` | macOS arm64 `.dmg` + updater `.zip`/metadata (release workflow signs and notarizes) |
| `npm run dist:win` | Windows x64 NSIS `.exe` + updater metadata/blockmap |

## Layout

```
┌────────────┬──────────────────────────────────────────┬────────────┐
│ Projects   │  Project / session top bar               │ Workspace  │
│ + Chats    │  Transcript / splash                     │ dock       │
│ Sessions   │  Plan · permissions · queue · spinner    │ Session    │
│ Git·Settings│ Anchored composer + status + pickers    │ Changes /  │
│            │  Turn-changes card (when files edited)   │ Git /       │
│            │                                          │ Terminal /  │
│            │                                          │ Jobs / Files│
└────────────┴──────────────────────────────────────────┴────────────┘
```

- Content max ~130ch; transcript prose, tool activity, notices, approval panels, and the composer share the font-independent `--transcript-measure: 40rem` reading measure
- **Left rail:** first-class Sessions workspace plus collapsible Projects + Chats sections; project rows reveal icon-only new-chat and ⋯ actions on hover/focus; Settings stays in the footer
- **Sessions workspace:** persistent Board/List management across every project and Chat, with search/filter/sort, automatic Active/Review/Done transitions from live model state, and open/rename/archive/delete actions backed by the existing host APIs
- **Right workspace dock:** full-label Session / Changes / Git / Terminal / Jobs / Files in an equally inset, quietly grey rounded enclosure on the chat surface; compact below ~960px
- **Shared activity sidebar:** Session, Changes, Git, Terminal, and Jobs open in one full-height, edge-attached right pane with equal switcher tabs, one compact Workspace header, a shared resize handle, and responsive drawer behavior. Horizontal divider rules are omitted; spacing and quiet surface shifts organize the chrome. Changes pairs a recursively expandable file tree with numbered Diff/File review and saturated semantic change colors. It is a structural sibling of chat, never a floating card or overlay on desktop. Files remains a Finder reveal.
- **Persistent contextual terminal:** project sessions open at the project root;
  Chats open at the user's home. Each effective-cwd PTY lives in the main process,
  so closing Terminal or switching views preserves commands and buffered output.
  Cloud-owned sessions transparently use the authenticated sandbox PTY and file
  previews; Local/Cloud ownership changes remount the view against the correct
  workspace, while local Git controls pause until the session returns.
- **Long-session recovery:** authoritative engine history is enhanced by a bounded
  IndexedDB presentation cache; corrupt, oversized, unsettled, or schema-invalid
  records are discarded and rebuilt instead of entering renderer state, and
  unavailable browser storage never blocks bootstrap or cleanup.
- **Deferred terminal runtime:** xterm is code-split and loaded only when the
  Terminal activity view first opens, preserving the chat startup bundle.
- **Cross-platform CI install:** macOS-only Liquid Glass is optional, so Linux
  quality/E2E runners skip it while packaged macOS builds retain native chrome.
- Project rail and activity sidebar resize or become drawers at responsive breakpoints; widths persist where resizing is available
- Projects and session titles come from the host's read-only `listProjects` index; Electron never parses vibe-codr state directly
- Themes via `/theme` (same 16 palettes as OpenTUI); accents via `/accent`
- Modes: explained **Plan / Agent / Yolo** menu with neutral icons and a current check in the composer (Shift+Tab still cycles)
- Execution: **Local / Cloud** selection in the composer; changing it opens the same reviewed handoff as `/handoff local|cloud`, names the active model, and includes configured model/subscription access by default with an explicit opt-out
- Slash discovery: one model selector and the complete canonical command set,
  with compact Commands / Skills / System groups cycled by Tab or selected
  directly; descriptive value submenus show the current setting and support
  Escape or Left Arrow to return

### Design system

All styling is token-first in `src/renderer/styles.css` — palette variables are
written by `applyPalette` from the active TUI theme, and every other color is a
`color-mix()` derivation, so all themes (and the light scheme) work with zero
per-theme CSS. On top of the palette sit theme-independent tokens: a locked
type scale, spacing/radii, a motion system (`--ease-enter/exit/standard`,
`--dur-*`, press-down faster than release, `prefers-reduced-motion` collapse),
two-layer keyboard focus rings (`--focus-ring`), and an elevation grammar of
hairlines + inset edge-highlights at rest with layered shadows reserved for
true overlays. **Sans is the UI voice**; monospace is reserved for real code
(terminal grids, fenced blocks, tool/diff/job output, inline code, ASCII wordmark). Icons are
Lucide stroke wrappers in `src/renderer/icons.tsx`. The composer, transcript
output, and approval panels share one 40rem measure. The conversation pane is
edge-to-edge inside the workspace; the composer is a dense, continuously
frosted floating surface so transcript text is blurred across its full bounds
without a hard cut. Approval cards stay opaque. Queue is one quiet card above
the composer with a flat “N Queued” list and hover steer/dequeue. Slash,
mention, and catalog menus are floating and
keyboard-contained; Session, Changes, Git, Terminal, and Jobs open in one
edge-attached activity sidebar without replacing the chat surface. Project/session ⋯ menus are portal-mounted, trigger-anchored, and
toggle cleanly. User-message Copy/Edit/time actions sit **under** the bubble
(trailing-aligned); assistant actions remain below the response. Tool/thinking
rows stay compact under a `Thinking · N steps` group; open thoughts are one
quiet surface (no brain icon). The live Subagents pill jumps to an expandable
per-agent review with task, activity, elapsed time, result, and Copy. User turns
fold by clicking the message. Source/article results use
structured cards. Dropped images and files render as removable attachment chips
and submit as project-aware `@` references. Finder drops use native path
resolution with `file://` URI fallbacks. Changes opens a wider master-detail
review workspace with searchable grouped files, aggregate and per-file stats,
previous/next navigation, Diff/File modes, copy, and Reveal; the footer
changed-files chip links into it. Light scheme keeps edge-lit elevation
and soft frost on floating chrome; `/accent` remaps selection and focus tokens
together. The complete token, layout, elevation, typography, panel, and
responsive contract lives in [design-system.md](./design-system.md).

## Keyboard (essentials)

| Keys | Action |
|------|--------|
| Shift+Tab | Cycle mode |
| Esc | Dismiss · deny permission · abort turn |
| y / a / ⌘P / n | Permission once · session · project · deny |
| Enter / type / Esc | Plan accept · revise · keep planning |
| ⌘Y | Accept plan + YOLO |
| ⌘O | Fold / unfold all turns |
| ⌘T | Expand / collapse thinking |
| ⌘D | Cycle density |
| ⌘G | Compose in `$VISUAL` / `$EDITOR` |
| ⌘V | Paste clipboard image as `@file` |
| ⌘K | Open slash palette |
| ⇧⌘N | Continue latest session |
| ⇧⌘I | Toggle inspector |
| ⌘N / ⌘O | New session / Open project |
| ⌘J / ⇧⌘J | Terminal / Background jobs |
| ⌘/ | Keyboard shortcuts |
| `/` | Slash commands |
| `@` | Attach file (fuzzy) |

Full list: type `/keys` in the composer. See also [PARITY.md](./PARITY.md).

## Settings & onboarding

- **First-run onboarding wizard**: Recommended / Local / All provider views plus
  full-catalog search, generated from
  the same models.dev registry used by OpenCode (166 current catalog providers)
  plus Hermes-compatible aliases and native Bedrock/Vertex/Azure setup (192
  choices / 190 provider ids at this sync), key entry with get-a-key links,
  automatic known endpoints, curated CrofAI, endpoint prompts only where required,
  built-in ChatGPT/Codex and xAI/Grok subscription sign-in, direct Codex 5.3 /
  Grok 4.5 / Grok Build selection, and transactional save → re-bootstrap;
  setup stays open with recovery guidance until the new engine configuration
  actually starts
- **Progressive settings**: everyday Providers, Models, Appearance, Behavior,
  Permissions, Cloud, and Instructions stay visible; the remaining technical
  sections stay searchable behind **Advanced settings**. Models keeps its default
  selection primary and collapses planning/fallback/reasoning/performance/pricing
  and context overrides. Providers opens first, separates subscriptions from
  API/local/custom routes, keeps credential/model/required URL primary, fills
  known URLs, and collapses transport/token/header overrides.
- **Full-workspace coverage**: 15 sections still cover every config field — Models
  (default, planning, fallbacks, reasoning, turn/stream/queue limits,
  pricing/context-window overrides),
  Providers (full catalog dropdown, free-text arbitrary IDs, transport and
  explicit-model controls, subscription connection cards), MCP Servers (stdio + remote,
  reversible transport drafts and strict `${VAR}` / `${VAR:-default}` preflight,
  headers/environment, OAuth token-store settings),
  Permissions (tool plus mutually exclusive glob/exact scope and action), Appearance (16 themes + accent
  swatches), Behavior (mode, approvals, sandbox, checkpoints, trust), Subagents,
  Build & Verify (recon, green gate, checks, review, worktrees, ensemble, plan
  gate), Memory, Search & Web, Compaction, Budget & Retry, Hooks, Custom
  Instructions (VIBE.md), Advanced (trusted plugins, LSP plus per-language
  server overrides, vision relay, verify, updates, goal/loop, orchestration)
- **Project trust is global-only**: a repository cannot authorize its own
  providers, hooks/plugins/MCP, LSP or verify commands, sandbox/SSRF
  relaxations, auto approvals, or broad allows. Exact scoped grants created by
  “Always for this project” and deny/ask rules still work while untrusted.
- **Draft-safe editors and saves**: incomplete header/environment lines remain
  visible with inline validation; config and instructions saves snapshot the
  submitted revision, so edits typed while a write is in flight remain dirty
  instead of being silently marked saved.
- **Atomic, bounded config writes**: temp+rename so a crash mid-write can't
  corrupt the config; per-path write serialization prevents concurrent
  clobber, settled queues are evicted, and the writer cannot create a file the
  reader's 2 MB safety limit would reject
- **Pre-write validation**: structural types, MCP/OAuth URLs, enums, and engine
  numeric ranges are checked before persisting — invalid values are rejected
  with a helpful error, not written; CI also fails if the engine adds or removes
  a top-level config field without a matching shell type
- **Bounded capability catalogs**: stale model/provider/agent/skill/MCP RPCs
  cannot reopen or clear a newer picker, and persisted favorite/recent model IDs
  are deduplicated and capped before rendering

Provider authentication, custom endpoints, Grok Build, and the Local/Cloud
credential boundary are documented in [PROVIDERS.md](./PROVIDERS.md).
- **Native close safety**: unsaved Settings, custom instructions, and malformed
  local editor drafts are synchronized to main; window close and Cmd/Ctrl+Q
  confirm before discarding or beginning engine/terminal shutdown
- **Deep-diff save**: only changed keys are persisted; clearing a field sends
  `null` (delete) instead of `undefined` (no-op)
- Config is shared with the CLI at `~/.config/vibe-codr/config.json`

## Security & resilience

- **Content Security Policy**: strict CSP in `index.html` (`default-src 'self'`);
  dev-mode relaxation for Vite HMR via `onHeadersReceived` only when
  `ELECTRON_RENDERER_URL` is present
- **React ErrorBoundary**: uncaught render errors show a recovery card with
  Reload instead of blanking the window
- **Application menu**: standard desktop roles plus New Session, Open Project,
  Continue Latest, Settings, Git, Inspector, Terminal, Background Jobs,
  Check for Updates, Keyboard Shortcuts, documentation, and issue reporting
- **IPC security**: all handlers assert trusted sender; context isolation +
  sandbox enabled; `nodeIntegration: false`
- **Bounded transport and output**: host NDJSON lines, individual commands,
  stdin backpressure queues, reasoning, tool bodies, diffs, clipboard data,
  file reads, terminal replay, and subprocess capture all have explicit ceilings
- **ATS**: `NSAllowsArbitraryLoads=false`, `NSAllowsLocalNetworking=true`;
  unused permission strings (camera/mic/Bluetooth) stripped in `after-pack`
- **Release integrity**: CI and release jobs pin third-party actions by commit
  SHA and build a native host from the commit in `ENGINE_COMMIT`; version tags
  must produce both a signed/notarized arm64 app/DMG/ZIP update and a Windows
  x64 NSIS installer before one GitHub Release is published with update feeds,
  differential blockmaps, and SHA-256 checksums

## Features (shell)

Everything the TUI exposes through `EngineCommand` / `UIEvent` — tools, MCP, memory, orchestration, build gate, etc. run in the host unchanged.

Shell-owned surfaces:

- Streaming transcript (lightweight plain text while generating; finalized Streamdown GFM with Shiki + line numbers, diffs, tools, thinking, and low-noise notices)
- Permission + plan approval cards (human titles, soft chrome, deny-reason on demand)
- Slash palette (one `/model` entry; complete canonical Commands / Skills /
  System groups plus custom `commandNames`; descriptive value submenus), catalog
  pickers (model context window shown), and direct
  guided provider setup from **Set up another provider…** or unconfigured rows
- Multi-project + Chats rail (collapsible sections, + add project / new chat, resume, filter; Continue Latest via ⇧⌘N)
- Workspace dock: Session / Changes / Git / Terminal / Jobs / Files on the chat surface;
  Session, Changes, Git, Terminal, and Jobs share one mutually exclusive right-side lane
- Changed-files chip after edits, sharing one row with Jump to latest; dedicated searchable master-detail Changes review
- Jobs activity view with live auto-follow output, localhost links, and copy
- Anchored streaming with intentional scroll disengagement and Jump to latest
- `@` fuzzy attach, clipboard image paste, external editor
- Finder drag/drop for images and files, including removable previews, mixed
  batches, duplicate detection, native path resolution, and URI fallback
- Stop control with elapsed time until `engine-idle` (Esc still interrupts); green-gate RED notice
- Session inspector closed by default; open from dock, Review, ⇧⌘I, or live chips;
  it shares the right-side lane with Changes, Git, Terminal, and Jobs and does not replace
  the chat workspace
- Project rail and right-side activity panels are responsive, with persisted
  desktop widths where resize handles are present
- Theme-faithful selection colors, headings, and user-message accent (neutral-white Vibe Dark default; `/accent` remaps)
- Empty-home splash: the same stylized, fluidly scaled ASCII wordmark at every window size, centered composer, and no automatic prompt suggestions
- Project rail: rename/archive/delete on hover, titled sessions, working-only spinner for the active busy session
- Host fatal recovery: **New session** on the boot-error card
- Memory notice: quiet `Memory · N notes` disclosure with click-to-expand note details
- Sources/articles: numbered reading cards with title, domain, and snippet hierarchy
- User turns: click or keyboard-activate the message to collapse/expand; actions under the bubble
- Engine-owned gate/review/verification continuations: compact expandable context rows, visually distinct from user messages and without user Copy/Edit actions
- Lucide icons across chrome, composer, and tool-row glyphs
- Accessibility: ARIA combobox pattern in composer/catalog, labeled regions, keyboard-focusable scrollable output, narrow busy/idle live status (transcript is not live), hover/focus copy and edit icons with keyboard focus (touch keeps them visible), busy-disabled rail labels, skip links to conversation/composer/projects/session panel, catalog focus trap
- App icon: `assets/icon.png` → `npm run build:icon` → `assets/icon.icns` for packaged builds; the master uses an Apple-style transparent safe area, squircle silhouette, optical scale, and edge highlight, and the unpackaged macOS dock uses the PNG via `app.dock.setIcon`

## Parity & verification

See **[PARITY.md](./PARITY.md)** for the full CLI ↔ Electron checklist (modeled on the macOS app’s parity doc).

Manual smoke steps: **[VERIFICATION.md](./VERIFICATION.md)**. Agent notes:
**[AGENTS.md](./AGENTS.md)** and its mirrored **[CLAUDE.md](./CLAUDE.md)**.

```bash
npm run verify && npm run smoke:bridge && npm run test:e2e
```

Current baseline: **622 passing unit tests** (2 paid-provider tests skipped), **12 Electron E2E scenarios**, 21 source
parity pairs, 40 top-level config fields, Biome, typecheck, production build,
and renderer bundle budget pass in the current checkout. Settings, Terminal,
Git, and Changes are isolated from the initial renderer chunk. CI runs `verify` +
coverage floors + bridge smoke + E2E on Linux and unsigned native-host pack
smokes on macOS and Windows; the tag workflow signs, notarizes, verifies, and
publishes both platform artifacts as one release.
Prefer live `npm test` counts over frozen numbers in prose. The deterministic preview matrix covers
attachments, settings, Git, Session review, light mode, and alternate themes.
Hardening backlog: [plans/IMPROVEMENT-AUDIT.md](./plans/IMPROVEMENT-AUDIT.md).
See [design-system.md](./design-system.md), [VERIFICATION.md](./VERIFICATION.md),
and [ACCEPTANCE.md](./ACCEPTANCE.md) for the visual contract, acceptance
contract, and release gates.

## Project layout

```
vbcode-electron/
  src/main/           # Electron main + EngineBridge + host resolver + PTY owner
  src/preload/        # contextBridge API, including terminal IPC
  src/renderer/       # React UI, activity sidebar, and xterm renderer
  src/shared/         # Pure ports from vibe-codr TUI / shared contracts
  scripts/            # copy-engine-host, smoke-bridge, pack helpers
  test/               # Playwright e2e + fixtures
  tools/ui-preview/   # Browser renderer preview (mocked bridge) + screenshots
  PARITY.md
  ACCEPTANCE.md
  VERIFICATION.md
  design-system.md
  AGENTS.md
  README.md
  LICENSE
```

## Related

- Engine / CLI TUI: [vibe-codr](https://github.com/robzilla1738/vibe-codr) (`packages/macos-bridge` NDJSON host)
- Native macOS shell: [vbcodrmacos](https://github.com/robzilla1738/vbcodrmacos)
- This Electron shell: [vbcode-electron](https://github.com/robzilla1738/vbcode-electron)
