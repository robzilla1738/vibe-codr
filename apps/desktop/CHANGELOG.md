# Changelog

## Unreleased

## 0.6.7 — 2026-07-17

### Fixed

- Cloud handoff is resilient to a required-models cloud-flag mismatch:
  the resumed engine validates the required models instead of failing with
  `runtime-profile-mismatch: requiredModels is only accepted by the Cloud
  runtime`. Together with the 0.6.6 appearance-profile fix, neither
  handoff profile field can abort a cloud handoff.

## 0.6.6 — 2026-07-17

### Fixed

- Cloud handoff is resilient to an appearance runtime-profile mismatch:
  the resumed engine ignores the profile and completes the handoff instead
  of failing with `runtime-profile-mismatch: runtimeProfile is only
  accepted by the Cloud runtime`. Theme, accent, and density still
  synchronize on a correctly flagged Cloud runtime.

## 0.6.5 — 2026-07-16

### Fixed

- Provider setup now renders above the composer instead of inside its panel
  stacking context. Short windows keep Cancel and Save & start fully visible
  while the provider list and detail area scroll within the bounded dialog.

## 0.6.4 — 2026-07-16

### Fixed

- Local appearance now survives Cloud handoff, reconnect, return, and restart;
  intentional Cloud theme, accent, and density changes synchronize back to the
  application-wide Mac preference.
- Model keys and Codex/Grok subscription access now cross the final process
  boundary in a sealed session envelope, are injected only into the resumed
  engine, and are removed from the transient transfer file after startup. Cloud
  terminals cannot inherit them.
- Authenticated health now depends on the actual resumed engine resolving every
  required provider model. Network generation preflight remains required, and
  missing/invalid access fails before ownership commit with stable diagnostics.
- Existing 0.6.2 sessions repair in place on reconnect from their protected
  credential snapshot after an authenticated engine-idle checkpoint and
  graceful shutdown. The Mac appearance replaces the untrusted legacy remote
  default; active terminals defer repair. Failures preserve Cloud ownership and
  expose Return Local without replaying the failed message.
- Raised the aggregate renderer bundle allowance by 1 KB for the measured
  31-byte appearance-profile addition; the startup chunk ceiling is unchanged.

## 0.6.3 — 2026-07-16

- Superseded before publication by 0.6.4 after the release bundle gate exceeded
  its aggregate allowance by 31 bytes.

## 0.6.2 — 2026-07-16

### Fixed

- Updated unified release packaging to validate the current AI SDK 7 provider
  bundle before publishing desktop and CLI artifacts together.

## 0.6.1 — 2026-07-16

- Changed the default Vibe Dark chrome accent from peach to neutral white; orange and purple remain opt-in accent presets or semantic colors.

### Improved

- Transcript work is now one compact, expandable phase per turn, including
  intermediate progress notes, while the final answer remains in the primary
  conversation flow.
- Sessions now move automatically between Active, Review, and Done from live
  model state; Cloud sandbox ownership is no longer mislabeled as active work.
- Cloud handoff now shows the active model and includes configured API keys and
  connected Codex/Grok subscription access by default, with global and
  per-handoff opt-outs. Explicit Cloud bindings remain available when automatic
  model access is disabled.

### Fixed

- xAI API keys configured for the standard `xai` provider can authenticate an
  `xai-oauth` Grok route after handoff, and Cloud status refreshes are no longer
  limited to the open session.

## 0.1.18 — 2026-07-16

### Fixed

- Cloud handoff now includes Git-ignored project files, automatically snapshots
  configured provider access, and rejects a daemon that starts without any
  reviewed model credential instead of failing on the first Cloud turn.
- Subscription sign-in RPCs now accept their reviewed provider, method, and
  session parameters instead of failing every ChatGPT and xAI connection with
  `Invalid RPC request`.
- `codex/` and `openai-codex/` now both use the ChatGPT subscription backend,
  including official Codex CLI account routing. Public OpenAI API keys can no
  longer be mistaken for ChatGPT subscription credentials.
- Eligible xAI subscriptions now expose Grok 4.5 as
  `xai-oauth/grok-4.5` through Responses with configurable reasoning, alongside
  Grok Build on Chat Completions.

### Improved

- Provider setup now opens on Recommended, Local, and All providers views,
  leads Settings with subscription connections, uses one clear action per
  sign-in flow, and offers Codex, Grok 4.5, and Grok Build model choices inline.
- The slash palette now release-gates every canonical engine command, keeps one
  `/model` entry, and organizes the complete list into compact Commands,
  Skills, and System tabs. Enum submenus explain each choice, identify the
  current value, and return to the command list with Escape or Left Arrow.

## 0.1.17 — 2026-07-16

### Added

- Added CrofAI as a guided provider with its standard endpoint, credential
  variable, and starter model, while retaining the complete synchronized
  models.dev/OpenCode catalog and arbitrary custom provider IDs.
- Unified `/model`, `/providers`, first-run onboarding, and Settings around one
  guided provider setup flow. Known URLs and starter models are filled
  automatically; custom endpoint transport, token extraction, headers, and
  overrides remain available under Advanced settings.

### Improved

- Simplified Settings into clear essentials with technical runtime sections,
  model pricing/context tuning, and less common provider controls kept
  discoverable under Advanced settings and search.
- Updated the model/catalog flow so an unconfigured model opens the exact setup
  it needs instead of leaving the user with an incomplete key command.

### Fixed

- E2B and Vercel handoff now run a tiny real generation through the imported
  engine provider registry for every active model before Local ownership
  commits. The previous Ollama `/models` check could return success without
  authenticating the generation endpoint, while non-Ollama providers were not
  remotely checked at all.
- Exact-model preflight covers main, plan, subagent, named-agent, vision, build,
  and usable fallback models. A credential, endpoint, egress, transport, or
  model failure destroys the provisional sandbox and leaves the original task
  Local.
- Arbitrary providers preserve their Chat Completions or Responses transport in
  Cloud, and the bundled Linux Node 24 runtime smoke now executes this path as
  the final isolated workload identity.

## 0.1.16 — 2026-07-15

### Added

- Added built-in ChatGPT/Codex sign-in using the official PKCE flow, automatic
  token refresh, ChatGPT account routing, deterministic connection state, and
  sign-out from onboarding or Settings.
- Added xAI browser and device-code sign-in for eligible Grok subscriptions,
  including Grok Build, refresh-token rotation, cancellation, expiry, and retry.
- Expanded provider setup to the synchronized 166-provider models.dev catalog
  and arbitrary named custom providers with Chat Completions or Responses
  transport, explicit models, headers, base URLs, and deterministic Cloud envs.
- Subscription Cloud handoff exports only a current access token and optional
  account routing ID from main; refresh tokens remain in the local user-only
  credential store and are unavailable to renderer IPC.

## 0.1.15 — 2026-07-15

### Fixed

- Ollama Cloud handoff now pins the hosted endpoint and verifies the exact
  session model from inside the new sandbox before Local ownership commits.
  A Mac-local endpoint, unreachable route, invalid credential, or unavailable
  model fails safely without leaving the user in a broken Cloud session.
- Cloud-to-Local export now runs as the isolated workload owner that owns the
  restored workspace, handles tracked/concurrent deletions, and reports the
  real exception instead of the trailing Node.js version from a stack trace.
- The locked `vibe-codr` 0.5.8 runtime smoke exercises both exact Cloud resume
  and the protected return-export path.

## 0.1.14 — 2026-07-15

### Fixed

- The Cloud daemon now sends its validated `cloud/e2b` or `cloud/vercel`
  execution target directly in the engine bootstrap command. The final health
  preflight no longer reconstructs ownership authority from process environment.
- Ownership failures include the expected target, and the locked engine adds a
  regression test that resumes a Cloud-owned session with no Cloud environment.

## 0.1.13 — 2026-07-15

### Fixed

- The permanent Cloud daemon now receives the selected provider as an explicit,
  validated startup argument. E2B background-process environment handling can
  no longer make an imported `cloud/e2b` session appear locally owned during
  the authenticated health check.
- Fresh handoff and reconnect use the same explicit provider path, while owner,
  generation, session ID, model, and transcript checks remain fail-closed.

## 0.1.11 — 2026-07-15

### Fixed

- Cloud restore verification now authorizes the exact imported session and
  `cloud/e2b` target from the portable archive itself instead of depending on
  ownership environment variables surviving the sandbox identity boundary.
- The bundled runtime smoke removes those ambient ownership variables before
  resuming, preventing this production-only `session is owned by cloud/e2b`
  false rejection from recurring.

## 0.1.10 — 2026-07-15

### Fixed

- Cloud handoff now invokes the runtime's identity-safe restore entrypoint, so
  the imported session is created and verified by the same non-root workload
  identity that resumes it in the permanent daemon.
- Eliminated the live E2B root/non-root state boundary that could report
  `requested session not found` after an otherwise successful import.

## 0.1.9 — 2026-07-15

### Fixed

- Cloud handoff now starts the permanent isolated engine on the exact imported
  session before the daemon can report healthy. A missing explicit resume is a
  hard failure and can never fall through to a replacement chat.
- Cloud health failures now surface the concrete final-workload resume error
  immediately while preserving the original Local session.

## 0.1.8 — 2026-07-15

### Fixed

- Prevented fresh Local → Cloud handoffs from reusing a stale same-name
  provisional sandbox. A stale resource is destroyed before creation, so an
  abandoned daemon cannot return a replacement session ID.
- Kept continuity failures fail-closed: the original local session retains
  ownership when remote identity, model, mode, subagent model, or conversation
  proof does not match.
- Removed the duplicate model selector from command discovery while retaining
  typed legacy aliases for compatibility.

### Improved

- Grouped slash discovery into Commands, Skills, and System with Tab/Shift+Tab
  cycling and accessible tab semantics.
- Added shared enter/exit presence motion to project and activity sidebars,
  drawer scrims, slash/mention menus, mode/insert menus, and catalog pickers.
- Preserved reduced-motion behavior and made leaving surfaces inert before their
  visual exit completes.
- Documented the minimal project-row new-chat affordance, running Cloud session
  indicator, canonical Vibe Dark palette, and current release verification.

## 0.1.7 — 2026-07-15

- Kept the renderer bundle within its release budget while retaining seamless
  handoff and shell polish from the 0.1.x release series.
