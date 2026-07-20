# UI.md — Current interaction and visual contract

> **Status:** current-state handoff  
> **Updated:** 2026-07-16 (appearance-stable, credential-complete Cloud handoff)
> **Repository:** [vbcode-electron](https://github.com/robzilla1738/vbcode-electron)

This is the renderer-facing design contract for the Electron shell. Re-check the
live code before changing behavior; the engine remains owned by
`vibe-codr` and this repository is responsible for presentation, IPC wiring,
and desktop interaction.

## Execution environment

New-project setup and the main composer expose the same Local/Cloud target.
Changing the composer target opens a reviewed ownership transition; the active
target is never changed optimistically. `/handoff` is a first-class palette entry
with Local and Cloud choices and opens that same review. Provider setup lives in
full-workspace Settings → Cloud. Confirmation is a modal preflight over the
existing chat surface; status stays in topbar metadata and never adds a rail or
persistent floating panel. Normal chrome says Local, Cloud, Cloud paused, or
Needs your Mac; provider names remain in setup, diagnostics, and cost details.
The complete composer footer uses the Local/Cloud control geometry: one height,
compact rounded-rectangle silhouette, quiet border, and consistent surface.
Mode, attachment, density, context, model, Stop, and Send do not introduce
separate pill or circle shapes; state and contrast carry their hierarchy.

The Cloud review begins with a Local → Cloud route, then uses flat provider rows,
an explicit Moves/Stays boundary, an optional next-task field, and one billing
note. It does not use a grid of rounded selection cards or repeat policy prose.
The complete usable project tree, including Git-ignored files, moves by default;
hard machine-secret and generated-dependency exclusions remain explicit in the
review. The active model is named and configured Cloud-capable provider access
is sealed for that session by default. An Include model access checkbox can
override the Settings → Cloud default; when disabled, only explicit Cloud
credential bindings move. Unrelated process environment and machine credential
stores remain Local. The remote runtime decrypts the one-shot envelope inside
the root-owned agent, injects the reviewed names only into the engine host, and
deletes the transient file. Cloud terminals use a separate environment and
cannot inherit model credentials.
Missing Cloud authentication and local-only providers are rejected before a
sandbox is created, with a direct setup action. Authenticated daemon health also
proves the actual resumed engine resolved every required model before ownership
moves; health and catalog metadata contain key names only, never values.
Changing main, subagent, or named-agent model access requires returning Local so
the running cloud daemon never gains an undisclosed credential mid-session.
Returning to Local mirrors the route and explains verified sync plus the safe
review-worktree fallback before files change.

While ownership is changing, the modal is non-dismissible and presents the
session-scoped stages Safe boundary, Package workspace, Create sandbox, Upload,
Verify runtime, Restore session, Start agent, Health check, and Connect. The
current stage, elapsed time, and progress are exposed through a polite live
region. A failure keeps the modal open with a plain-language alert, expandable
sanitized technical details, and **Try again** only for a manager-confirmed
retryable state. Non-retryable ownership failures disable the transition action
and direct the user to Settings → Cloud recovery. Reopening handoff always starts
with fresh progress, and reconnect failures persist a degraded catalog state
instead of appearing healthy. Success is accepted only after the remote snapshot
matches the local session identity, model, mode, subagent model, and conversation;
the composer adopts the returned Cloud catalog entry immediately and reconnects
that existing session automatically. Theme, accent, and transcript density are
part of the versioned runtime profile, so handoff never flashes a remote default;
intentional Cloud appearance changes become the application-wide Mac preference.
Legacy 0.6.2 sessions repair in place on reconnect only after the old engine is
authenticated, idle, and gracefully shut down. Active terminals defer repair.
A failed repair keeps Cloud ownership authoritative, never replays a prompt,
and presents Return Local in Settings → Cloud recovery.
Fresh provisioning removes a stale same-name provisional sandbox before create;
it never reconnects to an abandoned daemon from an earlier failed attempt.
The permanent isolated workload must preflight the exact imported session before
health succeeds. Missing resume state is a concrete fail-closed handoff error,
never a blank replacement chat.

## Product shape

App launch is direct-to-workspace. The renderer tries the last successfully
bootstrapped authorized workspace, then host-ordered recents, then the dedicated
Chats root. The normal launch path never stops at project selection; the picker
is reserved for switching projects or recovering when every automatic path
fails. Local/Cloud selection belongs to the main composer, not a launch gate.

First-run provider onboarding opens on a short **Recommended** view, with
separate **Local** and **All providers** views; search spans the complete
generated models.dev/OpenCode registry and Hermes aliases.
Provider-specific endpoint fields appear only when required; native AWS/Google
credential-chain routes explain environment setup instead of asking for a fake key.
Known endpoints are shown as filled automatic values, not empty configuration
work. The `/model` picker exposes one **Set up another provider…** action, and
unconfigured `/providers` rows open focused setup without making users compose
`/model key` commands.

Subscription providers use the same compact provider-card grammar in onboarding
and Settings. ChatGPT/Codex offers one browser sign-in action; xAI/Grok uses one
device-code action. Human status labels replace raw state names, the device code
stays copyable, and cancel/retry/sign-out remain keyboard reachable. Each card
offers its eligible default models directly: Codex 5.3, Grok 4.5, and Grok Build.
First-run Save remains disabled until the selected subscription is connected.

Custom providers use a free provider ID rather than a shared `custom` slot.
Their detail editor exposes base URL, API key/token file, headers, explicit
models, and either Chat Completions-compatible or Responses transport. API key,
model, and required URL remain in the primary flow; token files, overrides,
headers, and transport details sit under **Advanced settings**.

Settings navigation shows the everyday Essentials and Workspace groups first.
MCP, subagent/runtime tuning, hooks, compaction, pricing, context overrides, and
similar power-user controls remain searchable but collapsed under **Advanced
settings** by default.

The shell has these primary surfaces:

1. **Project rail** (left) — first-class **Sessions** workspace, collapsible
   **Projects** and **Chats** sections, search, session/project menus, and the
   Settings footer.
2. **Main stage** — topbar (project/session title), transcript (user bubbles,
   compact expandable engine-follow-up context, assistant prose, tools, thinking,
   structured gate/visual-check statuses, notices, sources), floating composer,
   plan/permission/queue overlays, and a single footer action row for changed files
   plus Jump to latest.
3. **Workspace dock** (right strip on the chat surface) — flat full-label list:
   Session, Changes, Git, Terminal, Jobs, Files. Its equally inset rounded
   `--surface-subtle` enclosure has no shadow, section dividers, or
   Local/Commit/Compare noise. It
   switches to a six-column compact icon grid below ~960px; every target remains
   outside the Electron drag region. Empty compact layouts use a denser 184px
   toolbar with 24px controls and 11px icons across the full compact range;
   non-empty navigation retains its larger responsive targets. Jobs is also
   available via `/jobs`.
4. **Activity sidebar** — one full-height, edge-attached right pane for Session,
   Changes, Git, Terminal, and Jobs. The active view replaces the previous view
   in the same structural grid column. Files remains a Finder reveal rather
   than an in-app panel.
5. **Changed-files footer chip** — after edits, a compact summary shares the
   transcript footer row with Jump to latest and opens the Changes workspace.
6. **Sessions workspace** — a full main-stage Board/List view over the host-owned
   project index. Live local and Cloud state automatically drives Working,
   Needs input, Review, and Done; users retain manual organization when no live
   state applies. The active card streams its current tool/task or actionable
   wait plus task progress, agents, jobs, queue, changed files, context, usage,
   model, mode, goal, and ownership. Project metadata refreshes when a turn
   settles so the board and rail do not lag behind the transcript.
   Search, project/status/mode filters, sorting, inline rename, status movement,
   archive, delete, and resume all operate on the existing session APIs.

Transcript prose, Thinking/tool activity, notices, approval cards, and the
composer use the same centered, font-independent `--transcript-measure: 40rem`
measure (`--prose-max` and `--composer-max` alias it). Compact caption
typography must never change a row's physical width or horizontal position.
Top-level transcript items use one `--transcript-flow-gap`; child blocks do not
stack their own vertical margins, and hidden assistant actions occupy that gap
without changing document flow. “Load earlier” controls anchor to the same
conversation edge rather than the wider structured-output canvas. Compact
activity, continuation, pagination, status, and footer-action surfaces share
`--transcript-compact-row-h` so adjacent controls do not wobble in height.
The central chat pane fills its workspace
edge-to-edge. Output may scroll behind the floating composer; continuous
full-surface frost blurs that overlap. Approval cards stay opaque.

The project rail and activity sidebar are responsive and desktop-resizable by
pointer or keyboard. Widths persist, and narrow layouts become edge drawers
without changing the active chat or scroll position.

## Visual language

- Default dark roles: background `#111111`, rail/panel `#1a1a1a`, elevated
  surfaces `#242424`, dividers `#393939`, and code/source accent `#88b0e0`.
- All renderer styling is token-first in `src/renderer/styles.css`; colors must
  come from palette tokens or `color-mix()` derivations.
- Use the shared sans font for interface copy, tool labels, metadata, notices,
  and prose. Reserve mono for code, terminal grids, diffs, job output, fenced
  blocks, the ASCII wordmark, and rich chart glyphs.
- Section headers (rail and popovers) and slash tabs (Commands / Skills / System) use the same UI sans
  voice — no micro-caps / tracked mono treatment for chrome labels.
- Use modest radii, hairline borders, and restrained shadows. Avoid gradients,
  decorative side borders on controls, animated dots, sparkle glyphs, and
  ornamental badge clouds.
- Radius grammar: surfaces use `--radius-md/lg/xl`; status chips, send, and
  Jump to latest use `--radius-pill`; utility Copy/Edit icons are transparent
  controls with no filled chip background.
- Markdown output is Streamdown-aware: bold is `[data-streamdown="strong"]`,
  headings/lists/code use the matching data attributes.
- Motion is property-scoped and tokenized. Rails and dismissible popovers retain
  only their last presentation for a short exit window, become inert immediately,
  then unmount. Respect `prefers-reduced-motion`, which skips that delay.
- Focus is `:focus-visible` only, using the two-layer `--focus-ring` token.
- Section navigation uses spacing and selected fills; never add bright white
  outline segments or moving white side lines to a selected section.
- Scrollbars are overlay-style: transparent until the scroller is hovered or
  focused.

## Interaction contracts

### Mobile handoff

- **Tools → Continue on Phone…** is a main-process ownership handoff, not a new
  renderer workspace. It finalizes the local engine, launches the packaged LAN
  relay, and opens a small native modal with a scannable pairing QR.
- The pairing window stays modal while the phone owns the session so the stale
  desktop composer cannot submit into a released engine. Closing it returns
  control; the phone's Return to desktop action does the same remotely.
- On release, Electron automatically continues the latest copy of the same cwd
  and session. The native pairing surface remains outside the renderer design
  system; do not add a duplicate topbar, dock, or activity-lane control.

### Project rail

- **Sessions** is the first workspace row and shows the total indexed session
  count. It toggles the management workspace without unmounting the conversation.
- Two hierarchy sections, top to bottom: **Projects** (code folders from host
  `listProjects`) then **Chats** (one-off conversations under `~/.vibe/chats`).
  No divider rules — quiet spacing only.
- Section headers are **collapsible** (chevron + label). Trailing **+** only:
  Projects → add folder; Chats → new chat. No New session / Continue pills on
  the rail (Continue Latest remains ⇧⌘N / menu; New session after host fatal is
  on the in-column boot-error card).
- Search forces both sections open so matches stay visible.
- Chat sessions use the same flat session-row grammar as project sessions
  (title + relative time). Project sessions stay nested under folders.
- Project rows reveal an icon-only **New chat** action beside the ⋯ menu on
  hover/focus; ⋯ owns rename, archive, and delete.
- Empty section copy (“No chats yet.” / “Add a folder…”) sits tight under the
  header, indented past the chevron.
- Project and session ⋯ menus: portal-mounted, trigger-anchored, flip above
  near the bottom; destructive actions use in-menu confirmation (not
  `window.confirm`).
- Busy disables navigation with an honest stop-turn reason.
- A quiet cloud glyph marks catalog sessions whose remote status is `running`;
  the session label also announces “Running in Cloud” to assistive technology.
- Desktop resize: pointer + ArrowLeft/ArrowRight + Home/End; width persisted.

### Sessions workspace

- Board and List share one search/filter/sort model and persist the selected view,
  filters, sort, and per-session Active/Review/Done status across app restarts.
- Metadata matches render immediately. Transcript recall merges asynchronously
  across projects with four-store concurrency, bounded snippets, and
  latest-query cancellation. It reuses the same search field and record grammar.
- Cards keep project identity, title, goal, model, mode, relative activity time,
  status, and actions scannable without turning each metadata value into a badge.
- Actual model execution or an ownership transition places a card in Active and
  shows Working. Permission, question, plan, and local-capability waits move to
  Review with “Needs your input”; a settled active turn moves to Done.
- The active card's polite live summary names the most actionable current state
  first, then exposes compact task/agent/job/queue/change/context/token/cost
  metrics. Cloud cards identify the provider and surface ownership errors; the
  same card reads `Ready` after the turn settles instead of retaining stale work.
- Rename stays inline. Archive and Delete use a keyboard-safe in-app confirmation
  dialog, then reuse the same host mutations and transcript-cache cleanup as the rail.
  **Fork here** appears in the existing session action menu and opens an atomic
  copy through the latest completed user-turn boundary.
- Switching to another local session never stops an owned running turn. The
  renderer attaches to one of three bounded runtimes; background work updates
  existing Working/Needs input/Needs review treatments without mutating the
  foreground transcript. Reattachment restores a snapshot plus event cursor.
- Below 48rem, board columns stack and list rows collapse without horizontal scroll;
  touch targets expand to 44px while pointer layouts retain desktop density.

### Composer menus

- `/` and ⌘K open one compact palette with Commands, Skills, and System tabs.
  Tab/Shift+Tab cycle groups; arrows move within the active group; Enter runs;
  Escape closes. Commands with fixed values open a descriptive breadcrumb
  submenu that marks the current value; Escape or Left Arrow returns to `/`.
  `/model` is the only model selector shown, while legacy aliases remain
  typeable for compatibility. Source parity fails if a new canonical engine
  command is not discoverable here.
- Slash/mention, mode, insert, and catalog surfaces share the same quiet
  opacity/translation enter and exit grammar. Closing removes pointer, focus,
  and accessibility ownership before the visual surface leaves.

### Workspace dock

- Lives **inside** the main column / content stage, inset equally from the top
  and side. Its rounded enclosure uses `var(--surface-subtle)` for a quiet grey
  separation from chat without becoming a separate workspace rail.
- Rows only: Session (`Show session panel`), Changes, Git, Terminal, Jobs
  (`Toggle background jobs` — toggles), Files (Finder reveal). Git may show the
  short branch name in the label; +/− meta appears on Changes when files exist.
- No Local row (Files is the single Finder action), no Commit/Compare rows, no
  section labels or decorative divider rules inside the dock nav.
- Switches to icon-only navigation at `max-width: 960px` (Jobs still via
  `/jobs`).
- Below the `900px` drawer breakpoint, topbar metadata yields to the compact
  dock instead of rendering beneath it; Local/Cloud remains in the composer.
- Session, Changes, Git, Terminal, and Jobs are mutually exclusive views in one shared
  right-side activity lane. Opening one closes the previous active view instead
  of replacing the whole workspace or jumping the conversation.
- The activity sidebar is a full-height grid sibling of the topbar/chat stage,
  separated by one quiet hairline. It is never an inset floating card and never
  overlays desktop chat content.
- A persistent top switcher keeps Session, Changes, Git, Terminal, and Jobs
  visible whenever the sidebar is open. Switching views replaces only the
  sidebar body; it does not close the lane or remount chat.
- The activity header, width, structural left edge, close behavior, Escape handling, resize
  handle, and open motion are shared across all five views. The header always
  uses the same Workspace eyebrow, title/subtitle geometry, and close placement.
  Do not create a bespoke drawer for a new dock item.
- Activity tabs and headers use compact caption/label typography and no
  horizontal divider rules. Spacing and surface tone provide grouping instead.
- Escape from a sidebar text-entry control stays with that control; it never
  closes the whole activity lane before a Git draft, filter, or editor can
  handle the key. Escape outside an editor closes the active lane.
- Changes keeps review on the left and a searchable nested file tree on the
  right. Folder disclosure is recursive, selected files remain visible while
  filtering, and compact drawers stack the tree above the numbered Diff/File
  code surface without replacing chat.

### Transcript

- Assistant output, tool output, approval panels, and the composer share the
  same reading width.
- Tool and thinking rows share one compact sans/icon scale. A turn's reasoning,
  tools, and intermediate progress live under one `Work · N steps` disclosure;
  the final answer stays outside it. Each open thought is **one
  quiet surface** (label + prose; no brain icon; no stacked empty cards).
  Copy for thinking sits on the head row.
- Quiet, Normal, and Verbose define only the initial disclosure state. A visible
  Work/tool/thinking control always responds to click or keyboard activation,
  and ⌘T explicitly opens or closes all thinking rows. A tool with no output is
  a static completion/failure status and never renders an inert chevron.
- Thinking groups, nested tool/thought rows, and assistant prose share the same
  physical left edge at every viewport width; compact label typography must not
  re-resolve the `ch` reading measure or introduce nested indentation.
- Restarting or returning to a session preserves the structured coding view:
  thinking, tool calls/results, diffs, and their collapsed presentation are
  restored instead of flattening the turn into assistant prose. Cached
  presentation state is accepted only when every content-bearing transcript
  block and changed-file record matches the host-owned session history;
  collapse state and other presentation-only fields do not invalidate it.
- User messages fold/unfold the turn by click or Enter/Space on the bubble —
  no persistent collapse arrow.
- User-message Copy / Edit / time sit **under** the bubble (trailing-aligned),
  hover/focus of the bubble stack; assistant Copy stays below the response.
- Streaming follows only near the bottom; Jump to latest restores follow.
- Live Tasks/Subagents chips use the standard UI text scale with a 38px compact
  target and proportionally sized activity ring so progress remains legible.
- Jump to latest occupies its own centered row above live Tasks/Subagents,
  permission, plan, and gate panels; it must never cover those controls.
- Extremely large assistant/user/reasoning payloads retain their newest useful
  tail and show an omission marker instead of growing renderer memory without
  bound. Plans, subagent summaries, orchestration rows, and changed-file diff
  bodies have corresponding explicit ceilings.
- The live Subagents pill opens Session directly at a focused Subagents section.
  Each child is an accessible disclosure: running children open by default and
  show live activity/elapsed time; completed children expose the full bounded
  markdown result with Copy.
- Memory is a quiet `Memory · N notes` disclosure.

### Sources and articles

Source results use `SourceList` cards: index, title link, domain, optional
snippet. External links go through `ExternalLink` / host bridge.

### Composer and queue

- Floating frosted composer; continuous full-surface frost.
- Soft bottom veil on non-empty chat; it continues through the reserved
  workspace-dock lane without a color seam. Empty home has no veil.
- Queue: one quiet card above the composer; steer/remove on row hover.
- Active work is communicated by the composer status and project-row spinner;
  do not render a redundant floating “Running” card. Density-change
  acknowledgements are silent, and warning output stays quiet/collapsible.
- Finder drag/drop: native path first, then `file://` / plain-text fallbacks.
- Slash, mention, mode, and catalog menus: floating, keyboard-contained.
- The mode menu explains Plan, Agent, and Yolo with an icon, behavior summary,
  and current-state check while the composer trigger stays compact.
- Empty home has no automatic prompt suggestions.

### Approval and plan cards

- Composer measure; sit above composer clearance.
- Permission: human title, bounded head/tail-safe preview (including unfamiliar
  plugin/MCP arguments), once/session/project/deny (+ optional deny reason).
- Plan: fixed title and approval footer around one bounded scroll region for
  markdown, sources, assumptions, and ungrounded warnings; Enter / Esc / ⌘Y.
  The footer remains visible and sits 8px above the plan-revision composer.

### Session, Changes, Git, Terminal, and Jobs panels

- The wide Environment dock is a compact hairline navigation surface on
  `--bg`, without a rail tint or floating shadow. At the compact breakpoint it
  becomes a small enclosed icon strip rather than disappearing; empty windows
  use a minimal 184px toolbar with 24px controls across the compact range while
  non-empty navigation retains its larger responsive controls.
- Activity views are closed by default. Session opens from dock Session or ⇧⌘I;
  Changes opens from the dock or changed-files footer chip. Git opens from the dock or
  Git shortcut; Jobs opens from the dock or `/jobs`. Sending a message must not
  reopen the activity sidebar.
- Opening Session, Changes, Git, Terminal, or Jobs closes the previous view in
  place. Escape, the close control, or the active dock toggle returns to the
  unchanged chat surface; a dismiss scrim is added only in compact drawer mode.
- Switching or resuming sessions changes conversation data without closing or
  changing the active Session/Changes/Git/Terminal/Jobs view. Changes keeps its
  Diff/File mode, and transcript scroll positions are restored per session.
- Terminal view close/switch detaches only xterm rendering. Project sessions
  open shells at the project root; one-off Chats open at the user's home instead
  of the internal `~/.vibe/chats` session store. Each effective-cwd PTY continues
  in the main process, keeps bounded replay output, and reconnects when Terminal
  is selected again; app shutdown remains the lifecycle boundary. Shells are
  explicitly interactive login sessions, and a stale PTY id self-heals by
  reopening the effective cwd instead of leaving a dead terminal banner.
- While Cloud owns the session, Terminal uses the authenticated remote PTY and
  file review reads from the remote workspace. Closing the sidebar or desktop
  preserves bounded Cloud replay; crossing the Local/Cloud ownership boundary
  remounts xterm against the new owner. Git controls pause because they target
  the local base; remote Git remains available in Terminal. Finder actions stay
  explicitly local and never masquerade as a Cloud reveal.
- All activity tabs, headers, labels, and supporting paths use the shared app
  sans stack and tokenized type scale. The xterm grid intentionally uses
  `--font-mono` at 12.5px with neutral letter spacing and a 1.35 line height so
  terminal cells and the thin bar cursor remain correct. Hierarchy comes from
  weight, color, and spacing rather than inconsistent font sizes.
- Git’s branches/changes/history/remotes/pull-request content stays inside the
  activity rail. It must not replace the project rail or main chat workspace.
- Changes is a dedicated master-detail review workspace: searchable directory
  groups stay visible beside the selected file, with aggregate/per-file stats,
  churn balance, previous/next navigation, Diff/File modes, line gutters, copy,
  and Reveal in Finder. Diff mode resolves the current HEAD-to-working-tree
  patch from Git, including repositories scaffolded beneath the opened project
  and synthetic unified diffs for untracked files; session event data remains
  the fallback outside Git. It stacks navigator above review in compact drawers.
- Host fatal / boot error: primary **New session**, plus Retry and Choose
  another project.

### Settings (Configuration and Custom Instructions)

- Config sections save via the bottom save bar. The Models performance group
  exposes turn, stream-idle, and queued-item limits; MCP server timeouts accept
  positive values only. Switching MCP transport disables the entry until its
  new command/endpoint is reviewed, and a remote draft always remains
  engine-schema-valid.
- MCP environment/header editors preserve invalid partial lines and show the
  parse error. Provider subscription grants are completed in-app; MCP OAuth
  configuration remains transport-level and honest about its token store. LSP
  exposes per-language command/args/enabled overrides. Project trust is a
  global-only decision and cannot be enabled by the project being loaded;
  untrusted filtering preserves exact persisted grants and deny/ask rules while
  rejecting broad allows and code/credential-bearing settings.
- Compaction preserves the engine's compatible normalization behavior: when a
  configured (or default) offload threshold would collide with the summary
  threshold, Settings displays the lower effective threshold the engine will
  use rather than presenting the raw value as runtime truth.
- The save path deep-diffs, validates structural types/URLs/OAuth/ranges, and
  writes atomically under a bounded per-path queue. Invalid merged config is
  surfaced in Settings and never persisted. A save snapshots the revision it
  submits, so newer edits remain dirty after the write resolves. **Instructions** (VIBE.md)
  keeps its own Save/Reset and stays **mounted (hidden)** when navigating away
  so drafts and dirty bind survive section switches. Closing settings still
  clears the shell dirty guard.
- Advanced reuses existing setting cards, badges, and buttons for content-free
  local performance summaries, Copy diagnostics, and plugin loaded/degraded/
  incompatible/failed health. Tools > Local Runtime Capacity applies the
  desktop pool limit immediately (1–8, default 3); lowering it preserves every
  protected runtime and retires idle excess. It introduces no telemetry or new
  visual primitive.
- Run evidence remains inside Advanced → Local Diagnostics. The latest bounded
  trace appears in a compact disclosure, events keep ledger sequence,
  content is absent by default, and an explicit control is required to reveal
  content that was already recorded under the redacted trace policy.
- Jobs exposes the protected-launch FIFO with stable position
  and Cancel. These rows mean waiting for a local runtime slot, never a running
  engine job. Background attention and completion notifications contain only
  project/session labels plus static action text; clicking one returns to its
  exact live session while stale targets are ignored.

## Key files

| Concern | Location |
|---|---|
| Shell / overlay ownership | `src/renderer/App.tsx` |
| Tokens and layout | `src/renderer/styles.css` |
| Composer / mode / menus | `src/renderer/composer/Composer.tsx` |
| Native dropped-file paths | `src/preload/index.ts` (`webUtils.getPathForFile`) |
| Project rail | `src/renderer/layout/ProjectRail.tsx` |
| Sessions workspace | `src/renderer/sessions/SessionsWorkspace.tsx`, `src/renderer/sessions/session-live-insight.ts`, `src/shared/session-board.ts` |
| Local runtime pool, queue, notifications | `src/main/local-runtime-supervisor.ts`, `src/main/runtime-settings-store.ts`, `src/main/local-runtime-notifications.ts`, `src/shared/local-runtime.ts` |
| Workspace dock | `src/renderer/layout/WorkspaceDock.tsx` |
| Changed-files footer chip | `src/renderer/panels/TurnChangesCard.tsx` |
| Diff display helpers | `src/shared/diff-view.ts`, `changed-files.ts` |
| Rail resizing | `src/renderer/layout/SidebarResizeHandle.tsx` |
| Transcript and folding | `src/renderer/transcript/TranscriptView.tsx` |
| Source/article cards | `src/renderer/transcript/SourceList.tsx` |
| Permission / plan / queue | `src/renderer/panels/LivePanels.tsx` |
| Jobs | `src/renderer/panels/JobsView.tsx` |
| Shared activity sidebar | `src/renderer/layout/ActivitySidebar.tsx` |
| Session view | `src/renderer/panels/Inspector.tsx` |
| Changes review | `src/renderer/panels/ChangesView.tsx`, `src/renderer/panels/DiffPreview.tsx` |
| Git view | `src/renderer/git/GitPanel.tsx` |
| Jobs view | `src/renderer/panels/JobsView.tsx` |
| Terminal renderer + PTY owner | `src/renderer/panels/TerminalPanel.tsx`, `src/main/terminal-manager.ts` |
| Boot / fatal recovery | `src/renderer/layout/WelcomeGate.tsx` |
| Catalogs | `src/renderer/pickers/CatalogModal.tsx` |
| Settings + instructions mount | `src/renderer/settings/SettingsPanel.tsx` |
| Settings config integrity | `src/shared/config-diff.ts`, `config-validate.ts`, `config-io.ts` |
| Icons | `src/renderer/icons.tsx`, `src/renderer/tool-glyph.tsx` |
| Preview harness | `tools/ui-preview/` |

## Verification

```bash
npm run lint
npm test
npm run typecheck
npm run build
npm run test:e2e
npm run verify:config-shape
npm run verify   # full non-E2E gate
```

For visual changes, use `tools/ui-preview` scenarios (`chat`, `docs`, `table`,
`sources`, `permission`, `plan`, `queue`, `jobs`, `inspector`, `catalog`,
`attachments`, `settings`, `git`, `splash`, …). Screenshots corroborate; they
do not replace code-level verification.

See [design-system.md](./design-system.md), [PARITY.md](./PARITY.md),
[VERIFICATION.md](./VERIFICATION.md), and [ACCEPTANCE.md](./ACCEPTANCE.md).
