# Mobile parity contract

“Parity” means the same applicable engine outcomes and control decisions as the
desktop app, adapted to native mobile interaction. It does not mean copying
desktop-only operating-system affordances. Every row below is classified by
current evidence; compilation alone is not treated as behavioral proof.

Status meanings:

- **Verified** — covered by automated behavior tests or a packaged end-to-end journey.
- **Partial** — useful behavior ships, but an applicable desktop outcome is missing or lacks native-runtime proof.
- **Blocked** — implementation or acceptance depends on an unavailable boundary.
- **Intentional** — desktop-only behavior has a documented mobile equivalent or no mobile meaning.

## Conversation and control

| Capability | Status | Mobile behavior and evidence |
|---|---|---|
| Engine protocol and session identity | **Verified** | Mobile uses the shared NDJSON bootstrap/send/RPC/shutdown contract. Protocol guards, bootstrap/resume, and request correlation are covered by `protocol-parity.test.ts` and `remote-engine-client.test.ts`. |
| Transcript, streaming, busy, abort, clear/new | **Verified** | Shared transcript/chrome reducers and busy policy are used directly. Reconnect tests prove transient loss does not clear busy; only the later `engine-idle` does. |
| Slash routing, modes, catalogs, file mentions | **Verified** | Shared slash, mode, catalog, and file-fuzzy modules drive the native surfaces; the complete mobile suite exercises their protocol paths. |
| Permission gate | **Verified** | Once, session, project, and deny decisions are available. Denial feedback uses typed commands. Pure action tests cover all decisions. |
| Plan gate | **Verified** | The full plan, sources, assumptions, and ungrounded warning are visible before accept/revise/accept-and-run decisions. |
| Questions and queued work | **Verified** | Typed question resolution and bounded queue head/tail disclosure use the shared command contracts. |
| Native document/image attachments | **Verified on iOS Simulator** | Photo and document pickers upload through the authenticated paired socket into a collision-safe `.vibe/mobile-attachments` path under the active project, then submit the same quoted `@path` tokens as desktop drops. A native Photos selection produced a byte-identical `0600` Mac file and removable attachment chip; the native Files picker opened successfully. Five-megabyte per-file bounds, linear base64 validation, exclusive writes, symlink containment, partial-batch recovery, attachment-only prompts, and removal are covered by protocol/filesystem/prompt tests. Physical camera/document-provider acceptance remains in the native matrix. |
| Durable Needs-your-Mac requests | **Partial** | The engine now returns approved results or denial errors to a live originating caller and durably retains a remotely resolved request for one-time consumption after handoff/restart. Tests cover live approval, denial, restored pending state, late resolution, and exactly-once return. The remaining gap is wiring a production local-only tool caller to this engine contract. |

## Desktop extension workspaces

| Capability | Status | Mobile behavior and evidence |
|---|---|---|
| Projects, chats, and exact-session switching | **Verified** | Project/session mutations use engine RPCs; reconnect persists the active cwd and session ID. The packaged relay smoke resumes the exact ID after a controller drop. |
| Inspector and checkpoints | **Verified** | Session details, changed files, expanded subagent metrics/details, and typed checkpoint undo/redo are available; workspace action tests cover routing. |
| Jobs and activity | **Verified** | All engine-reported activity categories render. Running activities with stable typed IDs can be cancelled through the same session send path as chat commands. |
| Changes and diff review | **Verified** | Shared changed-file ordering/totals back the mobile master-detail diff/file review. |
| Git and pull requests | **Verified at protocol boundary** | Git/PR operations stay desktop-authoritative behind the authenticated paired socket and shared Git types. Unit/type gates cover routing; live mutation of a real remote was not repeated in this run. |
| Contextual terminal | **Partial** | The main-owned PTY, input/resize/replay, and project cwd work remotely. Native iPhone Simulator acceptance covers opening the panel, entering a command, and line-level VoiceOver output. The simplified mobile VT model is not a full alternate-screen terminal emulator. |
| Local/Cloud target | **Verified at protocol boundary** | Protected credentials remain in the desktop keychain/control plane; the pairing link and relay process never receive secrets. Paid provider lifecycle proof remains the separate Cloud release gate. |
| Settings and instructions | **Verified at protocol boundary** | Mobile reads/writes validated desktop config through correlated relay requests and shares schema/diff logic. |
| Session-board presentation status | **Partial** | The board is available, but presentation-only manual status is not a cross-device engine contract and should not be treated as durable engine state. |

## Sync, reconnect, and ownership

| Guarantee | Status | Evidence |
|---|---|---|
| Concurrent request isolation | **Verified** | Every request-response relay frame carries a unique request ID; reverse-order unit coverage and the packaged concurrent config/file journey prove correlation. |
| Transient disconnect recovery | **Verified** | Retry continues for the lifetime of active mobile ownership with a capped 30-second delay. Socket generations prevent stale callbacks from mutating the current connection. Returning after meaningful OS suspension proactively replaces a possibly half-open socket without shutdown and resumes the exact session. |
| Atomic resync | **Verified** | Reconnect buffers live events, replaces history even when the snapshot is empty, filters by session, and replays the buffered tail after hydration. |
| Engine survival without controller | **Verified** | Relay heartbeat terminates dead sockets without shutting down the engine. Packaged smoke drops the controller and resumes the same engine session. |
| Desktop/phone ownership | **Verified** | Explicit mobile shutdown releases ownership; desktop-control/auth/ownership close codes are terminal and do not trigger retry. The managed relay/token can be reused for repeated handoff. |
| Pairing and public-network transport | **Verified** | Manual entry, QR deep links, and restored SecureStore connections share one fail-closed validator. Plain WebSocket is limited to private LAN/Tailnet IP addresses, public routing requires WSS, embedded URL credentials and malformed project/session values are rejected, and focused boundary tests cover safe and hostile inputs. |

## Native and release evidence — 2026-07-18

| Gate | Result |
|---|---|
| Mobile unit suite | **Verified:** 11 files, 54 tests passed. |
| Mobile and Electron/relay TypeScript | **Verified:** both typecheck gates passed. |
| Expo dependency/native configuration | **Verified:** Expo Doctor passed 20/20 checks. |
| iOS production bundle | **Verified:** Expo/Hermes export passed. |
| Android production bundle | **Verified:** Expo/Hermes export passed. |
| Exact locked packaged desktop host | **Verified:** unsigned arm64 package built against `ENGINE_COMMIT`. |
| Packaged desktop lifecycle | **Verified:** bootstrap, project command, idle auto-launch, shutdown, and orphan check passed. |
| Packaged Continue-on-Phone lifecycle | **Verified:** exact-session resume after dropped socket, correlated concurrent services, explicit release passed. |
| iPhone simulator interaction matrix | **Partial:** iOS 27 Expo Go completed credentialed relay pairing, preserved the same session and attachment across a 12-second background/foreground cycle, cleanly returned control to desktop, selected and uploaded a native Photos asset, and opened the native Files picker. Transcript, composer, Session, Changes, Git, Jobs, and Terminal workspaces were also exercised through the accessibility tree. Production custom-scheme deep-link and physical-device radio/background behavior remain unverified. |
| Physical iPhone/iPad matrix | **Blocked:** attached devices were offline; real radio/background and camera/document-picker behavior is unproven. |

## Intentional desktop-only behavior

- Finder Reveal / Files opens the host Finder and has no mobile meaning.
- Clipboard image paste and native dropped-file paths are desktop mechanisms;
  mobile uses native Photos/Files selection and authenticated upload instead.
- `$VISUAL` / `$EDITOR` compose launches a host editor and is desktop-only.
- Full-screen terminal TUIs are outside the simplified mobile terminal contract.
- Desktop updater, application-menu, window, dock, and rail-management controls
  are presentation-shell concerns, not engine parity requirements.
