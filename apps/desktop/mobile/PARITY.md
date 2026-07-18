# Mobile parity map

The mobile app reuses the Electron shell's pure contract + behavior layer
(`@shared/*`, `@hooks/*`) verbatim, so most parity is structural (same reducers,
same slash routing, same protocol, same theme derivation). This maps the desktop
surfaces to their native ports and notes intentional non-parity.

## Surfaces (1:1 via shared logic)

| Desktop surface | Mobile port | Shared engine |
|---|---|---|
| Transcript (markdown/code/diff/tool/thinking/notice; copy/edit/time actions) | `Transcript` + `Markdown` | `reducer` (`reduceTranscript`/`groupIntoTurns`/`Block`) |
| Transcript source cards (web_search) + subagent markdown | `Transcript` tool block | `sources` (`parseSources`), `external-url`, reducer `isSources`/`isMarkdown` |
| Composer (submit / slash / mode cycle / busy / abort) | `Composer` | `slash` (`lineToCommands`), `submit-routing`, `command-busy`, `modes` |
| Slash palette | `SlashPalette` | `commands-catalog` (`paletteState`/`applyPalette`) |
| Catalog pickers (/model /providers /agents /skills /mcp) | `CatalogPicker` | `catalog-draft` (builders + `limitCatalogOptions`) |
| Live panels (permission/plan/question/queue) | `LivePanels` | `commands` (resolve-*), `permission-input`, `reducer` (`PendingPerm`) |
| Settings — full config editor (all 15 sections + Instructions) | `ConfigSettingsSheet` + `form/*` | `config-schema` (`CONFIG_SECTIONS`/`VibeConfig`), `config-diff` (`buildConfigPatch`), relay config channel reuses `config-io`/`config-validate` |
| Settings — quick live (theme/accent/density/approvals/model) | `SettingsSheet` | `themes`/`theme-registry`, `density`, `commands` (applies immediately via slash) |
| Provider onboarding/auth | `ProviderAuthSheet` | `provider-auth`, `subscription-providers` |
| Inspector (review) | `InspectorSheet` | `context-usage`, `modes`, `reducer` (`ChangedFile`) |
| Project rail (Projects + Chats; rename/archive/delete) | `ProjectRailSheet` | `project-index`, `protocol` (`listProjects` + mutation RPCs), rebootstrap |
| Sessions workspace (board/list, filters, status, session actions, cloud state) | `SessionsWorkspaceSheet` | `session-board`, `project-index`, relay Cloud catalog |
| Activity sidebar (Session/Changes/Git/Jobs) | `ActivityDrawer` | `context-usage`, `modes`, `types` (`GitInfo`/`JobInfo`) |
| Git workspace (branches/changes/history/remotes/PRs) | `GitWorkspace` + relay Git channel | desktop `git-ops`, `git-types`, guarded cwd allowlist, authenticated `gh` |
| Local/Cloud execution target | `CloudWorkspaceSheet` + relay Cloud channel | desktop `CloudManager`, providers, catalog, protected credential store |
| Changed-files / diff review | `DiffReviewSheet` + `ChangedFilesPill` | `changed-files` (`sortChangedFilesForDisplay`/`changedFilesTotals`) |
| Terminal | `TerminalPanel` + relay `TerminalManager` | `terminal` (PTY via relay channel) |
| @-mention file attach | `AtMentionPicker` | `file-fuzzy` (`atMentionState`/`applyAtMention`/`rankPaths`) |
| Keys overlay | `KeysSheet` | `keys-help` (`ESSENTIAL_KEYS`) |
| Toasts | `Toast` | — (severity parity) |
| Theme system | `ThemeProvider` + `tokens` | `themes`/`theme-scheme` (`applyPalette` port), OKLab `color-mix` |

## Remote control

| Concern | Implementation |
|---|---|
| Wire protocol | `RemoteEngineClient` ↔ relay reuse `protocol` (`encodeInbound`/`decodeOutbound`) — byte-identical to `EngineBridge`/`RemoteEngineTransport` |
| Pairing | desktop Tools → Continue on Phone opens a native QR window; CLI relay also prints the same `vibecodr://connect?url&token&cwd&session` link; `App.tsx` handles it |
| Auth | `?token=` bearer; wrong token → close 4001 |
| Reconnect | bounded exponential backoff in `RemoteEngineClient` |
| Session continuity | the phone persists the active `sessionId` + cwd; reconnect and app relaunch resume the same conversation |
| Control handback | Return to desktop stops the mobile engine but keeps the managed relay/token parked; Electron resumes the exact session, rejects phone sockets while desktop owns it (`4003`), and Tools → Continue on Phone reauthorizes the same pairing for repeated switching |
| Drop resilience | the relay retains its active engine across transient socket drops and reattaches the matching session on reconnect |
| Durable local-only requests | pending “Needs your Mac” requests rehydrate from the engine snapshot and render a denial/continue action on both desktop and mobile; execution relay remains gated until its engine contract is complete |
| TLS | relay `--tls-cert`/`--tls-key` → `wss://` |
| Terminal channel | relay-only `relay/protocol.ts` (`relay`-keyed, never collides with host `type` frames) |
| Shell workspaces | relay-only terminal, config/memory, file listing, Git/PR, and Cloud channels reuse desktop logic behind the same paired socket |

## Intentional non-parity (mobile)

- **Finder Reveal / "Files" dock action** — desktop-only (opens Finder); the
  mobile app has no host Finder. The activity dock omits the Files action.
- **Clipboard image paste / dropped-file native paths** — desktop composer
  captures paste/drop with native path resolution; mobile has no equivalent host
  path surface (attachments use the @-mention project file picker instead).
- **`$VISUAL`/`$EDITOR` compose** (`Ctrl+G`) — launches a host editor; not
  applicable on mobile.
- **Full-screen terminal apps** (vim/less/tui) — the mobile terminal uses a
  simplified VT/ANSI screen model (no alternate-screen/cursor-addressing emulation),
  so the contextual shell works but full-screen TUI apps do not render faithfully.
## Verification

- `npm run typecheck` (mobile) clean; focused phone↔relay protocol parity — 8 tests.
- Expo SDK 57 dependency health passes `npx expo-doctor`; iOS and web production exports bundle cleanly.
- Relay: `tsc` clean; terminal + file-list + auth E2E smokes green; Git, PR, and
  Cloud transport compile against the shared desktop operation types.
- Electron: main/web typecheck and production build clean; packaged relay entry
  binds on a LAN port and prints a valid pairing endpoint/QR.
- Electron full suite and focused Cloud/mobile boundary tests pass with no
  regression from the host-resolver lazify.
- Relay config channel E2E: `config-read` (global) returns the real desktop
  config path + object (reuses config-io).
- Built relay E2E: authenticated controller receives two concurrent Cloud
  settings/catalog responses with correctly correlated request IDs.
- Expo web preview bundles and the 390×844 chat, workspace tray,
  project drawer/actions, Sessions board, Local/Cloud workspace, Git workspace/PRs, activity drawer, settings, and terminal states are captured
  from the live preview without render errors.
