# Plugin contract

Bundled plugins remain trusted, in-process modules. New plugins should
declare `PluginManifestV1` before executable code is imported. Put the manifest
in the package's `vibePlugin` field, beside the resolved entry as
`<entry>.manifest.json`, or as `vibe.plugin.json` in the entry directory.

```json
{
  "schemaVersion": 1,
  "name": "example-tools",
  "version": "1.0.0",
  "apiVersion": 1,
  "contributions": ["tools", "hooks"],
  "requiredCapabilities": [
    { "type": "tool", "name": "repo.search" },
    { "type": "hook", "name": "tool.before.execute" },
    { "type": "network-domain", "domain": "api.example.com" },
    { "type": "filesystem-root", "root": "workspace/packages", "access": "read" },
    { "type": "secret-handle", "handle": "example/token" }
  ],
  "provenance": { "source": "npm", "package": "@example/vibe-tools" }
}
```

Contributions describe what a plugin registers: `tools`, `providers`,
`commands`, `skills`, and `hooks`. Capabilities describe the authority it asks
the user to grant: named tools and hooks, network domains, workspace/state
filesystem roots, secret handles, and provider execution. A provider can only
request `trusted-in-process-approval-required`; a manifest cannot grant trust
to itself. Unknown fields and capabilities are rejected. Import and
registration remain bounded by the existing timeout and rollback isolation.

## Isolated executable contributions

Third-party JSON-schema tools, slash commands, and hooks can run through
`PluginWorkerClient`. The child process imports and retains every executable
function; the parent receives validated contribution metadata and JSON-safe
results only. Provider factories are deliberately rejected with
`trusted-in-process-approval-required` until their contract can safely cross
RPC. Bundled plugins continue to use the in-process host.

The worker protocol bounds startup, every RPC, frame size, pending and lifetime
request counts, output, and error surfaces. It starts with a scrubbed environment
instead of inheriting credentials. Abort, timeout, crash, malformed protocol,
and oversized output terminate the process group and reject pending calls with
stable redacted errors. The npm and standalone release builders ship the worker
entry beside the main executable; no Settings UI or silent trust grant is part
of this layer.

`listPluginStatus()` reports `loaded`, `degraded`, `incompatible`, or `failed`,
the declared and registered contributions, and provenance. Resolved npm entries
include their package version and entry-file SHA-256 integrity; local and data
plugins are explicitly unverified. Legacy manifest-free plugins continue to
load as degraded during the compatibility window.

## Curated catalog

`verifyCatalogIndex()` validates a bounded `PluginCatalogV1` JSON index signed
with Ed25519 by an explicitly trusted key. The signature covers canonicalized
catalog metadata, every exact identity/version, the complete capability review,
and the artifact's SHA-512 SRI integrity. Plugin entries must embed a manifest
whose identity, version, and capabilities exactly match the catalog entry.

Verification rejects unsigned or tampered indexes, unknown keys, duplicate
identities, version ranges/tags, malformed integrity, unsafe artifact locators,
unknown fields, and self-declared bundled or trusted-in-process state. It
returns deeply immutable review data only; fetching, installation, locking,
rollback, and execution are separate lifecycle operations.

`ExtensionLifecycleStore` owns the next local boundary. It accepts staged
artifacts associated with a verified catalog entry, streams and SHA-512 hashes
the complete artifact into an immutable machine-local store, and only then
atomically activates its exact version in a mode-0600 lock. Updates retain a
bounded activation history; enable/disable and rollback are explicit and
idempotent. The lifecycle store deliberately performs no network fetch,
archive extraction, execution, or automatic deletion.
