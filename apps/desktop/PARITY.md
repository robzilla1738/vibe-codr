# CLI ↔ Electron parity checklist

Manual smoke against OpenTUI / `vibecodr` in the **same project cwd**. Automated:
`npm test` (current live suite), `npm run test:e2e` (13 scenarios),
`npm run verify:source-parity` (22 declaration pairs),
`npm run verify:config-shape` (40 top-level engine fields), and CI
coverage/bridge/packaged-host gates.

## Experimental Local ↔ Cloud

- [x] Provider-neutral local-process and authenticated remote-WebSocket transports
- [x] Portable engine export/import with revision lock and monotonic ownership generations
- [x] Deterministic workspace transfer, staged/unstaged Git state, hashes, exclusions, and divergent safe return
- [x] E2B and Vercel adapters behind one lifecycle contract
- [x] Cloud settings, protected credential bindings, composer Local/Cloud target, route-and-boundary confirmation, first-class `/handoff` palette choices, status, and bundled skill
- [x] Desktop close/reopen attaches to the cloud owner without starting a local writer
- [x] Cloud import and daemon bootstrap share one canonical state root and prove the exact session ID, model, mode, subagent model, and conversation survive before ownership commits
- [x] The permanent isolated Cloud workload preflights the imported session before health succeeds; explicit missing resume fails closed and cannot create a replacement chat
- [x] Required model credentials are session-scoped into Cloud by default (configured keys plus connected Codex/Grok access), with global/per-handoff opt-out and explicit-binding fallback; missing authentication and local-only routes fail before provisioning
- [x] Every active model performs a bounded real generation through the imported engine provider registry inside the sandbox before ownership commit; this covers API-key, subscription, Ollama Cloud, and arbitrary Chat Completions/Responses providers on both E2B and Vercel
- [x] A versioned runtime profile preserves and synchronizes theme, accent, and transcript density; renderer attach cannot replace an established appearance with a remote default
- [x] Model access crosses Cloud as a sealed session envelope, is validated by the actual resumed engine, and is excluded from terminal environments, logs, catalog values, and health values
- [x] Legacy 0.6.2 Cloud catalog rows repair their runtime in place from the frozen protected credential snapshot only after authenticated engine-idle and graceful shutdown; active terminals defer repair, while failure preserves Cloud ownership and exposes Return Local without prompt replay
- [x] Cloud return exports as the isolated workload owner and survives tracked deletions
- [x] Fresh live E2B/Vercel provider lifecycle suites plus a packaged E2B
  workspace/model handoff and clean return passed on 2026-07-17
- [x] Packaged E2B handoff routes file previews and a persistent PTY through the
  authenticated Cloud agent, then returns cleanly and deletes the sandbox
- [x] Continue on Phone is main-owned and private-LAN/Tailnet-only over plaintext;
  public routing requires WSS
- [ ] Stable flag removal: enable the provider-neutral local integration
  executor only after its relay acceptance suite and verify Vercel firewall
  brokering

Engine ownership stays in `@vibe/core`; this app is a presentation shell over NDJSON (`macos-bridge` protocol). Public repo: [vbcode-electron](https://github.com/robzilla1738/vbcode-electron).

## Mobile extension contract

- [x] Every request-response relay service is correlated by request ID; pending
  calls reject on disconnect instead of cross-resolving or hanging.
- [x] Mobile reconnect retries for the lifetime of active ownership with capped
  delay, rejects stale socket generations, preserves busy until `engine-idle`,
  and atomically replays live events after snapshot hydration.
- [x] The relay detects dead controllers without stopping their engine. The
  packaged journey drops the phone socket, resumes the exact session, exercises
  concurrent services, then releases ownership explicitly.
- [x] Permission, plan, question, and queue gates expose the applicable desktop
  decisions; plan content and evidence are visible before approval.
- [x] Inspector checkpoint actions, expanded subagent detail, all activity
  categories, and typed cancellation are reachable on mobile.
- [x] Native document/image selection and authenticated bounded upload to the
  Mac. iOS Simulator Photos selection produced a byte-identical `0600` project
  file; the Files picker opened, and bounded/error-isolated batch behavior is tested.
- [ ] Phone execution of durable Needs-your-Mac requests. The engine now returns
  live results/errors and retains handoff-time resolutions for exactly-once
  consumption by the originating caller; a production local-only tool caller
  still needs to adopt the contract.
- [ ] Physical iPhone/iPad background, radio-loss, camera/document selection,
  and repeated handoff acceptance. Devices were offline during the 2026-07-18
  audit; Expo Doctor and iOS/Android production exports passed.

The authoritative row-by-row classifications and evidence are in
[`mobile/PARITY.md`](./mobile/PARITY.md). “Applicable parity” excludes Finder,
host editor, updater/window chrome, and full-screen terminal emulation.

## Durable planning and orchestration

- [x] Pending plan approvals rehydrate from `EngineSnapshot.planState` after a
  renderer/host restart, including sources, assumptions, and grounding warning.
- [x] Structured agent questions render in the existing decision-card layer and
  resolve through typed commands; choice, multiselect, freeform, abort, timeout,
  and stale-session settlement stay engine-owned.
- [x] Jobs is the unified background-activity surface for shell jobs, detached
  agents/task batches, and durable monitors, with status and cancellation.
- [x] Session → Subagents exposes the worker role, live activity, elapsed time,
  turn/tool/token/error metrics, final result, and bounded transcript.
- [x] Goal snapshots carry the frozen acceptance contract plus stagnation and
  strategy-reset counters; the shell preserves the existing goal presentation.

The parity scripts compare declaration/config ASTs with the exact revision in
`ENGINE_COMMIT`, read from the repository selected by `VIBE_CODR_ROOT` or
`~/Code/vibe-codr`. A local sibling checkout may be ahead or dirty without
changing that contract. Packaging separately requires a clean runtime checkout
whose HEAD equals the lock before it will embed a rebuilt host.

## Automated (unit)

- [x] Transcript reducer: user/assistant/tool/diff/thinking/notice
- [x] History hydrate from snapshot messages
- [x] Slash routing mirrors TUI `lineToCommands`
- [x] Permission answers + slash passthrough while pending
- [x] UiMode cycle + plan-pending does not flip optimistically
- [x] NDJSON codec (bootstrap encode / ready+fatal decode)
- [x] Theme registry covers all `THEME_NAMES`
- [x] Density overlay quiet/normal/verbose
- [x] chrome-seed merge (session-start + snapshot)
- [x] file-fuzzy ranking + `@` mention detect
- [x] keys-help essential chords
- [x] Palette merges custom `commandNames`
- [x] Project filtering, duplicate-name labels, and relative session time
- [x] Web-search/source parsing, task windowing, and native light/dark scheme
- [x] Catalog draft detectors + MCP normalize + provider/agent option builders
- [x] Theme palette parity: DEFAULT = Vibe Dark (warm chrome on near-black surfaces); legacy `opencode` falls back to default
- [x] Rich-block richKind routing (chart/line/pie/weather/sources)

## Core session loop

- [x] Open project → engine bootstrap → wait for `ready` → snapshot
- [x] Direct-to-workspace launch: try the last authorized cwd, then host-ordered
  recents, then the authorized Chats workspace; a workspace is persisted only
  after bootstrap and snapshot validation succeed
- [x] Resume restores structured thinking/tool/output history through the host's
  authoritative session record, falls back to `snapshot.history` with older
  hosts, and reuses an exact bounded IndexedDB presentation cache when the
  payload is size-consistent, settled, signature-valid, and deeply schema-valid;
  authoritative conversation signature still matches
- [x] Submit prompt → streaming assistant text + tool rows
- [x] `busy` held until `engine-idle` (not per-turn idle)
- [x] Reasoning → compact grouped Thinking disclosure with collapsed thought rows; ⌘T toggles
- [x] Mode cycle PLAN / AGENT / YOLO (⇧Tab); plan-pending gate
- [x] Leaving plan mode dismisses plan card (mode-changed → plan: null)
- [x] user-message resets subagents list (per-turn clean slate)
- [x] Permission card: once / session / project / deny + y/a/n / ⌘P keys
- [x] Plan card: Enter accept / type revise / Esc keep / ⌘Y accept+YOLO
- [x] Queue steer + dequeue while busy
- [x] `/clear` & `/new` abort + full local reset + suppress stale stream (full clearScopedEventTypes parity)
- [x] `/jobs` opens Jobs in the shared activity sidebar (chat stays); Esc / Close dismisses
- [x] Esc aborts in-flight turn
- [x] Graceful quit finalizes session (`finalize` RPC + shutdown)
- [x] Busy cue until engine-idle (composer Stop + elapsed; Esc via keyboard / Stop title)
- [x] `engine-idle.gate` red banner

## Transcript fidelity

- [x] Assistant output streams as lightweight plain text, then finalizes into Streamdown + GFM
- [x] Diff blocks green/red hunk coloring
- [x] Tool icons + condensed labels; expand on click; auto-expand on error
- [x] Each turn consolidates reasoning, tools, and intermediate progress into one
  `Work · N steps` disclosure; density supplies defaults only, every visible
  Work/tool/thinking disclosure remains interactive, empty-output tools do not
  advertise a fake chevron, and the final answer stays outside
- [x] Turn fold (click or keyboard-activate the user bubble / ⌘O fold-all; no persistent arrow); density quiet/normal/verbose (⌘D)
- [x] Windowed transcript (“N earlier turns”) with progressive reveal (20 at a time)
- [x] Per-turn item windowing for long tool runs (cap 120, step 24, reveal page)
- [x] Electron hard-caps live reasoning state (256 KiB), the compact Trail
  preview (16,384 characters), tool bodies, and file diffs; the source-parity
  guard records the intentional Trail renderer-safety divergence
- [x] Streaming follows only while anchored; upward scroll reveals Jump to latest
- [x] Notices use restrained level semantics; density acknowledgements are silent and verbose warnings collapse
- [x] Web-search results + `sources` fences as safe external source cards
- [x] Rich data views: bar/line/sparkline/pie/weather fenced blocks render as visual components (RichBlockView)
- [x] Active-task windowing; completed task panels retire with the CLI
- [x] Subagent activity rows show status/result/elapsed state without an expandable detail transcript
- [x] Narrow-mode tasks / subagents / thinking panels

## Catalogs & chrome

- [x] Slash palette (`/` / ⌘K) with descriptive enum submenus + custom commands;
  one discoverable `/model` action, Tab-cycled Commands / Skills / System
  groups, current-value markers, breadcrumb/back navigation, and a source-parity
  gate requiring every canonical engine command
- [x] Exact-command input cue via `commandNames`
- [x] Model picker with main ⇄ subagent target toggle + agent target (`/model agent …`)
- [x] `subagentModel` tracked from snapshot; Clear → inherit for sub/agent
- [x] Providers: configured → prefill `/model id/`; unconfigured → guided provider/model setup (no manual key command)
- [x] Agents: prefill `/model agent name `; New agent prefills `/agents new ` (no empty submit)
- [x] Skills: prefill `/skill name ` (args editable)
- [x] MCP roster matches host `listMcp` shape (connected · toolCount · error)
- [x] Live draft catalogs: typing `/model …`, `/providers`, `/agents`, `/skills`, `/mcp` opens/filters pickers
- [x] Native catalog dialog: focus trap (Tab cycle + focusin guard; draft-linked allows composer), arrows, Enter, Esc, focus return, aria-modal
- [x] Catalog filtering, no-results state, current-model marker, and RPC failure feedback
- [x] Multi-project + Chats rail with collapsible sections, section +, titles, resume/filter; Continue Latest via ⇧⌘N / menu
- [x] Project/session rename, archive, and delete menus with in-app confirmation; project menus escape rail clipping
- [x] Sessions workspace: persistent Board/List views across all projects and
  Chats, search/filter/sort, automatic Active/Review/Done transitions, live
  current tool/task and wait insight plus task/agent/job/queue/change/context/
  usage/model/mode/goal telemetry, end-turn metadata refresh, honest Local/Cloud
  ownership and error state, and open/rename/archive/delete management
- [x] Workspace dock (Session / Changes / Git / Terminal / Jobs / Files) on chat surface; no topbar duplicates
- [x] Changed-files chip after edits; dock Changes opens the dedicated master-detail review
- [x] Host fatal / boot error: primary New session recovery
- [x] `/jobs` drawer: live auto-follow terminal (full outputTail, stick-to-bottom, jump-to-latest); Close without Esc chip; quiet status/link chips
- [x] `@` fuzzy file attach (TUI `file-fuzzy` ranking)
- [x] Finder drag/drop for images and files: removable chips, mixed batches,
  duplicate normalization, native Electron path resolution, and `file://` /
  plain-text path fallbacks
- [x] Clipboard image → `@.vibe/clipboard/….png` (⌘V)
- [x] External-editor compose (⌘G; empty/non-zero keeps draft)
- [x] Theme / accent via engine events → CSS variables; value menu marks current
- [x] Theme palette also drives native control/dialog color scheme
- [x] Goal header ★ + phase/round; git dirty count / ahead / behind
- [x] Composer status: model · changed +/− · ctx% (hot ≥80%) · tokens · cost · queue · working
- [x] Inspector (⇧⌘I / dock Session): dynamic session/file title, shared activity sections,
  changed-file Diff/File review with line gutters, in-panel file preview +
  Reveal, checkpoints undo/redo; the live Subagents pill focuses expandable
  child details with task, activity, elapsed time, result, and Copy
- [x] Changes uses a dedicated persisted-width master-detail workspace with
  searchable directory groups, aggregate/per-file stats, churn balance,
  previous/next navigation, Diff/File modes, copy, and Reveal; compact drawers stack.
- [x] Project rail + Session inspector: pointer and Arrow/Home/End keyboard resizing,
  persisted widths, and hidden handles in narrow drawer layouts
- [x] Settings Custom Instructions stay mounted across section switches (dirty drafts preserved)
- [x] `/keys` local help surface
- [x] Onboarding points at shared `~/.config/vibe-codr/config.json`
- [x] Plugins / custom commands via `snapshot.commandNames` (no install UI — same as TUI)
- [x] Orchestration task list from `orchestration-task` events (no interactive DAG graph)

## Packaging & bridge

- [x] Host resolution: fresh compiled dist → Bun source fallback when runtime sources are newer → bundled resources
- [x] `npm run copy-host` / `npm run pack` copies host
- [x] Ready timeout 45s, RPC timeout 20s
- [x] Bounded NDJSON transport: 32 MiB output-line ceiling, 900 kB safe
  inbound-message ceiling below the host's 1 MB parser limit, and a 32 MiB
  stdin backlog ceiling behind stream backpressure
- [x] Read-only `listProjects` host index keeps session storage out of Electron
- [x] Bridge smoke: `npm run smoke:bridge`
- [x] Packaged renderer runs sandboxed with a CommonJS preload bridge
- [x] Packaged macOS and Windows apps prefer their release-matched native bundled host over developer checkouts
- [x] Custom macOS app icon with optical safe-area padding; restrictive ATS; no unused hardware permission descriptions
- [ ] Full interactive GUI smoke of every slash against live paid models (manual)
- [x] Standalone macOS/Windows packaged-app smoke without `VIBE_CODR_ROOT`: bundled host
  boots, restores the project, applies a command, and leaves no orphan process

## Intentional non-parity

- OpenTUI cell-grid / mouse capture / `/mouse` (listed in palette as no-op)
- Pixel-perfect terminal glyph metrics
- Engine reimplementation in Electron
- Plugin install/enable UI (CLI has none — config + `commandNames` only)
- Live MCP reconnect/install RPC and the first interactive OAuth grant
  (server config is edited in-app and loaded on the next bootstrap; OAuth token
  refresh works, but first authorization remains out-of-band in the engine)
- Job-kill UI (none in TUI)
- Interactive orchestration DAG graph (list only; TUI ignores the event)
- Full-window Liquid Glass replacing CLI theme surfaces (glass tints chrome only; palettes still drive semantic roles)
- Permission/Plan button labels use human verbs with `<kbd>` hints (TUI key chords still work)
- Electron prose, tool activity, notices, approval panels, and composer share the font-independent `--transcript-measure: 40rem`; composer uses a taller resting input (`--composer-input-min: 44px`)
- TUI select-to-copy auto-clipboard toast (Electron uses native selection + Cmd/Ctrl+C)
- TUI `/mouse` capture (palette lists it; Electron UI ignores `mouse-changed`)
- Width-fitted footer key-hint bands (Electron uses composer metrics + `/keys` help)

## How to verify

```bash
cd ~/Code/vibe-codr && bun run build:macos-bridge
cd ~/Code/vbcode-electron
npm install && npm test && npm run typecheck && npm run build
npm run lint && npm run verify:bundle
npm run smoke:bridge
npm run test:e2e
npm run dev
```

## Additional parity items (session 2)

- [x] Rich data views (bar/line/sparkline/pie/weather) render in assistant markdown via RichBlockView
- [x] Permission grant notices include toolLabel (TUI parity)
- [x] Usage label matches TUI formatUsage: `12.3k tok · $0.0421 · 1.1k cached`
- [x] Thinking trail persists across bursts + survives past turn end (Trail class wired in)
- [x] Per-event try/catch surfaces handler errors as transcript notices
- [x] Mode-changed dismisses plan card when leaving plan mode
- [x] user-message resets subagents + thoughtLog (per-turn clean slate)
- [x] subagent-activity only touches running subagents
- [x] plan-presented finalizes assistant text before showing card
- [x] flushDeltas before tool-finish and file-changed (TUI enqueue→landPending parity)
- [x] Source parity check covers themes, glyphs, wordmark (19 pairs)
- [x] Session chrome state tests: mode/plan dismissal, user-message reset, subagent-activity guard
- [x] Session bootstrap preserves the active workspace tool and restores transcript scroll per session instead of resetting the editing view

## Additional parity items (session 3)

- [x] Theme palette DEFAULT synced: warm heading/accent, dark selection band, and series ramp (source parity)
- [x] CSS :root fallbacks match synced default palette (no first-paint flash)
- [x] Selection colors: slash menu + catalog rows use --sel-bg/--sel-fg (dark band on Vibe Dark; `/accent` remaps)
- [x] Markdown headings use --heading (warm on Vibe Dark; follows `/accent` when set)
- [x] Table headers use --heading (TUI parity)
- [x] User message left accent border using --user color (TUI ❯ marker parity)
- [x] Splash uses one solid, stylized ASCII wordmark whose container-relative scale survives every breakpoint
- [x] Busy cue shows elapsed time via workingLabel (TUI parity)
- [x] Busy cue: Stop button is the primary interrupt (elapsed + Esc hint via title; no separate Esc chip)
- [x] Goal suffix: plan phase reads "planning" (not "plan"), no round/max until execute (TUI parity)
- [x] CycleMode shows notice when plan-pending prevents mode switch (TUI parity)
- [x] Stream flush interval matches TUI (24ms, was 32ms)
- [x] Tool progress chunks coalesced on flush timer (TUI landPending parity)
- [x] Model picker shows context window size via fmtContext (TUI parity)
- [x] Empty home keeps a quiet wordmark and composer without automatic prompt suggestions
- [x] Ungrounded plan warning matches TUI wording: "⚠ ungrounded — presented without the research…"
- [x] Jobs view shows PID when running (TUI parity)
- [x] Inline panel titles show counts: "Tasks · N/M", "Subagents · N/M done" (TUI parity)
- [x] Inline subagent rows show activity, result glimpse, elapsed time (TUI parity)
- [x] Permission card: human kind title (not raw tool id); soft neutral chrome; Deny reveals reason; technical JSON collapsed
- [x] Slash menu + catalog headers use --heading color (TUI palette.heading)
- [x] --focus CSS variable wired into --focus-ring (dead variable cleanup)
- [x] Clipboard temp dir cleanup on quit (TUI cleanupClipboardTempDir parity)
- [x] Z-index on .panels + .composer-stack prevents transcript pointer interception
- [x] E2e test assertions fixed: focus ring, ctx gauge, inspector label, thinking label
- [x] editor-compose.ts synced with full TUI JSDoc comments

## Hardening audit (session 4)

- [x] Host generations isolate stale ready/event/RPC output during rapid restart
- [x] Async child stdin/stdout/stderr failures become one actionable fatal state
- [x] NDJSON inbound/outbound messages, UI events, RPC results, and IPC inputs are runtime validated
- [x] Overlapping renderer bootstraps and project refreshes are latest-request-wins
- [x] Stale session events cannot mutate the active renderer session
- [x] Session mutation ids reject traversal/path components; missing delete/archive return failure
- [x] Host-level mutation and malformed/pre-bootstrap RPC coverage
- [x] Pure chrome/session state machine extracted from transport lifecycle
- [x] Biome lint, renderer bundle budget, Linux CI, and macOS/Windows packaged smoke gates
- [x] E2E session rename/archive/delete, fatal-host recovery, narrow layout, and reduced motion

## DAG status, accessibility, and StrictMode fix (session 5)

- [x] DAG sidebar/inspector render failed and skipped statuses with distinct colors (--task-failed/--task-skipped CSS tokens derived from --del/--muted)
- [x] StatusDot in both Sidebar and Inspector supports failed/skipped (was mapping to "pending" in Inspector — visual bug)
- [x] DAG rows show ellipsis truncation + title tooltips for long objectives
- [x] Orchestration rows cleared on user-message (per-turn clean slate, matching subagents reset)
- [x] Test added for orchestration reset on user-message (66 total unit tests)
- [x] ARIA combobox pattern in Composer (aria-autocomplete, aria-expanded, aria-controls, aria-activedescendant)
- [x] ARIA combobox pattern in CatalogModal (aria-controls, aria-autocomplete, aria-activedescendant, target toggle label)
- [x] Transcript aria-controls on expand/collapse buttons + aria-label on log and jump button
- [x] WelcomeGate: aria-busy, aria-labelledby, aria-live, focus primary action button
- [x] LivePanels (permission/plan cards): role=region, aria-labelledby, aria-keyshortcuts; permission card autofocuses primary action, plan keeps composer focus for revise/steer
- [x] JobsView: role=region, article elements, aria-label on status/output, keyboard-focusable output pre
- [x] Inspector: h2 heading, aria-labels on file rows, and keyboard-accessible
  subagent disclosures with focused pill navigation and bounded result output
- [x] ProjectRail: h2 heading, aria-controls, role=group, first menu item focus on open
- [x] Splash: section with aria-labelledby and quiet empty-state copy; no suggestion controls
- [x] Busy cue: composer Stop + elapsed; sr-only busy/idle live status; Esc via keyboard / Stop title
- [x] OnboardingHint: aside with role=region, h2 heading; no autofocus (composer / perm / plan own focus)
- [x] SourceList + MarkdownView: role=status on empty state, aria-label on list, title on external links
- [x] App toast: aria-live and aria-atomic
- [x] Sidebar thinking trail: keyboard-scrollable live region (role=log, tabIndex, aria-live)
- [x] Transcript is not a live region (role=region); busy/idle announced via narrow sr-only status
- [x] Copy controls always visible at muted rest (not hover-gated opacity)
- [x] Busy-disabled rail actions/session rows expose the stop-turn reason via aria-label
- [x] Skip links: conversation, composer, projects (when open), session panel (when open)
- [x] Named breakpoints (`BREAKPOINTS` in shared + CSS comments): wide 1280 / laptop 1100 / tablet 900 / compact 720 / narrow 640
- [x] Shared `drawer-scrim` + `--drawer-start-w` / `--drawer-end-w` / `--shadow-drawer(-end)` for rail & inspector overlays
- [x] Narrow widths keep truncated model chip (12ch) instead of hiding it
- [x] Coarse-pointer: composer status reflows; chips stay compact; submit stays 44px
- [x] Shared `primitives.tsx` (`ExternalLink`, re-exports MetaRow/StatusDot/chrome formatters); context-line + splash + topbar use `projectLabel` / shared git·goal
- [x] Elevation tokens `--elev-rest|overlay|modal|strip`; shadows/z-index tokenized (`--z-*`, `--shadow-ink` / `--edge-lit`)
- [x] Composer: stable metrics slot (trailing); density chip (quiet/normal/verbose, click = ⌘D)
- [x] Inspector checkpoints / file preview use `.button` (not legacy `.chip`)
- [x] `ui:shots` adds toast, density-quiet/verbose, ctx-hot (busy-narrow covers compact activity strips)
- [x] CSS: margin:0 added to .rail-section-label, .onboarding-title, .topbar-title for h2/h1 elements
- [x] CSS: :focus-visible on .job-output for keyboard focus ring
- [x] CSS: literal hex #1b2430 replaced with #000 (design system rule: no literal hex outside :root)
- [x] CSS: duplicate .rail-section-label and .topbar-title blocks merged
- [x] StrictMode dev hang fixed: bootstrapGate.invalidate() removed from useEffect cleanup (redundant with begin() in bootstrap; was causing bootstrap to always return false in dev due to StrictMode double-invocation)
- [x] Composer aria-expanded fixed: false when slash menu open but has 0 items (was always true when palette.open)
- [x] Preview harness: orchestration-task events (running/completed/failed/skipped) added to busy scenario

## Agent-home polish + typography (session 6)

- [x] Empty-home: invariant stylized ASCII wordmark, quiet tagline, centered composer, no automatic suggestions; fluid container-relative scaling; launch restores directly into the main shell, while WelcomeGate remains recovery-only and SessionBoot owns in-shell boot copy
- [x] ProjectRail: active session surface highlight (no accent bar/dot); always-on search; measured context menus; archive confirm; topbar brand when rail closed
- [x] Composer: shared transcript/activity/notice/approval/composer measure (`--transcript-measure: 40rem`), taller resting input (`--composer-input-min: 44px`); queue is one card above the composer (flat list, hover steer/dequeue)
- [x] Explained mode menu for Plan / Agent / Yolo (icon, behavior, current
  check, `selectModeAction`); Shift+Tab still cycles and plan-pending stays gated
- [x] Lucide stroke icons for chrome + composer; tool-row glyphs via renderer `tool-glyph.tsx` (shared unicode `toolIcon` labels unchanged)
- [x] Sans UI chrome; mono reserved for real code (terminal grids, fences, tool/diff/job bodies, wordmark, rich charts)
- [x] Streamdown markdown fences use Shiki `CodeBlock` + line numbers; theme follows app palette via `shikiThemeFor` (not hardcoded github)
- [x] One copy control (`CopyButton`) for fences, tool output, answers, thinking, plans; Streamdown table copy enabled
- [x] GFM tables: Streamdown 2.5 wrapper is flex (no float); scroll on the table shell; fixed layout so prose columns don’t clip or hog width
- [x] Streamdown markdown hierarchy: `[data-streamdown="strong"]` / headings / nested lists / inline-code tokens; nested detail on `--text-secondary`
- [x] SourceList cards: heading titles (not `.md a` blue), quiet domain, 2-line snippet clamp, light hairline cards
- [x] Plan approval body renders as bounded scrolling markdown with sources/assumptions; fixed title and equal-width Accept / Keep / YOLO footer remain visible above the composer
- [x] `selectModeAction` unit coverage + Shiki theme registry coverage

## Sleek modern Codex alternative — opencode-inspired polish (session 7)

- [x] Token system: `--thinking-opacity`, `--bg-menu`, `--ctx-track`, `--composer-input-min`, rail widths 20vw/260 & 26vw/340, icon 16px, light shadows lifted, glass blur 24px/sat 140%
- [x] Composer: dense full-surface frost with continuous blur + chat-column veil; focus ring; status row; mode dropdown; context gauge; tokenized user bubble (`--bubble-user-*`)
- [x] Transcript: compact aligned tool/thinking rows, readable tool bodies, thinking opacity token, code block 10px radius with bottom border header, diff 2.5px accent, structured source cards
- [x] Menus: slash/mention quiet surface-enter, sentence-case compact typography, keyboard containment, catalog grouping (favorites via localStorage + recent 8 + provider buckets, Free badge, clear ×)
- [x] Session panel (Inspector): shared Session/Changes end-panel view; closed by default; explicit dock/topbar toggle; user can close; LiveSidebar removed
- [x] Rails: active session uses surface highlight only; project row radius 7px, topbar 14px semibold, Session panel border 22% + blur 12px sticky header, meta-block tighter
- [x] Secondary: restrained cards, single Stop + Esc interrupt language, Jobs activity view, earlier/jump controls, compact toast, memory notice, and source/article cards
- [x] Model pill bordered 18% + hover 68%, transcript gap 28px/10px, code 12.5px
- [x] Light scheme: restored edge-highlight + soft frost elevation; hairlines via `--border-soft` (not hard card borders)
- [x] `/accent` remaps `--sel-bg` / `--sel-fg` / `--heading` / focus ring with contrast-aware foreground

## Second-pass deep polish (session 8)

- [x] Text input: auto-resize overflow toggle (hidden until 200px then auto), floating surface `::before` full-surface blur, placeholder 52% muted focus 38%, exact-cmd 500 weight, caret-color, status top border 14% + surface 22%, model pill bordered 18% + tabular-nums
- [x] Context gauge: pill with border, bg 36% → 56% hover, dial 14px + box-shadow 1px border, warn/notice/hot with bg tint
- [x] Mode dropdown: trigger + options menu (`selectModeAction`) with uniform sentence-case menu typography and keyboard focus
- [x] Slash/mention menu: quiet surface-enter, restrained overlay shadow, sentence-case headers, keyboard focus containment, and compact footer hints
- [x] Catalog popover: 46vh/440px max, floating origin, uniform sans typography, compact section labels, Free tags, empty hint, clear button, and inline loading/error states
- [x] Project rail: active session surface + weight; row radius 7px, session row 72% assistant text, working-only spinner on the active busy session
- [x] Side popups: activity rail 94% bg, heading 14px sticky blur 12px, meta-block 2px padding 10px radius + 1px 6% highlight, meta-label 10px 700 0.06em upper, sidebar-heading 14px padding
- [x] Transcript: user bubble max 92%/48rem, 14px radius + 1px 10% highlight, assistant prose optimizeLegibility, tool body margin 20px + 10px padding 36% bg, thinking 24% bg, source cards 10px radius softer, diff 2.5px solid + 82%/88% bg + 72% ctx, earlier/jump refined, composer-stack 14px radius 36% border + 1px 12% highlight
- [x] Composer stack: queue as its own quiet card above the composer (not a merged surface); busy Stop control (no separate working strip)
- [x] Typecheck, lint, build, and unit tests green (76 tests); source parity and bundle budget remain explicit release gates documented in `VERIFICATION.md`

## Current UI consolidation (2026-07-12)

- [x] Default palette is the canonical Vibe Dark palette: `#0a0a0a`,
  `#141414`, `#1e1e1e`, `#3c3c3c`, and warm `#fab283` chrome.
- [x] Project rows reveal icon-only new-chat and ⋯ actions on hover/focus; ⋯ owns
  rename/archive/delete without adding a permanent rail gutter.
- [x] Session inspector is explicit-toggle only; sending a message does not
  reopen it. Session/Changes/Git/Terminal/Jobs share one mutually exclusive,
  edge-attached activity sidebar without replacing the chat workspace.
- [x] Approval panels and transcript output share the composer measure.
- [x] Jump to latest and the changed-files chip share one footer action row.
- [x] User turns fold from the message itself without a persistent arrow.
- [x] Engine-owned gate/review/verification continuations retain turn boundaries
  but render as compact expandable context rows, never as user-authored bubbles.
- [x] Memory notices use a quiet `Memory · N notes` disclosure with an
  expandable note list; no emoji or decorative brain/sparkle glyph is used.
- [x] Source/article results use numbered cards with title, domain, and snippet
  hierarchy.

## Presentation polish (2026-07-11 evening)

- [x] App icon: Apple-style transparent safe area + squircle-composed `assets/icon.png` source → `build:icon` →
  `icon.icns`; unpackaged macOS dock via `app.dock.setIcon`
- [x] Queue: one quiet card, “N Queued” header, flat list, hover steer/dequeue
- [x] Continuous composer frost + chat-column veil so transcript is blurred
  across the full input surface; empty home has no veil; reduced-motion drops
  live blur
- [x] Project/session ⋯ menus: trigger-anchored (flip above near bottom), toggle
  on second click, no mousedown/click race, `aria-haspopup`/`aria-expanded`,
  hidden triggers `pointer-events: none`, and no permanent action gutter
- [x] Delete/archive confirm: title + detail, right-aligned Cancel / action pills
- [x] Overlay scrollbars; backgroundless white hover Copy/Edit icons with
  reserved gutters; Streamdown
  strong/heading/list/code hierarchy; GFM table scroll shell; quieter source cards
- [x] Preview scenarios `table`, `docs`, `sources`; docs synced
  (UI/PARITY/README/AGENTS/VERIFICATION/ACCEPTANCE)

## Renderer interaction polish (2026-07-12)

- [x] Thinking/tool activity uses one compact sans/icon scale and groups
  contiguous activity behind a click-to-expand `Thinking · N steps` row.
- [x] Memory notices are quiet expandable rows with readable note entries,
  replacing the previous brain-icon/clamped-preview treatment.
- [x] Project rail session spinner renders only for the active busy session,
  with a restrained rotating arc and reduced-motion support.
- [x] Project rail marks every catalog session with exact cloud status `running`
  using one quiet, accessible cloud glyph.
- [x] Workspace eyebrow labels use the primary sans typography rather than a
  letter-spaced micro-label treatment.

## Logic audit and hardening (2026-07-12)

- [x] Delta flush ordering: `flushDeltas()` now runs before `landReasoning()` and
  before every non-delta transcript dispatch, matching TUI's `landPending` →
  `commitThinking` → `reduceTranscript` sequence (was reversed/missing in
  `endTurn`, `user-message`, `assistant-text-delta`, `tool-call-started`,
  `plan-presented`, and all notice/checkpoint/verify/loop handlers)
- [x] Subagent-started deduplication: `continue_subagent` reuses the same child
  ID; existing row is updated in place (preserving position) instead of
  filtering and re-appending (TUI parity); `activity` and `result` cleared on
  re-start
- [x] Quit handler: 5-second hard budget via `Promise.race` (was unbounded —
  `finalize` RPC 20s + `stop()` 2s = 22s worst case); re-entrancy guard via
  `quitting` flag
- [x] Clipboard temp dir cleanup on quit (TUI `cleanupClipboardTempDir` parity);
  `rm(join(tmpdir(), \`vibe-clips-${process.pid}\`))` in quit race
- [x] Ctrl+C only fires in the composer or outside any text input (was quitting
  the app from rename fields, search filters, deny-reason inputs)
- [x] Escape in deny-reason input closes it, clears the reason, and returns
  focus to the "Allow once" button (was a dead end — no handler, window-level
  Esc returned early for non-composer inputs)
- [x] `CLEAR_SCOPED_TYPES` moved to module level (was recreated on every render)
- [x] `verify-finished` notice uses `truncate()` (cell-aware, code-point-safe)
  instead of `.slice(0, 120)` (could strand half a surrogate pair)
- [x] Source parity script: `ALLOW_EXTRAS` set with `{ extras, drift }` flags for
  reducer/density/tool-icons/themes/protocol; whitespace normalization for
  formatting-only drift
- [x] Forward-compatible parity allowances are declaration-scoped: only
  `spinner.compactElapsed`, additive `GLYPH` entries, engine-authored
  `UIEvent` user-message labels, and the Electron editor draft's `0600` mode
  may differ from v0.5.1; unrelated file drift still fails
- [x] Formatting in markdown-blocks, rich-blocks, spinner synced to match
  upstream TUI exactly (import paths only difference)
- [x] 2 new unit tests: subagent-started in-place update + fresh-id append
- [x] 98 unit tests, 10 e2e tests, 19 source pairs, lint, typecheck all green

## Settings & Git integration (2026-07-12)

- [x] Full-workspace settings view: replaces the left rail with section
  navigation + scope toggle and the center with the scrollable form area
  (not a narrow side drawer)
- [x] 15 settings sections: Models, Providers, MCP Servers, Permissions,
  Appearance, Behavior, Subagents, Build & Verify, Memory, Search & Web,
  Compaction, Budget & Retry, Hooks, Custom Instructions, Advanced
- [x] Settings read/write via direct config file I/O (global + project scope),
  mirroring `@vibe/config`'s JSONC parsing and deep-merge write semantics
- [x] Config scope toggle (Global / Project) with save/reset/dirty indicator
- [x] Custom instructions (VIBE.md) editor with global and project scope, live
  save, and dirty tracking
- [x] Provider management: API keys, base URLs, token files, extra headers per
  provider with expand/collapse cards and inline add form (no window.prompt)
- [x] Full synchronized models.dev/OpenCode provider manifest plus arbitrary
  provider IDs, explicit model lists, and selectable Chat Completions or
  Responses transport
- [x] Progressive provider setup: CrofAI is curated; known endpoints and starter
  models are filled; credential/model/required URL stay primary; transport,
  token extraction, headers, and overrides collapse under Advanced settings
- [x] Settings keeps Essentials/Workspace visible while technical runtime
  sections and model pricing/context tuning stay searchable behind Advanced settings
- [x] Built-in ChatGPT/Codex PKCE and xAI device subscription login with
  human connection state, refresh, cancel, retry, logout, direct Codex/Grok 4.5/
  Grok Build selection, and a strict renderer RPC parameter contract
- [x] Subscription refresh secrets remain main/engine-owned; renderer auth RPCs
  cannot export them and Cloud receives only the reviewed current access binding
- [x] MCP server management: stdio + remote (HTTP/SSE) with env-var expansion,
  reversible stdio/remote drafts, and malformed expansion-reference rejection
  draft-preserving environment/header editors, OAuth 2.1 token-store settings,
  per-server enable/disable, timeout, inline add form
- [x] Permission rules editor: tool/match/action with add/remove
- [x] Hooks editor: 8 lifecycle events, shell command or URL, async toggle
- [x] Git view stays on the chat surface in the shared right-side activity rail;
  the main column reserves its width and the project rail remains stable
- [x] Git tabs: Branches (create/switch/delete), Changes (stage/unstage/commit/
  amend), History (recent commits), Remotes (URLs + host/owner/repo),
  Pull Requests (list/create via gh CLI)
- [x] Git quick actions: fetch, pull, push from the rail sidebar
- [x] GitHub PR workflow: list PRs, create PR (title/body/base/draft), open in
  browser, gh CLI availability check
- [x] Settings & Git icons at the bottom of the project rail (rail-footer),
  not in the chat-area topbar; Git opens the shared end-panel lane
- [x] Keyboard shortcuts: ⌘, for settings, ⌘⇧B for git; Esc closes either view
- [x] Slash commands: /settings, /config, /git, /branches
- [x] Preview scenarios: ?scenario=settings and ?scenario=git
- [x] IPC security: all new handlers assert trusted sender via shared
  ipc-security module; inline styles removed (token-driven CSS only)
- [x] 22 new unit tests: config I/O (JSONC parsing, deep merge, null-delete,
  trailing commas, string-aware comment stripping) + git operations (repo
  detection, status parsing, branch listing, commit history)
- [x] 98 unit tests, lint, typecheck, build, bundle, source parity all green

## Attachments, review, and final renderer polish (2026-07-12)

- [x] Finder drag/drop accepts image and file batches with removable chips,
  image previews, duplicate normalization, and project-aware `@` references
- [x] Native dropped-file resolution uses Electron `webUtils.getPathForFile`,
  then `text/uri-list` and `text/plain` Finder path fallbacks for environments
  where `File.path` is empty
- [x] Session inspector changed files retain their latest unified diff and open
  in a toggleable Diff/File review surface with line gutters and Reveal
- [x] Project and Session rails expose pointer and Arrow/Home/End keyboard
  resizing with persisted desktop widths and responsive drawer fallbacks
- [x] User-message Copy/Edit/time actions sit beside the bubble; assistant
  actions remain below assistant responses
- [x] Metadata, costs, model/session telemetry, and section headings use the
  shared sans UI font; mono remains reserved for code and raw output
- [x] Preview harness covers `attachments`, `settings`, `git`, light mode, and
  Finder-style URI fallback behavior
- [x] 98 unit tests, 10 E2E scenarios, lint, typecheck, build, bundle, source
  parity, and bridge smoke all pass

## Production hardening & full config parity (2026-07-12)

- [x] Config writes are atomic (temp+rename) — a crash mid-write cannot
  truncate the config into unparseable garbage (BUG-092 parity with
  `@vibe/config`'s `atomicWriteJson`)
- [x] Per-path write serialization — concurrent config writes (settings save +
  permission grant) chain through a promise so neither clobbers the other
  (parity with `@vibe/config`'s `writeChain`)
- [x] Project/session rename, archive, and delete controls preserve their draft
  or confirmation until the backing mutation succeeds and block duplicate submits
- [x] Rename drafts and RPC payloads use the project index's canonical 80/72
  character labels, so successful names do not change again after refresh
- [x] Plugin module entries are trimmed, ordered, deduplicated, and validated
  against empty/control-character specifiers before Settings can persist them
- [x] The 2,500-block transcript ceiling applies identically to live events,
  IndexedDB replacement, and incremental engine-history hydration
- [x] Large model/provider/agent/skill/MCP catalogs remain fully filterable but
  cap mounted result rows at 400, preserving group labels and current model
- [x] Every Settings add-row draft (provider, MCP, pricing, context window, LSP)
  participates in dirty/close/scope guards and clears on Reset or context discard
- [x] Permission payloads are projected into bounded renderer state while
  retaining both head and tail; known command/edit previews and unfamiliar
  plugin/MCP argument previews cannot hide a dangerous suffix or require blind approval
- [x] Queue and background-job panels cap mounted rows at 200 with explicit
  omission counts; queue head/tail and running/recent jobs remain actionable
- [x] Runtime guards reject impossible negative usage/cost, Git divergence,
  goal progress, file churn, compaction savings, and loop/orchestration counters
- [x] Transcript cache opens fail closed without leaking a late IndexedDB
  connection; eviction deletes corrupt legacy records instead of throwing mid-cursor
- [x] Onboarding provider/model changes are transactional: failed startup rolls
  back the prior config and runtime while keeping form values available to fix
- [x] Plan accept mirrors the engine's active-goal ownership guard before
  clearing the card or setting optimistic busy, preventing a permanently stuck shell
- [x] `__vibeSecurityNotices` key stripped before disk write so a round-trip
  through the shell doesn't freeze a transient engine notice into user config
  (parity with `stripSecurityNotices`)
- [x] Memory (VIBE.md) writes are atomic (temp+rename) too
- [x] Settings save builds a deep-diff patch (not the whole config) so clearing
  a field (API key, model, accent color) sends `null` (delete) instead of
  `undefined` (no-op) — users can now unset values that were previously
  impossible to clear
- [x] NumberInput guards NaN — typing non-numeric text produces `undefined`,
  not `NaN`, preventing an invalid value from bricking the config on the next
  engine load
- [x] First-run onboarding modal: searchable generated models.dev catalog
  (OpenCode breadth) plus Hermes-compatible provider ids and native cloud
  routes; provider-specific credentials/endpoints, model preselect, and
  transactional save → re-bootstrap replace the passive hint strip
- [x] `--z-modal` CSS token defined (was referenced by `.keys-overlay-root` but
  never declared — z-index resolved to `auto`)
- [x] Settings parity gaps closed:
  - `subagent.structuredMaxAttempts` in Subagents section
  - `compaction.offload.maxArtifactBytes` in Compaction section
  - Compaction shows the effective lossless-offload threshold whenever the
    engine normalizes an inverted/default pair below the summary threshold
  - `build.recon.enabled` + `build.recon.ledger` in Build section
  - `build.gate.checks` multi-select (typecheck/test/build/lint) in Build section
  - `plan` config (minCodeTouches, requireWebFetch, requirePackageInfo,
    allowUngrounded, maxRejections) as "Plan Gate" subsection in Build section
  - `pricing` per-model overrides (input/output/cacheRead/cacheWrite) in Models
  - `contextWindow` per-model overrides in Models
  - `lsp.servers` command/args/enabled overrides per language in Advanced
- [x] Dead code removed: `OnboardingHint.tsx` + its CSS (replaced by
  `OnboardingModal`)
- [x] 125+ unit tests, lint, typecheck, build, bundle, source parity all green

## Production hardening round 2 (2026-07-12)

- [x] React ErrorBoundary: catches uncaught render errors so a single component
  failure doesn't blank the window — shows a recovery card with Reload button
- [x] Dev-mode CSP relaxation: Vite injects inline scripts (React refresh, HMR)
  that the production CSP blocks — `onHeadersReceived` injects a dev-friendly
  CSP only when `ELECTRON_RENDERER_URL` is present; production CSP untouched
- [x] Application menu: standard desktop roles plus File → New Session, Open
  Project, Continue Latest; Tools → Settings, Git, Inspector, Terminal, Jobs;
  Help → Keyboard Shortcuts, docs, issue reporting, wired through one
  `onMenuAction` router
- [x] Native window close and application quit share the Settings dirty guard;
  cancellation occurs before host finalization or terminal teardown
- [x] Theme list fix: AppearanceSection had completely wrong theme names
  (midnight, solarized-dark, github, rose-pine — none exist in the registry).
  Fixed to use the actual `THEME_NAMES` from `theme-registry.ts` with labels
- [x] Accent preset swatches: quick-select buttons for the 10 named accent
  presets from `ACCENT_PRESETS`
- [x] Curated provider dropdown: ProvidersSection "Add provider" uses a dropdown
  of the 33 curated `PROVIDER_CHOICES` (with labels) instead of free-text only;
  "Type manually" option preserved for custom/advanced IDs
- [x] git commit --amend arg construction bug fixed: the old splice(2) logic
  left a dangling `-m` that took `--amend` as its message value
- [x] 140 unit tests, 10 e2e tests, lint, typecheck, build, bundle, source
  parity all green; 31 UI preview scenarios all render correctly

## Unified activity sidebar and design-system documentation (2026-07-13)

- [x] Session, Changes, Git, Terminal, and Jobs use one mutually exclusive,
  full-height right activity sidebar with shared hairline geometry, close behavior,
  Escape handling, and persisted resizing. Changes keeps a wider review-specific
  width while remaining in that same structural lane.
- [x] The sidebar keeps all five view switches visible at the top. Project PTYs
  remain main-owned and continue running across Terminal close/view switches,
  then reconnect with bounded replay output. Interactive login shells and stale
  session recovery prevent a dead PTY id from stranding the terminal renderer.
- [x] Terminal cwd follows context: project sessions use the project root, while
  one-off Chats use the user's home directory rather than `~/.vibe/chats`.
- [x] Changes resolves authoritative per-file Git patches from nested repositories,
  combines staged/unstaged work against HEAD, and renders untracked files as
  proper `/dev/null` unified diffs while retaining engine diff fallback.
- [x] The activity sidebar is a structural grid column, not an inset floating
  card; user messages, transcript output, approvals, changed-files footer, and composer
  stay visible beside it.
- [x] Git no longer replaces the full workspace. Its Branches, Changes,
  History, Remotes, and Pull Requests content renders inside the activity rail.
- [x] Files remains a Finder reveal; `/jobs` remains available while the
  workspace dock compacts to icon navigation on narrow layouts.
- [x] Decorative white section outlines and moving white selection lines remain
  prohibited; section state uses spacing, fill, and keyboard-only focus rings.
- [x] `design-system.md` documents the live color, type, spacing, radius, blur,
  shadow, motion, breakpoint, panel, and accessibility contracts.
- [x] Project/activity rails, drawer scrims, slash/mention, mode/insert, and
  catalog surfaces retain a short inert closing phase so tokenized exit motion
  completes before unmount; reduced motion skips the delay.
- [x] Current release gate: live unit/Electron/mobile suites, lint,
  Electron/renderer/relay/mobile typecheck, build, bundle budget, source parity
  (22 pairs), config-shape parity (40 fields), coverage floors, bridge smoke,
  and locked-engine packaged app + Continue-on-Phone relay smokes.
- [x] Direct macOS/Windows releases publish GitHub-backed updater feeds. Update
  downloads and restarts require consent, and installation waits for the same
  bounded engine/PTY cleanup used by an ordinary app quit.

## Uniform activity chrome and diff review (2026-07-14)

- [x] Session, Changes, Git, Terminal, and Jobs render one shared Workspace
  header primitive with identical height, padding, subtitle rhythm, close
  placement, and five equal-width switcher tabs. Header/tabs use compact
  caption/label typography and no horizontal divider rules.
- [x] Changes uses a recursively expandable changed-file tree with deterministic
  directory/file ordering, deep-path filtering, selected-file retention,
  type-aware file badges, and compact tree-over-review stacking.
- [x] Diff review has fixed line gutters, semantic edge markers, distinct sticky
  hunk rows, and saturated addition/deletion washes. File review uses a numbered,
  keyboard-scrollable code surface while preserving copy, Reveal, navigation,
  loading, error, empty, and truncation behavior.
- [x] Dedicated `--diff-add` / `--diff-del` roles cover review rows, counters,
  transcript patches, changed-file cards, and dock summaries across
  dark, light, and contrast schemes without intensifying generic errors/tasks.
- [x] Activity-sidebar Escape handling bubbles after child controls and never
  closes the lane from a focused text-entry field; Git drafts and file filters
  retain keyboard ownership.

## Production safety closeout (2026-07-13)

- [x] Cold-start project discovery uses a short-lived pre-bootstrap host and
  authorizes only absolute existing roots from the engine's persisted project
  registry. The host launch cwd and renderer persistence are never treated as
  cwd capabilities.
- [x] Project config, VIBE.md, and clipboard writes reject symlink escapes;
  config and key/value editors reject prototype-pollution keys instead of
  silently accepting a write that changes shape.
- [x] Settings sections and MCP/provider editors remain mounted while hidden,
  preserving drafts across navigation. Saves stay bound to the scope/cwd that
  was loaded, invalid drafts block Save, and clearing absent optional nested
  fields no longer creates phantom empty objects.
- [x] Assistant/user/reasoning/plan/subagent/orchestration payloads, composer
  drafts/attachments, changed-file diffs, editor round trips, host transport,
  subprocess output, and terminal replay all have explicit ceilings with
  visible omission markers where user-visible content is shortened.
- [x] Onboarding closes only after the saved provider configuration successfully
  re-bootstraps; a failed startup preserves the setup form and actionable error.
  Catalog presentations are latest-request-wins, and corrupt local favorite/
  recent model state is bounded before it reaches the picker.
- [x] Permission rules cannot silently combine glob and exact scopes; the editor
  clears the competing scope and validation rejects ambiguous or empty rules.
- [x] Context telemetry rejects negative/zero-window payloads and shares one
  bounded percentage helper across composer and Session review.
- [x] Application accelerators no longer conflict with transcript folding or
  Session Inspector. Git remote metadata strips embedded HTTP credentials and
  secret query values before renderer exposure; Git and `gh` subprocesses have
  TERM/KILL escalation plus a hard settlement deadline. Branch drafts survive
  failed creation, mutations cannot double-submit, and `gh` PR JSON is validated
  before renderer exposure.
- [x] Source/config parity reads the exact locked engine commit. Packaging
  refuses a mismatched HEAD or dirty engine build input—including dependency
  manifests and the lockfile—before copying the host.

## Runtime continuity and efficiency (2026-07-18)

- [x] Versioned protocol ready/event/snapshot frames carry engine revision,
  capabilities, host identity, session identity, and monotonic event cursors;
  duplicate frames are ignored, gaps replay from a bounded 2,048-event/8 MiB
  host ring, and expired replay falls back to a fresh snapshot.
- [x] Adaptive tool discovery keeps core/task/allowlisted tools direct, defers
  only large MCP/plugin catalogs, preserves real tool identity through hooks,
  permissions, approvals, telemetry, and UI, and reduces the 100-tool fixture's
  schema tokens by at least 60% without exceeding the two-point selection budget.
- [x] The local runtime pool is configurable from 1–8 (default 3), reclaims the
  least-recently-used idle runtime before admitting work, and never evicts a
  working/input/review runtime. When every slot is protected, launches enter a
  deduplicated FIFO with stable IDs and explicit cancellation; Sessions and
  Jobs show queue position, and capacity reductions retire only idle excess.
- [x] Background permission/question/plan waits, failures, and completed work
  emit deduplicated native notifications containing only project/session labels
  and static action copy. Foreground work is silent, unsupported platforms are
  a no-op, and clicks focus the exact live `{cwd, sessionId}` without reviving a
  stale runtime.
- [x] Advanced Settings reports content-free local p50/p95 phase attribution,
  dominant bottleneck, seven-day/2 MiB retention, export/copy diagnostics, and
  plugin health without central telemetry or new presentation primitives.
- [x] Sessions merges immediate metadata filtering with cancellable cross-project
  BM25 transcript recall, persists stable completed-turn IDs, and atomically
  forks model/display history without dangling tool calls or mutating the source.
- [x] PluginManifestV1 is read before executable import, rejects incompatible
  API/contribution contracts, records package integrity or unverified local
  provenance, isolates failures with rollback, and exposes loaded/degraded/
  incompatible/failed status through the existing Advanced section.
