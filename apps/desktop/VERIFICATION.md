# Verification

Quick gate before shipping Electron shell changes. Repo: [vbcode-electron](https://github.com/robzilla1738/vbcode-electron).

## Performance acceptance

The performance path has deterministic, opt-in budgets in addition to the normal
correctness suite:

```bash
# Canonical engine: seeded private Git index versus the legacy empty index
cd /path/to/vibe-codr
bun run bench:checkpoint

# Desktop: 20 cold/prewarmed host pairs, 10,000 stream chunks, 2,500 blocks
cd apps/desktop
npm run bench:performance

# Paid xAI cache/TTFT canary; never run by CI
cd /path/to/vibe-codr
VIBE_LIVE_PERF=1 bun run test:perf:live
```

The 2026-07-18 local deterministic run recorded a 280.30 ms legacy checkpoint
median versus 64.01 ms seeded (77.2% lower) and a 50.09 ms cold host-fixture
click-to-ready baseline. The final continuity build measured 43.30 ms cold
versus 0.19 ms when reusing the project-index host (99.6%
lower), two renderer deliveries for 10,000 adjacent chunks (99.98% fewer), and
a 2,500-block incremental transcript flush of 0.0069 ms p95 / 0.06 ms max.
These are machine-local fixture results, not provider-generation claims. The
paid canary records default and Turbo TTFT/cache-token pairs only when explicitly
enabled; CI never incurs provider spend.

The local seven-day/2 MiB flight recorder attributes host spawn/ready/snapshot/
replay, tool-schema tokens, provider TTFT, generation, tool execution, bridge,
and first-paint phases without prompts, paths, credentials, tool inputs, or tool
outputs. Advanced Settings exposes 1-day/7-day p50/p95 summaries and a local
diagnostics export; no network sender exists.

The canonical seven-day/50 MiB run-event ledger is also inspectable under
Advanced → Local Diagnostics. List/read RPCs are bounded and validated; the
viewer and CLI strip content by default. `vibe trace export <run-id>` writes a
static escaped local HTML file, while `--include-redacted` is the only path that
includes content captured under the explicit redacted policy. There is no
script, remote resource, or hosted upload path.

## Continuity and discovery acceptance

```bash
cd /path/to/vibe-codr
bun test packages/macos-bridge/src/protocol.test.ts packages/macos-bridge/src/host.integration.test.ts \
  packages/tools/src/toolset.test.ts packages/core/src/store.test.ts \
  packages/core/src/recall.test.ts packages/core/src/recall.performance.test.ts \
  packages/plugins/src/plugin.test.ts

cd /path/to/vbcode-electron
npm test -- --run src/main/engine-bridge.test.ts src/main/remote-engine-transport.test.ts \
  src/main/local-runtime-supervisor.test.ts src/main/local-runtime-notifications.test.ts \
  src/main/runtime-settings-store.test.ts src/main/performance-store.test.ts \
  src/shared/protocol.test.ts
```

These fixtures cover duplicate/gap/replay/restart/version behavior, concurrent
local runtime capacity, FIFO/cancel behavior, idle-only eviction, privacy-safe
notification payloads/click routing, real-identity tool discovery with at least
60% schema-token reduction, 10,000-message recall at no more than 150 ms p95,
safe compacted-history forks, plugin preflight/rollback, and diagnostics
redaction/retention/percentiles.

## Experimental cloud gate

- `cd ../cli && bun test packages/core/src/portable-session.test.ts packages/core/src/session-tools.test.ts`
- `cd ../cli && bun test packages/cloud-agentd/src/cloud-model-probe.test.ts packages/providers/src/registry.test.ts`
  proves the sandbox preflight performs a bounded real generation for every
  exact model, rejects a model-list false positive, and restores arbitrary
  provider endpoint/transport bindings without a Mac-only config file.
- `cd ../cli && bun run build:cloud-runtime`
- `cd ../cli && bun run smoke:cloud-runtime` verifies the archive with
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
- `npm test -- --run src/main/cloud/cloud-runtime.test.ts src/main/cloud/cloud-supervision.test.ts src/main/cloud/session-continuity.test.ts src/main/cloud/workspace-transfer.test.ts src/shared/cloud-handoff-ux.test.ts src/main/remote-engine-transport.test.ts src/shared/protocol.test.ts`
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
  contracts with `E2B_API_KEY` and either `VERCEL_TOKEN` or an authenticated
  local Vercel CLI session; `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` are
  optional scope overrides. Fresh green output is required within seven days of a
  release; the default unit suite skips these resource-creating tests.
- 2026-07-17 local release audit: both provider contracts passed against live
  accounts. E2B completed create/upload/start/reconnect/suspend/resume/download/
  destroy; Vercel completed the same lifecycle using the authenticated CLI
  session and removed its named sandbox afterward.
- The E2B live contract must fetch its allowlisted registry domain while using
  the required `allowOut` plus `denyOut: [ALL_TRAFFIC]` policy, then prove
  pause/resume and destruction. This is the regression gate for E2B's 400
  network-policy response.
- `VIBE_LIVE_PACKAGED_CLOUD=1 E2B_API_KEY=… npm run smoke:cloud:packaged`
  exercises the installed-style Electron boundary: protected provider setup,
  deterministic temporary-project bootstrap, engine/workspace/model handoff,
  authenticated remote README preview, a real command through the isolated
  persistent PTY, verified clean return, and delete-on-return cleanup.
- 2026-07-17 packaged release audit: the unsigned macOS package with engine lock
  `82c9abcb53b8` passed that full E2B journey. The authenticated health response
  matched the sealed credential names and required-model profile, the preview
  returned the fixture's Cloud README, the Cloud PTY returned its command output,
  and return restored the original workspace without divergence before removing
  the catalog entry and deleting the sandbox.
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
- Never remove the experimental flag while either provider suite is stale, the
  durable local-capability relay acceptance suite is missing, or Vercel
  credential brokering remains unverified.

## Automated

### Provider and subscription auth focus

```bash
# Electron IPC/config/catalog/Cloud boundary
npm test -- --run src/shared/provider-auth.test.ts src/shared/renderer-rpc.test.ts \
  src/shared/providers-catalog.test.ts src/shared/runtime-guards.test.ts \
  src/shared/config-validate.test.ts src/main/cloud/model-environment.test.ts
npm run typecheck
npm run verify:source-parity

# Locked sibling engine OAuth/registry/bridge contracts
cd ../cli
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
cd ~/Code/vbcode-electron   # or your clone of this repo
npm test
npm run test:coverage  # V8 floors on shared + bridge/host-resolver/ipc-security
npm run lint
npm run verify:source-parity
npm run verify:config-shape
npm run typecheck
npm run build
npm run verify:bundle
npm run smoke:bridge   # requires vibe-codr dist host (sibling or VIBE_CODR_ROOT)
npm run test:e2e       # hermetic Electron host/renderer lifecycle matrix
```

Expect: the current Vitest suite green, Playwright Electron E2E
green, every reported upstream source pair aligned, Biome and `tsc`
clean, every engine config field represented, electron-vite build and
renderer/host bundle budget OK, and smoke prints
`ready` + `snapshot ok` and a structurally valid project-list response (which
may be empty when every project is archived). Prefer live suite output over frozen counts in prose.
Settings, Sessions, and the xterm runtime must remain in deferred chunks: aggregate
renderer payload may include them, but the initial/largest chunk retains its
budget. The aggregate ceiling includes a narrow 3 KB allowance for the active
Sessions insight surface; the startup/largest-chunk ceiling is unchanged.
Keep only measured headroom for the Work/final-answer hierarchy and lazy
terminal-link detector; do not relax the startup ceiling broadly.
The renderer build extracts repeated legal banners into
`out/renderer/THIRD_PARTY_LICENSES.txt`; `verify:bundle` requires that shipped
notice file as well as the JavaScript budgets.
`npm ci` must finish the `install-electron` prefetch before Vitest starts; this
prevents parallel test workers from racing Electron 43's lazy binary download.

| Gate | Includes |
|------|----------|
| `npm run verify` | lint + unit + source/config parity + typecheck + build + bundle |
| `npm run verify:fast` | lint + unit + typecheck |
| `npm run verify:ci` | verify + coverage + bridge smoke + E2E |

The source and config parity commands read their upstream files directly from
the exact revision in `ENGINE_COMMIT` with `git show`. `VIBE_CODR_ROOT` (or the
default `~/Code/vibe-codr`) therefore only needs to contain that fetched
commit; uncommitted sibling work cannot silently redefine the release
contract. Packaging is stricter: `copy-host` requires the engine checkout HEAD
to equal `ENGINE_COMMIT`, rejects dirty runtime paths, verifies source freshness
and host architecture, and only then embeds the host. The source parity script
allows documented Electron-specific additions and normalizes whitespace to
avoid false formatting drift.

CI checks the engine source out at `./vibe-codr`. That directory is excluded
from this repository's Biome scope so both checkouts retain independent root
configurations while the parity and bridge gates can still read it directly.
The macOS-only `electron-liquid-glass` package is optional, externally bundled,
and loaded only after a Darwin platform check; Linux CI must typecheck, build,
and run the Electron harness without installing that native module.

GitHub CI (`.github/workflows/ci.yml`) runs `verify`, coverage floors,
`smoke:bridge`, and Electron E2E on Linux, plus explicitly unsigned native-host
packaged smokes on macOS and Windows and a validated NSIS/update-feed build.
It independently installs, typechecks, and tests the Expo client, while the
root TypeScript gate also covers the packaged relay entrypoint.
A `v<package-version>` tag triggers
`.github/workflows/release.yml`, which gates publication on both platform jobs:
it signs and notarizes the hardened arm64 app/DMG/ZIP, validates Gatekeeper and
stapling, builds a Windows x64 NSIS installer, validates both updater feeds,
emits `SHA256SUMS`, and publishes both platforms to GitHub Releases. The protected `release`
environment must provide `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`,
`APPLE_API_KEY_P8` (the `.p8` contents), `APPLE_API_KEY_ID`,
and `APPLE_API_ISSUER`. `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` enable
Authenticode signing; without them the workflow clearly warns and produces an
unsigned installer that may trigger Windows SmartScreen. Local crash
breadcrumbs remain enabled without upload.

The unified v0.6.1 source baseline is 622 passing unit tests (2 paid-provider
tests skipped) and 12 Electron E2E
scenarios. The packaged smoke also stops the active host and proves that an idle
project-index request transparently starts and reaps the bundled helper host;
the bridge suite applies the same lifecycle to an exact session mutation, and
`smoke:packaged:relay` proves the installed Continue-on-Phone entrypoint resumes
through the bundled host and releases ownership cleanly.
Cloud handoff ships behind its experimental setting: ownership, reconnect,
workspace-return, and recovery contracts are release-gated, while promotion to
stable still requires a current provider audit, the durable local-capability
relay gate, and verified Vercel credential brokering in `ACCEPTANCE.md`.

For the v0.6.4 handoff boundary, focused release verification is:

```bash
bun test packages/shared/src/cloud-runtime.test.ts \
  packages/cloud-agentd/src/cloud-model-probe.test.ts \
  packages/cloud-agentd/src/server.test.ts \
  packages/macos-bridge/src/protocol.test.ts
npm --prefix apps/desktop test -- --run \
  src/main/cloud/session-continuity.test.ts \
  src/main/cloud/cloud-supervision.test.ts \
  src/shared/cloud-routing.test.ts \
  src/renderer/hooks/session-state.test.ts
bun run build:cloud-runtime && bun run smoke:cloud-runtime
```

The smoke must report the exact resumed session and history. Authenticated
health must report model-access version 1, `validated: true`, required model and
credential names only. Confirm the model envelope is deleted after startup and
that a Cloud terminal cannot read any reviewed model credential name.

For the v0.6.5 provider-dialog containment fix, run the focused onboarding
contract and desktop typecheck, then inspect the light-theme provider setup at
743 × 717 CSS pixels. The footer must remain inside the modal and viewport,
both actions must be fully visible, and the modal overlay must paint above the
composer while the provider columns retain their own scrolling.

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
Open Session, Changes, Git, Browser, Terminal, and Jobs in turn. Each must use the same
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
contrast themes without changing generic error colors. Open an ordinary transcript URL in Browser,
verify Cmd-click opens externally, and confirm HTTP is marked Not secure. In Terminal, start a delayed command, switch
to Session, then return to Terminal: the command must keep running and its output
must replay. Close/reopen Terminal and verify the same PTY remains. If the PTY
exits between resize/input and its exit event, confirm the panel reconnects to a
fresh interactive shell instead of remaining on “session is no longer open.” Files reveals Finder.
While a Git draft or Changes filter has focus, press Escape and confirm the
field retains ownership and the sidebar stays open; move focus to sidebar
chrome and confirm Escape closes the lane.
Open Terminal from a project and confirm `pwd` is that project root. Then open a
Chats session and confirm `pwd` is the user's home directory, not `~/.vibe/chats`.
Confirm terminal chrome uses the app sans stack while the xterm grid uses the mono stack with neutral
tracking and a thin cursor. Print an `https://` URL, click it, and confirm it
opens in the default browser rather than navigating the Electron window.
Resize through narrow and wide layouts and confirm the same stylized ASCII Vibe
Codr wordmark remains visible rather than switching to a plain text fallback.

## Packaged app

```bash
npm run build:icon   # assets/icon.png → assets/icon.icns
npm run pack         # macOS
npm run smoke:packaged
npm run smoke:packaged:relay
# On Windows:
npm run pack:win
npm run smoke:packaged
npm run smoke:packaged:relay
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
   mode filters, and sort all persist after reopening the app. Verify a busy turn
   moves to Active, permission/question/plan/capability waits move to Review,
   and a settled turn moves to Done. During a busy fixture, the active card must
   update its current tool/task or wait, tasks completed/total, running agents
   and jobs, queue, changed files, context, tokens/cost, model/mode/goal, and
   Local/Cloud provider without reopening Sessions. After engine-idle it must
   read Ready with refreshed saved metadata. A merely running Cloud sandbox must not be
   presented as model work. Transcript-only matches should merge without
   clearing immediate metadata hits. Start turns in three local sessions,
   switch rapidly, and confirm each continues with only the selected transcript
   visible. Set capacity to 3 from Tools > Local Runtime Capacity; a fourth
   protected launch must appear once in Jobs with its FIFO position. Cancel it
   and confirm no runtime starts. Queue two launches, free one slot, and confirm only the
   oldest starts. Lower capacity while protected runtimes are active and confirm
   only idle excess retires. Background permission/question/plan waits, failure,
   and completion must use content-free native notifications; foreground work
   stays silent. Clicking a notification must focus its exact project/session,
   while a stale target does nothing. Use
   **Fork here** and confirm the source is unchanged and the fork opens through
   the selected completed turn. Open, rename, archive,
   and delete records from both Board and List; destructive actions must use the
   in-app confirmation dialog and the underlying project rail must refresh.
3. Submit a short prompt — stream text + tools; the project rail spinner appears
   only on the active listed session while AI is working, spins continuously,
   and disappears at idle.
4. Scroll upward during streaming — output must stop following; Jump to latest restores it.
5. Shift+Tab through PLAN → AGENT → YOLO.
6. Open the Local → Cloud review and confirm it names the active model, defaults
   Include model access from Settings → Cloud, and disables configured-key and
   subscription export when unchecked while preserving explicit Cloud bindings.
   With Light selected, hand off `crof/glm-5.2`; confirm there is no dark-theme
   flash and both the first and second Cloud turns succeed. Reconnect and return
   must retain Light, the white accent, density, session ID, and history. Remove
   the binding after handoff and confirm the running session still uses its
   frozen protected snapshot. No credential value may appear in logs, catalog,
   health, or a Cloud terminal. A 0.6.2 session must repair in place after an
   authenticated engine-idle checkpoint and graceful engine shutdown. An active
   terminal or forced repair failure must defer repair, preserve Cloud ownership,
   and show Return Local without replaying the prompt. A pre-profile legacy
   remote default must be replaced by the Mac's current application-wide
   appearance during repair.
7. Trigger a permission (e.g. bash) — y / a / n / ⌘P.
   Use a command/edit longer than 200 lines and confirm Expand preview shows
   bounded head and tail content with an explicit middle-omission marker.
8. `/plan …` then present_plan — Enter / Esc / ⌘Y. With a long plan, confirm
   the review body scrolls while the title and equal-width action footer remain
   visible directly above the composer.
   While an active goal run owns tasks, attempt Accept; the plan must remain,
   Busy must stay false, and the shell must explain that the goal must be cleared.
9. Catalogs (TUI-faithful):
   - Type `/model clau` — live filter opens; Tab toggles main ⇄ sub; current marked.
   - `/providers` → configured provider prefills `/model id/`; unconfigured opens guided setup on that provider.
   - `/model` → **Set up another provider…** opens the same searchable setup; verify CrofAI fills `https://crof.ai/v1` and `crof/glm-5.2`.
   - `/agents` → agent prefills `/model agent name ` then models picker; New agent prefills without submit.
   - `/mcp` — status shows connected/disconnected · N tools (not blank).
   - `/skills` → choose prefills `/skill name ` (add args before Enter).
10. `@` file pick; ⌘V image paste → `@.vibe/clipboard/…`.
11. `/theme tokyonight`; `/keys`; open Session from the workspace dock (or ⇧⌘I);
    switch through Changes, Git, Terminal, and Jobs without leaving the chat surface;
    narrow the window for drawer behavior (dock becomes a compact icon strip
    below ~960px; `/jobs` still works).
12. Click a user message to fold/unfold its turn; confirm no persistent arrow is rendered;
    hover the bubble — Copy/Edit/time appear **under** it (not beside).
    Trigger an automatic review-fix continuation; confirm its prompt appears as a collapsed
    `Automatic review follow-up` context row, not a user bubble, and has no Copy/Edit actions.
13. Confirm approval panels and output align to the composer width; inspect source
    cards, the collapsed `Memory · N notes` row, and its expanded note list. Scroll
    away from the bottom after edits and confirm Jump to latest sits beside the
    changed-files chip, not above it.
14. In each Quiet, Normal, and Verbose density, confirm commentary remains
    visible and open/close individual tool/thinking rows. Compact steps retain no brain icon and one surface per
    open thought; density only chooses the default. Confirm ⌘T closes Verbose
    thinking, then reopens it, and that a completed tool with no output has no
    chevron or disclosure semantics.
15. Approve a permission request for a background `npm run dev`; confirm the job starts, the host remains healthy, and the session does not show a generic host-exited failure. Trigger an unfamiliar plugin/MCP permission and confirm its bounded argument preview is visible before deciding.
    For synthetic large queue/job fixtures, confirm only 200 rows mount, the
    omitted count is visible, and running jobs plus queue head/tail remain present.
16. Settings → MCP: add a stdio server with a command and one argument per line,
    switch it to Remote and back, and confirm the stdio command/args/env draft is
    restored. Confirm malformed `${VAR}` / `${VAR:-default}` references block
    Save with the exact field path. Verify an incomplete `KEY=value` or header
    line stays visible with an
    inline error and cannot be silently discarded. For remote OAuth, verify the
    UI states that first authorization is out-of-band rather than promising an
    in-app callback flow.
17. Settings → Behavior: switch to Project scope and confirm project trust is
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
    Confirm Advanced shows plugin status/provenance plus content-free 1-day and
    7-day performance p50/p95; Copy diagnostics must contain no prompt, path,
    credential, tool input, or tool output.
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
