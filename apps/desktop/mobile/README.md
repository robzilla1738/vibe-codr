# Vibe Codr — Mobile (Expo)

A React Native (Expo) presentation shell for [vibe-codr](https://github.com/robzilla1738/vibe-codr) that targets **applicable behavioral parity** with the Electron desktop app, plus authenticated remote control of a desktop engine. The evidence-backed status of each surface, including remaining gaps, lives in [PARITY.md](./PARITY.md).

## Architecture — no tech debt

The mobile app is a **remote renderer**. It does not bundle or fork the engine. It speaks the exact same NDJSON host protocol (`bootstrap` / `send` / `rpc` / `shutdown`) the Electron `EngineBridge` and `RemoteEngineTransport` speak, over React Native's built-in WebSocket.

**Single source of truth.** The pure contract + behavior layer is shared, not copied:

- `@shared/*` → `../src/shared/*` — protocol, commands, events, types, themes, the transcript reducer, slash routing, modes, density, busy policy, history hydration, stream caps.
- `@hooks/*` → `../src/renderer/hooks/*` — the chrome state machine (`session-state`) and `RequestGate`.

Both are wired through Metro path aliases (`metro.config.js`) and TypeScript paths (`tsconfig.json`). The shared source imports `node:*` builtins for desktop-only paths (git, config, editor); `src/shims/*` provides RN-safe stubs so the shared layer imports **unmodified** — zero drift.

**Token-first design system.** `src/theme/color.ts` is a faithful JS port of CSS `color-mix(in oklab, …)`; `tokens.ts` ports the `:root` variables and `applyPalette` derivation; `ThemeProvider` switches themes/accent/scheme from `shared/themes.ts`, so every TUI theme and the light scheme work.

**Behavior parity.** `useRemoteSession` ports the Electron `useSession` event loop and reuses the real `reduceChrome` / `reduceTranscript` / `Trail` / `hydrateFromHistory` / `shouldClearBusyOnSendFailure` — streaming coalescing, busy-until-`engine-idle`, `/clear` suppression, and the mode cycle are identical by construction.

## Remote control

The phone controls a desktop engine via the **relay** (`../relay/server.ts`), which reuses the desktop `EngineBridge` + `host-resolver` and exposes the host NDJSON over WebSocket with `?token=` pairing. The active cwd/session is saved securely. Temporary network drops retry for the lifetime of active phone ownership with a capped delay, rehydrate from an authoritative snapshot, and reattach to the same relay engine. Returning after meaningful iOS/Android suspension proactively replaces a possibly half-open socket without sending shutdown, resumes the exact session, and runs the same authoritative resync. **Return to desktop** releases only mobile ownership while preserving the relay, token, and exact session. In the packaged desktop app, choose **Tools → Continue on Phone…** to safely release the desktop session and open a scannable pairing window. Returning from mobile automatically continues the same session on desktop; choosing Continue on Phone again reauthorizes that existing pairing instead of making the user scan a new token. The CLI remains available for development:

The packaged relay also reuses the desktop's encrypted Cloud provider/session
store through request-scoped parent IPC; the desktop main process keeps the
OS-keychain authority and no secret is placed in the pairing link, argv, or
relay environment.

```bash
# on the desktop (this repo)
npm run relay                 # prints a token + ws://<lan-ip>:7788
```

Then in the mobile app: enter the relay URL, the pairing token, and the project path. The connection is persisted in the device SecureStore.

## Develop

```bash
cd mobile
npm install --legacy-peer-deps
npm start                     # expo start
npm run typecheck
npx expo-doctor               # SDK/dependency/native-config health
```

## Layout

```
mobile/
  src/
    app/        App root, connection config (SecureStore)
    remote/     RemoteEngineClient (NDJSON over RN WebSocket)
    hooks/      useRemoteSession (parity port of useSession)
    theme/      tokens, OKLab color-mix, ThemeProvider
    components/ primitives, Transcript, Composer, LivePanels, TopBar, Toast, Markdown,
              SlashPalette, CatalogPicker, SettingsSheet, InspectorSheet,
              ProjectRailSheet, SessionsWorkspaceSheet, ActivityDrawer,
              GitWorkspace, CloudWorkspaceSheet
    screens/    ConnectScreen, ChatScreen
    shims/      node-builtin stubs for the shared layer
  relay/  (../relay)  desktop WebSocket relay reusing EngineBridge (prints a
              pairing QR encoding vibecodr://connect?… the mobile app deep-links)
```

## Pairing

`npm run relay` prints a terminal QR encoding `vibecodr://connect?url=…&token=…&cwd=…`.
Scanning it on the phone opens the app and auto-connects (the scheme is registered
in `app.config.ts`; `App.tsx` handles the initial + incoming deep link). Manual
entry on the Connect screen remains available; connections persist in SecureStore.
All three entry paths use the same validation boundary: plaintext `ws://` is
accepted only for private LAN, loopback, or Tailnet IP addresses; public endpoints
must use `wss://`. Embedded URL credentials, relative project paths, malformed
session IDs, and oversized or NUL-containing fields are rejected before any
socket opens or pairing data is persisted.

## Verify

```bash
cd mobile
npm run typecheck     # tsc --noEmit (clean)
npm test              # focused theme, protocol, and terminal-screen parity tests
npx expo export --platform ios   # production native bundle
npx expo export --platform android
npm run preview       # web UI preview with a mocked engine (no relay needed) —
                      #   renders the full chat surface with canned chrome/transcript
                      #   for visual verification/screenshots
```

The preview harness (`EXPO_PUBLIC_VIBE_PREVIEW=1`) renders the real `ChatScreen` against a
`MockRemoteClient` (canned snapshot + scripted event stream), so the native UI can be
exercised and screenshotted in a browser with no engine or relay running.

## Current status

Working: connect + QR deep-link pairing, transcript (markdown/code/diff/tool/
thinking/notice), composer (slash routing, mode cycle, busy/abort), live approval
gates (permission/plan/question/queue), slash palette, catalog pickers
(/model //providers//agents//skills//mcp via RPC), settings (theme/accent/density/
approvals/model — engine-driven, syncs back via events), inspector (session review
+ changed-file diff), project rail (projects + chats, session switching plus
rename/archive/delete), Sessions workspace (board/list, filters, status and
cloud ownership), activity drawer (session/changes/git/jobs), full Git
workspace (branches, staging, commit/amend, history, remotes, sync, and GitHub
pull requests through the Mac's authenticated `gh`), provider auth
(openai-codex/xai-oauth OAuth via RPC, browser sign-in, model select), keys
overlay, terminal, master-detail diff review, and shell-local slash routes
(`/keys`, `/settings`, `/jobs`, `/git`) that open the right surface. The remote
client also exposes the desktop Local/Cloud target with provider setup, handoff,
return, recovery, policies, and credential bindings. It includes authenticated
QR pairing, the desktop-native Continue on Phone handoff, same-token repeated
desktop/phone switching, TLS relay support, bounded reconnect, persisted exact
session resume, and an explicit return-to-desktop flow. The packaged continuity
smoke drops the controller, resumes the exact session, exercises concurrent
correlated relay services, and releases ownership cleanly.

Not yet complete: phone-triggered execution of durable local-only capability requests, full-screen
terminal emulation, and a fresh physical-device background/radio acceptance
matrix. Project-file `@` mentions and native photo/document uploads are available. See [PARITY.md](./PARITY.md)
for the row-by-row verified/partial/blocked contract; do not infer completion
from typecheck or bundling alone.

The iOS native acceptance pass also verifies line-level VoiceOver terminal
output plus named command/run controls; terminal cells must never be exposed as
one accessibility element per character.

The mobile UI uses a quiet opaque chat canvas with restrained system glass only
on functional chrome: the compact project header and full composer surface.
Content cards remain opaque and readable, controls keep native-size touch
targets, and motion/transparency follow the device accessibility settings.
Projects and activity use edge-attached drawers; settings switch to horizontal
section navigation and single-column fields on phone widths.

Native photos and documents use Expo's system pickers. Selected files are read
from the app cache, capped at 5MB each, sent only over the already-authenticated
paired socket, and written with exclusive permissions beneath the active
project's ignored `.vibe/mobile-attachments/` directory. The composer submits
the resulting project-relative `@path` tokens, so engine mention expansion and
multimodal image handling remain identical to desktop file drops.
