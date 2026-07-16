# Providers and subscription authentication

Vibe Codr accepts `<provider>/<model>` strings. Its generated provider manifest
is synchronized from the same [models.dev](https://models.dev) catalog used by
OpenCode. This release is audited against OpenCode commit
`4a760b5743496942fd821eeafaa7d648a5630973`; the exact reference is recorded in
`OPENCODE_PROVIDER_COMMIT`. The generated manifest currently contains 166
provider IDs, and live `/models` results are merged with its model metadata.

## Authentication order

For API-key providers, credentials resolve in this order:

1. the provider's documented environment variables;
2. `providers.<id>.apiKey`;
3. `providers.<id>.tokenFile`, optionally narrowed by `tokenPath`.

Extra `headers` and a `baseURL` override can be set per provider. Native AWS
Bedrock and Google Vertex providers continue to use their standard platform
credential chains rather than an API key.

## ChatGPT subscription for Codex

The desktop app exposes **Settings → Providers → ChatGPT · Codex**. Sign-in uses
the official Codex authorization-code flow with PKCE. Tokens and the ChatGPT
account identity are stored in `~/.vibe-codr/auth.json`, outside every project,
with user-only permissions. Access tokens refresh automatically; the Codex
Responses request is routed to the subscription backend with the required
`ChatGPT-Account-Id` header.

Use model IDs under `openai-codex/`, for example:

```text
openai-codex/gpt-5.3-codex
```

If Vibe's own credential is absent, the engine can still read the official
Codex CLI credential from `~/.codex/auth.json`. Eligibility, available models,
and usage limits remain controlled by the user's ChatGPT plan.

## Grok subscription and Grok Build

The desktop app exposes **Settings → Providers → xAI · Grok**. It supports both
browser PKCE and RFC 8628 device authorization. Device polling honors
`authorization_pending`, `slow_down`, denial, and expiry responses. Refresh
tokens rotate atomically in the same user-only auth store.

The subscription route uses the `xai-oauth` provider. Grok Build is always
discoverable even if xAI's live model endpoint omits it:

```text
xai-oauth/grok-build-0.1
```

Eligibility and quota remain controlled by the user's xAI plan. API-key users
can continue to use `xai/<model>` with `XAI_API_KEY`.

## Arbitrary custom providers

Custom providers are not limited to one reserved ID. Add any provider name and
choose the HTTP dialect that its endpoint implements:

```jsonc
{
  "providers": {
    "company-gateway": {
      "transport": "openai-compatible",
      "baseURL": "https://llm.example.com/v1",
      "apiKey": "...",
      "headers": { "x-team": "platform" },
      "models": ["coding-large", "coding-fast"]
    },
    "responses-lab": {
      "transport": "openai-responses",
      "baseURL": "https://responses.example.com/v1",
      "models": ["lab-agent"]
    }
  }
}
```

Those models resolve as `company-gateway/coding-large` and
`responses-lab/lab-agent`. Explicit `models` are useful when the endpoint does
not publish `/models`; otherwise the live catalog is merged automatically.

For headless configuration, an arbitrary provider ID also has deterministic
environment aliases. Uppercase the ID, replace punctuation with `_`, and prefix
it with `VIBE_PROVIDER_`: `company-gateway` becomes
`VIBE_PROVIDER_COMPANY_GATEWAY_API_KEY` and
`VIBE_PROVIDER_COMPANY_GATEWAY_BASE_URL`.

## Cloud handoff

Cloud handoff preserves the exact provider and model. API-key or custom-endpoint
credentials are bound only to the selected session. For Codex and xAI
subscriptions, the desktop main process obtains a current access token and
binds only that token plus non-secret account routing metadata. Refresh tokens
never enter renderer IPC, project config, the transcript, or the Cloud catalog.
If the credential cannot be prepared, ownership stays Local.

## Compatibility verification

Focused provider/auth checks:

```bash
bun test packages/providers/src/oauth.test.ts packages/providers/src/registry.test.ts
bun test packages/macos-bridge/src/protocol.test.ts packages/macos-bridge/src/host.integration.test.ts
bun run typecheck
```

The Electron repository separately checks its synchronized manifest, auth IPC
guards, custom-provider config, Cloud environment mapping, and locked engine
revision.
