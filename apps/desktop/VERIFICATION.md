# Verification

Quick gate before shipping desktop changes from [`apps/desktop`](https://github.com/robzilla1738/vibe-codr/tree/main/apps/desktop).

## Experimental cloud gate

- `cd ../.. && bun test packages/core/src/portable-session.test.ts packages/core/src/session-tools.test.ts`
- `cd ../.. && bun test packages/cloud-agentd/src/cloud-model-probe.test.ts packages/providers/src/registry.test.ts`
  proves the sandbox preflight performs a bounded real generation for every
  exact model, rejects a model-list false positive, and restores arbitrary
  provider endpoint/transport bindings without a Mac-only config file.
- `cd ../.. && bun run build:cloud-runtime`
- `cd ../.. && bun run smoke:cloud-runtime` verifies the archive with
  network disabled, loads `node-pty`/`ws`, exports and imports a real engine
  session into the canonical cloud state root as the isolated workload user,
  resumes that exact session ID with a non-default Ollama model and persisted
  history, starts the daemon with the same identity, requires it to preflight the
  same ID before authenticated `/health` succeeds, snapshots the same
  model/history, runs the bundled exact-generation probe against two models on
  a network-isolated mock endpoint, stops cleanly, and exports a return snapshot
  into a directory writable only by the isolated workload identity.
- Confirm runtime `engineRevision` equals `ENGINE_COMMIT`, outer and internal
  checksums pass in Linux, and `sbom.spdx.json` is present.
- Confirm packaging rejects dirty engine runtime inputs and outbound handoff
  rejects a portable archive whose session ID or canonical source root differs
  from the active workspace.
- `npm test -- --run src/main/cloud/cloud-supervision.test.ts src/main/cloud/session-continuity.test.ts src/main/cloud/workspace-transfer.test.ts src/shared/cloud-handoff-ux.test.ts src/main/remote-engine-transport.test.ts src/shared/protocol.test.ts`
  covers protected return paths and Git history, branch/index-only divergence,
  recursive submodule commit restoration, exact mode rollback, remote-session
  identity/model/history continuity before ownership commit, stale same-name
  sandbox destruction before fresh create, finite-command exits,
  output redaction/truncation, daemon early exit,
  concrete stack-error summaries, exact-model generation preflight through the
  shared provider registry, explicit hosted Ollama route pinning,
  health timeout, immediate final-workload resume rejection, transient retries,
  session-filtered accessible progress,
  renderer RPC privilege separation, and archive verification.
- `npm run test:cloud:live` runs the paid, opt-in E2B and Vercel lifecycle
  contracts with `E2B_API_KEY`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and
  `VERCEL_PROJECT_ID`. Fresh green output is required within seven days of a
  release; the default unit suite skips these resource-creating tests.
- The E2B live contract must fetch its allowlisted registry domain while using
  the required `allowOut` plus `denyOut: [ALL_TRAFFIC]` policy, then prove
  pause/resume and destruction. This is the regression gate for E2B's 400
  network-policy response.
- Paid opt-in suites must additionally cover the packaged runtime's authenticated
  PTY and preview channels before stable release.
- Both provider contracts must prove privileged control startup (`id -u` is 0),
  while runtime tests prove engine/PTY children receive the dedicated non-root
  UID/GID and cannot inherit the control bearer or one-shot file path.
- Vercel cold-resume coverage must prove the daemon is relaunched and healthy
  before Electron switches transport; workspace tests must cover both
  file-to-directory and directory-to-file return replacements.
- Reconnect coverage must prove live events survive transcript hydration, a
  disconnected remote is resumed before cloud-to-local export, catalog writes
  are durably flushed, and interrupted ownership cannot invoke cloud deletion.
- Core recovery must return structured aborted/already-committed ownership
  results; tests must cover the snapshot/engine-idle lost-wakeup window and the
  Settings mutation/draft guards.
- Reopen coverage must restore a durable Needs-your-Mac request from snapshot,
  replay events held during remote activation, and authorize only the verified
  divergent worktree returned by the main-process manager.
- Never remove the experimental flag while either provider suite or the durable
  local-capability relay acceptance suite is missing.

## Automated

### Provider and subscription auth focus

```bash
# Electron IPC/config/catalog/Cloud boundary
npm test -- --run src/shared/provider-auth.test.ts src/shared/renderer-rpc.test.ts \
  src/shared/providers-catalog.test.ts src/shared/runtime-guards.test.ts \
  src/shared/config-validate.test.ts src/main/cloud/model-environment.test.ts
npm run typecheck
npm run verify:source-parity

# Locked engine OAuth/registry/bridge contracts
cd ../..
bun test packages/providers/src/oauth.test.ts packages/providers/src/registry.test.ts \
  packages/macos-bridge/src/protocol.test.ts packages/macos-bridge/src/host.integration.test.ts
bun run typecheck
```

The release records the audited OpenCode revision in
`OPENCODE_PROVIDER_COMMIT`. Manual packaged checks connect an eligible ChatGPT
account and send one Codex turn, then connect an eligible xAI account and send
one `xai-oauth/grok-4.5` turn and one `xai-oauth/grok-build-0.1` turn. Confirm
Grok 4.5 uses Responses reasoning and Grok Build uses Chat Completions. These
live entitlement checks are not run by CI and must not be represented as
automated coverage.

```bash
cd /path/to/vibe-codr/apps/desktop
npm test
npm run test:coverage  # V8 floors on shared + bridge/host-resolver/ipc-security
npm run lint
npm run verify:source-parity
npm run verify:config-shape
npm run typecheck
npm run build
npm run verify:bundle
npm run smoke:bridge   # requires the locked engine worktree host or VIBE_CODR_ROOT
npm run test:e2e       # hermetic Electron host/renderer lifecycle matrix
```

Expect: the current Vitest suite green, Playwright Electron E2E
green (**12** scenarios), all 21 upstream source pairs aligned, Biome and `tsc`
clean, all 40 engine config fields represented, electron-vite build and
renderer/host bundle budget OK, and smoke prints
`ready` + `snapshot ok` and a structurally valid project-list response (which
may be empty when every project is archived). Prefer live suite output over frozen counts in prose.
Settings, Sessions, and the xterm runtime must remain in deferred chunks: aggregate
renderer payload may include them, but the initial/largest chunk retains its
budget.
`npm ci` must finish the `install-electron` prefetch before Vitest starts; this
prevents parallel test workers from racing Electron 43's lazy binary download.

| Gate | Includes |
|------|----------|
| `npm run verify` | lint + unit + source/config parity + typecheck + build + bundle |
| `npm run verify:fast` | lint + unit + typecheck |
| `npm run verify:ci` | verify + coverage + bridge smoke + E2E |

The source and config parity commands read their upstream files directly from
the exact revision in `ENGINE_COMMIT` with `git show`. The canonical repository
therefore only needs to contain that commit; newer default-branch work cannot
silently redefine the release contract. Packaging is stricter: `copy-host` requires the engine checkout HEAD
to equal `ENGINE_COMMIT`, rejects dirty runtime paths, verifies source freshness
and host architecture, and only then embeds the host. The source parity script
allows documented Electron-specific additions and normalizes whitespace to
avoid false formatting drift.

CI materializes the locked engine commit at repository-root `.engine` and
points parity, bridge, cloud-runtime, and packaging gates at that worktree.
The macOS-only `electron-liquid-glass` package is optional, externally bundled,
and loaded only after a Darwin platform check; Linux CI must typecheck, build,
and run the Electron harness without installing that native module.

Repository-root GitHub CI (`../../.github/workflows/ci.yml`) runs `verify`, coverage floors,
`smoke:bridge`, and Electron E2E on Linux, plus explicitly unsigned native-host
packaged smokes on macOS and Windows and a validated NSIS/update-feed build.
A `v<package-version>` tag triggers
`../../.github/workflows/release.yml`, which gates publication on engine/CLI and both desktop platform jobs:
it signs and notarizes the hardened arm64 app/DMG/ZIP, validates Gatekeeper and
stapling, builds a Windows x64 NSIS installer, validates both updater feeds,
emits `SHA256SUMS`, and publishes both platforms to GitHub Releases. The protected `release`
environment must provide `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`,
`APPLE_API_KEY_P8` (the `.p8` contents), `APPLE_API_KEY_ID`,
and `APPLE_API_ISSUER`. `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` enable
Authenticode signing; without them the workflow clearly warns and produces an
unsigned installer that may trigger Windows SmartScreen. Local crash
breadcrumbs remain enabled without upload.

The v0.6.0 source baseline is 606 unit tests and 12 Electron E2E
scenarios. The packaged smoke also stops the active host and proves that an idle
project-index request transparently starts and reaps the bundled helper host;
the bridge suite applies the same lifecycle to an exact session mutation.
Cloud handoff ships behind its experimental setting: ownership, reconnect,
workspace-return, and recovery contracts are release-gated, while promotion to
stable still requires the paid E2B/Vercel and durable relay gates in
`ACCEPTANCE.md`.

For interaction motion, the renderer preview must prove slash, mode/catalog,
and activity-sidebar surfaces enter `is-closing`, remain inert during the short
exit, and unmount afterward. Repeat with `prefers-reduced-motion: reduce` and
confirm the presence delay is skipped.

Slash discovery is also a release contract. `npm run verify:source-parity`
compares the palette with the canonical command declarations at `ENGINE_COMMIT`
and fails if a new engine command is missing. In `?scenario=slash`, verify the
compact 360px surface, Commands/Skills/System Tab cycling, descriptive enum
submenus, current-value markers, and Escape/Left Arrow return to the root list.

## UI preview (renderer-only, no engine)

```bash
npm run ui:preview                        # http://localhost:4517/?scenario=chat
npx playwright install chromium           # once
npm run ui:shots -- tools/ui-preview/shots
```

Visually sweep the scenario matrix (`welcome`, `splash`, `chat`, `table`,
`docs`, `sources`, `busy`, `permission`, `plan`, `gate`, `mode`, `queue`,
`onboarding`, `slash`, `catalog`, `catalog-draft`, `mention`, `jobs`,
`attachments`, `inspector`, `settings`, `git`, `toast`, `density-quiet`,
`density-verbose`, `ctx-hot`) in the default theme, plus `&theme=light` and one alternate theme (e.g.
`&theme=tokyonight`). `npm run ui:shots` fails non-zero if any scenario capture
errors (still not a pixel-diff CI gate). Focus rings must be visible
keyboard-only, overlays must animate (and respect reduced motion), and no
surface may lose theme colors.
Confirm queue is one card above the composer, Copy/Edit actions are clean white
icons without filled backgrounds, scrollbars stay overlay-only, the chat pane
reaches its workspace edges, and the composer’s continuous frost fully blurs
text that scrolls underneath, including at the top edge. Confirm the
attachments scenario accepts images/files, the Session panel opens changed
files in Diff/File mode, metadata uses the primary sans font, and rail resize
handles respond to pointer and keyboard input. Confirm the right workspace dock
matches the chat background (no decorative divider/project header), Projects/Chats
headers collapse, and user-message actions appear under the bubble on hover.
Confirm the Environment dock has equal top/right inset and a quiet grey fill
inside its rounded hairline in both full-label and compact icon layouts. At
empty-state viewports on both sides of the 720px breakpoint, verify the strip
remains 184px wide with 24px controls and 11px icons; confirm non-empty compact
navigation retains its larger responsive targets. Below 900px, confirm no
topbar metadata text is visible underneath the compact dock.
Open Session, Changes, Git, Terminal, and Jobs in turn. Each must use the same
full-height edge-attached sidebar with one left divider, no outer radius/shadow,
and no desktop scrim. Confirm each view has the same Workspace eyebrow,
header height, title/subtitle baseline, and close-button position, and that the
five switcher tabs remain equal width. Confirm there are no horizontal rules
below the switcher, header, or sidebar section chrome; patch hunk boundaries are
the only intentional horizontal lines. Session/Git/Terminal/Jobs share a persisted width; Changes
uses its own persisted wider review width. Confirm the
five-item top switcher stays visible, chat remains mounted and unobscured, and
compact widths use an end drawer. In Changes, collapse nested folders, filter a
deep path, switch between files and Diff/File modes, and verify the active file
stays visible with numbered gutters. Addition/deletion rows and counters,
and transcript patches must use the saturated diff roles in dark, light, and
contrast themes without changing generic error colors. In Terminal, start a delayed command, switch
to Session, then return to Terminal: the command must keep running and its output
must replay. Close/reopen Terminal and verify the same PTY remains. If the PTY
exits between resize/input and its exit event, confirm the panel reconnects to a
fresh interactive shell instead of remaining on “session is no longer open.” Files reveals Finder.
While a Git draft or Changes filter has focus, press Escape and confirm the
field retains ownership and the sidebar stays open; move focus to sidebar
chrome and confirm Escape closes the lane.
Open Terminal from a project and confirm `pwd` is that project root. Then open a
Chats session and confirm `pwd` is the user's home directory, not `~/.vibe/chats`.
Confirm terminal chrome uses the app sans stack while the xterm grid uses the
compact mono stack with neutral tracking, even cell spacing, and a thin cursor.
Resize through narrow and wide layouts and confirm the same stylized ASCII Vibe
Codr wordmark remains visible rather than switching to a plain text fallback.

## Packaged app

```bash
npm run build:icon   # assets/icon.png → assets/icon.icns
npm run pack         # macOS
npm run smoke:packaged
# On Windows:
npm run pack:win
npm run smoke:packaged
```

`pack` is intentionally unsigned and disables hardened runtime only for local/CI
launch proof; public artifacts use the signed/notarized release path. Verify
`release/mac-arm64/Vibe Codr.app` (or `release/win-unpacked/Vibe Codr.exe`)
launches with the renderer sandbox enabled,
uses `Contents/Resources/vibecodr-engine-host`, shows the optically padded VC
app icon at a comparable size to neighboring macOS icons in Dock/Finder, with
transparent outer padding and a native-looking squircle silhouette, and
does not require `VIBE_CODR_ROOT`. The smoke grants its fixture through the
native Open Project path; renderer `localStorage` is not treated as a cwd
capability. Its final plist must keep
`NSAllowsArbitraryLoads=false` and omit unused camera, microphone, and Bluetooth
permission strings. On Windows, confirm the unpacked smoke launches with the
bundled `.exe` host and the NSIS build emits one installer, `latest.yml`, and
its differential-update blockmap. In an installed build, Help → Check for
Updates must report the current version; for a newer tagged release, confirm
the download prompt, progress indicator, restart prompt, engine cleanup, and
successful relaunch on the new version.

## Manual (dev window)

```bash
npm run dev
```

1. Launch the app and confirm it enters the main shell automatically: the last
   authorized workspace wins, then the newest usable recent, with Chats as the
   fresh-install fallback. Project selection appears only if all restore paths fail.
2. Confirm projects and titled sessions load; switch projects and resume one session.
   A session containing thinking and tool calls must retain those expandable
   rows after an app restart rather than merging them into assistant prose.
   Keep Changes open in File mode while switching sessions, then return: the
   activity view/mode and each session's transcript position must be preserved.
   Open **Sessions** from the rail and confirm Board/List, search, project/status/
   mode filters, and sort all persist after reopening the app. Move a card through
   Active → Review → Done; verify only a genuinely busy local or running Cloud
   session shows Working and temporarily appears in Active. Open, rename, archive,
   and delete records from both Board and List; destructive actions must use the
   in-app confirmation dialog and the underlying project rail must refresh.
3. Submit a short prompt — stream text + tools; the project rail spinner appears
   only on the active listed session while AI is working, spins continuously,
   and disappears at idle.
4. Scroll upward during streaming — output must stop following; Jump to latest restores it.
5. Shift+Tab through PLAN → AGENT → YOLO.
6. Trigger a permission (e.g. bash) — y / a / n / ⌘P.
   Use a command/edit longer than 200 lines and confirm Expand preview shows
   bounded head and tail content with an explicit middle-omission marker.
7. `/plan …` then present_plan — Enter / Esc / ⌘Y. With a long plan, confirm
   the review body scrolls while the title and equal-width action footer remain
   visible directly above the composer.
   While an active goal run owns tasks, attempt Accept; the plan must remain,
   Busy must stay false, and the shell must explain that the goal must be cleared.
8. Catalogs (TUI-faithful):
   - Type `/model clau` — live filter opens; Tab toggles main ⇄ sub; current marked.
   - `/providers` → configured provider prefills `/model id/`; unconfigured opens guided setup on that provider.
   - `/model` → **Set up another provider…** opens the same searchable setup; verify CrofAI fills `https://crof.ai/v1` and `crof/glm-5.2`.
   - `/agents` → agent prefills `/model agent name ` then models picker; New agent prefills without submit.
   - `/mcp` — status shows connected/disconnected · N tools (not blank).
   - `/skills` → choose prefills `/skill name ` (add args before Enter).
9. `@` file pick; ⌘V image paste → `@.vibe/clipboard/…`.
10. `/theme tokyonight`; `/keys`; open Session from the workspace dock (or ⇧⌘I);
    switch through Changes, Git, Terminal, and Jobs without leaving the chat surface;
    narrow the window for drawer behavior (dock becomes a compact icon strip
    below ~960px; `/jobs` still works).
11. Click a user message to fold/unfold its turn; confirm no persistent arrow is rendered;
    hover the bubble — Copy/Edit/time appear **under** it (not beside).
    Trigger an automatic review-fix continuation; confirm its prompt appears as a collapsed
    `Automatic review follow-up` context row, not a user bubble, and has no Copy/Edit actions.
12. Confirm approval panels and output align to the composer width; inspect source
    cards, the collapsed `Memory · N notes` row, and its expanded note list. Scroll
    away from the bottom after edits and confirm Jump to latest sits beside the
    changed-files chip, not above it.
13. Expand a Thinking group — compact steps, no brain icon, one surface per open
    thought; tool rows stay expandable for output.
14. Approve a permission request for a background `npm run dev`; confirm the job starts, the host remains healthy, and the session does not show a generic host-exited failure. Trigger an unfamiliar plugin/MCP permission and confirm its bounded argument preview is visible before deciding.
    For synthetic large queue/job fixtures, confirm only 200 rows mount, the
    omitted count is visible, and running jobs plus queue head/tail remain present.
15. Settings → MCP: add a stdio server with a command and one argument per line,
    switch it to Remote and back, and confirm the stdio command/args/env draft is
    restored. Confirm malformed `${VAR}` / `${VAR:-default}` references block
    Save with the exact field path. Verify an incomplete `KEY=value` or header
    line stays visible with an
    inline error and cannot be silently discarded. For remote OAuth, verify the
    UI states that first authorization is out-of-band rather than promising an
    in-app callback flow.
16. Settings → Behavior: switch to Project scope and confirm project trust is
    disabled there; only Global settings can opt into unsafe repo-authored code,
    credential routes, sandbox/SSRF relaxations, auto approvals, and broad
    allows. Confirm an exact “Always for this project” grant remains effective.
    In Permissions, entering a glob must clear an existing exact scope (and vice
    versa); empty tools or a manually-authored rule containing both must block Save.
    In Compaction, lower Summary threshold below the configured/default Offload
    threshold and confirm the effective engine threshold is shown five percentage
    points below Summary; restoring a valid ordering removes the note.
    Type but do not submit a provider, MCP, pricing, context-window, or LSP add row;
    Save must stay blocked, close/scope switching must confirm discard, and Reset
    must clear the unfinished row.
17. Onboarding: Skip for now, reopen/reload the renderer, and confirm onboarding
    is eligible to appear again when no provider is configured. A failed or
    inaccessible project open must not replace the last known-good workspace.
    Save an invalid provider/model combination and confirm setup remains open
    after bootstrap fails, preserving the form for correction while restoring
    the prior config/runtime so dismissing or quitting cannot strand the app.
    Search by provider label and exact id; confirm an OpenCode catalog provider,
    a Hermes alias (`opencode-zen` or `kimi-coding`), and a native cloud route
    (`bedrock`, `vertex`, or `azure`) expose the correct credential/endpoint
    requirements without losing the selected model.
    Confirm known endpoints render as **Filled automatically**, and confirm
    custom provider ID / URL / model are primary while transport remains under
    **Advanced settings**. In Settings, confirm technical sections collapse
    behind **Advanced settings** but remain discoverable through search.
    Simulate unavailable/blocked IndexedDB and corrupt cache metadata; startup
    must continue without cache, and a late open handle must be closed.
18. Exercise File/Tools/Help menu actions: New Session, Open Project, Continue
    Latest, Settings, Git, Inspector, Terminal, Jobs, and Keyboard Shortcuts.
    Then make an unsaved Settings or Custom Instructions edit and try native
    window close and Cmd/Ctrl+Q. Both must offer Keep Editing / Discard Changes;
    Keep Editing leaves the app running and teardown begins only after Discard.
19. Hover an assistant response — confirm clean white Copy/Edit icons appear
    below it. Click the live Subagents pill, confirm Session focuses the
    Subagents section, then expand each child and review task/activity/elapsed
    time/result; confirm result Copy works.
20. `/clear` mid-turn — abort + empty transcript.
21. Quit app — host finalizes (no orphan process).
22. Drag one image and one file from Finder onto the composer; confirm both
    become removable chips, image previews render, spaces in names survive, and
    submit references the project-aware paths.
23. Drop the same Finder file twice; confirm only one chip is retained and the
    duplicate toast appears only for the second drop.
24. Open Changes from the dock. Confirm the pane expands without covering chat;
    searchable directory groups remain visible beside the selected file; totals,
    churn bar, per-file stats, hunk count, and index are correct. Switch Diff/File,
    copy/reveal, navigate previous/next, resize and reopen, then verify a project
    containing a nested generated Git repository shows its real HEAD-to-working-tree
    hunks, deleted files whose parent directory is gone, and untracked files as
    additions—not current file contents posing as a diff.
    Verify the compact drawer stacks the navigator above review without losing selection.
25. Switch through Session, Git, Terminal, and Jobs, then drag the project rail
    and activity-panel handles; verify keyboard Arrow/Home/End resizing and width
    persistence after reopening. After another edit, the footer chip and dock
    Changes count must update and open the highest-churn file in Diff mode.
    In Git, force branch creation to fail and confirm the name/form remains for
    correction; repeated Enter while an operation is running must not duplicate it.
    Repeat with project/session rename, archive, and delete from the project rail:
    failed operations retain the draft/confirmation and in-flight controls cannot
    submit twice.
26. Kill/fatal the host (or `fixture:fatal` in e2e) — **New session** recovers;
    Settings → Instructions: switch sections without losing unsaved VIBE.md text.
27. Present a plan, restart/reconnect the host, and resume the same session. The
    exact plan approval card must reappear with its sources/assumptions; Accept,
    revision text through the composer, and Keep planning must each clear the
    durable pending state without starting a stale plan.
28. Trigger `ask_user_question` with choices and freeform enabled. Answer it from
    the decision card, then repeat and abort the turn; the card must settle once,
    never leak into the next session, and the agent must receive only the chosen
    answer/freeform text.
29. Start a background shell job, detached subagent, and durable monitor. Jobs
    must show all three; wait/cancel through the engine must update status. In
    Session → Subagents, expand the child and confirm role, metrics, transcript,
    and result. Restart the engine and continue the child id; prior context must
    be retained while the child remains absent from the normal Chats list.

Full matrix: [PARITY.md](./PARITY.md).
