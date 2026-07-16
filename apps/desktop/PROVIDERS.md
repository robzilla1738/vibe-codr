# Model providers

Vibe Codr Desktop ships the complete generated models.dev provider catalog used
by OpenCode, plus native Bedrock, Vertex, Azure, local-model, and compatibility
routes. This release is audited against OpenCode commit
`4a760b5743496942fd821eeafaa7d648a5630973`; the reference is locked in
`OPENCODE_PROVIDER_COMMIT`. The synchronized manifest currently contains 166
provider IDs.

## Connect a provider

Use `/model` and choose **Set up another provider…**, use `/providers`, or open
**Settings → Providers**. An unconfigured provider now opens the same guided
setup instead of prefilling a key command. For a known provider, Vibe fills the
endpoint and recommended model; the normal path asks only for the credential.

Settings opens on two subscription connections first, with API-key, local, and
custom providers below them:

- **ChatGPT · Codex** opens the official Codex browser sign-in. Vibe stores the
  access token, rotating refresh token, and account routing identity in
  `~/.vibe-codr/auth.json` with user-only permissions. Use a model under
  `openai-codex/`, such as `openai-codex/gpt-5.3-codex`. The legacy `codex/`
  alias uses the same subscription backend. Public OpenAI API keys remain under
  `openai/` and are never mistaken for ChatGPT credentials.
- **xAI · Grok** uses the RFC 8628 device flow. Choose
  `xai-oauth/grok-4.5` for Grok 4.5 or `xai-oauth/grok-build-0.1` for Grok
  Build. Grok 4.5 is routed through xAI Responses with low/medium/high
  reasoning; Grok Build and earlier models remain on Chat Completions. The app
  handles pending, slow-down, cancellation, expiry, refresh rotation, retry,
  and sign-out.

Subscription eligibility, available models, usage, and quota are determined by
the signed-in provider. An API subscription does not automatically imply a
ChatGPT or Grok product subscription, or vice versa.

Every catalog provider can still use its documented environment variable or a
saved API key. Setup starts with **Recommended**, **Local**, and **All providers**
views; search always covers the complete catalog. The
normal model picker is grouped and filtered so the catalog does not become one
undifferentiated list. Endpoint overrides, token files/paths, explicit model
lists, headers, and transport selection are grouped under **Advanced settings**.

### CrofAI

CrofAI is a first-class setup choice. Vibe uses `CROF_API_KEY`, fills
`https://crof.ai/v1`, and suggests `crof/glm-5.2`. Its standard `/models`
catalog remains available through the normal model picker. Create or manage an
account at [crof.ai](https://crof.ai/signin).

## Custom providers

Choose **Set up another provider… → Custom endpoint**, or **Settings →
Providers → Add provider → Custom endpoint**. Enter a stable provider ID, then
configure the URL, credential, and model. The setup dialog defaults to Chat
Completions and keeps Responses transport under **Advanced settings**.

The full Settings editor also supports:

- API key or token file;
- base URL;
- additional headers;
- **Chat Completions (OpenAI compatible)** or **OpenAI Responses** transport;
- explicit model IDs for endpoints without `/models`.

Custom providers are independent. For example, `team-gateway/model-a` and
`lab-responses/model-b` can coexist; neither is forced through a shared
`custom` slot. The underlying configuration is:

```jsonc
{
  "providers": {
    "team-gateway": {
      "transport": "openai-compatible",
      "baseURL": "https://gateway.example.com/v1",
      "apiKey": "...",
      "headers": { "x-team": "desktop" },
      "models": ["model-a"]
    },
    "lab-responses": {
      "transport": "openai-responses",
      "baseURL": "https://responses.example.com/v1",
      "models": ["model-b"]
    }
  }
}
```

Arbitrary IDs also receive deterministic environment aliases. `team-gateway`
maps to `VIBE_PROVIDER_TEAM_GATEWAY_API_KEY`,
`VIBE_PROVIDER_TEAM_GATEWAY_BASE_URL`, and (when needed)
`VIBE_PROVIDER_TEAM_GATEWAY_TRANSPORT`.

## Local and Cloud use

The same provider and exact model survive a Local ↔ Cloud handoff. The selected
session receives an encrypted snapshot of every safely representable configured
provider route and key, so plan/subagent work does not depend on Mac-global
configuration after the move. For Codex and Grok
subscription auth, the main process exports a current access token and optional
non-secret account ID; the refresh token never reaches renderer IPC, project
config, transcripts, logs, or the Cloud session catalog. A missing or expired
credential fails before ownership changes and leaves the task Local.

The Cloud daemon reports the names of its inherited provider bindings through
the authenticated health check. If any reviewed binding was dropped between
setup and the long-running workload, the provisional sandbox is destroyed and
the task remains Local.

Local-only providers still require a Cloud-accessible route. Ollama Cloud is a
separate hosted endpoint; a Mac-local Ollama or LM Studio server is not silently
substituted in Cloud.

After restore and before ownership changes, the isolated Cloud workload makes a
tiny real generation with every active main, plan, subagent, vision, build, and
usable fallback model. A public `/models` response is not treated as proof of
authentication. Any credential, endpoint, transport, egress, or exact-model
failure destroys the provisional sandbox and leaves the task Local. E2B and
Vercel use this same verification path.

## Release verification

Focused checks for this surface:

```bash
npm test -- --run src/shared/provider-auth.test.ts src/shared/renderer-rpc.test.ts src/shared/providers-catalog.test.ts src/shared/runtime-guards.test.ts src/shared/config-validate.test.ts src/main/cloud/model-environment.test.ts
npm run typecheck
npm run verify:source-parity
```

The engine OAuth, registry, protocol, and host integration tests are run before
updating `ENGINE_COMMIT`; the Electron release is then built from that exact
engine revision.
