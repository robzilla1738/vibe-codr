# Vibe Codr relay

A desktop-side WebSocket gateway that exposes the local/cloud engine transport
and a persistent contextual terminal to the mobile app (remote control). It reuses
the Electron shell's own `EngineTransportController` + `CloudManager` +
`host-resolver` + `TerminalManager`,
so the wire contract, host freshness checks, and PTY lifecycle are identical to
the desktop app — no second engine binary, no forked logic.

## Run

The packaged Electron app launches this relay from **Tools → Continue on Phone…**
and shows a native QR pairing window. Closing that window or tapping Return to
desktop releases mobile ownership and automatically resumes the exact session in
Electron. The managed relay and token stay parked; choosing Continue on Phone
again reauthorizes the same pairing, so repeated switching does not require a new
QR scan.

For development or a standalone relay:

```bash
npm run relay                  # from the electron repo root
# override: --cwd=<project> --host=<address> --port=<port>, or VIBE_RELAY_TOKEN / VIBE_RELAY_PORT
```

It binds to a private LAN/Tailnet interface and prints a pairing token, a
`ws://<lan-ip>:<port>` URL, and a terminal QR
encoding `vibecodr://connect?url=…&token=…&cwd=…&session=…` (scan with the mobile app to
auto-connect).

## Why tsx (Node), not Bun

The standalone relay runs under `tsx` (Node) because `node-pty` — the native PTY backend the
`TerminalManager` uses — does not deliver `onData` events under Bun's event loop.
The engine bridge (child-process NDJSON) works under either; the terminal
channel requires Node. `tsx` is a relay devDependency; `npm run relay` invokes it.
The desktop-managed relay runs through the packaged Electron binary's Node mode.
Encryption and decryption requests are proxied over its private parent/child IPC
channel to the desktop main process, which remains the sole OS-protected-storage
authority. Provider/session secrets never enter relay argv or environment
variables. Standalone Node mode keeps engine, terminal, Git, config, and cloud
catalog/settings access, but account secrets remain unavailable until launched
through the desktop app.

Plain `ws://` connections are accepted only from private, link-local, or
Tailnet IPv4 addresses. The server binds to that private interface instead of
all network adapters. For a public or routed endpoint, provide `--tls-cert`
and `--tls-key` and pair with the emitted `wss://` URL.

## Protocol

Two namespaces ride the same WebSocket (newline-delimited JSON):

- **Engine host** (shared `protocol.ts`): `bootstrap` / `send` / `rpc` /
  `shutdown` inbound; `ready` / `event` / `resp` / `fatal` outbound — byte-
  identical to the Electron `EngineBridge` / cloud `RemoteEngineTransport`.
- **Relay shell services** (`relay/protocol.ts`, `relay`-keyed, NOT engine protocol):
  `term-open` / `term-input` / `term-resize` / `term-close` inbound;
  `term-opened` / `term-event` / `term-command` / `term-closed` outbound. The PTY
  + bounded replay buffer persist across mobile reconnects (close detaches the
  renderer only — desktop parity). The same namespace carries guarded project
  file lookup, config/memory reads and writes, and the full desktop Git/`gh`
  operation surface plus Local/Cloud settings, catalog, handoff, return, and
  recovery. Those calls reuse the Electron shared logic and cwd allowlist.

Auth: `?token=<pairing token>`; wrong token → close `4001`. A valid paired phone
is closed with `4003` while Electron owns the session, until Continue on Phone
reauthorizes mobile ownership.

The engine lifecycle is independent of a transient mobile socket: backgrounding
or a brief Wi-Fi drop detaches the renderer but does not abort the active turn.
When the same cwd/session reconnects, the relay reattaches it and the phone
rehydrates from a fresh snapshot. In managed mode, an explicit host-protocol
`shutdown` releases the mobile engine but not the relay process; the parent
Electron process resumes that exact session and remains the owner until the next
handoff.
