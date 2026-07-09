import type { LanguageModel, EmbeddingModel } from "ai";
import { extractReasoningMiddleware, wrapLanguageModel } from "ai";
import { VibeError } from "@vibe/shared";
import type { ProviderDef, ProviderCreateOptions, ModelInfo } from "./types.ts";
import { listOpenAICompatibleModels } from "./openai-compat.ts";

/** Wall-clock bound on the `/v1/models` listing fetch. Without it a blackholed
 * custom baseURL hangs `/models`, `--models`, the model picker, and onboarding
 * until the OS TCP timeout (listConfiguredModels awaits all providers at once).
 * A timeout degrades to "this provider isn't listed", never an error. */
export const LIST_MODELS_TIMEOUT_MS = 8_000;

/**
 * Static loader map for the provider SDKs. The specifiers are LITERAL `import()`
 * calls (not `import(variable)`) for one critical reason: `bun build --compile`
 * — the `build:binary` "standalone" target — only bundles modules it can see
 * statically. A variable specifier is invisible to the bundler, which left the
 * shipped binary unable to load ANY provider ("Cannot find module …"). Listing
 * them here makes the standalone binary genuinely self-contained while keeping
 * the import lazy (only the selected provider's SDK is evaluated at runtime).
 */
const PROVIDER_MODULES: Record<string, () => Promise<unknown>> = {
  "@ai-sdk/anthropic": () => import("@ai-sdk/anthropic"),
  "@ai-sdk/openai": () => import("@ai-sdk/openai"),
  "@ai-sdk/deepseek": () => import("@ai-sdk/deepseek"),
  "@ai-sdk/openai-compatible": () => import("@ai-sdk/openai-compatible"),
};

/**
 * Load a provider SDK package. Falls back to a variable `import()` for any
 * specifier not in the static map (e.g. a plugin-registered provider); the
 * failure surfaces a clear, actionable error at call time rather than startup.
 */
async function loadProviderModule(spec: string, providerId: string): Promise<any> {
  try {
    const loader = PROVIDER_MODULES[spec];
    return loader ? await loader() : await import(spec);
  } catch (err) {
    // A missing SDK is a dependency problem, not an auth problem — say so,
    // with the exact install command, instead of mislabeling the package as
    // an unconfigured provider.
    throw new VibeError(
      `Provider "${providerId}" needs the ${spec} package — install it with \`bun add ${spec}\` (${(err as Error).message})`,
      "PROVIDER_SDK_MISSING",
    );
  }
}

interface BuiltinSpec {
  id: string;
  env: string[];
  baseURL: string;
  baseURLEnv?: string;
  requiresBaseURL?: boolean;
  keyless?: boolean;
  /**
   * Hosted endpoint used automatically when an API key is present and no base
   * URL override is set — lets a single provider serve both a local keyless
   * daemon and its cloud service (e.g. Ollama local vs. ollama.com).
   */
  cloudBaseURL?: string;
  /** Default credential file (e.g. a subscription/OAuth token from another CLI). */
  tokenFile?: string;
  /** SDK package + factory export name. */
  module?: string;
  factory?: string;
}

const BUILTINS: BuiltinSpec[] = [
  {
    id: "anthropic",
    env: ["ANTHROPIC_API_KEY"],
    baseURL: "https://api.anthropic.com/v1",
    module: "@ai-sdk/anthropic",
    factory: "createAnthropic",
  },
  {
    id: "openai",
    env: ["OPENAI_API_KEY"],
    baseURL: "https://api.openai.com/v1",
    module: "@ai-sdk/openai",
    factory: "createOpenAI",
  },
  {
    id: "deepseek",
    env: ["DEEPSEEK_API_KEY"],
    baseURL: "https://api.deepseek.com/v1",
    module: "@ai-sdk/deepseek",
    factory: "createDeepSeek",
  },
  {
    // xAI (Grok) serves an OpenAI-compatible API; the dedicated `@ai-sdk/xai`
    // package has no `ai@5` (spec v2) release, so we drive it through
    // `@ai-sdk/openai-compatible`.
    id: "xai",
    env: ["XAI_API_KEY"],
    baseURL: "https://api.x.ai/v1",
    baseURLEnv: "XAI_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // Meta Model API — Muse Spark via OpenAI-compatible Chat Completions.
    // Official env is MODEL_API_KEY (key shape LLM|…); META_API_KEY is a
    // discoverable alias. Docs: https://dev.meta.ai/docs/getting-started/overview
    // Tool names stay [A-Za-z0-9_-] (our MCP sanitizer); Meta allows at most one
    // dot. Never send reasoning_effort:"none" (400) — see model-tuning.ts.
    id: "meta",
    env: ["MODEL_API_KEY", "META_API_KEY"],
    baseURL: "https://api.meta.ai/v1",
    baseURLEnv: "META_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // MiniMax: OpenAI-compatible API, token (subscription) auth.
    id: "minimax",
    env: ["MINIMAX_API_KEY"],
    baseURL: "https://api.minimax.io/v1",
    baseURLEnv: "MINIMAX_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // Codex: reuse the token the Codex CLI stored at ~/.codex/auth.json (API key
    // or ChatGPT OAuth access token). Point CODEX_BASE_URL at the right backend
    // for OAuth-subscription use; an API key works against OpenAI directly.
    id: "codex",
    env: ["CODEX_API_KEY", "OPENAI_API_KEY"],
    baseURL: "https://api.openai.com/v1",
    baseURLEnv: "CODEX_BASE_URL",
    tokenFile: "~/.codex/auth.json",
    module: "@ai-sdk/openai",
    factory: "createOpenAI",
  },
  {
    // Fireworks serves an OpenAI-compatible API; use openai-compatible so it
    // works under `ai@5` without the dedicated (spec v3+) package.
    id: "fireworks",
    env: ["FIREWORKS_API_KEY"],
    baseURL: "https://api.fireworks.ai/inference/v1",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // Baseten exposes an OpenAI-compatible Model API, so we drive it through
    // `@ai-sdk/openai-compatible` (AI-SDK spec v2). The dedicated `@ai-sdk/baseten`
    // package tracks AI-SDK v6 (spec v3) and is incompatible with our pinned
    // `ai@5`, so it would reject every request with an "unsupported version".
    id: "baseten",
    env: ["BASETEN_API_KEY"],
    baseURL: "https://inference.baseten.co/v1",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // OpenRouter is OpenAI-compatible; the dedicated `@openrouter/ai-sdk-provider`
    // now peers `ai@^6`, so we route through `@ai-sdk/openai-compatible` to stay
    // on the pinned `ai@5`. (Unified reasoning options are not forwarded — the
    // model still reasons natively.)
    id: "openrouter",
    env: ["OPENROUTER_API_KEY"],
    baseURL: "https://openrouter.ai/api/v1",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // Google Gemini via its OpenAI-compatible endpoint — keeps us on `ai@5` /
    // openai-compatible (no `@ai-sdk/google`, which needs `ai@6`). Use a Google AI
    // Studio key. models.dev slug is `google` (enrichment lands directly).
    id: "google",
    env: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    baseURLEnv: "GOOGLE_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // Z.ai (Zhipu) — GLM models via the OpenAI-compatible endpoint. Coding-plan
    // subscribers use the dedicated coding endpoint instead: set
    // ZAI_BASE_URL=https://api.z.ai/api/coding/paas/v4. models.dev slug is `zai`.
    id: "zai",
    env: ["ZAI_API_KEY", "ZHIPU_API_KEY"],
    baseURL: "https://api.z.ai/api/paas/v4",
    baseURLEnv: "ZAI_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // Moonshot AI (Kimi) — OpenAI-compatible, international endpoint (mainland
    // China is api.moonshot.cn; point MOONSHOT_BASE_URL there if needed).
    // models.dev slug is `moonshotai`; the catalog aliases `moonshot` → it.
    id: "moonshot",
    env: ["MOONSHOT_API_KEY"],
    baseURL: "https://api.moonshot.ai/v1",
    baseURLEnv: "MOONSHOT_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // Alibaba Model Studio (Qwen) — DashScope's OpenAI-compatible
    // "compatible-mode" endpoint, international region (mainland is
    // dashscope.aliyuncs.com — override via DASHSCOPE_BASE_URL). models.dev
    // slug is `alibaba` (matches, so enrichment lands directly).
    id: "alibaba",
    env: ["DASHSCOPE_API_KEY"],
    baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    baseURLEnv: "DASHSCOPE_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // Hugging Face Inference Providers router — one HF token, OpenAI-compatible;
    // each open model is auto-routed to a live inference provider.
    id: "huggingface",
    env: ["HF_TOKEN", "HUGGINGFACE_API_KEY"],
    baseURL: "https://router.huggingface.co/v1",
    baseURLEnv: "HF_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    id: "groq",
    env: ["GROQ_API_KEY"],
    baseURL: "https://api.groq.com/openai/v1",
    baseURLEnv: "GROQ_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    id: "mistral",
    env: ["MISTRAL_API_KEY"],
    baseURL: "https://api.mistral.ai/v1",
    baseURLEnv: "MISTRAL_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // Together AI — OpenAI-compatible. models.dev slug is `togetherai`, so the
    // catalog alias maps `together` → `togetherai` for enrichment.
    id: "together",
    env: ["TOGETHER_API_KEY"],
    baseURL: "https://api.together.xyz/v1",
    baseURLEnv: "TOGETHER_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    id: "cerebras",
    env: ["CEREBRAS_API_KEY"],
    baseURL: "https://api.cerebras.ai/v1",
    baseURLEnv: "CEREBRAS_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // Perplexity (Sonar) — OpenAI-compatible chat; it has no `/models` listing, so
    // models are used by id (listing degrades gracefully to []).
    id: "perplexity",
    env: ["PERPLEXITY_API_KEY"],
    baseURL: "https://api.perplexity.ai",
    baseURLEnv: "PERPLEXITY_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // Generic bring-your-own OpenAI-compatible endpoint: point it at ANY OpenAI-
    // style API. The base URL is REQUIRED (no default) — set it via
    // `config.providers.custom.baseURL` or `CUSTOM_BASE_URL`; the key is optional
    // (keyless) since some self-hosted endpoints need none.
    id: "custom",
    env: ["CUSTOM_API_KEY"],
    baseURL: "",
    baseURLEnv: "CUSTOM_BASE_URL",
    requiresBaseURL: true,
    keyless: true,
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    id: "lmstudio",
    env: [],
    baseURL: "http://localhost:1234/v1",
    baseURLEnv: "LMSTUDIO_BASE_URL",
    keyless: true,
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // Ollama: local models via its OpenAI-compatible endpoint (keyless), and
    // Ollama Cloud (ollama.com) when an OLLAMA_API_KEY is set. `ollama serve`
    // listens on 11434; override the host with OLLAMA_BASE_URL. With a key and
    // no override we target the cloud `/v1` endpoint automatically; cloud model
    // ids are plain (e.g. `ollama/gpt-oss:120b`) — list them with `vibe models`.
    id: "ollama",
    env: ["OLLAMA_API_KEY"],
    baseURL: "http://localhost:11434/v1",
    baseURLEnv: "OLLAMA_BASE_URL",
    cloudBaseURL: "https://ollama.com/v1",
    keyless: true,
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
];

/** Build the AI-SDK provider instance (shared by language + embedding models). */
async function buildProvider(
  spec: BuiltinSpec,
  baseURL: (opts: ProviderCreateOptions) => string,
  opts: ProviderCreateOptions,
): Promise<(modelId: string) => unknown> {
  const url = baseURL(opts);
  // A provider with no default base URL (the generic `custom` provider) is
  // unusable until one is set — fail with an actionable message rather than
  // letting the SDK build a broken relative URL.
  if (!url) {
    throw new VibeError(
      `Provider "${spec.id}" needs a base URL. Set config.providers.${spec.id}.baseURL or $${spec.baseURLEnv ?? "BASE_URL"}.`,
      "PROVIDER_CONFIG",
    );
  }
  const mod = await loadProviderModule(spec.module!, spec.id);
  const factory = mod[spec.factory!];
  if (typeof factory !== "function") {
    throw new VibeError(
      `Provider "${spec.id}" SDK ${spec.module} has no export "${spec.factory}".`,
      "PROVIDER_SDK_INVALID",
    );
  }
  // openai-compatible needs a `name`; others ignore extra fields.
  return factory({
    name: spec.id,
    apiKey: opts.apiKey ?? "not-needed",
    baseURL: url,
    ...(opts.headers ? { headers: opts.headers } : {}),
  }) as (modelId: string) => unknown;
}

function buildDef(spec: BuiltinSpec): ProviderDef {
  const baseURL = (opts: ProviderCreateOptions): string =>
    opts.baseURL ??
    (spec.baseURLEnv ? process.env[spec.baseURLEnv] : undefined) ??
    // With a key and no explicit override, prefer the hosted cloud endpoint
    // (e.g. Ollama Cloud) over the local default.
    (spec.cloudBaseURL && opts.apiKey ? spec.cloudBaseURL : undefined) ??
    spec.baseURL;

  return {
    id: spec.id,
    auth: {
      env: spec.env,
      baseURLEnv: spec.baseURLEnv,
      requiresBaseURL: spec.requiresBaseURL,
      keyless: spec.keyless,
      tokenFile: spec.tokenFile,
    },

    async create(modelId, opts): Promise<LanguageModel> {
      const provider = await buildProvider(spec, baseURL, opts);
      // Provider instances are callable: provider(modelId) -> LanguageModel.
      const model = provider(modelId) as LanguageModel;
      // OpenAI-compatible endpoints have no first-class reasoning channel:
      // hosted open reasoning models (qwen, deepseek-r1 via ollama, …) emit
      // their chain-of-thought INLINE as <think>…</think>, which would leak
      // into the visible reply. Extract it into real reasoning stream parts
      // so it flows to the Thinking panel like any native reasoning model.
      // A model that never emits the tag passes through untouched, and the
      // dedicated-SDK providers (anthropic/openai/deepseek) keep their own
      // native reasoning parts — only the compat family is wrapped.
      if (spec.factory === "createOpenAICompatible" && typeof model !== "string") {
        return wrapLanguageModel({
          model,
          middleware: extractReasoningMiddleware({ tagName: "think" }),
        });
      }
      return model;
    },

    async createEmbedding(modelId, opts): Promise<EmbeddingModel<string>> {
      const provider = await buildProvider(spec, baseURL, opts);
      const embed = (provider as {
        textEmbeddingModel?: (id: string) => EmbeddingModel<string>;
      }).textEmbeddingModel;
      if (typeof embed !== "function") {
        throw new VibeError(
          `Provider "${spec.id}" does not support text embeddings.`,
          "PROVIDER_UNSUPPORTED",
        );
      }
      return embed.call(provider, modelId);
    },

    async listModels(opts): Promise<ModelInfo[]> {
      const url = baseURL(opts);
      if (!url) return []; // no endpoint configured yet (e.g. custom) → nothing to list
      return listOpenAICompatibleModels(
        spec.id,
        url,
        opts.apiKey,
        AbortSignal.timeout(LIST_MODELS_TIMEOUT_MS),
        opts.headers,
      );
    },
  };
}

/** The full set of built-in provider definitions. */
export function builtinProviders(): ProviderDef[] {
  return BUILTINS.map(buildDef);
}
