# Design polish audit — visual & interaction inventory

**Date:** 2026-07-13
**Scope:** Electron renderer presentation only (`src/renderer/**`, `src/shared/themes.ts` / `breakpoints.ts`, `design-system.md`, `UI.md`, preview harness).
**Original audit constraint:** Documentation only.
**Implementation pass:** Complete. Every finding below now records its shipped change or intentional no-op while preserving the existing design system (quiet dense Graphite character, token-first colors, theme-faithful roles).

This is distinct from the engineering backlog in [`plans/IMPROVEMENT-AUDIT.md`](./IMPROVEMENT-AUDIT.md).

---

## How to read this document

| Severity | Meaning |
|----------|---------|
| **bug-feeling** | Looks broken, clipped, or uses undefined tokens — users notice as a defect |
| **a11y** | Keyboard, focus, hit targets, reduced motion, or contrast gaps |
| **inconsistency** | Two valid-looking treatments that fight the design system or each other |
| **polish** | Small refinement that would make an already-good surface excellent |

Each finding: **title · severity · where · issue · direction** (design-system-preserving, not a redesign).

**Sources:** `src/renderer/styles.css` (~8.9k lines), layout/composer/transcript/panels/settings/git components, `design-system.md`, `UI.md`, the tracked `tools/ui-preview/shoot.mjs` / `tools/ui-preview/mock-vibe.ts` harness, and locally generated `tools/ui-preview/shots/*` (many shots lag live chrome — see D-55).

---

## Executive summary

The shell already has a strong system: semantic tokens, restrained elevation, frosted floating composer, a mutually exclusive activity sidebar, and a quiet activity stream. Excellence work is mostly **cleanup and consistency**:

1. **Token holes** in onboarding (and a few global utilities) fall back to browser defaults.
2. **Motion / focus / easing** have parallel dialects (`--ease-out` vs standard trio; 3px rings vs `--focus-ring`; layout-property transitions).
3. **Chrome contracts** drift slightly (rail primary actions vs “+ only”; dock as elevated card vs chat-surface grammar; dead CSS for full-workspace Git).
4. **Responsive / density** gaps (settings narrow clipping in shots; composer status overcrowding; dual navigation density).
5. **Evidence lag** — preview shots still show pre-dock topbar Jobs/Session and old rail pills.

Prioritize **P0 token bugs → focus/motion grammar → contract alignment → surface polish**.

---

# 1. Layout & chrome

### D-01 · Rail primary actions vs “trailing + only” contract
- **Status:** Complete — Projects and Chats use one trailing `+` each; the duplicate primary action block is removed.
- **Severity:** inconsistency
- **Where:** `src/renderer/layout/ProjectRail.tsx` (`.rail-primary-actions`: New chat, Open project) + section `+` on Projects/Chats; `UI.md` Project rail (“Trailing **+** only… No New session / Continue pills”)
- **Issue:** Live rail still ships full-width **New chat** and **Open project** rows *and* section `+` for the same jobs. UI.md forbids the old Continue/New-session pills but the current primary block is still heavy chrome for a “quiet Projects + Chats” rail. Preview shots still show the even older three-pill set (stale evidence — D-55).
- **Direction:** Pick one primary grammar and document it: either (A) section `+` only (strict UI.md), or (B) one quiet primary row set — but not both Open project entry points. Align `UI.md`, rail JSX, and shots.

### D-02 · Workspace dock still reads as a floating card, not chat surface
- **Status:** Complete — final user review selected an equally inset compact `--surface-subtle` hairline enclosure with no floating shadow; it remains chat-surface navigation rather than a competing full-height rail.
- **Severity:** inconsistency
- **Where:** `.workspace-dock` in `src/renderer/styles.css`; `src/renderer/layout/WorkspaceDock.tsx`; AGENTS.md / UI.md (chat-surface enclosure, equal inset, no full-height rail tint)
- **Issue:** Dock uses `--drawer-bg`, border, `--shadow-dock`, and glass blur — same elevation family as the activity end panel. Contract text wants the dock *on* the chat surface without a separate rail fill. Visually it competes with Session/Git/Jobs panels rather than reading as stage-local navigation.
- **Direction:** Soften dock to chat-stage grammar (transparent/`var(--bg)`, hairline or no shadow, no glass stack) while keeping row hover/selected fills. Keep end panels as the elevated “open tool” layer.

### D-03 · Dock disappears at 960px with no in-chrome replacement
- **Status:** Complete — the shared `dock: 960` breakpoint switches to an accessible compact icon strip.
- **Severity:** polish (narrow UX)
- **Where:** `@media (max-width: 960px)` hides `.workspace-dock`; Session/Git/Jobs remain via slash / shortcuts
- **Issue:** Below 960px the Environment card vanishes; topbar no longer carries Jobs/Session (correct per contract). Discoverability of Session/Changes/Git relies on muscle memory or `/jobs`.
- **Direction:** Optional compact icon strip in topbar or a single “Workspace” menu at ≤960px — still mutual-exclusive end panels, no second rail tint.

### D-04 · End-panel open motion vs reserved main-column inset
- **Status:** Complete — structural desktop content fades without directional motion; only the compact overlay drawer slides from its edge.
- **Severity:** polish
- **Where:** `.content-inset.end-panel-open .main-column` padding-right; `.activity-rail` / `inspector-enter`
- **Issue:** Main column reflows width when the lane opens; panel animates opacity + `translateX`. Reflow is layout (not property-scoped motion) and can feel like a jump next to the calm 8–12px panel slide.
- **Direction:** Prefer reserved lane always-or animate only opacity on the panel if reflow is required; avoid second simultaneous layout animation. Honor reduced motion (already collapses durations).

### D-05 · Jobs stack is parallel to activity-rail (same geometry, different shell)
- **Status:** Complete — Jobs now uses the shared activity-rail shell and production code contains no Jobs drawer/backdrop path.
- **Severity:** inconsistency
- **Where:** `.jobs-drawer-root` / `.jobs-drawer` vs `.activity-rail`; `src/renderer/panels/JobsView.tsx`
- **Issue:** Jobs uses a dedicated root + transparent backdrop + `jobs-backdrop-in` while Session/Git share `.activity-rail` + `inspector-enter`. Geometry matches (`--activity-rail-w`) but enter/exit/backdrop grammar differs — risk of subtle visual desync when switching dock targets.
- **Direction:** Route Jobs through the same activity-rail shell classes (header, close, enter/exit, optional closing class) so only body content differs.

### D-06 · Git full-workspace leftovers vs end-panel GitView
- **Status:** Complete — Git has one activity-panel model; the stale public content export and drawer naming are removed.
- **Severity:** polish / dead UI risk
- **Where:** `src/renderer/git/GitPanel.tsx` exports `GitSidebar` / `GitContent` (settings-rail grammar); live `GitView` is `.activity-rail.git-activity-rail`
- **Issue:** Full-workspace Git chrome remains in source and in stale `git.png` shot, while product path is the right-side lane. Dual mental models confuse polish work.
- **Direction:** Delete or quarantine unused full-workspace Git chrome; refresh git shot to end-panel geometry.

### D-07 · Topbar is intentionally sparse — brand separator can feel orphaned
- **Status:** Complete — the decorative brand rule is absent; brand appears only in the collapsed-rail leading cluster and `/` remains semantic project/session separation.
- **Severity:** polish
- **Where:** `.topbar-brand::after` 1px rule; topbar has no trailing actions in live `src/renderer/App.tsx`
- **Issue:** When the rail is collapsed, brand + thin separator + project/session title is correct but the separator is a micro-decoration with no matching right-side balance.
- **Direction:** Keep minimal topbar; either drop the brand `::after` hairline or ensure it only appears when brand + title share the leading cluster.

### D-08 · Context line competes with empty stage air
- **Status:** Complete — the live line uses `--text-secondary` and medium weight; no additional chip chrome is needed.
- **Severity:** polish
- **Where:** `.context-line` above transcript when busy/non-empty
- **Issue:** Very quiet (`--text-subtle`, caption); easy to miss next to git meta chips at laptop widths.
- **Direction:** Slightly stronger secondary text or single-line chip treatment consistent with `.topbar-meta-chip` when metrics matter.

### D-09 · Settings remains full-workspace (intentional) but long nav densifies poorly
- **Status:** Complete — navigation blurbs collapse at laptop density while section titles remain scannable.
- **Severity:** polish
- **Where:** `.settings-nav-list`, settings shot, `settings-narrow.png`
- **Issue:** 14+ section rows with title + blurb fill the rail; at narrow widths form content clips (see D-10). Selected section fill is good; section blurbs add vertical noise for power users.
- **Direction:** Collapse blurbs to title-only under a density threshold; keep full labels on wide.

### D-10 · Settings narrow layout clips form content
- **Status:** Complete — tablet forms stack fields with tokenized inline padding, and phone Settings becomes a full-width vertical surface.
- **Severity:** bug-feeling
- **Where:** `tools/ui-preview/shots/settings-narrow.png`; `@media (max-width: 900px)` settings rules
- **Issue:** Shot shows form fields truncated mid-glyph on the left; rail + form stack poorly. Feels broken, not merely dense.
- **Direction:** Ensure settings form column gets full remaining width, horizontal padding from tokens (`--column-inset` / `--space-base`), and that dual-column field grids stack before content is clipped. Re-capture `settings-narrow` after fix.

### D-11 · Welcome gate is calm but disconnected from rail empty states
- **Status:** Complete (intentional no-op) — the rail keeps the D-01 trailing-`+` contract; adding a second gate-style empty-state button would duplicate project creation.
- **Severity:** polish
- **Where:** `WelcomeGate.tsx`, `welcome.png`
- **Issue:** Centered “Open a project” is excellent; once inside, empty Projects copy is different voice (“Add a folder to start.”). Fine, but first-run → rail handoff could share button radius/weight language (gate primary is filled pill; rail actions are ghost).
- **Direction:** Shared primary/secondary button recipes for “Open project” across gate and rail.

---

# 2. Surfaces, backgrounds, elevation, frost

### D-12 · Undefined CSS custom properties (onboarding + utilities)
- **Status:** Complete — all listed usages map to existing semantic/type tokens; no undefined aliases remain.
- **Severity:** bug-feeling
- **Where:** `styles.css` onboarding block (~8718+); also toast/memory
- **Issue:** Used but **never defined** in `:root` / scheme blocks:
  - `--leading-copy` (toast, `.memory-notice-detail`)
  - `--text-h3` (onboarding header)
  - `--text-primary` (onboarding provider item)
  - `--ok` (provider check)
  - `--danger` (save error)
  Browser ignores invalid `var()`, so type size/color/line-height silently degrade.
- **Direction:** Map to existing tokens only: e.g. `--leading-prose`, `--text-heading` / `--text-display-sm`, `--assistant`, `--add` or `--subagent`, `--del`. No new palette language.

### D-13 · Dual glass models: opaque shell vs liquid-glass chrome
- **Status:** Complete — shell, floating, and true-overlay materials now use one documented tier model with shared frost tokens.
- **Severity:** inconsistency
- **Where:** `html.glass` / `html.electron-transparent` rules throughout
- **Issue:** Many surfaces re-declare glass fills (rail, dock, activity, composer, queue). Light + glass forces opaque `--bg` on shell (good) while dark transparent mode punches through. Risk of uneven frost strength across siblings.
- **Direction:** Centralize glass surface recipes (3 tiers max: shell opaque, floating frost, overlay frost) and have components only pick a tier.

### D-14 · Composer frost vs bottom veil stacking
- **Status:** Complete — reduced motion drops blur but uses a five-stop wash, preserving atmosphere without a hard band.
- **Severity:** polish
- **Where:** `.chat-column:not(.is-empty)::after` veil; `.composer-wrap::before` frost
- **Issue:** Two blur layers (veil + composer) in the same vertical band. Usually correct; on low-end GPUs or reduced-motion (blur stripped) the veil becomes a flat gradient that can look like a hard dirt band.
- **Direction:** When blur is disabled, use a longer softer gradient stop list so the veil still reads as atmosphere, not a dirty cut.

### D-15 · Mask uses raw `rgb(0 0 0 / 0.6)`
- **Status:** Complete — the mask uses explicit `black`/transparent semantic alpha stops.
- **Severity:** polish
- **Where:** veil `-webkit-mask-image` / `mask-image` (~1619–1630)
- **Issue:** Only literal RGB outside `:root` fallbacks (allowed for masks, but unique dialect).
- **Direction:** Comment as intentional mask-only, or use `black` alpha stops consistently.

### D-16 · Queue tray vs composer elevation mismatch
- **Status:** Complete — queue and composer share the same surface background, border, radius, and floating-frost tier.
- **Severity:** polish
- **Where:** `.composer-queue-tray` (opaque elevated) vs frosted `.composer-wrap`
- **Issue:** Queue card sits above composer with solid elevated fill; composer is frosted. Stack reads as two different material systems.
- **Direction:** Share composer material (same border radius family already uses `calc(xl + 2xs)`).

### D-17 · Approval cards opaque (good) but padding tokens drift
- **Status:** Complete — cards use `--space-sm` / `--space-base`; no raw 14px card padding remains.
- **Severity:** polish
- **Where:** `.card` padding `14px 16px` (raw) vs space scale
- **Issue:** 14px is off the 4/8/12/16 scale.
- **Direction:** Use `--space-sm` / `--space-base` (or a single card-padding token).

### D-18 · Light scheme edge-lit is strong; dark edge is subtle — intentional but watch cards
- **Status:** Complete (verified no-op) — cards, sources, and approval surfaces consume the shared hairline/elevation grammar across schemes.
- **Severity:** polish
- **Where:** light `--edge-highlight` 78% edge-lit vs dark 5%
- **Issue:** Light cards can feel “outlined”; dark can feel flat. Not wrong, but source cards / code blocks need the same edge grammar.
- **Direction:** Spot-check light `sources`, `table`, `permission` after any elevation tweak; keep one hairline recipe.

---

# 3. Hover, press, active, disabled

### D-19 · Press feedback exclusion list is fragile
- **Status:** Complete — press movement is opt-in through semantic action classes; dense row/icon controls remain still by default.
- **Severity:** inconsistency
- **Where:** global `button:active:not(...long exclusion list)` (~287)
- **Issue:** New icon buttons that omit the exclusion twitch; some primary actions that should press are excluded. Hard to maintain.
- **Direction:** Opt-in class (e.g. `.pressable`) for primary/chip actions only.

### D-20 · Hover-reveal utility actions (copy/edit)
- **Status:** Complete — shared `.hover-reveal` behavior covers pointer, `:focus-within`, and always-visible touch paths; assistant Copy uses trusted native clipboard IPC with explicit failure state.
- **Severity:** a11y / polish
- **Where:** `@media (hover: hover)` on `.assistant-actions`, tool/plan copy, queue actions
- **Issue:** Opacity 0 until hover/focus-within — good for calm UI; keyboard path relies on focus-within. Fine if focus rings always show; easy to regress. Touch forces visible (good).
- **Direction:** Keep hover-hide; add a single shared `.hover-reveal` recipe + tests that focus-within forces `opacity: 1`.

### D-21 · Disabled opacity is a grab bag
- **Status:** Complete — unavailable controls use `--opacity-disabled`; selected/current controls that are non-clickable keep semantic state styling.
- **Severity:** inconsistency
- **Where:** global disabled `0.45`; dock row `0.38`; composer-ghost `0.32`; various `0.55`
- **Issue:** Same semantic “can’t use” reads differently per surface.
- **Direction:** Tokenize `--opacity-disabled: 0.45` (and maybe `--opacity-quiet: 0.72` for secondary icons).

### D-22 · Session/project more (⋯) opacity until row hover
- **Status:** Complete — active rows and `:focus-within` retain the overflow action in addition to hover discovery.
- **Severity:** polish
- **Where:** project/session row more buttons
- **Issue:** Correct quiet pattern; ensure selected row still shows ⋯ without hunting (active row should keep affordance).
- **Direction:** `opacity: 1` on `.is-active` / `:focus-within` rows as well as hover.

### D-23 · Composer status chips: hover on metrics is uneven
- **Status:** Complete — display-only metrics use `cursor: default` and no hover treatment; interactive chips retain hover feedback.
- **Severity:** polish
- **Where:** `.composer-metric` vs `.mode-trigger:hover`
- **Issue:** Some chips are interactive, some display-only; display-only still look chip-like so users may click for nothing.
- **Direction:** Non-interactive metrics: no border hover change, `cursor: default`; interactive: chip hover.

---

# 4. Focus-visible treatment

### D-24 · Two focus ring dialects
- **Status:** Complete — keyboard focus uses `--focus-ring`; container/drop states use the single documented `--focus-soft` token.
- **Severity:** inconsistency / a11y
- **Where:** canonical `--focus-ring` (2px bg + 4px focus); ad-hoc `0 0 0 3px color-mix(...ring...)` on filter, rename, composer focus-within, catalog, drop target (~920, 1200, 1326, 4217, 4411, 6635)
- **Issue:** Keyboard focus and “soft focus” containers don’t share one visual language. Composer focus-within uses 3px glow; buttons use two-layer ring.
- **Direction:** Prefer `--focus-ring` everywhere for keyboard; keep a single `--focus-soft` token if container focus-within needs a gentler glow.

### D-25 · Toast dismiss uses `outline: var(--focus-ring)` not `box-shadow`
- **Status:** Complete — toast, project, and session controls apply the multi-layer ring through `box-shadow` only.
- **Severity:** inconsistency
- **Where:** `.toast-dismiss:focus-visible` (~6869)
- **Issue:** `--focus-ring` is a box-shadow stack used as `outline` — browsers may not paint multi-layer outline as intended.
- **Direction:** Use `box-shadow: var(--focus-ring)` like other controls; keep outline none.

### D-26 · Global `:focus { outline: none }` without universal :focus-visible safety net
- **Status:** Complete — buttons, interactive roles, and `[tabindex]` receive the default ring; wrapper-owned inputs explicitly opt out.
- **Severity:** a11y
- **Where:** lines 294–295 + selective list of selectors that get `--focus-ring`
- **Issue:** Any new control not added to the allowlist gets **no** visible focus. Current list is long but incomplete by construction.
- **Direction:** Default `button:focus-visible, a:focus-visible, [tabindex]:focus-visible { box-shadow: var(--focus-ring) }` and opt out wrappers only.

### D-27 · Links use underline focus, not ring
- **Status:** Complete (intentional no-op) — prose links retain a strong two-pixel focus underline; card-like link controls use rings.
- **Severity:** polish
- **Where:** `a:focus-visible, summary:focus-visible`
- **Issue:** Intentional alternate; can be low-visibility on busy markdown.
- **Direction:** Keep underline for inline prose links; use ring for link-buttons / source titles if they act as cards.

---

# 5. Motion, enter/exit, interactive animation

### D-28 · Layout properties are transitioned (design-system violation)
- **Status:** Complete — layout changes are discrete; transitions are scoped to transform, opacity, color, and shadow.
- **Severity:** inconsistency
- **Where:** `.project-rail` transitions `width` + `flex-basis`; resize-handle `::after` transitions `height`
- **Issue:** design-system.md: “Transition only transform, opacity, color, or box-shadow; never animate layout properties.” Rail open/close animates width.
- **Direction:** Prefer transform/opacity drawer pattern, or accept layout animation only for rail with an explicit exception documented in design-system.

### D-29 · Dual easing families
- **Status:** Complete — legacy aliases are removed; enter, exit, and standard curves own all finite motion.
- **Severity:** inconsistency
- **Where:** `--ease-enter` / `--ease-exit` / `--ease-standard` vs legacy `--ease-out` (22 uses) and `--ease-default` alias
- **Issue:** Same durations, different curves → hover vs enter feel slightly “off-brand” between rail and dock.
- **Direction:** Migrate `--ease-out` call sites to enter/exit/standard; remove alias once unused.

### D-30 · Many enter keyframes; exit is incomplete
- **Status:** Complete — toasts and menus have matched exits; structural dock switching remains intentionally immediate per D-04.
- **Severity:** polish
- **Where:** `surface-enter`, `inspector-enter`, `workspace-dock-enter`, `toast-in`, `jump-in`, `scrim-enter`, `jobs-backdrop-in`; `surface-exit` used for menus; toast has **no exit**
- **Issue:** Toasts and some panels unmount hard (no exit). Menus do exit. Asymmetric.
- **Direction:** Shared enter (opacity + 4px Y or 8px X by edge) + matching exit before unmount for toast/dock; reuse `surface-exit` where vertical.

### D-31 · Modal overlay reuses `toast-in`
- **Status:** Complete — overlays use `scrim-enter` and modal surfaces use `surface-enter`.
- **Severity:** polish
- **Where:** `.modal-overlay { animation: toast-in ... }`
- **Issue:** Semantic mismatch; modal should use scrim + surface enter.
- **Direction:** `scrim-enter` on overlay + `surface-enter` on `.onboarding-modal`.

### D-32 · Duplicate spin keyframes
- **Status:** Complete — one `spin` keyframe serves all rotating loaders.
- **Severity:** polish
- **Where:** `@keyframes spin`, `@keyframes gate-spin` in `src/renderer/styles.css` (identical rotate)
- **Issue:** Two identical keyframe names for the same spin loop add noise and risk divergent edits.
- **Direction:** One `spin` keyframe.

### D-33 · Reduced motion: global hammer + leftover local rules
- **Status:** Complete — one global rule owns CSS motion, and JavaScript transcript scrolling explicitly honors the OS preference.
- **Severity:** polish
- **Where:** global `@media (prefers-reduced-motion: reduce)` (~7079); jobs-local reduce (~6189)
- **Issue:** Global rule is good; local job rules are redundant. `animation-duration: 0.01ms` still runs one frame — acceptable. JS scroll/rail must also honor preference (design-system requirement) — verify `SidebarResizeHandle` / scroll anchors.
- **Direction:** Keep global; delete redundant locals; audit JS motion paths.

### D-34 · Status spinners: engine-pulse vs spin
- **Status:** Complete — loading rings rotate continuously; non-loading active rows retain the quiet engine pulse, and reduced motion preserves state without travel.
- **Severity:** polish
- **Where:** `.status-dot-active` uses `spin`; job running uses `engine-pulse`
- **Issue:** Two busy languages (rotate ring vs opacity pulse).
- **Direction:** One busy motif for “work in progress” (prefer quiet pulse for row status, spin only for blocking boot).

---

# 6. Appear / disappear of menus, panels, toasts

### D-35 · Popovers: strong inverted selection
- **Status:** Complete — selected rows consistently use `--sel-bg`/`--sel-fg`; hover remains a quieter surface state and no longer impersonates selection.
- **Severity:** polish
- **Where:** `.slash-item.selected`, mode/insert selected → near-white `--sel-bg`
- **Issue:** Correct high-contrast keyboard selection; on light scheme may be harsh if `--sel-bg` tracks accent poorly.
- **Direction:** Theme-check light + contrast + opencode; ensure selected row text uses `--sel-fg` consistently (partially done).

### D-36 · Slash menu headers omit shared popover chrome consistency
- **Status:** Complete — slash, catalog, and generic popovers consume shared header/footer padding and type recipes.
- **Severity:** polish
- **Where:** `.slash-menu-header` vs `.popover-header` padding (8/6 vs 10/8)
- **Issue:** Same family, slightly different padding/type.
- **Direction:** Slash/mention/mode/catalog all consume `.popover-surface` + shared header/footer padding tokens.

### D-37 · Onboarding shot is not the modal
- **Status:** Complete — the preview scenario drives the real first-run `OnboardingModal` through unconfigured provider data.
- **Severity:** inconsistency (evidence)
- **Where:** `onboarding.png` shows in-chat “Setup” card; code has full `.onboarding-modal`
- **Issue:** Preview scenario/docs drift from real first-run modal.
- **Direction:** Scenario should mount `OnboardingModal`; recapture shot.

### D-38 · Permission card shows truncated command + full command
- **Status:** Complete — short commands render once; only truncated or multiline commands add a full preview, with raw payload behind Technical details.
- **Severity:** polish
- **Where:** `permission.png`, permission card preview
- **Issue:** Truncated pill + full body duplicate the same command — useful but tall.
- **Direction:** Single preview with expand (“Technical details”) as today; avoid double full strings when short enough to show once.

---

# 7. Typography hierarchy

### D-39 · Raw font sizes bypass type scale
- **Status:** Complete — renderer CSS contains no literal pixel font sizes; all typography uses the documented scale.
- **Severity:** inconsistency
- **Where:** e.g. code header `11px`, card titles `16px`, perm details `10px`/`11px`, settings form `17px`, git badge `8px`
- **Issue:** Scale defines caption/micro/label/title; literals drift.
- **Direction:** Map 8–10 → micro/caption, 11–12 → caption/label, 15–16 → prose/title, 17 → heading.

### D-40 · Font weights outside token set
- **Status:** Complete — all renderer weights use the documented 400/450/500/600 tokens; no raw 550/700 variants remain.
- **Severity:** inconsistency
- **Where:** many `font-weight: 450|500|550|600|700`; tokens are regular/ui/medium/semibold
- **Issue:** `550` and `700` are not in the documented scale (`400/450/500/600`).
- **Direction:** Replace 550→500 or 600; 700→600; prefer `var(--weight-*)`.

### D-41 · Uppercase micro labels reappear
- **Status:** Complete — chrome labels are sentence case at the component source and consume normal UI tracking; no uppercase override dialect remains.
- **Severity:** inconsistency
- **Where:** `[data-streamdown="code-block-header"]` uppercase + tracked; `.card-eyebrow` uppercase + `0.06em` tracking
- **Issue:** UI.md / design-system: section headers use sans sentence case — “no micro-caps / tracked mono.” Code language chips are a gray area; card eyebrows (“Needs your approval”) are chrome.
- **Direction:** Sentence case for card eyebrows; keep code lang label quiet sans medium without forced uppercase (or accept uppercase only for language ids with documented exception).

### D-42 · Letter-spacing micro-variants
- **Status:** Complete — UI copy uses `--tracking-ui`, display hierarchy uses `--tracking-tight`; only the fixed-geometry ASCII wordmark retains custom tracking.
- **Severity:** polish
- **Where:** body `-0.01em`, titles `-0.02em`, user bubble `-0.011em`, various `0.01–0.06em`
- **Issue:** Too many tracking values for little gain.
- **Direction:** Two tracking tokens: UI default and tight display.

### D-43 · Mono reserved mostly correctly; watch path chrome
- **Status:** Complete — activity-panel paths use sans UI chrome; mono remains limited to code, diffs, job output, and fixed machine content.
- **Severity:** polish
- **Where:** paths in turn-changes / inspector may use mono; tool labels use sans (good) in transcript styles
- **Issue:** Mostly correct mono/sans split; path rows can drift into mono “chrome voice” if not treated as machine identifiers.
- **Direction:** Mono only for code, diffs, job output, fenced blocks; paths can stay mono if treated as machine ids.

---

# 8. Spacing & alignment

### D-44 · Off-scale gaps and paddings
- **Status:** Complete — structural spacing consumes the 4/8/12/16/24/32/48/64 scale; only optical 1–3px adjustments remain local.
- **Severity:** polish
- **Where:** widespread `2px`, `3px`, `5px`, `6px`, `10px`, `14px` in flex gaps/padding
- **Issue:** Scale is 4/8/12/16…; sub-grid 2–3px is fine for icon optical alignment but 5/6/10/14 should snap.
- **Direction:** Prefer `--space-2xs` (4) and half-gaps only with comment; replace 10→8/12, 14→12/16.

### D-45 · User bubble / assistant / composer measure alignment
- **Status:** Complete — user turns and composer share `--composer-max`; transcript content retains its intentionally wider reading measure.
- **Severity:** polish (mostly good)
- **Where:** user stack `max-width: min(84%, 36rem)`; composer `--composer-max: 40rem`; reading `--reading-max: 130ch`
- **Issue:** Intentional wider transcript vs tighter composer; user bubble at 36rem is slightly inside composer 40rem — usually fine, can look left-of-composer on wide.
- **Direction:** Optionally bind user max to `min(100%, var(--composer-max))` for perfect stack alignment.

### D-46 · Icon columns: 13–18px boxes
- **Status:** Complete — rail, dock, and activity navigation share the 16px utility column; smaller dimensions are status indicators only.
- **Severity:** polish
- **Where:** dock grid `18px`, rail `--rail-icon-size: 16px`, various 13–15px icons
- **Issue:** Mostly stable; dock vs rail differ by 2px.
- **Direction:** Standardize utility icon box 16px; dock column 16 or 18 consistently.

### D-47 · Composer status strip overcrowding
- **Status:** Complete — detailed metrics hide at laptop density while mode, model, and the primary Stop action remain available.
- **Severity:** polish
- **Where:** busy/queue shots: Agent + tokens + cost + cached + density + ctx% + model + Stop
- **Issue:** One row becomes a metric parade; at laptop, metrics hide late (≤720).
- **Direction:** Progressive disclosure: always mode + model + stop; park cost/tokens behind overflow or Session panel.

---

# 9. Responsive & breakpoints

### D-48 · CSS 960 dock hide vs JS breakpoints table
- **Status:** Complete — `dock: 960` is named in shared breakpoints, parity coverage, and the design-system table.
- **Severity:** inconsistency
- **Where:** design-system tables list 1280/1100/900/720/640; dock hide is **960** (undocumented in breakpoints.ts)
- **Issue:** Magic number not in `src/shared/breakpoints.ts`.
- **Direction:** Add `dock: 960` (or chosen value) to breakpoints + design-system table.

### D-49 · Tablet rail drawer uses `--bg` not `--rail`
- **Status:** Complete — the tablet start drawer uses `--drawer-bg` consistently.
- **Severity:** polish
- **Where:** `@media (max-width: 900px) .project-rail.is-open`
- **Issue:** Drawer background switches to `--bg` while desktop rail uses `--rail` — slight scheme inconsistency.
- **Direction:** Use `--drawer-bg` / `--rail` consistently for start drawer.

### D-50 · Compact end drawer drops radius (full-bleed) — good; scrim animation only
- **Status:** Complete — full-bleed compact geometry and the end scrim share one path while chat remains mounted.
- **Severity:** polish
- **Where:** ≤720 activity/jobs absolute edge drawers
- **Issue:** Correct pattern; ensure chat scroll position preserved (contract) remains tested.
- **Direction:** Keep; verify e2e/scroll contract still covered.

### D-51 · Coarse pointer: composer chips stay 32px, not 44px
- **Status:** Complete — primary Send/Stop actions are 44px; secondary status chips remain 32px and wrap as the documented dense-strip exception.
- **Severity:** a11y (accepted tradeoff?)
- **Where:** `@media (hover: none), (pointer: coarse)`
- **Issue:** Comment acknowledges density; design-system asks usable hit targets. Status chips at 32px are small for thumbs.
- **Direction:** Prefer wrap + 44px for primary stop/send; keep secondary chips 32 if documented as intentional exception.

### D-52 · Narrow settings dual-pane not collapsing to single scroll
- **Status:** Complete — at 720px Settings becomes a full-width vertical index plus one active-form scrollport.
- **Severity:** bug-feeling (with D-10)
- **Where:** settings narrow shot
- **Issue:** Side nav + form at phone widths without clear single-column handoff.
- **Direction:** At ≤720, settings sections as select/dropdown or stacked full-width nav above form.

---

# 10. Component-specific notes

### D-53 · Turn changes card is quiet (good); Review affordance easy to miss
- **Status:** Complete — the compact changed-files pill shares the transcript footer row with Jump to latest and opens the dedicated Changes workspace above the composer veil.
- **Severity:** polish
- **Where:** `TurnChangesCard`, chat shots
- **Issue:** Pill “Changed files · N · Review” is calm; after long turns it sits above composer under veil.
- **Direction:** Slightly higher contrast label or pin above veil stacking context.

### D-54 · ASCII splash wordmark stays invariant
- **Status:** Complete — the plain compact fallback was removed. The same fixed-geometry ASCII `WORDMARK` scales fluidly with its container at every window size, with a contract test preventing a responsive swap.
- **Severity:** polish
- **Where:** `.splash-wordmark`, `src/renderer/layout/Splash.tsx`, `src/shared/splash-wordmark-contract.test.ts`
- **Issue:** A plain small-window fallback lost the product’s distinctive identity.
- **Direction:** Preserve one wordmark and scale it rather than substituting a second brand treatment.

### D-55 · Preview shots and mock chrome are stale
- **Status:** Complete for live code; image recapture intentionally skipped per the user’s explicit instruction not to over-test. The preview mock follows the live dock/topbar contracts and includes the master-detail `changes` scenario.
- **Severity:** inconsistency (tooling)
- **Where:** `tools/ui-preview/shots/*` (dated Jul 11–12); many frames show topbar **Jobs / Session**, rail **New session / Open project / Continue latest**
- **Issue:** Live `App.tsx` topbar has no Jobs/Session actions; rail is New chat + Open project; dock is the workspace launcher. Shots mis-train visual QA.
- **Direction:** Regenerate full matrix with `npm run ui:shots` after mock reflects live shell; fail CI if key contracts regress (already partly covered by unit contracts).

### D-56 · Error notice in busy transcript is correct severity color
- **Status:** Complete — error notices retain semantic delete color, sentence case, and card-scale padding.
- **Severity:** polish (positive + watch)
- **Where:** `.notice.error`, busy shot “Engine emitted an invalid UI event”
- **Issue:** Strong red banner is appropriate; ensure it doesn’t use uppercase/micro tracking.
- **Direction:** Keep; match padding to card scale.

### D-57 · Keys overlay / catalog / onboarding focus traps exist — visual parity of overlays
- **Status:** Complete — modal and drawer overlays consume shared `--scrim-modal` / `--scrim-drawer` tokens and matched enter grammar.
- **Severity:** polish
- **Where:** Keys, Catalog, Onboarding z-index `--z-modal` / popover
- **Issue:** Overlay scrim strengths differ (modal 55% bg mix vs drawer scrim 40% ink).
- **Direction:** Shared `--scrim-modal` / `--scrim-drawer` tokens.

### D-58 · Git end-panel tabs vs settings nav item grammar
- **Status:** Complete — Git active rows use `--nav-active-bg`, hover is quieter, and keyboard focus retains the shared ring.
- **Severity:** polish
- **Where:** `.git-drawer-tab` vs `.settings-nav-item`
- **Issue:** Both are section switches; different density (horizontal tabs vs vertical nav). Acceptable for narrow rail; watch active fill consistency with dock rows.
- **Direction:** Shared `is-active` fill token for all nav rows (dock, settings, git tabs).

### D-59 · Scrollbars overlay — good; nested panes may still jump
- **Status:** Complete (verified no-op) — overlay scrollbars remain gutter-free and only reveal color on hover/focus.
- **Severity:** polish
- **Where:** global thin overlay scrollbars
- **Issue:** Transparent until hover; some nested lists (settings nav, git file list) may reflow when scrollbar appears if not overlay on all platforms.
- **Direction:** Verify Electron/Chromium overlay scrollbars on macOS; avoid `scrollbar-gutter: stable` (already avoided).

### D-60 · Empty Chats / Projects quiet states
- **Status:** Complete — section empty states use `--text-secondary` at label size with consistent rail indentation.
- **Severity:** polish
- **Where:** `.rail-state-quiet`
- **Issue:** Indented empty copy is correct; ensure color contrast ≥ muted secondary.
- **Direction:** Use `--text-secondary` not ultra-subtle for empty CTAs.

---

# 11. Theme & multi-scheme risks

### D-61 · Selection colors on non-Graphite themes
- **Status:** Complete for live code — all selected rows consume palette-provided `--sel-bg`/`--sel-fg`; screenshot theme sweep intentionally skipped per user instruction.
- **Severity:** polish
- **Where:** `--sel-bg` / `--sel-fg` from palette; slash selected rows
- **Issue:** Inverted selection is Graphite-native; colorful themes may get surprising selected rows.
- **Direction:** Preview `theme=opencode|tokyonight|light|contrast` for slash + catalog + mode.

### D-62 · Accent remaps focus — verify onboarding accent swatches
- **Status:** Complete — selected and keyboard-focused swatches use `--focus-ring`, which follows the active accent token.
- **Severity:** polish
- **Where:** accent presets; `--focus` from `--ring`
- **Issue:** Custom accent should move focus ring; swatches use raw borders.
- **Direction:** Selected swatch uses `--focus-ring` or border-active.

---

# 12. Completed implementation roadmap

| Priority | IDs | Theme |
|----------|-----|--------|
| **P0** | D-12, D-10, D-52 | Undefined tokens; settings narrow clip |
| **P1** | D-24, D-25, D-26, D-28, D-29, D-02, D-05, D-01 | Focus grammar; motion rules; dock/jobs/rail contract |
| **P2** | D-16, D-30, D-31, D-36, D-39–D-42, D-47, D-48 | Materials, type scale, composer metrics, breakpoints doc |
| **P3** | D-03, D-07, D-08, D-11, D-53–D-55, D-61 | Discoverability, shot refresh, theme sweep |

---

# 13. What is already excellent (do not “fix”)

- Token-first Graphite fallbacks synced to `themes.ts` first paint
- Mutually exclusive activity sidebar + main column reserve
- Composer continuous frost covering full surface
- User bubble fold + actions under bubble
- Overlay scrollbars
- Sentence-case rail section labels (Projects / Chats)
- Quiet thinking/tool activity stream (no badge clouds)
- Portal menus with flip / destructive in-menu confirm
- `prefers-reduced-motion` global collapse of animation/transition
- Design docs (`design-system.md`, `UI.md`) as living contracts

---

# 14. Evidence index

| Surface | Primary sources | Shots / scenarios consulted |
|---------|-----------------|------------------------------|
| Tokens / motion | `src/renderer/styles.css` :root–350, 7079+ | — |
| Project rail | `src/renderer/layout/ProjectRail.tsx`, styles 707–1550 | splash, chat, busy |
| Topbar / stage | `src/renderer/App.tsx`, styles 523–700 | chat, light |
| Dock / activity sidebar | `src/renderer/layout/WorkspaceDock.tsx`, `src/renderer/layout/ActivitySidebar.tsx`, `src/renderer/panels/Inspector.tsx`, `src/renderer/panels/TerminalPanel.tsx`, `src/renderer/panels/JobsView.tsx`, `src/renderer/git/GitPanel.tsx`, `src/main/terminal-manager.ts` | inspector, jobs, git; terminal requires live/E2E |
| Composer / queue | `src/renderer/composer/Composer.tsx`, styles 3993–4980 | queue, permission, slash |
| Transcript | `src/renderer/transcript/TranscriptView.tsx`, styles 1717–2900 | chat, docs, table, sources |
| Settings | `src/renderer/settings/SettingsPanel.tsx`, styles 7346+ | settings, settings-narrow |
| Onboarding | `src/renderer/panels/OnboardingModal.tsx`, styles 8718+ | onboarding (stale) |
| Themes | `src/shared/themes.ts`, `src/renderer/theme/applyPalette.ts` | light, theme-opencode |
| Contracts | `design-system.md`, `UI.md`, AGENTS.md | — |
| Preview matrix | `tools/ui-preview/shots/*`, `tools/ui-preview/mock-vibe.ts` | full scenario list in mock header |

---

**End of audit.** All 62 findings have an implementation disposition; the
post-audit terminal, activity-sidebar, and responsive-wordmark follow-up is
complete. Live-code verification is recorded above. Screenshot recapture
remains intentionally omitted per user instruction.
