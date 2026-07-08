# vibe-codr — project notes for agents

A model-agnostic CLI coding agent for the terminal (in the class of Claude Code
and Codex). TypeScript + Bun monorepo. `AGENTS.md` is the canonical project
memory; `CLAUDE.md` exists as the Claude Code bridge and points back here.

## Stack & layout

- **Runtime:** Bun (workspaces + Turbo). **Models:** Vercel AI SDK v5.
- Hard **core/TUI boundary:** the engine emits a typed `UIEvent` stream and
  accepts `EngineCommand`s; no UI type leaks into core, so the engine is fully
  testable headless.

| Package | Owns |
|---|---|
| `@vibe/shared` | Contracts: `UIEvent`, `Message`/`Part`, `ToolDefinition`, `EngineSnapshot`, errors, logger |
| `@vibe/config` | Zod config schema, file discovery + deep-merge, auth resolution |
| `@vibe/providers` | `ProviderRegistry`, `resolveModel`, `CatalogService` (models.dev + `/v1/models`) |
| `@vibe/tools` | Built-in tools (`read`/`edit`/`bash`/`grep`/`repo_map`/`git_*`/…) + the AI-SDK `tool()` adapter; the file-write lock is an **exclusive-ownership claim registry** (`createFileLock`) so parallel subagents can't clobber one file. Web search is **keyless** and **fans out across DuckDuckGo + Bing** (`search-engines.ts`), then dedupes by canonical URL + quality-ranks the merge (`searchcore.ts`); TinyFish is an optional booster. Search HTML parsers must keep result/snippet association local to each result row so malformed skipped rows cannot shift later snippets. `webfetch` extracts PDFs (`pdftext.ts`, zero-dep) + optional Readability, backed by a cache-through store (`fetch-cache.ts`). **OS sandbox** (`sandbox.ts`, opt-in): a pure Seatbelt(macOS)/bwrap(Linux) policy every command spawn (`bash`, jobs, and core's `exec`/`verify`) routes through — the permission engine stays the policy brain, the sandbox is the kernel backstop |
| `@vibe/core` | Agent loop (`Session.run`), `Engine`, slash commands, checkpoints, context-window tracking, plus three pillars: (1) **long-term memory** — injected project/global notes (`memory.ts`), a `save_memory` write-path (`memory-store.ts`), and hybrid recall — BM25 (`bm25.ts`) fused with optional semantic search (`embeddings.ts` + `vector-store.ts` over `bun:sqlite` + `semantic-memory.ts`) and session recall via RRF (`memory-search.ts`), behind `MemoryService`; (2) **orchestration** — a tree-global AIMD limiter (`limiter.ts`), the default-ON task-DAG scheduler (`orchestrator.ts` + `orchestration/orchestrator-runner.ts`: structured handoffs, `read_report`, model tiers, executable verify, worktree isolation, ensemble, journal resume), continuation + background spawns (`continue_subagent`/`check_task` over a bounded-LRU `orchestration/child-registry.ts`; `detach:true`), schema-validated child output (`orchestration/structured-output.ts` — a real JSON-Schema validator, since ai@5's `jsonSchema()` doesn't validate — `outputSchema` enforced on the inline, worktree, AND ensemble/`hard` paths: validated JSON or an honest failure, never silently dropped; a `continue_subagent` that coerced a child to plan mode restores its registry-remembered original mode when continued in execute), and a typed coordination blackboard (`blackboard.ts`); (2b) **build intelligence** (`build/` — deterministic recon → `RepoProfile`, `run_check` parsing, the green-gate, green checkpoints, stub scan, gitops/worktrees, browser verify); (2c) **diagnostics** — the `diagnose()` seam behind a composite of the in-process TS fast path and a multi-language `lsp/` client (stdio JSON-RPC, lazy per-language spawn, deadline-bounded, advisory-only); (3) **MCP** (`mcp.ts`) — stdio + Streamable-HTTP/SSE transports, tools, resources (`read_mcp_resource`), prompts (`get_mcp_prompt`) — both network-flagged so permission rules govern them — `${VAR}`/`${VAR:-default}` expansion over connect-time config, OAuth 2.1 (`mcp-oauth.ts`), and auto-reconnect + `tools/`/`resources/`/`prompts/list_changed` live re-registration; (4) **production** — crash handlers + redacted crash log (`crash.ts`), a keyless update check (`update-check.ts`) |
| `@vibe/plugins` | `HookBus`, slash-command + skill runtimes, `PluginHost`; declarative shell/HTTP hooks are layered on via `core/config-hooks.ts` from the config `hooks` block |
| `@vibe/tui` | OpenTUI app + headless/REPL renderers, themes, tool icons, spinner |
| `@vibe/cli` | `bin/vibecodr` entrypoint (argv, config, headless `-p` vs TUI); the `VERSION` sentinel (`version.ts`, stamped at release) and `vibe upgrade` channel detection (`upgrade.ts`). Release tooling (binary + npm-bundle builds, version stamping) lives in `scripts/release/` |

## Commands

```bash
bun install
bun run typecheck     # tsc across all packages (turbo)
bun test              # bun test across packages
bun run lint          # biome lint
bun run format        # biome format --write
bun run build:binary  # standalone binary -> dist/vibecodr
bun packages/cli/bin/vibecodr.ts --help   # run from source

# Smoke-test the OpenTUI app's render + input + command-menu paths by driving the
# REAL App component with a mock engine via OpenTUI's deterministic test renderer
# (the only way to exercise app.tsx outside a terminal). Run after app.tsx edits.
bun run smoke:tui

# Regenerate the README screenshots. Drives the REAL App component with a mock
# engine through OpenTUI's test renderer, then rasterizes the actual rendered cell
# grid (captureSpans) to PNG via Playwright Chromium — so the shots are pixel-for-
# pixel what the live app paints (no HTML mirror to keep in sync). Re-run after any
# visible TUI change.
bun packages/tui/scripts/screenshot.ts docs/screenshots
```

## Conventions

- **NEVER touch the developer's real `~/.config/vibe-codr/config.json`.** Run
  `bun test` from the REPO ROOT (per-package bunfig.toml mirrors the preload as
  a backstop, and `writeGlobalConfig` hard-fails under NODE_ENV=test without an
  `XDG_CONFIG_HOME` override). When testing the CLI **manually** (a real
  `vibecodr` run, trying `/model`, `/theme`, `/accent`, onboarding), point it at
  throwaway dirs first:
  `XDG_CONFIG_HOME=$(mktemp -d) VIBE_STATE_DIR=$(mktemp -d) bun packages/cli/bin/vibecodr.ts`
  — settings changed in a real session persist globally, and fixture models /
  light themes / grey accents leaking into the developer's config is a bug we
  have already shipped once. Keep their config on its defaults.
- Keep the **core/TUI boundary** intact: core must not import from `@vibe/tui`;
  UIs communicate only through `UIEvent` / `EngineCommand`.
- **Engine runs in a `worker_threads` Worker on the interactive TUI path** (the
  freeze fix — see `packages/cli/src/engine-worker-client.ts`). The CLI fork in
  `packages/cli/src/index.ts` constructs `WorkerEngineClient implements
  EngineClient` for the TUI; the headless `-p` path AND `vibe models` stay
  in-process with direct `new Engine(...)` (single-shot, no real-time consumer
  to starve, no serialization tax on throughput). The worker entry is
  `packages/cli/src/engine-worker-entry.ts`. Wire protocol: `EngineCommand`s
  (UI→core) and `UIEvent`s (core→UI) cross the boundary unmodified and are
  plain structured-cloneable POJOs (`Uint8Array` for image parts clones too);
  RPC over `{ __req, op }`/`{ __resp, ok, value }`; a `{ __fatal__: true,
  message }` sentinel funnels an in-worker crash back to the main thread so the
  existing `crash.ts` `handleCrash` runs (workers can't `process.exit` the
  parent nor restore its raw-mode stdin). `resolveEngineWorkerPath` finds the
  worker — sibling of `process.execPath` for the compiled binary, sibling of
  `import.meta.url` for the npm bundle, in-repo `.ts` for source/dev. `VIBE_NO_WORKER=1`
  OR a missing worker binary falls back to in-process `Engine` so a packaging
  hiccup never bricks the CLI; in that fallback the cooperative-yield gate on
  `app.tsx`'s `for await (const event of engine.events())` (`makeYieldGate(50)`)
  still bounds the freeze (Option B's defense-in-depth — keeps working in both
  paths). `build:binary` produces a second compile target
  `dist/vibecodr-engine-worker`; `build-npm.ts` produces `dist/npm/vibecodr-engine-worker.js`
  so npm users also get thread isolation. Don't re-introduce an in-process
  synchronous-iterator drain in `app.tsx` — microtasks pre-empt macrotasks
  (paint/stdin/spinner) and that's the freeze class.
- Provider SDKs, OpenTUI, `@modelcontextprotocol/sdk`, and
  `@huggingface/transformers` (on-device embeddings for semantic memory) are
  **optional peer deps** — import them via non-literal specifiers and fail with a
  clear, actionable error rather than at startup. **"Non-literal" means a runtime
  VARIABLE** (`const s = "playwright"; await import(s)`) — a cast
  (`import("playwright" as string)`) erases at transpile time back to a literal,
  which `bun build --compile` statically bundles: that broke `build:binary`
  (playwright-core's optional `chromium-bidi` requires) and silently baked
  typescript/linkedom/readability into the binary. Semantic memory degrades to
  lexical BM25 recall when no embedder (local dep or configured cloud model) is
  available, so `bun add @huggingface/transformers` is opt-in.
- **Provider spec invariant:** the repo is pinned to **AI SDK v5** (provider spec
  `"v2"`). Only providers with a v2-compatible dedicated SDK use it directly
  (anthropic `^2`, openai `^2`, deepseek `^1`, codex via openai); **every other
  provider routes through `@ai-sdk/openai-compatible` (`^1`, spec v2)** —
  minimax, ollama, lmstudio, baseten, xai, openrouter, fireworks, google, groq,
  mistral, together, cerebras, perplexity, custom. Their dedicated packages have
  moved to AI SDK v6/v7 (spec v3/v4) and `ai@5` rejects those with "unsupported
  model version". Don't wire a provider to a dedicated SDK unless you confirm it
  resolves `@ai-sdk/provider@^2`; otherwise use openai-compatible with its base
  URL. `registry.test.ts` asserts the rerouted providers stay spec-`v2`.
- **Adding a provider = one `BuiltinSpec`** in `packages/providers/src/defs.ts`
  (`id`, `env`, `baseURL`, optional `baseURLEnv`/`keyless`/`tokenFile`,
  `module:"@ai-sdk/openai-compatible"`, `factory:"createOpenAICompatible"`). No new
  SDK package, no `PROVIDER_MODULES` change. Then add a `ProviderChoice` to
  `packages/cli/src/providers-catalog.ts` (onboarding). **Match the `id` to its
  models.dev slug** so `CatalogService.enrich` lands metadata; where they differ,
  add the exception to `PROVIDER_SLUG_ALIASES` in `catalog.ts` (e.g. `together →
  togetherai`, `fireworks → fireworks-ai`, `codex → openai`). The generic `custom`
  provider has no default base URL — it requires `config.providers.custom.baseURL`
  (or `$CUSTOM_BASE_URL`) and errors clearly otherwise.
- **Model freshness is automatic:** metadata is a live `models.dev/api.json` fetch
  with a 24h disk cache (no vendored snapshot to go stale); availability is each
  provider's live `/v1/models`. `/models refresh` force-pulls past the cache.
- **"Via auth" = token reuse, no OAuth in-repo.** `resolveAuth`→`#resolveKey`
  resolves env → config `apiKey` → token file (`tokenFile`/`tokenPath`, default
  e.g. codex's `~/.codex/auth.json`) → keyless, **re-read every turn** so a token
  another CLI refreshes is picked up. `codex` reuses `OPENAI_API_KEY` or
  `tokens.access_token` from `~/.codex/auth.json` (`auth-file.ts` `COMMON_KEYS`);
  the ChatGPT-subscription backend is configurable (`CODEX_BASE_URL` + provider
  `headers`), not hard-wired. Any provider can reuse another CLI's creds via
  `config.providers.<id>.tokenFile`/`tokenPath`. There is **no *provider* OAuth/
  refresh flow** — don't add one without an explicit ask. (MCP *servers* do have
  OAuth 2.1 — `mcp-oauth.ts` — a separate concern from provider chat auth.)
- **The models.dev cache honors `$XDG_CACHE_HOME`** (default `~/.cache`), read at
  `CatalogService` construction — same rationale as the config's
  `$XDG_CONFIG_HOME` (Bun's `os.homedir()` caches at startup; XDG is read live, so
  `test-preload.ts` isolates both off the developer's real files).
- Tools declare `readOnly` and `concurrencySafe`. Only read-only tools are exposed
  in plan mode; non-read-only tools pass through the permission gate. The AI SDK
  runs a step's tool calls in parallel, so `Toolset.aiTools` serializes every
  non-`concurrencySafe` (mutating) tool behind a shared FIFO lock — never bypass
  it, or parallel edits/writes to one file will race. That lock is **per session**,
  so cross-_subagent_ same-file safety comes from a separate **tree-wide per-file
  write lock** (`createFileLock`, threaded through `SessionDeps.fileLock` →
  `ToolContext.lockFile`): `edit`/`write` wrap their read-modify-write in
  `withFileLock(ctx, absPath, …)` so two parallel subagents editing the same path
  serialize while disjoint paths stay parallel. Lock keys are **canonicalized**
  (`realpathSync.native` — resolves symlinks and on-disk casing) so different
  spellings of one file (`src/App.ts` vs `SRC/app.ts` on case-insensitive APFS)
  still share a lock; idle locks are pruned race-free. Don't add a file-mutating
  built-in without taking that lock.
- **Every context-producing tool caps its output.** A tool's output lands in the
  prompt verbatim, so none may return an unbounded blob — `grep` caps at 500
  matches, `glob` at 1000, `git_*` at 20k chars, `verify` at 8k, `webfetch` at
  `maxChars`, `read` at 100k chars, and `edit` caps the diff it echoes back at
  20k chars (`write` keeps its diff out of the output entirely — both still emit
  the full diff on the `file-changed` event for the UI) (all with an explicit
  `…(truncated …)` marker). **`spawn_subagent` is no exception:** a child's final
  answer lands verbatim in the *parent's* prompt (and a parent can fan out
  `maxParallel` of them in one step), so it's capped at 32k chars
  (`MAX_SUBAGENT_OUTPUT`) before the model sees it while the full text still rides
  the `subagent-finished` event for the UI — same head-cap pattern as `edit`.
  `read` additionally sniffs the leading bytes for a NUL and refuses a
  binary file rather than dump mojibake. Any new tool that surfaces file/command
  content must cap likewise — an uncapped read defeats the engine's context
  accounting and can 400 the next turn on an over-long prompt.
- **Multi-agent coding.** Delegation is the model's own job (vibe-codr has no
  separate orchestrator process), so the execute-mode system prompt carries a
  delegation doctrine (when/how to fan out, self-contained child prompts,
  disjoint-file ownership, consolidate+verify) — injected by `composeSystemPrompt`
  only when `subagentsAvailable` (`depth < subagent.maxDepth`, either mode), the
  same gate that registers `spawn_subagent`. **Plan mode can fan out too** — the
  parent is read-only, so every subagent it spawns is **coerced to plan**
  (`childMode = this.mode === "plan" ? "plan" : …`), giving parallel read-only
  exploration while planning without ever risking a write; plan mode gets a
  read-only doctrine variant and the roster is filtered to read-only agents.
  That filter is enforced at the call site too: a **plan-mode parent rejects an
  execute-only named agent** (`named.mode !== "plan"`) rather than coerce it —
  coercing a writer to read-only would hand the child a write-oriented brief
  with no write tools and burn a turn; the error points at the read-only agents
  it can use (an explicit `mode:"execute"` *without* a named agent is still
  safely coerced). `spawn_subagent` is `readOnly: true` so the orchestration itself never prompts
  for permission — the child's own tools gate their side effects individually
  (auto-verify still counts a spawn turn as mutating via a special-case). Three
  coding agents ship by default (`agents.ts` `defaultAgents()`: `explore`/`review`
  are plan-mode/read-only, `test` is execute); `loadAgents` layers
  `.vibe/agents/*.md` over them so a user file overrides a default by name. The
  roster is injected into the prompt for capability routing. Per-fan-out
  concurrency is bounded by a **per-session** semaphore (`#childGate` =
  `createSemaphore(subagent.maxParallel)`) — per-session on purpose: a tree-global
  cap deadlocks a parent awaiting its own children.
- **Web context-gathering is adaptive, by prompt.** The "Gather web context in
  proportion to the question" block in `system-prompt.ts` (part of `BASE`)
  calibrates depth: quick facts answered from `web_search` snippets (one query, no
  `webfetch`), broad/technical questions cross-check 1–3 authoritative sources.
  Version/currency questions route to **`package_info`** (npm/PyPI authoritative
  latest, no key, read-only — `package-info.ts`) and official docs over blogs.
  `web_search` **fans out across every engine in parallel** (keyless DuckDuckGo +
  Bing, TinyFish when keyed), then **dedupes by canonical URL and quality-ranks**
  the merged pool (`searchcore.ts` `mergeCandidates`), capped at `maxResults` (the
  merged/ranked top-N, default `DEFAULT_MAX`=12); `deep:true` widens the query into
  complementary phrasings before the fan-out. A per-engine cooldown sits an engine
  out on 429/403/503 rather than hammering it. `webfetch` takes `maxChars` (default
  25k, truncation reports the dropped count) and caches per-URL (TTL + stale-on-
  failure). Keep the intent: "fast when simple, exhaustive when needed, model
  decides"; the prompt only biases snippet-first reading (cheaper), never a cap.
- MCP tool names exposed to the model go through `mcpToolName()` (sanitize to
  `[A-Za-z0-9_-]`, cap 64 with a hash suffix); the real MCP name is used only for
  `callTool`. Hosted providers 400 on dotted/over-long function names.
- **Subsystem invariants (don't regress these — each has a test):**
  - **The system prompt must stay byte-stable across a session** (so the whole
    cached conversation prefix survives turn-to-turn). Volatile working state —
    the live task list and gathered-sources block — must NOT go in it; it rides
    in a `<workspace-state>` block folded into the newest user turn
    (`formatWorkspaceState`, appended in `#pushUser` to the model content only,
    never `#history`/the UI bubble). The conversation cache breakpoint is placed
    by `markConversationTail` in `prepareStep` on the CURRENT last message every
    step (sole placer — exactly one conversation breakpoint; system + tools +
    this = 3 ≤ the 4-breakpoint cap). Mid-turn offload projection anchors on
    `#lastSentEstimate` (the estimate of what was actually sent last step), NOT
    `estimateTokens(#modelMessages)` — the latter double-counted the within-turn
    tool-result tail and fired microcompaction far too early.
  - `Session.fork()` (subagents) must NOT inherit the parent's `initial*`
    seed/`store`/`extraSystem`/`createdAt` — a resumed parent would otherwise
    leak its whole history + double-count cost into children, and children would
    self-persist and pollute `/resume`/`--continue`.
  - Project memory (`memory.ts`) walks `cwd`→git-root (only with a `.git`
    ancestor), `cwd` highest precedence, each file byte-capped (`MAX_MEMORY_BYTES`).
  - `SessionStore` writes are atomic (temp + `rename`) and reads tolerate a
    corrupt `meta.json` / truncated jsonl line (skip, never throw).
  - `/loop` iterations run **through the engine queue** (`#enqueue`) so they
    serialize with user turns; `LoopController.stop()` aborts the in-flight turn
    via `onStop`.
  - **The drain loop re-checks `#pending` after the idle consultation.** The
    outer `do-while` condition is `await #maybeContinueOnIdle() || #pending.length`
    — a prompt enqueued DURING the `session.idle` hook's async await (an
    HTTP/shell config hook, or any async in-process handler) would otherwise be
    stranded: `#enqueue`'s `void #drain()` is a no-op against `#draining` still
    true, and a `{continue:false}` hook made the loop exit with the item still in
    `#pending`. The `|| #pending.length` tail loops back to drain it before
    settling idle.
  - Compaction prepends the summary as a leading **user** turn (folding into an
    existing leading user message) to keep strict alternation, and never cuts the
    kept window across a tool boundary: tool results are their own `role: "tool"`
    messages, so the slice point walks back past any leading `tool` message (and
    bails to null if that leaves nothing older) — otherwise `recent` would start
    with a `tool_result` whose `tool_use` was summarized away, a hard 400. After a
    compaction actually replaces the message set it **resets `#lastInputTokens`**
    (the provider's real prompt size measured the pre-compaction context) and emits
    a fresh `context-updated`, so `contextTokens`/`/context`/the live `ctx %` reflect
    the freed space immediately instead of staying pinned at the old high value.
  - Headless `runOneShot` returns `false` on engine error so the CLI exits
    non-zero; interactivity is gated on `values.prompt === undefined` (so `-p ""`
    reads stdin, not onboarding).
  - `/undo` restores via a throwaway `GIT_INDEX_FILE` (never the user's real
    index), removes only files absent from the snapshot tree (keeps the user's
    pre-existing untracked files), and rewinds the conversation to the
    checkpoint's `conversation` mark. It **guards `read-tree`/`ls-tree` success**:
    a snapshot whose commit object is gone (GC'd) is SKIPPED (its dangling ref
    dropped) and `undo` advances to the next valid checkpoint — a failed git call
    must never be read as an empty snapshot, which would delete every untracked file.
    `/undo <index|id>` (`restoreTo`) rewinds multiple steps at once, capturing the
    pre-rewind working tree as a phantom redo step so `/redo` recovers the newest
    edits byte-for-byte. `undo`/`restoreTo` stash the **sliced-off conversation
    tail** on the redo step; `/redo` re-appends it **only while the context still
    sits at the rewound mark** — a `/clear` or any intervening turn skips the
    append (files still restore, with an honest notice), and `/clear` also drops
    stashed redo payloads so a mark-0 edge can't resurrect a cleared conversation.
    Any new snapshot clears the redo stack.
  - The plugin `HookBus` isolates each handler (one throw doesn't break the turn)
    and the lifecycle hooks are actually wired: `session.start/idle/end` (engine),
    `tool.before.execute` (with a working `deny` gate) / `tool.after.execute` /
    `assistant.message` (session). Four events carry a **response contract**
    (Claude Code parity), mirrored by the declarative config-hook layer and
    documented once in `packages/config/src/schema.ts`: `tool.before.execute`
    `{deny,reason}`/`{input}`; `tool.after.execute` `{additionalContext}` (appended
    to the result) or `{deny,reason}` (overrides the already-run result with an
    error — the tool still ran); shell/HTTP hook output may include stdout logs,
    but the JSON directive is trusted only when it is the final non-empty line
    (never scan arbitrary logged JSON-looking payloads); `user.prompt.submit` `{deny}` (turn cancelled
    **before** any state mutation, the handoff plan-discard, or the checkpoint
    snapshot) or `{text}`/string `{input}` (rewrite); `session.idle`
    `{continue:true,reason}` injects one bounded follow-up turn — capped at 3 per
    user prompt via `#idleContinueRounds`, and refused when the turn was Esc-aborted
    or budget-stopped (`#maybeContinueOnIdle` reads `session.interrupted` first) so
    the engine-idle terminal invariant holds. Safety builtins (`RESERVED_SLASH`)
    can't be shadowed by `.vibe/commands/*.md`, and `Toolset.register` refuses to
    let an extension tool shadow a built-in.
  - **Cost/context are real for any model.** `Engine.#resolveContextWindow` tries
    `config.contextWindow[model]` → an Ollama `/api/show` probe (local + cloud) →
    the models.dev catalog → the 128k default. `#resolvePricing` tries a full
    `config.pricing` pin → `CatalogService.pricing`, which falls back to a
    **base-model match** (`ollama/glm-5.2` inherits a `glm-5.2` price) flagged
    `estimated`. The flag rides `SessionUsage.costEstimated` so `formatUsage` shows
    `~$` for estimates, `$0.00` for genuinely free/local — cost is never hidden.
    Anthropic reports `cache_read` tokens **disjoint** from `input_tokens`, so
    `onStepFinish` folds them into a superset (`cacheTokensDisjointFromInput`)
    before cost/context/compaction accounting, else cost + `ctx %` under-report.
  - **A turn that ends before any assistant reply rolls back its user message.**
    `Session.run`'s `finally` identity-matches the just-pushed user turn and pops it
    (with its `#history` echo) when a pre-stream abort/error left it as the last
    message, so the next turn never opens with two consecutive user messages (a 400
    on strict providers, a corrupt `--resume` seed). The identity check survives a
    mid-turn compaction that keeps the message verbatim at the tail.
  - **The tree-global provider `Limiter` must not deadlock a deep fan-out.**
    `run(fn, signal)` is abort-aware (a queued waiter aborts + rejects, so a
    timed-out subagent stuck on `acquire` unwinds) and the engine floors the AIMD
    ceiling at `subagent.maxDepth + 1`, so a linear chain of ancestors each holding
    a slot can't starve its own leaf. `#withLimiter` threads `this.#abort.signal`.
  - **`webfetch` is DNS-rebinding-safe.** `assertFetchAllowed` resolves a hostname
    ONCE (`ADDRCONFIG`, all addresses verified public) and returns `pinnedIp`
    (preferring a verified IPv4 for reachability); `webfetch` connects to *exactly*
    that IP (bracketing IPv6, preserving `Host` + TLS `serverName` + userinfo),
    re-validated + re-pinned on every redirect hop. Never re-resolve at connect time.
  - **Every context-producing tool caps output DURING streaming, not after.**
    `bash`/`git_*`/`verify` read their streams with a bounded reader (cancel at the
    cap), `edit`/`diff` fall back to a coarse diff past an LCS-matrix size guard,
    `@`-mentions bound the READ by stat size, and `pdftext` caps `inflateSync`
    (`maxOutputLength`) against a deflate bomb — so a runaway/hostile input can't OOM.
  - **Orchestration `verify→retry` is honest.** The reviewer verdict must be
    `REVIEW-CLEAN` on its own line (`isReviewClean`, not a substring — an "NOT
    REVIEW-CLEAN …" must read as feedback), and a non-mutating RETRY (feedback set)
    must NOT short-circuit to `completed` (it leaves the prior rejected edits on disk).
  - **MCP:** two real tool names that sanitize to one exposed name are
    disambiguated with a hash suffix (`#registerServerTools`); a reconnect that
    resolves after `close()` tears down its transport (no leak); a transient
    transport `onerror` does NOT latch `connected=false` (only `onclose` drives the
    down/reconnect); resources/prompts first seen on a reconnect register their
    aggregate tool; the OAuth token store writes atomically (temp+rename) and sets a
    corrupt file aside rather than dropping the grant.
  - **Config defaults are per-parse independent.** `defaultConfig`/`loadConfig`
    `structuredClone` the parsed config — Zod's object/array defaults are shared by
    reference, and the engine mutates several (`providers`, `subagent`, `reasoning`),
    so aliasing would leak across configs and pollute tests. `writeGlobalConfig`
    serializes its read-modify-write, and `save_memory` (`appendMemory`) is atomic
    per dated file, so concurrent fire-and-forget persists can't clobber.
  - The plan→execute handoff is **bound to its enqueued job** (a `{handoff}` option
    on `#handlePrompt`, captured at enqueue time), not a shared flag a queued prompt
    could steal; `abort`/`steer` target `(#loopSession ?? #session)` so Esc
    interrupts an in-flight `/loop` iteration, not just the idle main session.
  - **Recon is deterministic and degrade-only.** `build/codeintel.ts` never
    throws — a failed probe degrades fields to null; watch/dev scripts are never
    detected as build/test commands (`NON_TERMINATING`); `run_check` + the
    green-gate share ONE `detectCommands` so worker and gate can't drift; "no
    tests ran" is never green and an unparseable passing run is never "no tests"
    (`build/check.ts`). The ledger fills only MISSING commands (detection wins).
  - **The green-gate is honest.** No detected command → the turn is reported
    UNVERIFIED, never silently green; fix rounds are bounded (`build.gate.maxRounds`)
    and enqueue through the FIFO like user turns; `/loop` iterations are never
    gated; green checkpoints are hidden refs (commit-on-green must NEVER touch
    the user's branch/index — branch mode is opt-in and refuses a dirty tree).
    The diff reviewer sees the REAL diff (`checkpoints.diffFrom`, untracked
    files included) — never a child's self-report.
  - **Worktree tasks commit-then-squash-merge** (a squash-merge only sees
    committed history), merges are serialized behind a per-runner lock, and a
    conflict FAILS the task with feedback — never a half-merged tree. Ensemble
    attempts are judged by their own gate results; only a scoring winner merges.
  - **Microcompaction only touches `role:"tool"` messages** (alternation and
    tool-boundary invariants are structurally safe), keeps untouched messages
    BY REFERENCE (the orphan-rollback identity check depends on it), never
    offloads the most recent `keepLiveResults`, and is idempotent via the
    offload sentinel. prepareStep edits are EPHEMERAL — the durable pass at
    end-of-turn/pre-compaction is what persisted sessions carry.
  - **Permission rules: DENY is absolute; specificity decides allow-vs-ask.**
    Any matching deny — scoped OR name-only — wins outright (a blanket deny can't
    be punched through by a scoped allow; express deny-with-exceptions by SCOPING
    the deny). Below deny, a content-scoped (`match`) rule beats a name-only one
    (so an allowlist doesn't prompt); within that, ask > allow. Globs are
    action-aware: deny/ask compile dotAll+case-insensitive (a newline/case trick
    can't dodge a kill-switch), allow compiles strictly (no smuggling a trailing
    command past an allowlist). An EXPLICIT `ask` rule fails CLOSED when headless
    (no human to approve); a default/fallback ask auto-allows. `always`-allow is
    remembered per tool+content-scope and cleared when approvals re-gate to `ask`.
    Network read-only tools consult the rules with a fallback of allow
    (frictionless default, governable egress) — don't restore the old readOnly bypass.
  - **Stale-write guard:** `read` records mtimes; `edit`/`write` to an
    externally-changed file must error "re-read first" (checked INSIDE the file
    lock). Our own writes re-record so they never self-flag.
  - **Wayback recovery fires ONLY on HTTP-status failures** — an SSRF-guard
    rejection must propagate untouched (asking archive.org about a blocked
    internal URL would leak it).
- Every behavior change ships with a test. Prefer mock-model integration tests
  (`ai/test`'s `MockLanguageModelV2`) over hitting the network.
- `packages/tui/src/app.tsx` is excluded from `tsc` (OpenTUI is an optional
  native dep) and can't run in CI. Verify it two ways: `bun run smoke:tui` drives
  the real `App` with a mock engine through OpenTUI's test renderer (asserts
  input/submit, streamed output, tool icons, the working spinner, the command
  menu, the permission card, the plan-approval card, the reasoning preview, the
  verify/loop/checkpoint notices, and the accent-swatch submenu actually work).
  **Smoke click-coordinate gotcha:** the turn/input panels carry
  `paddingLeft={2}` after the rail column, so a row's own clickable box starts at
  column ~14 on the 104-col test terminal — `mockMouse.click(15, row)` hits it; a
  click at column 12 lands in panel padding and silently no-ops (this staled five
  click assertions once). Full-width Rail targets (the user card) still take
  x=12, and a selection drag must START inside the content column (x≥14), never
  the gutter. The other verification path:
  `packages/tui/scripts/screenshot.ts` drives that SAME real `App` and rasterizes
  its actual rendered cell grid (`captureSpans()`) to the README PNGs — so there's
  no parallel render logic to keep in lockstep; a visible app.tsx change just gets a
  smoke assertion (where behavioral) and a screenshot re-run. Never use an OpenTUI
  prop you can't confirm
  exists (the input once silently dropped every keystroke because it lacked
  `focused`, and streamed replies never repainted because `<For>` is
  reference-keyed; both are now covered by the smoke test). OpenTUI box/text
  facts confirmed in the installed 0.4.x: `border` takes `BorderSides[]` and
  `borderStyle:"heavy"` draws `┃`; `<text>` takes `fg`/`bg`/`attributes`
  (`TextAttributes.BOLD`); there is no `<spinner>` intrinsic (we animate a
  signal-driven braille frame instead). Assistant/plan prose renders through the
  native `<markdown content streaming syntaxStyle>` renderable (build the style
  once with `SyntaxStyle.create()`) — **never** pre-style markdown into an ANSI
  string and hand it to `<text>`: the buffer counts the escape bytes as glyph
  width and garbles wrapped/streamed replies (that was the corruption bug). The
  renderable conceals inline markers (`**bold**`, `` `code` ``) via a tree-sitter
  *inline* parser whose worker statically imports **`web-tree-sitter`** — a peer
  dep of `@opentui/core`. It's wired as an optional peer of `@vibe/tui` and
  provided through the root dev env; without it the worker throws `Cannot find
  package 'web-tree-sitter'`, conceal never runs, and every reply shows literal
  `**`/backticks. The smoke test pushes `**42**` and asserts `!frame.includes("**")`
  so a missing peer can't regress silently.
  `<code>`/`<diff>` intrinsics also exist; all renderables accept `onMouseDown`
  (used for click-to-expand of tool output), and `useTerminalDimensions()` drives
  the responsive `contentWidth()` (the centered column reflows on resize). A mouse
  click blurs the focused input, so any click
  handler must restore it via a **deferred** `inputEl.focus()` (queueMicrotask —
  a synchronous call runs before the renderer's own post-click focus pass and is
  immediately undone); the smoke test clicks a tool row then opens the menu to
  guard this.
- Pure UI logic lives in small, unit-tested modules so app.tsx stays thin:
  **`reducer.ts`** (the transcript `UIEvent→Block` reducer — streaming coalescing,
  tool-block creation, diff folding, cumulative file deltas + `groupTurns` — app.tsx
  keeps only the Solid signals + the flush timer and delegates via `apply(action)`),
  `markdown-blocks.ts` (`splitMarkdown` peels a reply into prose / **heading** /
  **quote** / code / table blocks — streaming-tolerant and fence-aware — so app.tsx
  renders each with the right primitive and explicit color: headings/table-header in
  `heading`, quotes with a `gutter` bar, code in `code`; prose still goes through
  the native `<markdown>`. `renderTable` returns a **flat** table: `header`/`row`
  lines carry their columns as `cells: string[]` (pre-padded) so `TableBlock` draws
  a bold accent header over aligned rows — no lines/bands — while wrapped cells stay
  in-column), `rich-blocks.ts` (the out-of-the-box data views — bar/line/pie charts,
  weather + source cards, all pure + tested), `gradient.ts` (the single-hue accent
  ramp `brandRamp`/`brandSpans` + `hexToHsv`/`hsvToHex`), `tool-icons.ts` (per-tool
  glyph + action summary — every registered tool has a bespoke summary reading its
  REAL schema fields; `kv()` digests object args as JSON, never `[object Object]`),
  `spinner.ts` (braille frames), `themes.ts` (palettes: `default`/`light`/
  `contrast`/`opencode` + the ported classics `tokyonight`/`catppuccin`/`gruvbox`/
  `nord`/`one-dark`/`dracula`/`rosepine`/`kanagawa`/`everforest`/`flexoki`/`vesper`;
  every palette defines the `gutter`/`heading`/`code` text tokens + a `series`
  chart ramp, and its own background/panel/elevated surfaces. The theme/accent
  NAME registry — `THEME_NAMES`/`ACCENT_PRESETS`/`ACCENT_NAMES` — lives in
  `@vibe/shared` (`theme-registry.ts`): core (`engine-commands.ts`) and tui
  (`themes.ts`) both import it, so there is no copy to keep in sync; the
  palettes themselves stay render-only in tui, `themes.test.ts` asserts every
  shared name has a palette, and `commands-catalog.ts` derives its menus from
  these so it never drifts), `modes.ts`, `commands-catalog.ts`.
  The screenshot generator lives in `@vibe/tui` and imports the real `App`, so it
  reuses these modules directly — there are no duplicated copies to keep in sync.
- **Layout invariant (centered single column; don't regress scrolling):** the
  ROOT is a flex *row* on a **black background** (`backgroundColor={palette().
  background}`): a `flexGrow` **left gutter**, the **chat column**
  (`flexDirection="column"`, `width={contentWidth()}`, `flexShrink={0}`,
  `padding={1}`), on wide terminals (≥140 cols, `sidebarOn()`) a fixed-width
  **right sidebar** (`SIDEBAR_W`=42: Tasks panel hugging the top, then the
  live **Subagents fan-out** — one row per child with a spinner/✓ glyph, a
  right-aligned elapsed, and a second muted line for its live activity while
  running / result glimpse once done — then the turn's **reasoning-only
  Thinking** panel in a `grow` Rail filling the rest when the model thinks
  (so the sidebar spans the SAME height as the chat column); the trail
  persists until the next user-message. Tool work is **not** mirrored in the
  sidebar as an Activity feed — tools live only in the chat transcript
  (ToolBlockView). When there is no reasoning, an invisible grow filler
  keeps bottom alignment. The inline chat-column Tasks/Subagents panels
  render ONLY when the sidebar is off (`!sidebarOn()`) — never both. The
  rigid panels split a height budget (`sidePanelBudget`/`sideTaskCap`/
  `sideSubCap`) so a long list can't push the Thinking block off-screen).
  Sidebar alignment is EXACT and smoke-guarded (`bun run smoke:sidebar`):
  first block on the viewport's first content row (NO marginTop on the first
  sidebar block — the chat's first-block margin is swallowed by its
  scrollbox), bottom edge on the input block's bottom (a `height={2+…}`
  spacer reserves the under-input status rows). openai-compat providers get
  `extractReasoningMiddleware` in @vibe/providers so inline `<think>` streams
  as real reasoning parts instead of leaking into the reply. Then a `flexGrow`
  **right gutter**. **PERF INVARIANTS (the freeze fix — keep these):** engine
  events reduce immediately but PAINT through one batched commit per 24 ms
  frame (`enqueue` vs `apply` in app.tsx — burst traffic like
  tool-start/finish/file-changed/notice must use `enqueue`); the transcript
  renders only the last `WINDOW_TURNS`=40 turns behind a "▸ N earlier turns"
  fold row (`windowStartIndex` in `trail.ts`, render-only — the reducer keeps
  full history); reasoning tokens buffer per frame and the trail appends
  incrementally (never re-split the whole log); hot producers yield a
  macrotask (`makeYieldGate` — bash pump every ~64 KB, session #consume every
  50 parts) because engine + UI share ONE thread and an unyielding microtask
  loop starves stdin (the frozen-keyboard bug); the UI event loop try/catches
  each event so a throwing handler degrades to an error notice, not a dead
  half-alive UI. The gutters center the
  column ChatGPT-style; `contentWidth()` = `min(CONTENT_MAX, dims().width - 2 -
  (sidebarOn() ? SIDEBAR_W : 0))`.
  **There is NO top header.** Inside the column, top to bottom:
  the **body** (`flexGrow={1}`) — when `showJobs()` it's the **`/jobs` sub-view**
  (background shell jobs + detected localhost servers, a scrollbox replacing the
  transcript; Esc or `/jobs` closes it). Otherwise a `<Show>` renders the scrolling
  transcript when there are blocks, else a **centered Vibe Codr wordmark splash**.
  The wordmark is a compact ░██ block face (`packages/tui/src/wordmark.ts`, 80×7)
  rendered as a **clean left→right single-hue blue fade** (`BrandLine`): each row is
  a flex *row* of one `<text fg>` per character, colored by COLUMN position
  (`brandSpans`, `gradient.ts`) via a lightness ramp around the live accent hue
  (`brand()`), so column `i` shares a ramp position across every row and the block
  reads as one smooth light→deep sweep (and follows `/accent`). **Gotcha:
  per-character color must use a row of `<text fg>` (the SegRow mechanism); inline
  `<span fg>` children DO NOT paint in this renderer** (they render the default fg —
  this is what made the wordmark show up white). The smoke test asserts the gradient
  via `captureSpans()` (many distinct fg colors, all blue-dominant — `captureCharFrame`
  is color-blind). Shown when the column has room (`showWordmark()`); otherwise it
  falls back to `<ascii_font text="VIBE CODR" font="slick" color={brand()}>` (flat
  accent), then `◆ Vibe Codr`. Below it is a quiet "Try asking" intro then the
  example asks as a **block-centered list** with aligned `›` markers (a flex row of
  `[flexGrow spacer][column of rows][flexGrow spacer]`, each row `[› ][example]`) —
  reads as inviting quick-actions, not a cramped one-liner. `SegRow` is a row of
  coloured `<text>` runs (OpenTUI has no inline-markup `<text>`), two-tone: muted
  scaffolding, brighter foreground. **Context (location · git · goal) sits
  TOP-LEFT** of the column (`topLeftLine()`, muted, left-aligned), out of the
  conversation's way. The **under-input footer is a justified status BAR** (NOT
  centered): `detailsRight()` (model · changed · ctx · cost) hugs the LEFT edge
  (aligned with the top-left line), and the `SegRow` key hints hug the RIGHT edge —
  but only when they fit beside the status (`footerFits()`), else the hints drop to
  their own left-aligned row so the two never collide/clip on a narrow terminal.
  Hints show only on the empty splash or while a job runs (`showHints()`), so the
  working footer is just the left-aligned status and the input sits low.
  **Chrome is NEVER drawn with `border={[…]}`** — the border renderable paints
  outside content flow (it gaps `│` into dashes on terminals with line spacing and
  can ghost stray segments on reflow/scroll). Every block accent (user/reply
  cards, input, plan, permission, toast, quotes) goes through the **`Rail`
  component**: a thin `▎` quarter-block glyph column, absolutely positioned over
  the block's reserved first column and clipped to its height — ordinary content
  that is always clipped/cleared/repainted with its block. **The slash-command
  menu renders INSIDE the input block** — the input is a filled *elevated* box on
  the mode-hued Rail whose prompt reads `MODE ❯ …`; when `menuModel().open`, the
  menu (title, key hint, two-tone rows with a full-width selection band, `+N
  more`, a blank spacer) renders ABOVE the prompt row in that same block, so the
  field fluidly grows UPWARD and reads as one control, not a separate popup. The
  box has no fixed height — it auto-sizes to the menu + input
  (`height={inputRows()}`) stack. Opening it shrinks the scrollable transcript
  above rather than covering it; the input stays pinned at the bottom. The
  transcript is `<scrollbox flexGrow={1}
  flexShrink={1} stickyScroll stickyStart="bottom">`. Every surface *below* the
  transcript (working spinner, plan box, **Tasks** panel, **Subagents** panel,
  permission card, the input frame, the status line) must set
  `flexShrink={0}`, or the scrollbox steals their space and they collapse to one
  overlapping row. Long conversations must scroll inside the box, never overflow
  onto the input. The transcript is a list of `Block`s rendered with `<Index>`
  (stable per position, append-only); tool output is condensed to one clickable
  row and expands in place. Consecutive **tool** rows stack flush (chained — the
  follower drops its top margin when the prior visible block is also a tool), so a
  search→fetch→fetch sequence reads as one group instead of separated fragments;
  the gap is kept only at a boundary with prose, a notice, or a folded turn. A **`spawn_subagent` block is flagged `isMarkdown`** —
  it opens expanded and renders its reply through `<markdown>` (headers, bold,
  lists, code, and **tables**, which OpenTUI renders natively) instead of raw text
  lines; `ToolBlockView` takes the `SyntaxStyle` for this. Expand/collapse goes
  through `anchoredToggle`: when the
  turn is **idle** it disengages the scrollbox's `stickyScroll` and freezes
  `scrollTop` so the clicked row stays put; while **streaming** it leaves sticky
  alone. Auto-follow re-engages next turn (`runText` sets `stickyScroll=true`).
  **Turn folding is anchored on the USER message:** a turn is keyed by its user
  message id; every following block (until the next user message) belongs to it
  (`grouping` memo → `turnKey`/`counts`). **Tapping your message** folds the whole
  exchange under it (`toggleTurn` → `collapsedTurns`; `isHidden` hides every
  non-user block of that turn) down to a `▸ N items hidden · tap to expand`
  affordance; tap again to reopen; **Ctrl+O** (`toggleAllTurns`) folds/unfolds
  every turn. Assistant/tool/notice blocks are NOT click targets — folding is
  driven from the user message only; do NOT reintroduce an emission-time `turn`
  field on blocks.
  **The input is a filled block on the mode Rail**: an `elevated`-bg padded box
  (vertical padding 1 — the user explicitly wants the thick padded strip, don't
  slim it) on a thin `Rail` in the mode hue, whose prompt row reads
  **`MODE ❯ …`** — `modeWord()` (`ASK`/`PLAN`/`YOLO` — **execute reads "ASK"**
  because every action is gated by an approval prompt, vs YOLO = no prompts) in
  `accent()` = `modeColor(uiMode())` (ASK blue · PLAN green · YOLO red, fixed
  constants in `modes.ts`), then a `brand()` `❯` caret glyph. The `<input>`'s own
  `backgroundColor`/`focusedBackgroundColor` are **`"transparent"`** (an OpenTUI
  Textarea otherwise paints its whole row a different shade past the block's
  fill). The placeholder is "Send a message or type / to start". **All status
  details live UNDER the input**, not in a header (and cwd · git · goal sit
  top-left). Git state comes from `readGitInfo()` (`git-info.ts`, an injectable-
  runner module unit-tested against fixed porcelain output; the engine keeps a thin
  `#git` wrapper + `#emitGit`) via the
  `git-updated` event + the snapshot `git` field; `changedSummary()` condenses the
  session's edits (`✎ N files +a -b` — the detail is the inline diff rows). Do NOT
  add a tool-call "Activity" feed — it duplicated the transcript and was removed.
  **Subagents** render ONE truncated line each by default (a big fan-out used to
  dump every full multi-line prompt and flood the screen); tap a row
  (`toggleSub`/`expandedSubs`) to expand its full prompt + result, bounded by
  `truncate(…, 700)` so an expanded row can't run off-screen. User message blocks
  are filled `panel` cards on the `brand()` Rail (the turn's reply/tool card sits
  on a muted `gutter` Rail) so a sent message reads as a quoted echo of where you
  type.
- **Spacing (uniform rhythm):** the chat column carries `padding={1}` (a one-cell
  inset on every side) and is centered by the two `flexGrow` gutters. Every region
  stacked below the transcript (working spinner, plan, Tasks panel, Subagents
  panel, permission card, menu, input, the details status line) carries
  `marginTop={1}` — one blank row between every area; the second status line (hints
  / goal) hugs the details line with no margin so the two read as one block. Keep
  that rhythm; don't special-case a region to 2.
- **Color discipline (graphite bg + neutral grey borders + white chrome, one violet
  stroke):** the app paints a **graphite background** (`backgroundColor=
  {palette().background}`, `#0a0a0a` on the default theme), neutral **charcoal**
  surfaces (`panel`/`elevated`), **neutral grey borders** (`palette().border`,
  `#3c3c3c`), and mostly **white/grey** text. The chrome accent `brand()` =
  `accentColor() || palette().primary` is **white** by default (`#eeeeee`,
  opencode-style — titles and markers render in the body white, bold where
  emphasis is needed). **Violet `#8b5cf6` appears in exactly two places**: the
  selected menu row (`selBg`, a solid violet band with dark text — the one
  saturated signature stroke) and markdown headings / table header rows
  (`palette().heading`). Override the chrome accent with `/accent <name|hex>` —
  the wordmark fade follows it. **The accent is reserved for titles + markers
  only** (`gradient.ts` + `modes.ts` + palette tokens):
  1. **Wordmark** — a single-hue fade (`BrandLine`/`brandSpans`), a lightness
     ramp around `brand()`.
  2. **Markers** — panel titles, the `❯` user marker + heavy left gutter, the active
     task/step, and the input caret (all `brand()`); the selected menu row uses the
     violet `selBg` band.
  3. **Mode chip** — the input's mode label + rail. ASK (execute) FOLLOWS the live
     brand accent (`accent()` in app.tsx returns `brand()` for execute — so
     `/accent orange` recolors the whole input control coherently instead of
     clashing with a fixed hue); PLAN green `#9ece6a` · YOLO red `#f7768e` stay
     fixed alert hues (`modes.ts`).
  4. **Working spinner** — the one deliberate exception to the single-hue rule:
     the `✻` glyph cycles through `rainbow(tick)` (gradient.ts) while a turn runs,
     and recedes to the gutter tone when idle (rides the existing
     `working()`-gated tick; no new idle timer).
  **Borders stay neutral grey** — the input frame and every panel box use
  `palette().border`, NOT `brand()`. Tool-step gutters and subagent markers use one
  **calm muted tone** (`palette().gutter`, `#484848`) — no per-item rotation; a
  running subagent's glyph is `brand()` (alive), a finished one recedes to the
  gutter tone. Text-output tokens: markdown **headings** and the **table header row**
  use `palette().heading` (violet, bold); **code** text uses `palette().code`; diffs
  use `add`/`del`, warnings `notice` (amber). **Accent/mode color is for ACCENTS
  only — never body text or tool output.** A `title` needs a top edge, so the input
  uses a full `border` (all sides); the docked slash menu (below) drops its *bottom*
  border so the input's top border is the shared divider.
- **Event-surface parity (don't re-drop these).** The TUI's event switch handles
  the full user-meaningful set the headless printer shows: `reasoning-delta`
  (a one-line muted+italic `✻ thinking` preview under the working spinner —
  cleared when answer text streams and at turn end), `verify-started`/
  `verify-finished` (notice; a failure carries the output's first line),
  `loop-tick`, and `checkpoint-restored` (both notices). Intentionally silent in
  BOTH renderers: `session-start` (snapshot covers it), `step-finished`
  (usage-updated covers it), `checkpoint-created` (per-turn noise),
  `orchestration-task` (the Subagents panel + runner notices cover it),
  `queue-changed.active` (the pending list is the UI need).
- **Ctrl+C exits GRACEFULLY.** `mountApp` renders with `exitOnCtrlC: false` and
  App's `useKeyboard` routes Ctrl+C through the same `gracefulExit` path as
  `/exit` (await `engine.finalize()` — digest, job reap, MCP close — then
  `process.exit(0)`; OpenTUI's exit hook restores the terminal). A non-empty
  draft is cleared by the first press; a second press during teardown hard-exits
  (130) so a hung finalize can't trap the user. Don't re-enable `exitOnCtrlC` —
  the built-in handler exits WITHOUT finalize (the old leak).
- **Plan-approval modal.** A presented plan (`plan-presented` event) is an
  interactive gate, not a static hint: with the input empty, **Enter accepts**
  (`resolve-plan` → engine switches to execute, seeds the task list from the plan's
  checklist, and runs a turn against the approved plan via the existing
  `#pendingHandoff`), **typing a message revises** it (`resolve-plan` `edit` →
  re-plan in plan mode), and **Esc keeps planning**. The binding is collision-free
  on purpose — single letters go into the revision text, not a shortcut — mirroring
  the permission card's `resolve-permission` pattern.
- **Interactive submenus (the `/` menu):** one normalized `menuModel` memo in
  `app.tsx` drives five shapes — `command` (flat list), `value` (enum submenus like
  `/theme`/`/approvals`/`/reasoning`, current value marked `●`), `models` (the model
  picker), `providers`, and `agents`. Each shape builds `MenuRow[]` whose `choose`
  carries its own action, so keyboard/click/render share one path (`chooseAt(idx)`,
  hover highlight). Detectors on the draft text open each: **`/model` (one unified
  picker for BOTH agents — `modelPicker()` returns a `target` of `"main" | "sub" |
  {agent}`; Tab flips main⇄sub via the `modelTarget()` signal, `/model agent <name>`
  targets a named agent)** → `set-model` / `set-subagent-model` / `set-agent-model`;
  **`/providers`** (`EngineClient.listProviders()`, ✓/○ status) → prefills
  `/model key <id> ` or browses that provider's models; **`/agents`**
  (`EngineClient.listAgents()`, per-agent model + mode, with `/agents new <name>` to
  scaffold) → opens an agent-targeted model picker. Model/provider/agent lists
  are fetched once and cached in signals (`models`/`providers`/`agents`); the agents
  cache is invalidated (`setAgents(null)`) after a write so it re-fetches. To add a
  submenu, extend `menuModel` + add a detector — don't dump output into the transcript
  via `#notice`. Named-agent models persist to `.vibe/agents/<name>.md` via the
  `agents.ts` writer (`setAgentModel`/`scaffoldAgent`), then the engine reloads the roster.
  **Hover vs arrows (FOOTGUN):** a menu row's `onMouseOver` must go through
  `hoverRow(idx, e)`, which re-selects only when the pointer's `(e.x, e.y)` actually
  changed from the last event. A resting mouse otherwise keeps re-firing hover (or a
  new row scrolls under it after an arrow press) and pins the selection, making ↑/↓
  look dead. Keyboard nav wins until the mouse truly moves. `MouseEvent` carries
  `x`/`y` (confirmed in `@opentui/core` 0.4.x `renderer.d.ts`).
- **Persisted settings + test isolation (FOOTGUN — already bit once):**
  `/model`, `/model sub`, `/model key`, `/accent`, `/theme`, `/reasoning` persist via
  `#persistConfig` → `writeGlobalConfig` → `globalConfigPath()`. That path honors
  **`$XDG_CONFIG_HOME`** (read live), NOT `HOME` — because **Bun's `os.homedir()`
  caches at startup and ignores a runtime `process.env.HOME`**. Any test that runs a
  persisting command MUST isolate via `XDG_CONFIG_HOME` (the `test-preload.ts` Bun
  `preload` does this suite-wide; per-test helpers set it too). Setting `HOME` does
  nothing and silently clobbers the developer's real `~/.config/vibe-codr/config.json`.
- Match the surrounding code's style; comments explain *why*, not *what*.

## Before you finish

Run `bun run typecheck && bun test && bun run lint` — all must pass.
