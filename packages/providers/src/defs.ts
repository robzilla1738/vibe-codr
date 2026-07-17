import { VibeError } from "@vibe/shared";
import type { EmbeddingModel, LanguageModel } from "ai";
import { extractReasoningMiddleware, wrapLanguageModel } from "ai";
import { listOpenAICompatibleModels } from "./openai-compat.ts";
import { subscriptionFetch, type SubscriptionProviderId } from "./oauth.ts";
import { PROVIDER_MANIFEST } from "./provider-manifest.ts";
import type { ModelInfo, ProviderCreateOptions, ProviderDef } from "./types.ts";

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
  "@ai-sdk/amazon-bedrock": () => import("@ai-sdk/amazon-bedrock"),
  "@ai-sdk/azure": () => import("@ai-sdk/azure"),
  "@ai-sdk/google-vertex": () => import("@ai-sdk/google-vertex"),
  "@ai-sdk/google-vertex/anthropic": () => import("@ai-sdk/google-vertex/anthropic"),
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
  endpointEnvGroups?: readonly (readonly string[])[];
  keyless?: boolean;
  /**
   * Hosted endpoint used automatically when an API key is present and no base
   * URL override is set — lets a single provider serve both a local keyless
   * daemon and its cloud service (e.g. Ollama local vs. ollama.com).
   */
  cloudBaseURL?: string;
  /** Default credential file (e.g. a subscription/OAuth token from another CLI). */
  tokenFile?: string;
  tokenPath?: string;
  /** SDK package + factory export name. */
  module?: string;
  factory?: string;
  /** Native cloud SDK whose auth/URL construction is not API-key compatible. */
  native?: "bedrock" | "azure" | "vertex";
  externalAuth?: "aws" | "google-adc";
  subscriptionAuth?: SubscriptionProviderId;
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
    // xAI uses Chat Completions for its existing catalog, but Grok 4.5 requires
    // the Responses API. `@ai-sdk/openai` exposes both transports from one
    // provider instance, so buildDef can route per model below.
    id: "xai",
    env: ["XAI_API_KEY"],
    baseURL: "https://api.x.ai/v1",
    baseURLEnv: "XAI_BASE_URL",
    module: "@ai-sdk/openai",
    factory: "createOpenAI",
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
    // Friendly compatibility alias for ChatGPT/Codex subscription auth. Public
    // OpenAI API keys belong to the `openai` provider; sending one to the
    // ChatGPT backend produces the misleading api.responses.write error.
    id: "codex",
    env: ["VIBE_CODEX_OAUTH_TOKEN"],
    baseURL: "https://chatgpt.com/backend-api/codex",
    baseURLEnv: "CODEX_BASE_URL",
    tokenFile: "~/.vibe-codr/auth.json",
    tokenPath: "providers.openai-codex.access",
    subscriptionAuth: "openai-codex",
    module: "@ai-sdk/openai",
    factory: "createOpenAI",
  },
  {
    // Fireworks serves an OpenAI-compatible API; keep it on the shared transport
    // so endpoint behavior and auth match the rest of the compatible catalog.
    id: "fireworks",
    env: ["FIREWORKS_API_KEY"],
    baseURL: "https://api.fireworks.ai/inference/v1",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // Baseten exposes an OpenAI-compatible Model API, so use the shared SDK 7
    // compatible transport and preserve its endpoint-specific model ids.
    id: "baseten",
    env: ["BASETEN_API_KEY"],
    baseURL: "https://inference.baseten.co/v1",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // OpenRouter is OpenAI-compatible; the shared transport keeps its broad model
    // catalog on the same streaming/tool contract as the other gateways.
    id: "openrouter",
    env: ["OPENROUTER_API_KEY"],
    baseURL: "https://openrouter.ai/api/v1",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // Google Gemini via its OpenAI-compatible endpoint. Use a Google AI Studio
    // key. models.dev slug is `google` (enrichment lands directly).
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
    // NVIDIA NIM — OpenAI-compatible API for NIM-hosted models (Llama, Qwen,
    // Phi, Mistral, …). models.dev slug is `nvidia` (enrichment lands directly).
    id: "nvidia",
    env: ["NVIDIA_API_KEY"],
    baseURL: "https://integrate.api.nvidia.com/v1",
    baseURLEnv: "NVIDIA_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // DeepInfra — OpenAI-compatible endpoint for hosted open models. The shared
    // transport keeps its stream and tool behavior aligned with other gateways.
    id: "deepinfra",
    env: ["DEEPINFRA_API_KEY"],
    baseURL: "https://api.deepinfra.com/v1/openai",
    baseURLEnv: "DEEPINFRA_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // Venice AI — OpenAI-compatible endpoint on the shared SDK 7 transport.
    id: "venice",
    env: ["VENICE_API_KEY"],
    baseURL: "https://api.venice.ai/api/v1",
    baseURLEnv: "VENICE_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // Cohere — OpenAI-compatible "compatibility-mode" endpoint on the shared
    // SDK 7 transport.
    id: "cohere",
    env: ["COHERE_API_KEY"],
    baseURL: "https://api.cohere.com/compatibility/v1",
    baseURLEnv: "COHERE_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // Kilo Gateway — OpenAI-compatible multi-model gateway. models.dev slug is
    // `kilo` (enrichment lands directly).
    id: "kilo",
    env: ["KILO_API_KEY"],
    baseURL: "https://api.kilo.ai/api/gateway",
    baseURLEnv: "KILO_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // LLM Gateway — OpenAI-compatible multi-model gateway. models.dev slug is
    // `llmgateway` (enrichment lands directly).
    id: "llmgateway",
    env: ["LLMGATEWAY_API_KEY"],
    baseURL: "https://api.llmgateway.io/v1",
    baseURLEnv: "LLMGATEWAY_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // ZenMux — OpenAI-compatible multi-model gateway. models.dev slug is
    // `zenmux` (enrichment lands directly).
    id: "zenmux",
    env: ["ZENMUX_API_KEY"],
    baseURL: "https://zenmux.ai/api/v1",
    baseURLEnv: "ZENMUX_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // Snowflake Cortex — OpenAI-compatible LLM gateway on Snowflake's
    // managed Cortex service. The base URL is account-specific:
    // https://{account}.snowflakecomputing.com/api/v2/cortex/v1 — set it via
    // SNOWFLAKE_CORTEX_BASE_URL or config.providers.snowflake-cortex.baseURL.
    // Auth: a bearer token (OAuth, JWT, or PAT) via SNOWFLAKE_CORTEX_TOKEN or
    // SNOWFLAKE_CORTEX_PAT. models.dev slug is `snowflake` (enrichment via alias).
    id: "snowflake-cortex",
    env: ["SNOWFLAKE_CORTEX_TOKEN", "SNOWFLAKE_CORTEX_PAT"],
    baseURL: "",
    baseURLEnv: "SNOWFLAKE_CORTEX_BASE_URL",
    requiresBaseURL: true,
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    // Cloudflare Workers AI — OpenAI-compatible endpoint scoped to a Cloudflare
    // account. The base URL includes the account ID:
    // https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1 — set it
    // via CLOUDFLARE_BASE_URL or config.providers.cloudflare-workers-ai.baseURL.
    // Auth: CLOUDFLARE_API_KEY. models.dev slug is `cloudflare-workers-ai`.
    id: "cloudflare-workers-ai",
    env: ["CLOUDFLARE_API_KEY"],
    baseURL: "",
    baseURLEnv: "CLOUDFLARE_BASE_URL",
    requiresBaseURL: true,
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

const SUPPORTED_MANIFEST_SDKS: Record<string, Pick<BuiltinSpec, "module" | "factory">> = {
  "@ai-sdk/anthropic": { module: "@ai-sdk/anthropic", factory: "createAnthropic" },
  "@ai-sdk/deepseek": { module: "@ai-sdk/deepseek", factory: "createDeepSeek" },
  "@ai-sdk/openai": { module: "@ai-sdk/openai", factory: "createOpenAI" },
  "@ai-sdk/openai-compatible": {
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
};

/** Hermes provider slugs that differ from models.dev/vibe-codr ids. These are
 * real aliases with their own documented credentials and regional endpoints,
 * not UI-only names, so model strings copied from Hermes work unchanged. */
const HERMES_COMPAT_SPECS: BuiltinSpec[] = [
  {
    id: "nous",
    env: ["NOUS_API_KEY"],
    baseURL: "https://inference.nousresearch.com/v1",
    tokenFile: "~/.hermes/auth.json",
    tokenPath: "providers.nous.tokens.access_token",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    id: "arcee",
    env: ["ARCEEAI_API_KEY"],
    baseURL: "https://api.arcee.ai/api/v1",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    id: "azure-foundry",
    env: ["AZURE_FOUNDRY_API_KEY"],
    baseURL: "",
    baseURLEnv: "AZURE_FOUNDRY_BASE_URL",
    requiresBaseURL: true,
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    id: "copilot",
    env: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
    baseURL: "https://api.githubcopilot.com",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    id: "gmi",
    env: ["GMI_API_KEY", "GMICLOUD_API_KEY"],
    baseURL: "https://api.gmi-serving.com/v1",
    baseURLEnv: "GMI_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    id: "kilocode",
    env: ["KILOCODE_API_KEY", "KILO_API_KEY"],
    baseURL: "https://api.kilo.ai/api/gateway",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    id: "kimi-coding",
    env: ["KIMI_API_KEY", "KIMI_CODING_API_KEY", "MOONSHOT_API_KEY"],
    baseURL: "https://api.moonshot.ai/v1",
    baseURLEnv: "KIMI_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    id: "kimi-coding-cn",
    env: ["KIMI_CN_API_KEY", "MOONSHOT_API_KEY"],
    baseURL: "https://api.moonshot.cn/v1",
    baseURLEnv: "KIMI_CN_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    id: "minimax-cn",
    env: ["MINIMAX_CN_API_KEY", "MINIMAX_API_KEY"],
    baseURL: "https://api.minimaxi.com/anthropic/v1",
    baseURLEnv: "MINIMAX_CN_BASE_URL",
    module: "@ai-sdk/anthropic",
    factory: "createAnthropic",
  },
  {
    id: "minimax-oauth",
    env: ["MINIMAX_API_KEY"],
    baseURL: "https://api.minimax.io/anthropic/v1",
    tokenFile: "~/.hermes/auth.json",
    tokenPath: "providers.minimax-oauth.tokens.access_token",
    module: "@ai-sdk/anthropic",
    factory: "createAnthropic",
  },
  {
    id: "novita",
    env: ["NOVITA_API_KEY"],
    baseURL: "https://api.novita.ai/openai/v1",
    baseURLEnv: "NOVITA_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    id: "ollama-cloud",
    env: ["OLLAMA_API_KEY"],
    baseURL: "https://ollama.com/v1",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    id: "openai-codex",
    env: ["VIBE_CODEX_OAUTH_TOKEN"],
    baseURL: "https://chatgpt.com/backend-api/codex",
    baseURLEnv: "CODEX_BASE_URL",
    tokenFile: "~/.vibe-codr/auth.json",
    tokenPath: "providers.openai-codex.access",
    subscriptionAuth: "openai-codex",
    module: "@ai-sdk/openai",
    factory: "createOpenAI",
  },
  {
    id: "openai-api",
    env: ["OPENAI_API_KEY"],
    baseURL: "https://api.openai.com/v1",
    baseURLEnv: "OPENAI_BASE_URL",
    module: "@ai-sdk/openai",
    factory: "createOpenAI",
  },
  {
    id: "gemini",
    env: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    baseURLEnv: "GOOGLE_BASE_URL",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    id: "opencode-zen",
    env: ["OPENCODE_ZEN_API_KEY", "OPENCODE_API_KEY"],
    baseURL: "https://opencode.ai/zen/v1",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    id: "opencode-go",
    env: ["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"],
    baseURL: "https://opencode.ai/zen/go/v1",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    id: "qwen-oauth",
    env: ["QWEN_API_KEY"],
    baseURL: "https://portal.qwen.ai/v1",
    tokenFile: "~/.hermes/auth.json",
    tokenPath: "providers.qwen-oauth.tokens.access_token",
    module: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
  },
  {
    id: "xai-oauth",
    env: ["XAI_API_KEY"],
    baseURL: "https://api.x.ai/v1",
    tokenFile: "~/.vibe-codr/auth.json",
    tokenPath: "providers.xai-oauth.access",
    subscriptionAuth: "xai-oauth",
    module: "@ai-sdk/openai",
    factory: "createOpenAI",
  },
];

const NATIVE_CLOUD_SPECS: BuiltinSpec[] = [
  {
    id: "amazon-bedrock",
    env: [],
    baseURL: "",
    keyless: true,
    module: "@ai-sdk/amazon-bedrock",
    factory: "createAmazonBedrock",
    native: "bedrock",
    externalAuth: "aws",
  },
  {
    id: "bedrock",
    env: [],
    baseURL: "",
    keyless: true,
    module: "@ai-sdk/amazon-bedrock",
    factory: "createAmazonBedrock",
    native: "bedrock",
    externalAuth: "aws",
  },
  {
    id: "azure",
    env: ["AZURE_API_KEY"],
    baseURL: "",
    requiresBaseURL: true,
    endpointEnvGroups: [["AZURE_RESOURCE_NAME"]],
    module: "@ai-sdk/azure",
    factory: "createAzure",
    native: "azure",
  },
  {
    id: "azure-cognitive-services",
    env: ["AZURE_COGNITIVE_SERVICES_API_KEY"],
    baseURL: "",
    requiresBaseURL: true,
    endpointEnvGroups: [["AZURE_COGNITIVE_SERVICES_RESOURCE_NAME"]],
    module: "@ai-sdk/azure",
    factory: "createAzure",
    native: "azure",
  },
  {
    id: "google-vertex",
    env: [],
    baseURL: "",
    keyless: true,
    requiresBaseURL: true,
    endpointEnvGroups: [
      ["GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION"],
      ["VERTEX_PROJECT_ID", "VERTEX_REGION"],
    ],
    module: "@ai-sdk/google-vertex",
    factory: "createVertex",
    native: "vertex",
    externalAuth: "google-adc",
  },
  {
    id: "google-vertex-anthropic",
    env: [],
    baseURL: "",
    keyless: true,
    requiresBaseURL: true,
    endpointEnvGroups: [
      ["GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION"],
      ["VERTEX_PROJECT_ID", "VERTEX_REGION"],
    ],
    module: "@ai-sdk/google-vertex/anthropic",
    factory: "createVertexAnthropic",
    native: "vertex",
    externalAuth: "google-adc",
  },
  {
    id: "vertex",
    env: [],
    baseURL: "",
    keyless: true,
    requiresBaseURL: true,
    endpointEnvGroups: [
      ["GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION"],
      ["VERTEX_PROJECT_ID", "VERTEX_REGION"],
    ],
    module: "@ai-sdk/google-vertex",
    factory: "createVertex",
    native: "vertex",
    externalAuth: "google-adc",
  },
];

/**
 * OpenCode gets its broad provider coverage from models.dev rather than a
 * hand-maintained switch. Mirror that architecture for every HTTP provider we
 * can drive through the SDK families bundled by vibe-codr. Providers whose
 * models.dev entry names a native SDK we do not bundle still get a safe
 * OpenAI-compatible fallback when the catalog publishes an API URL; otherwise
 * they remain configurable through an explicit baseURL instead of pretending
 * that key-only setup is sufficient.
 */
function manifestSpecs(): BuiltinSpec[] {
  const fixed = new Set(
    [...BUILTINS, ...HERMES_COMPAT_SPECS, ...NATIVE_CLOUD_SPECS].map((spec) => spec.id),
  );
  return PROVIDER_MANIFEST.flatMap((provider) => {
    if (fixed.has(provider.id)) return [];
    const supported = SUPPORTED_MANIFEST_SDKS[provider.npm];
    const transport = supported ?? SUPPORTED_MANIFEST_SDKS["@ai-sdk/openai-compatible"]!;
    return [
      {
        id: provider.id,
        env: [...provider.env],
        baseURL: provider.baseURL,
        requiresBaseURL: provider.baseURL.length === 0,
        keyless: provider.env.length === 0,
        ...transport,
      },
    ];
  });
}

function expandEnvironmentTemplate(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => process.env[name] ?? "");
}

/** Build the AI-SDK provider instance (shared by language + embedding models). */
async function buildProvider(
  spec: BuiltinSpec,
  baseURL: (opts: ProviderCreateOptions) => string,
  opts: ProviderCreateOptions,
): Promise<((modelId: string) => unknown) & {
  chat?: (modelId: string) => unknown;
  responses?: (modelId: string) => unknown;
}> {
  const url = baseURL(opts);
  // A provider with no default base URL (the generic `custom` provider) is
  // unusable until one is set — fail with an actionable message rather than
  // letting the SDK build a broken relative URL.
  if (!url && !spec.native) {
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
  const settings = await (async () => {
    if (spec.native === "bedrock") {
      const hasStaticCredentials = Boolean(
        process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY,
      );
      const credentialProvider = hasStaticCredentials
        ? undefined
        : (await import("@aws-sdk/credential-providers")).fromNodeProviderChain(
            process.env.AWS_PROFILE ? { profile: process.env.AWS_PROFILE } : {},
          );
      return {
        region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        sessionToken: process.env.AWS_SESSION_TOKEN,
        ...(credentialProvider ? { credentialProvider } : {}),
        ...(url ? { baseURL: url } : {}),
        ...(opts.headers ? { headers: opts.headers } : {}),
      };
    }
    if (spec.native === "azure") {
      const resourceEnv =
        spec.id === "azure-cognitive-services"
          ? "AZURE_COGNITIVE_SERVICES_RESOURCE_NAME"
          : "AZURE_RESOURCE_NAME";
      return {
        apiKey: opts.apiKey,
        resourceName: process.env[resourceEnv],
        ...(url ? { baseURL: url } : {}),
        ...(opts.headers ? { headers: opts.headers } : {}),
      };
    }
    if (spec.native === "vertex") {
      return {
        project: process.env.GOOGLE_VERTEX_PROJECT ?? process.env.VERTEX_PROJECT_ID,
        location: process.env.GOOGLE_VERTEX_LOCATION ?? process.env.VERTEX_REGION,
        ...(url ? { baseURL: url } : {}),
        ...(opts.headers ? { headers: opts.headers } : {}),
      };
    }
    return {
      name: spec.id,
      apiKey: opts.apiKey ?? "not-needed",
      baseURL: url,
      ...(spec.subscriptionAuth ? { fetch: subscriptionFetch(spec.subscriptionAuth) } : {}),
      ...(opts.headers || spec.subscriptionAuth === "openai-codex"
        ? {
            headers: {
              ...(spec.subscriptionAuth === "openai-codex" && process.env.CODEX_ACCOUNT_ID
                ? { "ChatGPT-Account-Id": process.env.CODEX_ACCOUNT_ID, originator: "vibe-codr" }
                : {}),
              ...opts.headers,
            },
          }
        : {}),
    };
  })();
  return factory(settings) as ((modelId: string) => unknown) & {
    chat?: (modelId: string) => unknown;
    responses?: (modelId: string) => unknown;
  };
}

function createTextModel(
  provider: ((modelId: string) => unknown) & {
    chat?: (modelId: string) => unknown;
    responses?: (modelId: string) => unknown;
  },
  spec: BuiltinSpec,
  modelId: string,
): unknown {
  const xai = spec.id === "xai" || spec.subscriptionAuth === "xai-oauth";
  if (xai && modelId !== "grok-4.5" && provider.chat) return provider.chat(modelId);
  if (xai && modelId === "grok-4.5" && provider.responses) return provider.responses(modelId);
  return provider(modelId);
}

function buildDef(spec: BuiltinSpec): ProviderDef {
  const baseURL = (opts: ProviderCreateOptions): string =>
    expandEnvironmentTemplate(
      opts.baseURL ??
        (spec.baseURLEnv ? process.env[spec.baseURLEnv] : undefined) ??
        // With a key and no explicit override, prefer the hosted cloud endpoint
        // (e.g. Ollama Cloud) over the local default.
        (spec.cloudBaseURL && opts.apiKey ? spec.cloudBaseURL : undefined) ??
        spec.baseURL,
    );

  return {
    id: spec.id,
    auth: {
      env: spec.env,
      baseURLEnv: spec.baseURLEnv,
      requiresBaseURL: spec.requiresBaseURL,
      endpointEnvGroups: spec.endpointEnvGroups,
      externalAuth: spec.externalAuth,
      keyless: spec.keyless,
      tokenFile: spec.tokenFile,
      tokenPath: spec.tokenPath,
      fallbackTokenFiles:
        spec.subscriptionAuth === "openai-codex"
          ? [{ path: "~/.codex/auth.json" }]
          : spec.subscriptionAuth === "xai-oauth"
            ? [
                {
                  path: "~/.hermes/auth.json",
                  tokenPath: "providers.xai-oauth.tokens.access_token",
                },
              ]
            : undefined,
    },

    async create(modelId, opts): Promise<LanguageModel> {
      const provider = await buildProvider(spec, baseURL, opts);
      const model = createTextModel(provider, spec, modelId) as LanguageModel;
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

    async createEmbedding(modelId, opts): Promise<EmbeddingModel> {
      const provider = await buildProvider(spec, baseURL, opts);
      const embed = (
        provider as {
          textEmbeddingModel?: (id: string) => EmbeddingModel;
        }
      ).textEmbeddingModel;
      if (typeof embed !== "function") {
        throw new VibeError(
          `Provider "${spec.id}" does not support text embeddings.`,
          "PROVIDER_UNSUPPORTED",
        );
      }
      return embed.call(provider, modelId);
    },

    async listModels(opts): Promise<ModelInfo[]> {
      if (spec.native) return [];
      const url = baseURL(opts);
      if (!url) return []; // no endpoint configured yet (e.g. custom) → nothing to list
      const live = await listOpenAICompatibleModels(
        spec.id,
        url,
        opts.apiKey,
        AbortSignal.timeout(LIST_MODELS_TIMEOUT_MS),
        opts.headers,
        spec.subscriptionAuth ? subscriptionFetch(spec.subscriptionAuth) : globalThis.fetch,
      );
      if (
        spec.subscriptionAuth === "xai-oauth" &&
        !live.some((model) => model.id === "grok-build-0.1")
      ) {
        live.unshift({ id: "grok-build-0.1", providerId: spec.id, name: "Grok Build 0.1" });
      }
      if (
        spec.subscriptionAuth === "xai-oauth" &&
        !live.some((model) => model.id === "grok-4.5")
      ) {
        live.unshift({ id: "grok-4.5", providerId: spec.id, name: "Grok 4.5" });
      }
      return live;
    },
  };
}

/** The full set of built-in provider definitions. */
export function builtinProviders(): ProviderDef[] {
  return [...BUILTINS, ...HERMES_COMPAT_SPECS, ...NATIVE_CLOUD_SPECS, ...manifestSpecs()].map(
    buildDef,
  );
}

/** Build a config-defined provider with an arbitrary ID. This is the same
 * compatibility escape hatch OpenCode exposes: Chat Completions by default,
 * or the OpenAI Responses transport when explicitly selected. */
export function configDefinedProvider(
  id: string,
  transport: "openai-compatible" | "openai-responses" = "openai-compatible",
): ProviderDef {
  return buildDef({
    id,
    env: [configProviderEnvironmentName(id, "API_KEY")],
    baseURL: "",
    baseURLEnv: configProviderEnvironmentName(id, "BASE_URL"),
    requiresBaseURL: true,
    keyless: true,
    module: transport === "openai-responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
    factory: transport === "openai-responses" ? "createOpenAI" : "createOpenAICompatible",
  });
}

export function configProviderEnvironmentName(
  id: string,
  suffix: "API_KEY" | "BASE_URL" | "TRANSPORT" | "HEADERS_JSON",
): string {
  const normalized =
    id
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "CUSTOM";
  return `VIBE_PROVIDER_${normalized}_${suffix}`;
}
