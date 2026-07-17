# Cloud handoff threat model

Protected assets are workspace contents, engine/session state, provider and
model credentials, Git identity/remotes, local integrations, and the single
session writer. Trust boundaries are renderer ↔ Electron main, main ↔ provider
SDK, provider file API ↔ guest, authenticated WebSocket ↔ `cloud-agentd`, and
`cloud-agentd` ↔ the unchanged NDJSON engine host.

The renderer receives provider readiness and progress metadata only. Provider,
session, and bound model credentials remain in main-process `safeStorage`.
Ownership, portable export/import, and handoff recovery RPCs are rejected at
the renderer IPC boundary and are callable only by the main-process controller.
Workspace and portable archives upload directly through the selected provider
SDK. There is no Vibe service in the data path.

## Controls

- Monotonic ownership generations, source lease release after destination proof,
  stale-generation rejection, and rollback prevent dual writers.
- A random 288-bit per-session bearer token authenticates bounded 32 MiB frames.
  The provider launches `cloud-agentd` as root and the bearer crosses startup
  through a root-only one-shot file. Engine-host and tools run as non-root
  `vibe-workload`; PTYs run as a distinct non-root `vibe-terminal` identity so
  they cannot inspect the credential-bearing engine process. A shared project
  group preserves workspace collaboration while the engine state and both home
  directories remain private. Startup fails if these OS boundaries cannot be
  established.
- Runtime outer and internal SHA-256 checksums, engine revision equality,
  workspace/file hashes, and portable archive hashes are checked before use.
- Packaging refuses a revision-locked runtime when any engine build input is
  dirty, and outbound handoff binds the exported session ID and canonical source
  root to the selected workspace before any upload begins.
- Runtime validation rejects unknown protocol shapes, traversal, NUL paths,
  escaping symlinks, oversized files/messages, and device objects. Transfer
  files are opened without following symlinks, then rechecked by canonical path
  and inode before their actual bytes are counted.
- Transfer policy includes Git-ignored project inputs but still excludes likely
  machine secrets and generated dependency trees by default. Reviewed model
  access is encrypted locally with OS-protected storage, then uploaded only as
  an authenticated session-bound envelope. The root agent decrypts it, deletes
  the transient file, and injects values only into the engine host. Terminals
  receive a separately filtered environment and distinct Unix identity. Probe
  diagnostics are sanitized against the decrypted values even though those
  values never enter the probe launch environment. Preload, logs, catalog, and
  health expose key names at most; authenticated health also proves the actual
  resumed engine resolved every required model before ownership commits.
- Hard and user-configured exclusions are enforced on upload, return entries,
  deletions, and paths reachable from transferred Git history, including
  workspace-relative patterns inside every recursive submodule.
- Local return binds the archive to the session ID, ownership generation,
  engine revision, local target, and expected remote root before applying
  through recovery; any source divergence goes to a new worktree.
- Recovery metadata, including the old Git HEAD, is durably flushed before the
  corresponding workspace or reference mutation. File/directory type changes
  are applied deletion-first without weakening protected-descendant checks.
- Root and recursive submodule bundles are verified, exclusion-scanned, fetched,
  and checked out before the provider resource can be deleted.
- Provider events do not authorize ownership changes. The local atomic catalog
  and engine generation record are authoritative. Catalog replacements flush
  both file data and the parent directory before an ownership transition is
  treated as durable; ambiguous transitions cannot use destructive cleanup.
- A pre-prepare transition intent and target-bound engine recovery close the
  crash window before the desktop can receive or persist a preparation nonce.
  Recovery returns a structured aborted/already-committed outcome; the desktop
  never infers ownership from error text and retains the transition if a remote
  abort cannot be proven.
- The planned local recovery path and deterministic provider resource name are
  cataloged before their respective mutation/create boundaries.
- A new handoff never reuses an existing same-name provisional sandbox. The
  provider-confirmed stale resource is destroyed before a clean create, and the
  remote session/model/history proof must pass before local ownership commits.
- The permanent daemon cannot report healthy until its isolated workload has
  resumed the exact imported session ID. Explicit resume is fail-closed in the
  engine host, so missing or unreadable state cannot create a second writer or
  replacement chat.
- The non-secret runtime profile is versioned and restricted to appearance and
  required model identifiers. Existing sessions with older runtime metadata are
  repaired in place from their frozen protected snapshot only after the old
  agent is authenticated, terminals are absent, and the engine reaches idle and
  exits through protocol shutdown. Their remote appearance has no intent
  provenance and may be the known accidental dark default, so the Mac's global
  preference is the one-time migration authority. Repair failure cannot transfer
  ownership or automatically replay user input. The appearance profile is
  cosmetic, so a non-cloud runtime that receives it ignores the profile and
  continues rather than failing the handoff; an appearance-profile mismatch
  can never block session transfer.
- A missing provider sandbox is not silently forgotten. Recovery requires the
  provider-confirmed missing state, an explicit destructive confirmation, the
  matching provider, and the exact ownership generation before core returns the
  session to its last local base.
- Arbitrary remote shell access to the Mac is disabled. A machine-bound action
  must be a bounded capability request and pass ordinary approvals.

## Known experimental limitations

Durable capability request types, state persistence, and `Needs your Mac` events
ship in the protocol. The provider-neutral local integration executor and Vercel
firewall credential broker remain disabled pending live security suites; Cloud
must stay experimental while either stable acceptance item is incomplete.
Environment bindings are supported and disclosed explicitly.
Cloud settings mutations are serialized and durably replaced, while unsaved
network/transfer drafts participate in the app-wide Settings discard guard.

Provider compromise, malicious intentionally transferred project dependencies,
user-approved credential misuse, provider account takeover, and charges in the
user’s provider account cannot be eliminated by the local protocol. Use scoped,
revocable keys and provider-native account controls.
