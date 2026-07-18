# Local ↔ Cloud sessions (experimental)

Vibe Codr can move an idle session between this Mac and a user-owned E2B or
Vercel Sandbox. Electron remains the presentation shell; both locations run the
same revision-locked `vibe-codr` engine and host protocol. Vibe provides no
hosted account, billing, database, object store, relay, or web control plane.

Cloud remains labeled experimental. Confirming the first handoff enables it
inline after showing the transfer boundary; the same preference remains under
**Settings → Cloud**. Both provider contract suites must have fresh, opt-in
green results within seven days of a release before the label can be removed.

## Setup

1. Open the Cloud handoff sheet or **Settings → Cloud**.
2. Connect and test E2B, Vercel, or both. Provider credentials are encrypted by
   Electron `safeStorage`; setup and unattended handoff are refused when
   OS-protected storage is unavailable.
3. Vibe automatically snapshots configured provider access for the active,
   plan, subagent, and other Cloud-capable models. Add explicit environment
   bindings only for extra tools or integrations. Local credential directories
   are never copied.
4. Set allowed egress domains and transfer exclusions. Project rules may also
   be added to `.vibe/cloudignore`.
5. Choose Cloud when opening a project, click **Continue in Cloud**, run
   `/handoff cloud e2b` or `/handoff cloud vercel`, or let the bundled `handoff`
   skill request it. Every route ends at the same mandatory preflight sheet.

E2B pause may retain guest process memory, including injected secrets. Prefer
revocable, sandbox-scoped keys. Vercel firewall credential brokering is preferred
where the connected plan exposes it; this experimental build enables explicit
environment bindings and does not claim brokering until the live suite proves it.
E2B's allowlist API requires `ALL_TRAFFIC` in `denyOut` as the block-all fallback;
the explicitly listed `allowOut` domains remain reachable and are verified by the
paid provider contract suite.

For a local Ollama session, Cloud requires an Ollama Cloud key and preserves the
exact `ollama/<model>` string. Vibe pins the transferred endpoint to
`https://ollama.com/v1`, then verifies from inside the sandbox that the endpoint,
credential, and exact model are usable before Local releases ownership. It never
silently substitutes a different provider or model. LM Studio and private/local
Ollama endpoints remain Local-only.

Codex and Grok subscription sessions are also supported. The desktop main
process refreshes the selected provider credential and binds only its current
access token plus optional non-secret account routing metadata to the protected
Cloud environment. Refresh tokens stay in the Mac's user-only
`~/.vibe-codr/auth.json`; they are never exposed through renderer IPC, project
configuration, transcript events, or the Cloud catalog. A missing, expired, or
ineligible subscription fails before ownership commits and keeps the task Local.

Arbitrary custom provider IDs preserve their exact ID, transport, base URL,
headers, explicit models, and deterministic provider-specific environment names
through handoff. Their endpoint must be reachable from the sandbox.

## What moves

- Session ID, transcript/model history, goal/task/plan state, checkpoints,
  orchestration journals, pending capability metadata, and engine state.
- A deterministic Git bundle, staged and unstaged binary patches, deletions,
  untracked and Git-ignored project files, executable modes, safe relative
  symlinks, and recursive submodule bundles in both directions, including
  cloud-only commit objects.
- Non-Git directories as a deterministic snapshot.
- Portable instructions, memory state, skills, agents, plugins, hooks, HTTP MCP
  configuration, portable stdio MCP configuration, jobs metadata, and settings.

Inside the sandbox, the authenticated control daemon uses a separate privileged
OS identity. The engine, terminals, tools, and project commands run as a
dedicated non-root workload user; the one-time control bearer is never inherited
by those processes, and startup fails if the boundary cannot be established.
Before upload, Electron seals the reviewed credential environment and runtime
profile to that session bearer with AES-256-GCM. Probe and daemon startup consume
the same envelope; the daemon removes the one-shot file after authenticating it
and health reports only credential names and required model IDs. Raw model keys
are never placed in the daemon launch environment or catalog.

Every `.env*` variant (including `.envrc` and `.env-secret`), SSH/cloud
credential material, private-key files, `node_modules`, nested repository
metadata, sockets, devices, escaping or absolute symlinks, files over 64 MiB, and transfers over
128 MiB are excluded or rejected by default. This symmetric limit leaves room
for the return snapshot's base64 encoding inside its bounded 256 MiB channel.
Portable engine state is capped at
20 MiB so its encoded response remains below the authenticated transport limit.
The same hard and user-configured exclusions are enforced on return, including
transferred Git history, so a cloud-created secret path cannot overwrite a
protected local file.

This is logical migration at `engine-idle`, not migration of macOS processes to
Linux. Portable jobs restart from recorded commands. Local PTYs and macOS-only
processes do not move. While Cloud owns the session, file previews and the
Terminal activity use the authenticated daemon against the remote workspace.
The Cloud PTY is a new isolated Linux shell, retains bounded replay when the
sidebar or desktop disconnects, and reattaches on reconnect. The local Git panel
pauses to avoid mutating a stale base; remote Git remains available in the Cloud
terminal. Finder continues to mean the explicitly labeled local base.

## Provisioning and diagnostics

The handoff sheet follows one session-scoped sequence: **Safe boundary → Package
workspace → Create sandbox → Upload → Verify runtime → Restore session → Start
agent → Health check → Connect**. It shows elapsed time and announces each stage
through an accessible live region. Events from other sessions are ignored.

Provider calls have a 60-second deadline, upload/runtime bootstrap has a
five-minute deadline, and authenticated agent health has a two-minute deadline.
Only safe transient provider failures are retried, at most three times, with
1/2/4-second backoff. Finite setup commands retain a bounded, redacted output
tail and exit code. Agent health is raced against the supervised daemon, so an
early crash is reported immediately instead of becoming a generic readiness
timeout. Failures show a plain-language cause, expandable stage/code/output
details, and **Try again** only after local ownership rollback and provisional
sandbox cleanup are confirmed. Ambiguous ownership or cleanup remains
fail-closed and routes through Cloud recovery.

The runtime archive is built on pinned Linux and already contains its own Node
24.18.0 binary, complete production dependency tree, and Linux `node-pty` addon,
so provider base-image Node versions do not affect startup. Sandbox setup
only extracts the archive, verifies checksums/platform/ABI, restores the
workspace, and starts the daemon; it performs no registry access or native
compilation.

## Ownership and return

Every handoff acquires a monotonic ownership generation. The source releases its
lease only after the destination imports the archive, verifies hashes, starts the
same session, and returns a valid snapshot. Failed provisional handoffs destroy
the provisional sandbox and abort back to the unchanged owner.
Before a fresh handoff creates its deterministic provider resource, any
same-name provisional sandbox left by an earlier failed or timed-out attempt is
destroyed. A fresh bootstrap can therefore never reconnect to an abandoned
daemon with a different session identity. The destination snapshot must still
match session ID, main/subagent model, mode, and conversation identity before
local ownership can commit.
The runtime restores and verifies portable state as the same isolated workload
identity used by the permanent daemon. The daemon is then given the expected
session identity explicitly. The one-shot verification host derives its resume
authorization from the exact portable archive it successfully imported, rather
than ambient ownership environment variables that a sandbox identity boundary
may scrub. The archive session, workspace, provider, and ownership generation
must still agree; unrelated or conflicting owners remain rejected. The daemon
receives the expected session ID before authenticated health can return
success, and sends that validated provider identity directly in the engine
bootstrap command so no process environment participates in the ownership
decision. An explicit missing
resume is fatal in the engine host; it never falls
through to a newly generated session ID. A final-workload read or ownership
failure is returned immediately as the handoff error while Local remains the
owner.
An atomic desktop transition intent is written before engine preparation. If
the app exits at any later boundary, startup either aborts to the recorded prior
owner or finishes the generation whose commit already won; provisional
sandboxes and imports remain visible until cleanup is verified.
The deterministic provider resource name is journaled before creation, allowing
an interrupted desktop to rediscover and remove a sandbox even if its returned
provider ID was never written locally.

On return, Vibe verifies the remote archive before touching local files. If the
original fingerprint is unchanged, a journaled transaction applies Git state,
writes, deletions, modes, and symlinks and retains a local recovery archive for
seven days. Any divergence leaves the original untouched and continues in
`~/.vibe/worktrees/<workspace>/<generation>` for review and merge.
The recovery path is persisted to the cloud catalog after backups are complete
but before the first workspace mutation. Returned files cannot recursively
replace a directory containing ignored or otherwise excluded local data.
The fingerprint includes the current branch and Git index tree, so branch
switches, partial staging, `git add`, and `git reset` also choose that safe path.
It is checked again immediately before the first mutation. If the desktop exits
mid-apply and the user edits an affected path before recovery, those edits are
preserved in a separate review workspace before rollback restores the original.
Legitimate file-to-directory and directory-to-file changes are applied in a
deletion-first transaction; protected descendants still force the safe worktree
path instead of being removed. A verified review worktree is admitted to the
same protected project IPC allowlist only after return succeeds, so Git, files,
terminal, settings, and later handoffs work there without broadening access.
The return snapshot is created as the same isolated workload user that owns the
Cloud workspace. Tracked deletions and files that disappear during capture are
encoded as return state rather than aborting the handoff; command failures retain
the concrete exception instead of displaying a runtime-version footer.

Closing the desktop disconnects only the authenticated WebSocket. The provider
sandbox, engine, PTYs, replay, and jobs continue. Reopening the same desktop
installation discovers the cloud owner from its atomic local catalog and
reattaches without starting a second writer. Live events are bounded and buffered
while the transcript snapshot/cache hydrates, then replayed after it becomes
authoritative so reconnecting cannot erase output produced during attachment.
Pending Needs-your-Mac requests are restored from the engine snapshot, including
their bounded request ID and arguments, so the explicit resolution action
survives closing and reopening the desktop.

If the provider confirms that a retained sandbox has expired or was deleted,
the catalog moves to **Sandbox missing** instead of repeatedly intercepting the
session. **Settings → Cloud → Cloud recovery → Recover local base** performs an
explicit generation-checked ownership recovery. It keeps the last local state
and clearly warns that cloud-only work is irretrievable.

## Lifecycle and cost

The default idle timeout is ten minutes. E2B pauses with auto-resume; Vercel uses
a named persistent sandbox that stops and resumes. After a Vercel cold resume,
Vibe reseals the protected model-access snapshot, relaunches the authenticated
cloud daemon, and waits for its credential/model health proof before reconnecting
the session. A cold Return Local uses a credential-free recovery profile, so an
expired provider login cannot trap work in Cloud. Provider charges, quotas,
retention, and network features are governed entirely by the user’s provider
account and plan. Check the provider dashboard for authoritative pricing. Remote
sandboxes are deleted after a verified local return by default. **Keep cloud
copy** suspends instead. Suspended and cleanup-pending copies remain visible in
**Settings → Cloud → Cloud recovery**, where they can be deleted and their
provider credentials can then be disconnected. If local portable-import
finalization failed, **Finish cleanup** retries that engine-owned commit before
the sandbox or catalog record can be removed.

## Troubleshooting

- **Cloud disabled:** connect/test a provider, then confirm the handoff; Vibe
  enables the experimental preference inline. It can also be changed in Settings.
- **Protected storage unavailable:** enable the macOS login keychain; credentials
  are never persisted as plaintext fallback.
- **Runtime missing or revision mismatch:** in `vibe-codr`, run
  `bun run build:cloud-runtime`; its revision must equal Electron `ENGINE_COMMIT`.
- **A provisioning stage fails:** expand **Technical details** for the sanitized
  stage/code/output tail. **Try again** appears only when rollback and cleanup
  completed safely.
- **Transfer rejected:** review limits, `.vibe/cloudignore`, escaping symlinks,
  and excluded credential material in the preflight.
- **Reconnect fails:** confirm the sandbox still exists and this is the desktop
  installation that created it. There is intentionally no hosted lookup. A
  retained older runtime must be returned Local once before a fresh handoff.
- **Return opens a worktree:** local files changed after departure. Review and
  merge the safe worktree; Vibe will not overwrite the original.
- **Needs your Mac:** reconnect this Mac and review the bounded request. The
  experimental build exposes an explicit deny-and-resume action; approval stays
  unavailable until the local relay security suite is complete. Vibe never
  substitutes a cloud model/tool for a local-only one.

## Developer verification

The local release gate remains `npm run verify:ci` plus packaged smoke. Cloud
adds `bun run build:cloud-runtime`, the network-disabled `bun run
smoke:cloud-runtime`, checksum/SBOM inspection, supervision and portable
round-trip tests, workspace transfer tests, paid opt-in E2B/Vercel lifecycle
suites, and the packaged authenticated PTY/file-preview round trip.
Never run paid live suites implicitly in CI.
