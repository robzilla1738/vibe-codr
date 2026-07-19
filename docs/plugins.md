# Plugin contract

Plugins remain trusted, in-process modules for this release. New plugins should
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
  "requiredCapabilities": ["tools", "hooks"],
  "provenance": { "source": "npm", "package": "@example/vibe-tools" }
}
```

Supported contribution and capability names are `tools`, `providers`,
`commands`, `skills`, and `hooks`. The loader rejects malformed manifests,
incompatible API versions, unsupported capabilities, and registration of an
undeclared contribution before retaining any registrations. Import and
registration remain bounded by the existing timeout and rollback isolation.

`listPluginStatus()` reports `loaded`, `degraded`, `incompatible`, or `failed`,
the declared and registered contributions, and provenance. Resolved npm entries
include their package version and entry-file SHA-256 integrity; local and data
plugins are explicitly unverified. Legacy manifest-free plugins continue to
load as degraded during the compatibility window.
