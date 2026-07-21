# Vibe Codr design system

> Canonical visual and interaction reference for the Electron renderer.
>
> This document describes the current implementation. It is intentionally
> code-sourced: `src/renderer/styles.css` owns the CSS tokens, while
> `src/shared/themes.ts` and `src/shared/theme-registry.ts` own palette and
> theme semantics. Update this document when those contracts change.

Cloud handoff reuses the existing modal elevation, buttons, status roles,
spacing, focus-visible rings, and reduced-motion collapse. Provider choice is a
flat divided list, not rounded setting cards. A route summary and paired
Moves/Stays boundary create hierarchy without nested cards. The Local/Cloud
segmented control lives in the composer beside mode because execution location
changes how the next message runs. It introduces no new palette, rail,
full-height tint, or floating desktop panel.
The boundary copy explicitly states that access for models configured in this
session moves alongside explicit Cloud bindings while unbound credentials stay local. Provider validation happens
before provisioning so an invalid route never degrades into a generic remote
connection error after a sandbox has been created.
Model changes while Cloud-owned direct the user back to Local because credential
scope is fixed and disclosed at the ownership boundary.

All composer-footer controls inherit that segmented control's compact
rounded-rectangle geometry and surface treatment. Dropdowns, icon utilities,
status controls, and Send retain semantic emphasis through color and state, not
through unrelated pill or circle silhouettes.

The mode trigger stays compact; its upward-opening menu may expand to explain
Plan, Agent, and Yolo. Each row uses a fixed icon column, title, one plain-language
behavior line, and a trailing current check. Keyboard highlight and current mode
remain separate states, and the existing Shift+Tab cycle remains visible.

Cloud ownership adds no new rail section. A small accent-tinted cloud glyph sits
in the existing session metadata slot only while the catalog status is exactly
`running`; it is static, theme-derived, and backed by accessible session copy.

Cloud errors follow ownership semantics. Retryable failures retain the primary
Try again action; non-retryable failures replace it with disabled Recovery
required state plus a Settings → Cloud recovery direction. Old progress is
cleared whenever the review opens so a prior successful stage never flashes as
current work.

## Product character

Launch is a short transition into the working shell, not a destination page.
Automatic restore uses the last workspace, recent workspaces, and finally Chats;
the centered project gate is recovery-only. Execution location is selected in
the composer after the shell opens.

Vibe Codr is a native-feeling macOS and Windows Electron presentation shell for the `vibe-codr`
engine. The interface is a quiet, dense workspace for building, reviewing, and
debugging software. It should feel precise and calm under long-running agent
work: strong hierarchy, low visual noise, predictable surfaces, and immediate
feedback without decorative motion.

The design voice is:

- **Quiet:** near-black Vibe Dark chrome, restrained elevation, and no ornamental
  gradients, sparkle, or badge clouds.
- **Direct:** short labels, human action names, and controls that explain what
  will happen.
- **Technical where useful:** mono is reserved for code and raw machine output;
  the rest of the product speaks in a readable sans font.
- **Theme-faithful:** the Electron shell renders the same semantic theme roles
  as the CLI/TUI. Presentation polish must never replace engine semantics.

## Surfaces and ownership

The onboarding provider list may be long, so compact Recommended / Local / All
tabs and its search field stay pinned to the top of the scrolling list. Search
always spans the complete catalog. The controls use standard input/overlay
tokens; provider rows retain the quiet selected/hover treatment rather than
introducing a second catalog visual language.

Provider setup follows progressive disclosure. The primary rhythm is provider,
credential, model, and any truly required endpoint. Known endpoints render as a
quiet filled summary. Overrides, transport, token-file extraction, explicit
catalog fallbacks, and headers use the shared **Advanced settings** disclosure;
they do not compete visually with first-run success.

Subscription connection cards reuse the existing setting-card surface, badge,
button, focus, model-choice, and compact error roles. They add no provider brand colors or oversized
logos: provider identity is text, connection state is compact, and device-code
affordances stay monospace only where the code itself benefits. Custom-provider
transport and model controls use the standard form rhythm.

Settings navigation applies the same rule: Essentials and Workspace stay
visible, while technical runtime sections collapse behind one text-and-chevron
Advanced settings control. Search temporarily reveals matching advanced
sections, so simplification never makes a capability undiscoverable.

The shell has five primary layout regions:

1. **Project rail:** left-edge Sessions destination plus Projects and Chats
   navigation, search, project/session actions, and Settings in the footer.
2. **Main stage:** project/session topbar, transcript, approvals, queue,
   changed-files card, and composer.
3. **Sessions workspace:** a full main-stage Board/List manager that keeps the
   project rail mounted. It uses flat workflow columns and one bordered record
   surface per session; Active / Review / Done are desktop organization states,
   while accent is reserved for actual local or Cloud work. Transcript recall,
   safe forks, and background-runtime state reuse these existing rows, menus,
   labels, and status treatments; they add no dashboard or layout region.
4. **Workspace dock:** compact navigation that stays on the chat surface and
   exposes a flat list of **Session**, **Changes**, **Git**, **Terminal**, **Jobs**, and
   **Files** only — no Local/Files double Finder entry and no commit/compare
   shortcuts (those live inside the Git activity view).
5. **Activity sidebar:** one shared full-height right-side lane for Session,
   Changes, Git, Terminal, and Jobs. It is an edge-attached structural grid
   column with a hairline divider, not an inset floating card. Opening one view
   replaces the other in the same geometry. **Files** is a Finder reveal action,
   not an in-app panel.

The activity sidebar is not a route change and does not replace the chat. It
spans the topbar and chat rows beside the main stage, opens with the standard
panel motion, preserves conversation scroll position, and closes with Escape,
the dock trigger, or its close control. Settings remains a full-workspace tool
because its section navigation and form content require the larger canvas.

Its compact top switcher is persistent while the lane is open. The five views
use equal-width quiet text tabs with selected fill, optional Changes/Jobs counts,
and no bright selection line. Every view uses the same compact Workspace
header primitive, including identical padding, height, subtitle rhythm, and
close placement. Tabs and headers use caption/label typography with no
horizontal rules; spacing and surface tone provide separation. Terminal's PTY is owned by the main process per
effective cwd; projects use their root and Chats use the user's home directory.
Closing or switching its renderer view never terminates the shell.
Changes may use a wider persisted review measure inside the same structural lane:
its master-detail layout keeps a searchable, recursively expandable changed-file
tree beside the active Diff/File surface, then stacks the tree above review inside
the compact drawer. File mode uses the same numbered code gutter as diff review.

### Layout measures

These values are the current production tokens in `src/renderer/styles.css`:

| Token | Value | Use |
|---|---:|---|
| `--project-rail-w` | `clamp(260px, 24vw, 320px)` | Project and chat navigation rail |
| `--workspace-lane-w` | `clamp(280px, 26vw, 340px)` | Shared reserved lane for dock and activity sidebar |
| `--workspace-dock-w` | `clamp(208px, 18vw, 232px)` | Compact upper-right launcher |
| `--activity-rail-w` | `var(--workspace-lane-w)` | Shared Session/Changes/Git/Terminal/Jobs sidebar |
| `--changes-rail-w` | `clamp(520px, 42vw, 680px)` | Dedicated master-detail Changes review width |
| `--column-max` | `52rem` | Transcript, approvals, and composer column |
| `--transcript-measure` | `40rem` | Shared conversational output, approval, and composer measure |
| `--prose-max` | `var(--transcript-measure)` | Assistant, activity, and notice alias |
| `--composer-max` | `var(--transcript-measure)` | Composer and approval alias |
| `--reading-max` | `130ch` | Wider transcript content measure |
| `--transcript-inset` | `64px` | Desktop output side inset |
| `--column-inset` | `48px` | Column framing and narrow fallback |
| `--composer-clearance` | `184px` | Bottom room reserved for floating composer |
| `--panels-clearance` | `0px` | Measured extra room for live task, gate, and approval panels |
| `--topbar-h` | `52px` | Main stage chrome |
| `--composer-input-min` | `44px` | Resting composer input height |

The stage is edge-to-edge inside the workspace. The transcript uses an even,
responsive inset; the composer and approval cards align to the same centered
measure. When an activity view is open, `.content-inset.end-panel-open` becomes
a two-column grid whose second track is `min(var(--activity-rail-w), 48%)`.
Because opening that structural track already changes layout, its content only
fades in; the horizontal enter motion is reserved for the compact overlay drawer.

Named JavaScript breakpoints live in `src/shared/breakpoints.ts`:

| Name | Width | Behavior |
|---|---:|---|
| `wide` | `1280px` | Comfortable rail, output, and activity-sidebar composition; JS-only |
| `laptop` | `1100px` | Compress topbar action labels |
| `dock` | `960px` | Workspace dock switches to compact icon navigation |
| `tablet` | `900px` | Project rail becomes a start-edge drawer |
| `compact` | `720px` | End panel becomes an end-edge drawer |
| `narrow` | `640px` | Dense phone-narrow chrome |

The workspace dock switches to compact icon navigation below `960px`. Empty
layouts across that compact range use a restrained 184px-wide toolbar with
24px controls and 11px icons, including Retina-scaled desktop windows below
`720px`. Non-empty navigation retains its larger responsive targets. Jobs
remains reachable through `/jobs`, and the activity drawer remains available
through the responsive layout rules.
Below the `tablet` breakpoint, topbar metadata is hidden so the absolute compact
dock owns its chrome region without overlap; Local/Cloud remains in the composer.

## Color system

All renderer colors are semantic. Outside the `:root` fallback block in
`src/renderer/styles.css`, use `var(--token)` or a `color-mix(in oklab, ...)`
derivation. Do not add literal component hex values.

### Vibe Dark default

The first-paint fallbacks mirror the default palette in
`src/shared/themes.ts`:

| Role | Token | Vibe Dark value |
|---|---|---|
| Background | `--bg` | `#0a0a0a` |
| Rail / panel | `--panel` / `--rail` | `#141414` |
| Elevated surface | `--elevated` / `--surface` | `#1e1e1e` |
| Border | `--border` | `#3c3c3c` |
| Muted text | `--muted` | `#808080` |
| Assistant / primary text | `--assistant` / `--primary` | `#eeeeee` / `#e6e6e6` |
| User semantic color | `--user` | `#5c9cf5` |
| Tool | `--tool` | `#56b6c2` |
| Notice | `--notice` | `#f5a742` |
| Plan | `--plan` | `#9d7cd8` |
| Subagent | `--subagent` | `#7fd88f` |
| Diff addition | `--add` | `#4fd6be` |
| Diff deletion | `--del` | `#c53b53` |
| Addition background | `--add-bg` | `#20303b` |
| Deletion background | `--del-bg` | `#37222c` |
| Code / source accent | `--code` | `#56b6c2` |

Dedicated review roles keep vivid code changes separate from generic success and
error semantics. Dark themes use `--diff-add: #00d26a` and
`--diff-del: #ff4d4f`; light mode uses contrast-safe `#087a3b` and `#c92a2a`;
the contrast theme retains its maximum-separation pair. Diff rows, counters,
transcript patches, and changed-file summaries use these roles while
task failures and application errors continue to use `--del`.

The semantic palette is applied at runtime by `applyPalette`. `light` and
`contrast` are explicit schemes, while the named terminal themes are registered
in `src/shared/theme-registry.ts` and rendered by `src/shared/themes.ts`:

`default`, `dark`, `light`, `contrast`, `tokyonight`, `catppuccin`,
`gruvbox`, `nord`, `one-dark`, `dracula`, `rosepine`, `kanagawa`, `everforest`,
`flexoki`, and `vesper`.

Named accent presets are `blue`, `purple`, `orange`, `ember`, `amber`, `green`,
`teal`, `violet`, `rose`, and `white`. A six-digit custom accent is also valid.
Accent changes remap the accent, selection, and focus roles together.

### Surface grammar

- Resting surfaces use a quiet hairline plus `--edge-highlight`.
- Cards and rails are opaque in the normal shell so desktop background wash
  cannot reduce readability.
- Frost is reserved for floating chrome. Dark glass uses the current surface
  with `--blur-surface` or `--blur-overlay`; light glass uses a softer frost.
- The composer frost covers its entire surface, including the top edge, so
  transcript text never remains visibly readable through a hard cut.
- Section navigation uses spacing and selected fills, not bright white outline
  segments or decorative divider lines. Lines are reserved for semantic data
  boundaries such as patch hunks, never activity-sidebar chrome.

## Typography

The UI voice is `--font-sans`:

```css
-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif
```

The code voice is `--font-mono`:

```css
ui-monospace, "Berkeley Mono", "SF Mono", "SFMono-Regular", "JetBrains Mono",
"IBM Plex Mono", Menlo, Consolas, "Liberation Mono", monospace
```

| Token | Size | Leading | Use |
|---|---:|---:|---|
| `--text-display` | `32px` | `--leading-tight` | Large app display titles |
| `--text-display-sm` | `20px` | `--leading-tight` | Large panel titles |
| `--text-heading` | `18px` | `--leading-tight` | Section and response headings |
| `--text-title` | `16px` | `--leading-ui` | Primary labels |
| `--text-prose` | `15px` | `--leading-prose` | Transcript prose |
| `--text-ui` | `13px` | `--leading-ui` | Controls and chrome |
| `--text-label` | `12px` | `--leading-ui` | Supporting labels |
| `--text-caption` | `11px` | `--leading-ui` | Metadata |
| `--text-micro` | `10px` | `--leading-ui` | Compact status |
| `--text-code` | `12.5px` | `--leading-code` | Code and raw output |

Use `400` for body copy, `450` for the default UI weight, `500` for emphasis,
and `600` for headings or strong labels. Use `--tracking-ui` for normal UI
copy and `--tracking-tight` for display hierarchy. Keep tracking normal and avoid
all-caps, tracked mono labels for ordinary chrome. Bold markdown remains a
content hierarchy signal, not a replacement for layout.

The empty-home brand is the same fixed-geometry ASCII wordmark at every window
size; container-relative scaling changes its size without replacing it with a
plain text fallback. Activity chrome and the xterm grid use `--font-sans`; the
terminal keeps a compact 12.5px size, neutral letter spacing, and 1.35 line
height. URLs detected in terminal output open through the guarded external-link
bridge rather than navigating the app window.

Completed transcript hierarchy follows `Process → Result → Evidence`: Process
is a quiet, lossless disclosure; Result keeps the normal prose voice; Evidence
is a compact sans metadata row. During streaming, the process stays expanded
and chronological so compaction never hides current activity.

## Spacing and shape

The spacing scale is `4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96px`, exposed as
`--space-2xs` through `--space-3xl`. Use the smallest token that preserves a
clear hit target and group related controls before adding more whitespace.

Radius tokens are:

| Token | Value | Use |
|---|---:|---|
| `--radius-xs` | `4px` | Small controls and code chips |
| `--radius-sm` | `8px` | Compact controls |
| `--radius-md` | `10px` | Cards and fields |
| `--radius-lg` | `12px` | Panels and medium surfaces |
| `--radius-xl` | `16px` | Floating composer / drawers |
| `--radius-pill` | `999px` | Status chips, send, Jump to latest |

Use consistent icon and text columns. Lucide wrappers in
`src/renderer/icons.tsx` and `src/renderer/tool-glyph.tsx` use stroke icons at
the 14–16px utility scale; icons are aligned to a fixed box before labels are
laid out. Never let an overflow menu move when its parent row changes state.

## Elevation, blur, and motion

Elevation is semantic rather than per-component decoration:

| Token | Intended layer |
|---|---|
| `--shadow-float` | Small floating controls |
| `--shadow-menu` | Slash, mention, catalog, and context menus |
| `--shadow-modal` | Blocking dialogs and onboarding |
| `--shadow-drawer` | Start-edge drawers |
| `--shadow-drawer-end` | End-edge drawers |
| `--shadow-composer` | Floating composer |
| `--shadow-jump` | Jump-to-latest control |

Blur tiers are `--blur-veil: 12px`, `--blur-surface: 16px`, and
`--blur-overlay: 18px` in dark mode. Light mode uses `10px`, `14px`, and
`18px`. Floating chrome consumes `--glass-float-bg` / `--glass-float-filter`;
true menus and modals consume `--glass-overlay-bg` /
`--glass-overlay-filter`. Structural shell and activity-lane surfaces remain
opaque and never opt into backdrop blur. The composer veil spans any reserved
workspace-dock lane so its filter boundary cannot create a false sidebar tint.
Saturation is `1.06` dark and `1.04`
light. Use blur only on an
elevated floating surface or intentional transcript veil. Never blur the text
content itself.

Transitions use the shared curves `--ease-enter`, `--ease-exit`, and
`--ease-standard`, with `--dur-micro: 80ms`, `--dur-fast: 120ms`,
`--dur-standard: 200ms`, `--dur-moderate: 280ms`, and `--dur-press: 60ms`.
Transition only transform, opacity, color, or box-shadow; never animate layout
properties. The global reduced-motion rule collapses motion and JS scroll/rail
animation must honor the same preference.

Dismissible rails and popovers use a short presence window before unmounting so
their `--ease-exit` animation can finish. Closing immediately removes logical
focus/click ownership, retains only the last rendered presentation for the exit,
and never animates width, grid columns, or other layout properties.

The single per-turn Work disclosure uses one restrained text shimmer while a turn is
active (`--dur-thinking-shimmer: 1800ms`); completed groups remain static and
the global reduced-motion rule collapses the effect. Assistant streaming stays
in the normal sans prose flow with a thin inline caret—never a temporary mono
code surface. Assistant prose, activity groups, and every notice severity align
to the font-independent `--transcript-measure`; compact labels cannot re-resolve
the container width from their own font metrics. Transcript items use the shared
`--transcript-flow-gap`; individual block margins must not accumulate into
different spacing between otherwise equivalent rows. Compact transcript rows
and footer actions share `--transcript-compact-row-h: 30px`.

## Focus and interaction states

Focus is keyboard-only and two-layer:

```css
--focus-ring: 0 0 0 2px var(--bg),
  0 0 0 4px color-mix(in oklab, var(--focus) 62%, transparent);
```

Use `:focus-visible` on controls. Inputs whose wrapper owns the focus treatment
opt out of the duplicate native outline. Hover changes color, opacity, or a
small elevation; active state uses the 60ms press token and `--press-offset`.
Disabled controls reduce contrast and interaction without shifting layout.

Panels must remain predictable:

- The workspace dock and activity sidebar use the same row order and edge alignment.
- The workspace dock is a compact `--surface-subtle` navigation surface with
  equal top/side inset, one quiet hairline, and no floating shadow. Its compact
  icon-grid form keeps the same enclosure and explicit non-drag hit testing.
  Empty pointer-sized desktop layouts use 24px toolbar controls and 11px icons
  across the compact range; non-empty navigation keeps the larger targets over
  the reclaimed chat area.
- Session, Changes, Git, Terminal, and Jobs are mutually exclusive in the activity sidebar.
- Session handoffs preserve the active activity view and each session's reading
  position; replacing conversation data must not reset the surrounding workspace.
- Active-turn state stays in the composer/project row; do not add a redundant
  floating Running card. Density acknowledgements remain silent and verbose
  warnings collapse into quiet disclosures.
- Escape dismisses the topmost menu/panel before it aborts a running turn.
- The composer stays anchored while transcript scroll changes.
- The user bubble, assistant output, approval cards, and composer align to the
  same readable measure.
- Long plan approvals scroll only their review body. Their title and equal-width
  decision footer stay fixed, with one `--space-xs` gap before the composer.
- Menus are portal-mounted and trigger-anchored; they flip when near an edge.
- No section uses a bright white “selected outline” or moving side line.

## Component contracts

| Component | Source | Contract |
|---|---|---|
| Project rail | `src/renderer/layout/ProjectRail.tsx` | Collapsible Projects/Chats, stable icon/text columns, portal menus, persisted resize |
| Sessions workspace | `src/renderer/sessions/SessionsWorkspace.tsx`, `src/shared/session-board.ts` | Persistent Board/List, search/filter/sort, explicit workflow states, honest live execution, and session mutations |
| Workspace dock | `src/renderer/layout/WorkspaceDock.tsx` | Chat-surface navigation for Session/Changes/Git/Terminal/Jobs/Files |
| Activity sidebar | `src/renderer/layout/ActivitySidebar.tsx`, `src/renderer/panels/Inspector.tsx`, `src/renderer/panels/TerminalPanel.tsx`, `src/renderer/panels/JobsView.tsx`, `src/renderer/git/GitPanel.tsx` | Persistent five-view switcher; full-height edge-attached geometry, compact shared header, rule-free horizontal chrome, and shared resize behavior; content never occludes chat |
| Contextual terminal | `src/main/terminal-manager.ts`, `src/renderer/panels/TerminalPanel.tsx` | Main-owned PTY at project root or user home for Chats, bounded replay, detach/reconnect across sidebar close and view switches |
| Transcript | `src/renderer/transcript/TranscriptView.tsx` | Plain streaming text, finalized Streamdown hierarchy, anchored scrolling, foldable user turns; engine-authored continuations use compact expandable context rows, while gate and visual-check results use structured status rows |
| Composer | `src/renderer/composer/Composer.tsx` | Floating, continuously frosted, attachment-aware, keyboard-contained menus |
| Changes review | `src/renderer/panels/ChangesView.tsx`, `DiffPreview.tsx` | Searchable nested file navigator, compact totals, persistent Diff/File review, navigation, copy, and Reveal |
| Changed-files footer | `src/renderer/panels/TurnChangesCard.tsx` | Compact file summary beside Jump to latest; Review opens Changes |
| Settings | `src/renderer/settings/SettingsPanel.tsx` | Full-workspace section navigation, engine-shape-validated saved config, mounted Instructions draft |
| Cloud handoff | `src/renderer/panels/CloudHandoffSheet.tsx` | Blocking ownership-transition modal with ordered session-scoped progress, elapsed state, polite live announcements, sanitized expandable failure detail, and safe retry |
| Git | `src/renderer/git/GitPanel.tsx` | Full Git content inside the shared right-side activity rail |
| Icons | `src/renderer/icons.tsx`, `src/renderer/tool-glyph.tsx` | Lucide stroke wrappers with stable sizing and labels |

## Accessibility and responsive behavior

Use semantic buttons and labeled regions, preserve keyboard reachability, and
keep hit targets usable at narrow widths and 200% zoom. Catalogs and menus trap
focus only while open, restore focus when dismissed, and expose empty/error
states. The transcript is scrollable and keyboard reachable but is not a live
region; narrow busy/idle status is the live status.
Cloud handoff is also a polite atomic live region while provisioning. Its close
and cancel controls are disabled only while ownership is changing, and failure
alerts keep keyboard focus inside the still-open dialog for inspection or retry.

The project rail becomes a start drawer at tablet widths. The activity sidebar becomes
an end drawer at compact widths. Dock navigation switches to icon-only mode at
the CSS `960px` threshold, while keyboard and slash-command routes remain
available. Nothing in
the responsive collapse may place a user bubble, answer, approval, or composer
behind a panel.

## Theme and style change checklist

When changing renderer presentation:

1. Add or adjust a semantic token in `src/renderer/styles.css`; keep Vibe Dark
   fallbacks synchronized with `src/shared/themes.ts`.
2. Avoid literal component colors, hard-coded shadow stacks, and layout
   transitions.
3. Confirm no decorative section dividers or bright white selection outlines
   were introduced.
4. Check the default, light, contrast, and one alternate named theme in the
   preview harness.
5. Exercise the relevant panel, composer, transcript, narrow, reduced-motion,
   and keyboard states.
6. Update `UI.md`, `README.md`, `VERIFICATION.md`, and the relevant parity or
   acceptance entry when an interaction contract changes.
7. Run `npm run verify` and `git diff --check`; use E2E/bridge/packaged gates
   when the changed surface requires them.

## Source of truth

- Tokens and layout: `src/renderer/styles.css`
- Theme registry and palettes: `src/shared/theme-registry.ts`,
  `src/shared/themes.ts`
- Breakpoints: `src/shared/breakpoints.ts`
- Shell ownership: `src/renderer/App.tsx`
- Right-side workspace geometry: `src/renderer/App.tsx`,
  `src/renderer/git/GitPanel.tsx`, and `src/renderer/styles.css`
- Interaction contract: `UI.md`
- CLI parity: `PARITY.md`
- Acceptance and release gates: `ACCEPTANCE.md`, `VERIFICATION.md`
