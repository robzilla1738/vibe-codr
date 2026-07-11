# `@vibe/macos-bridge`

NDJSON stdio host that embeds `@vibe/core` `Engine` for the **Vibe Codr** SwiftUI and Electron desktop shells.

In-process engine (no worker thread): the desktop UI already runs in another process, so the TUI freeze class does not apply.

## Protocol

One JSON object per line on **stdin** (desktop client → host) and **stdout** (host → desktop client). Stderr is diagnostics only. Both directions are runtime validated; malformed or unknown messages produce a `fatal` response rather than being trusted through a TypeScript cast.

### Inbound (`HostInbound`)

| `op` | Fields | Notes |
|------|--------|--------|
| `bootstrap` | `cwd`, optional `resume`, `continue`, `model`, `mode` | Once per process. `mode`: `plan` \| `execute` \| `yolo` |
| `send` | `command` | Full `EngineCommand` from `@vibe/shared` |
| `rpc` | `id`, `method` | See RPC methods below |
| `shutdown` | — | Finalize + exit |

```json
{"op":"bootstrap","cwd":"/path/to/project"}
{"op":"send","command":{"type":"submit-prompt","text":"hi"}}
{"op":"rpc","id":1,"method":"snapshot"}
{"op":"shutdown"}
```

### Outbound (`HostOutbound`)

| `type` | Meaning |
|--------|---------|
| `ready` | Bootstrap finished; `sessionId` set |
| `event` | Nested `UIEvent` (same as TUI) |
| `resp` | RPC reply: `{ id, ok: true, value }` or `{ id, ok: false, error }` |
| `fatal` | Unrecoverable host error |

```json
{"type":"ready","sessionId":"ses_…"}
{"type":"event","event":{"type":"session-start","sessionId":"ses_…","model":"…","mode":"execute"}}
{"type":"resp","id":1,"ok":true,"value":{}}
{"type":"fatal","message":"…"}
```

### RPC methods

| Method | Needs engine | Returns |
|--------|--------------|---------|
| `snapshot` | yes | `EngineSnapshot` |
| `listModels` | yes | `ModelSummary[]` |
| `listProviders` | yes | `ProviderInfo[]` |
| `listAgents` | yes | `AgentInfo[]` |
| `listSkills` | yes | `SkillInfo[]` |
| `listMcp` | yes | MCP roster |
| `listSessions` | no (cwd from last bootstrap) | `SessionMeta[]` |
| `listProjects` | no (cwd from last bootstrap) | `ProjectSummary[]` with titled sessions |
| `renameSession` | no (`cwd`, `id`, `title`) | renamed session id/title |
| `archiveSession` | no (`cwd`, `id`) | archived session id |
| `deleteSession` | no (`cwd`, `id`) | deleted session id |
| `finalize` | yes | flush digest |

`listProjects` scans the vibe-codr state registry, derives a compact title from each session's first user message (then goal/id fallbacks), merges legacy sessions through `SessionStore`, and skips unreadable projects or corrupt session rows. Desktop clients receive presentation summaries only; state paths and parsing remain host-owned.

Session mutation ids must be one directory-name component: traversal segments and path separators are rejected before persistence access. Missing sessions return an error instead of reporting a false success.

## Run (dev)

```bash
# From vibe-codr repo root
bun install
bun run macos-bridge
# or
bun packages/macos-bridge/bin/engine-host.ts
```

Smoke:

```bash
printf '%s\n' \
  '{"op":"bootstrap","cwd":"'"$PWD"'"}' \
  '{"op":"rpc","id":1,"method":"snapshot"}' \
  '{"op":"shutdown"}' \
  | bun run macos-bridge
```

Expect a `ready` line, then a `resp` for the snapshot.

## Compile (app packaging)

```bash
bun run build:macos-bridge
# → dist/vibecodr-engine-host
```

The macOS app’s Release **Copy Engine Host** phase copies this binary into
`Vibe Codr.app/Contents/Resources/vibecodr-engine-host`. Debug prefers this file when present under `VIBE_CODR_ROOT` / `~/Code/vibe-codr`.

## Config / state

Same as CLI:

- Config: `~/.config/vibe-codr/config.json` (or `XDG_CONFIG_HOME`)
- State / sessions: `~/.vibe/state` (or `VIBE_STATE_DIR`)

Do not point tests at the developer’s real config without an override.

## Related

- Swift client: `vbcodrmacos` → `Bridge/EngineBridgeClient.swift`, `HostProtocol.swift`
- Shared contracts: `@vibe/shared` `commands.ts`, `events.ts`, `types.ts`
- App docs: sibling repo `vbcodrmacos/README.md`, `PARITY.md`
