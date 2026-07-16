/**
 * Curated provider choices for first-run onboarding — mirrors the CLI's
 * `packages/cli/src/providers-catalog.ts` so the Electron app's setup wizard
 * shows the same provider list, labels, key URLs, and default models.
 *
 * Kept separate from the runtime ProviderRegistry (which only knows
 * auth/endpoints) so the menu can carry human-facing copy without leaking
 * presentation into the engine. `registryId` maps a choice back to a real
 * provider id. "Ollama Cloud" and "Ollama (local)" share the `ollama` registry
 * id: the provider is keyless locally but auto-targets ollama.com when a key is
 * present, so onboarding treats the cloud option as key-required.
 */

import { PROVIDER_MANIFEST } from "./provider-manifest";

export { hasUsableOnboardingProvider } from "./provider-readiness";

export interface ProviderChoice {
  /** Stable choice id (unique within the menu). */
  key: string;
  /** Provider id understood by the registry. */
  registryId: string;
  /** Menu label. */
  label: string;
  /** One-line description shown under the label. */
  blurb: string;
  /** Recommended/default model string, used as a fallback and preselect. */
  defaultModel: string;
  /** Primary env var that supplies the key (for detection + prompts). */
  env?: string;
  /** Where to get a key. */
  keyUrl?: string;
  /** Human-facing endpoint shown during setup. Runtime defaults still live in the engine. */
  defaultBaseURL?: string;
  /** Local provider that needs no key at all (skip the key prompt entirely). */
  localKeyless?: boolean;
  /** Generic bring-your-own OpenAI-compatible endpoint — prompts for a base URL. */
  customEndpoint?: boolean;
  /** Provider has no catalog endpoint and therefore needs an explicit URL. */
  requiresBaseURL?: boolean;
  /** Extra setup note (e.g. "needs `ollama serve`"). */
  note?: string;
  /** Shown in the short Recommended view before the complete provider catalog. */
  featured?: boolean;
}

const manifestById = new Map(PROVIDER_MANIFEST.map((provider) => [provider.id, provider]));
const builtinDefaultBaseURLs: Readonly<Record<string, string>> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  moonshot: "https://api.moonshot.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  together: "https://api.together.xyz/v1",
  cerebras: "https://api.cerebras.ai/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  perplexity: "https://api.perplexity.ai",
  deepseek: "https://api.deepseek.com/v1",
  xai: "https://api.x.ai/v1",
  "xai-oauth": "https://api.x.ai/v1",
  "openai-codex": "https://chatgpt.com/backend-api/codex",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  venice: "https://api.venice.ai/api/v1",
  cohere: "https://api.cohere.com/compatibility/v1",
};

/** Return the endpoint users will get without an override. Kept pure so every
 * setup surface explains the same provider default instead of showing an empty
 * URL field for a provider that is already fully configured by the engine. */
export function providerChoiceDefaultBaseURL(choice: ProviderChoice): string {
  if (choice.defaultBaseURL) return choice.defaultBaseURL;
  return builtinDefaultBaseURLs[choice.registryId]
    ?? manifestById.get(choice.registryId)?.baseURL
    ?? "";
}

/** Best catalog copy for an existing provider id, including arbitrary ids. */
export function providerChoiceForId(id: string): ProviderChoice | undefined {
  return PROVIDER_CHOICES.find((choice) => choice.registryId === id);
}

const CURATED_PROVIDER_CHOICES: ProviderChoice[] = [
  {
    key: "anthropic",
    registryId: "anthropic",
    label: "Anthropic · Claude",
    blurb: "Claude Fable / Opus / Sonnet — top-tier coding models.",
    defaultModel: "anthropic/claude-opus-4-8",
    env: "ANTHROPIC_API_KEY",
    keyUrl: "https://console.anthropic.com/settings/keys",
    featured: true,
  },
  {
    key: "openai",
    registryId: "openai",
    label: "OpenAI · GPT",
    blurb: "GPT-5.5 / GPT-5.4 family via the OpenAI API.",
    defaultModel: "openai/gpt-5.5",
    env: "OPENAI_API_KEY",
    keyUrl: "https://platform.openai.com/api-keys",
    featured: true,
  },
  {
    key: "openai-codex",
    registryId: "openai-codex",
    label: "ChatGPT · Codex subscription",
    blurb: "Use an eligible ChatGPT plan through the official Codex sign-in.",
    defaultModel: "openai-codex/gpt-5.3-codex",
    note: "No API key needed. Existing official Codex CLI sign-ins are detected automatically.",
    featured: true,
  },
  {
    key: "google",
    registryId: "google",
    label: "Google · Gemini",
    blurb: "Gemini 3.x Pro / Flash via the OpenAI-compatible endpoint.",
    defaultModel: "google/gemini-3.1-pro-preview",
    env: "GEMINI_API_KEY",
    keyUrl: "https://aistudio.google.com/apikey",
    featured: true,
  },
  {
    key: "zai",
    registryId: "zai",
    label: "Z.ai · GLM",
    blurb: "GLM-5.2 — flagship open coding models from Z.ai.",
    defaultModel: "zai/glm-5.2",
    env: "ZAI_API_KEY",
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    note: "coding-plan subscribers: set ZAI_BASE_URL=https://api.z.ai/api/coding/paas/v4",
    featured: true,
  },
  {
    key: "moonshot",
    registryId: "moonshot",
    label: "Moonshot · Kimi",
    blurb: "Kimi K2.7 Code — frontier agentic coding models.",
    defaultModel: "moonshot/kimi-k2.7-code",
    env: "MOONSHOT_API_KEY",
    keyUrl: "https://platform.moonshot.ai/console/api-keys",
  },
  {
    key: "alibaba",
    registryId: "alibaba",
    label: "Alibaba · Qwen",
    blurb: "Qwen 3.7 Max / Coder via Model Studio (DashScope).",
    defaultModel: "alibaba/qwen3.7-max",
    env: "DASHSCOPE_API_KEY",
    keyUrl: "https://www.alibabacloud.com/help/en/model-studio/get-api-key",
  },
  {
    key: "groq",
    registryId: "groq",
    label: "Groq · LPU",
    blurb: "GPT-OSS / Llama / Qwen at very low latency.",
    defaultModel: "groq/openai/gpt-oss-120b",
    env: "GROQ_API_KEY",
    keyUrl: "https://console.groq.com/keys",
  },
  {
    key: "mistral",
    registryId: "mistral",
    label: "Mistral",
    blurb: "Devstral 2 / Mistral Large 3 — strong European models.",
    defaultModel: "mistral/devstral-latest",
    env: "MISTRAL_API_KEY",
    keyUrl: "https://console.mistral.ai/api-keys",
  },
  {
    key: "cerebras",
    registryId: "cerebras",
    label: "Cerebras · wafer-scale",
    blurb: "GLM / GPT-OSS at the fastest token rates available.",
    defaultModel: "cerebras/zai-glm-4.7",
    env: "CEREBRAS_API_KEY",
    keyUrl: "https://cloud.cerebras.ai",
  },
  {
    key: "together",
    registryId: "together",
    label: "Together AI",
    blurb: "Hundreds of open models (GLM, Kimi, DeepSeek, Qwen, …).",
    defaultModel: "together/zai-org/GLM-5.2",
    env: "TOGETHER_API_KEY",
    keyUrl: "https://api.together.ai/settings/api-keys",
  },
  {
    key: "fireworks",
    registryId: "fireworks",
    label: "Fireworks AI",
    blurb: "Fast hosted open models (GLM, Kimi, DeepSeek, GPT-OSS…).",
    defaultModel: "fireworks/accounts/fireworks/models/glm-5p2",
    env: "FIREWORKS_API_KEY",
    keyUrl: "https://fireworks.ai/account/api-keys",
  },
  {
    key: "perplexity",
    registryId: "perplexity",
    label: "Perplexity · Sonar",
    blurb: "Sonar models with built-in web grounding.",
    defaultModel: "perplexity/sonar-pro",
    env: "PERPLEXITY_API_KEY",
    keyUrl: "https://www.perplexity.ai/settings/api",
  },
  {
    key: "minimax",
    registryId: "minimax",
    label: "MiniMax",
    blurb: "MiniMax M-series — strong agentic/coding models.",
    defaultModel: "minimax/MiniMax-M3",
    env: "MINIMAX_API_KEY",
    keyUrl: "https://www.minimax.io/platform/user-center/basic-information",
  },
  {
    key: "ollama-cloud",
    registryId: "ollama",
    label: "Ollama Cloud · subscription",
    blurb: "Run big open models on ollama.com with your subscription key.",
    defaultModel: "ollama/glm-5.2",
    env: "OLLAMA_API_KEY",
    keyUrl: "https://ollama.com/settings/keys",
    defaultBaseURL: "https://ollama.com/v1",
  },
  {
    key: "ollama-local",
    registryId: "ollama",
    label: "Ollama · local",
    blurb: "Local models served by `ollama serve` — free, no key.",
    defaultModel: "ollama/gpt-oss:20b",
    env: "OLLAMA_BASE_URL",
    defaultBaseURL: "http://localhost:11434/v1",
    localKeyless: true,
    note: "needs the Ollama app running (`ollama serve`)",
    featured: true,
  },
  {
    key: "deepseek",
    registryId: "deepseek",
    label: "DeepSeek",
    blurb: "DeepSeek V4 Pro / Flash — frontier open models, cheap.",
    defaultModel: "deepseek/deepseek-v4-pro",
    env: "DEEPSEEK_API_KEY",
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    key: "crof",
    registryId: "crof",
    label: "CrofAI",
    blurb: "One OpenAI-compatible API for GLM, Kimi, DeepSeek, Greg, and other open models.",
    defaultModel: "crof/glm-5.2",
    env: "CROF_API_KEY",
    keyUrl: "https://crof.ai/signin",
    defaultBaseURL: "https://crof.ai/v1",
    note: "The standard /v1 endpoint and live /models catalog are configured automatically.",
    featured: true,
  },
  {
    key: "xai-oauth",
    registryId: "xai-oauth",
    label: "xAI · Grok subscription",
    blurb: "Use an eligible Grok/X plan with Grok 4.5 or Grok Build.",
    defaultModel: "xai-oauth/grok-4.5",
    note: "Connect xAI once, then choose Grok 4.5 or Grok Build without an API key.",
    featured: true,
  },
  {
    key: "xai",
    registryId: "xai",
    label: "xAI API · Grok",
    blurb: "Grok 4.5 and other xAI models using an API key.",
    defaultModel: "xai/grok-4.5",
    env: "XAI_API_KEY",
    keyUrl: "https://console.x.ai",
    featured: true,
  },
  {
    key: "meta",
    registryId: "meta",
    label: "Meta · Muse Spark",
    blurb: "Muse Spark 1.1 — agentic coding via Meta Model API.",
    defaultModel: "meta/muse-spark-1.1",
    env: "MODEL_API_KEY",
    keyUrl: "https://dev.meta.ai/",
    note: "create a key in the Model API dashboard (export MODEL_API_KEY)",
  },
  {
    key: "openrouter",
    registryId: "openrouter",
    label: "OpenRouter",
    blurb: "One key, hundreds of models from every major lab.",
    defaultModel: "openrouter/anthropic/claude-sonnet-5",
    env: "OPENROUTER_API_KEY",
    keyUrl: "https://openrouter.ai/keys",
    featured: true,
  },
  {
    key: "baseten",
    registryId: "baseten",
    label: "Baseten",
    blurb: "Hosted open models (GLM, Kimi, DeepSeek, Nemotron…).",
    defaultModel: "baseten/zai-org/GLM-5.2",
    env: "BASETEN_API_KEY",
    keyUrl: "https://app.baseten.co/settings/api_keys",
  },
  {
    key: "huggingface",
    registryId: "huggingface",
    label: "Hugging Face · Inference Providers",
    blurb: "One HF token — open models auto-routed to live providers.",
    defaultModel: "huggingface/zai-org/GLM-5.2",
    env: "HF_TOKEN",
    keyUrl: "https://huggingface.co/settings/tokens",
  },
  {
    key: "lmstudio",
    registryId: "lmstudio",
    label: "LM Studio · local",
    blurb: "Local models via the LM Studio server — free, no key.",
    defaultModel: "lmstudio/openai/gpt-oss-20b",
    env: "LMSTUDIO_BASE_URL",
    localKeyless: true,
    note: "needs LM Studio's local server running",
  },
  {
    key: "nvidia",
    registryId: "nvidia",
    label: "NVIDIA · NIM",
    blurb: "Hosted open models (Llama, Qwen, Phi, Mistral…) via NVIDIA NIM.",
    defaultModel: "nvidia/nvidia/llama-3.3-nemotron-super-49b",
    env: "NVIDIA_API_KEY",
    keyUrl: "https://build.nvidia.com",
  },
  {
    key: "deepinfra",
    registryId: "deepinfra",
    label: "Deep Infra",
    blurb: "Fast, cheap hosted open models (Llama, Qwen, DeepSeek…).",
    defaultModel: "deepinfra/meta-llama/Llama-3.3-70B-Instruct",
    env: "DEEPINFRA_API_KEY",
    keyUrl: "https://deepinfra.com/dashboard/api_key",
  },
  {
    key: "venice",
    registryId: "venice",
    label: "Venice AI",
    blurb: "Uncensored and open models — private, no content logging.",
    defaultModel: "venice/llama-3.3-70b",
    env: "VENICE_API_KEY",
    keyUrl: "https://venice.ai/api-settings",
  },
  {
    key: "cohere",
    registryId: "cohere",
    label: "Cohere · Command",
    blurb: "Command A / Command R+ — strong enterprise + reasoning models.",
    defaultModel: "cohere/command-a-03-2025",
    env: "COHERE_API_KEY",
    keyUrl: "https://dashboard.cohere.com/api-keys",
  },
  {
    key: "kilo",
    registryId: "kilo",
    label: "Kilo Gateway",
    blurb: "One key, hundreds of premium models via the Kilo gateway.",
    defaultModel: "kilo/anthropic/claude-sonnet-4-5",
    env: "KILO_API_KEY",
    keyUrl: "https://kilo.ai/settings/api-keys",
  },
  {
    key: "llmgateway",
    registryId: "llmgateway",
    label: "LLM Gateway",
    blurb: "Unified multi-model gateway — one key, many providers.",
    defaultModel: "llmgateway/anthropic/claude-sonnet-4-5",
    env: "LLMGATEWAY_API_KEY",
    keyUrl: "https://llmgateway.io",
  },
  {
    key: "zenmux",
    registryId: "zenmux",
    label: "ZenMux",
    blurb: "Unified multi-model gateway — one key, many providers.",
    defaultModel: "zenmux/anthropic/claude-sonnet-4-5",
    env: "ZENMUX_API_KEY",
    keyUrl: "https://zenmux.ai",
  },
  {
    key: "snowflake",
    registryId: "snowflake-cortex",
    label: "Snowflake · Cortex",
    blurb: "Managed LLMs on Snowflake — Claude, Llama, Mistral via Cortex.",
    defaultModel: "snowflake-cortex/claude-sonnet-4-6",
    env: "SNOWFLAKE_CORTEX_TOKEN",
    keyUrl: "https://docs.snowflake.com/en/user-guide/snowflake-cortex/llm-overview",
    note: "set SNOWFLAKE_CORTEX_BASE_URL to your account's Cortex endpoint",
  },
  {
    key: "cloudflare",
    registryId: "cloudflare-workers-ai",
    label: "Cloudflare · Workers AI",
    blurb: "Serverless open models (Llama, Mistral, Qwen…) via Cloudflare.",
    defaultModel: "cloudflare-workers-ai/@cf/meta/llama-3.3-70b-instruct",
    env: "CLOUDFLARE_API_KEY",
    keyUrl: "https://dash.cloudflare.com/profile/api-tokens",
    note: "set CLOUDFLARE_BASE_URL to your account's Workers AI endpoint",
  },
  {
    key: "custom-endpoint",
    registryId: "custom",
    label: "Custom · OpenAI-compatible endpoint",
    blurb: "Point at ANY OpenAI-style API — your own base URL + key.",
    defaultModel: "",
    env: "CUSTOM_API_KEY",
    customEndpoint: true,
  },
  {
    key: "custom",
    registryId: "",
    label: "Other / advanced",
    blurb: "Type any provider/model string yourself.",
    defaultModel: "",
  },
];

const HERMES_PROVIDER_CHOICES: ProviderChoice[] = [
  { key: "hermes-nous", registryId: "nous", label: "Nous Portal", blurb: "Nous Research subscription and hosted frontier models.", defaultModel: "nous/deepseek/deepseek-v4-flash", env: "NOUS_API_KEY", keyUrl: "https://portal.nousresearch.com" },
  { key: "hermes-arcee", registryId: "arcee", label: "Arcee AI", blurb: "Trinity reasoning models through Arcee's direct API.", defaultModel: "arcee/trinity-large-thinking", env: "ARCEEAI_API_KEY", keyUrl: "https://app.arcee.ai" },
  { key: "hermes-azure-foundry", registryId: "azure-foundry", label: "Azure Foundry", blurb: "Models deployed to your Azure AI Foundry endpoint.", defaultModel: "", env: "AZURE_FOUNDRY_API_KEY", requiresBaseURL: true },
  { key: "hermes-copilot", registryId: "copilot", label: "GitHub Copilot", blurb: "Copilot models using a GitHub or Copilot token.", defaultModel: "copilot/gpt-5.4", env: "COPILOT_GITHUB_TOKEN" },
  { key: "hermes-gmi", registryId: "gmi", label: "GMI Cloud", blurb: "Hosted open and frontier models through GMI Cloud.", defaultModel: "gmi/zai-org/GLM-5.1-FP8", env: "GMI_API_KEY", keyUrl: "https://www.gmicloud.ai" },
  { key: "hermes-kilocode", registryId: "kilocode", label: "Kilo Code", blurb: "Kilo Gateway under Hermes-compatible model ids.", defaultModel: "kilocode/anthropic/claude-sonnet-4-5", env: "KILOCODE_API_KEY", keyUrl: "https://kilo.ai" },
  { key: "hermes-kimi", registryId: "kimi-coding", label: "Kimi Coding Plan", blurb: "Kimi coding models on the international endpoint.", defaultModel: "kimi-coding/kimi-k2.7-code", env: "KIMI_API_KEY", keyUrl: "https://www.kimi.com" },
  { key: "hermes-kimi-cn", registryId: "kimi-coding-cn", label: "Kimi Coding Plan · China", blurb: "Kimi coding models on Moonshot's China endpoint.", defaultModel: "kimi-coding-cn/kimi-k2.6", env: "KIMI_CN_API_KEY" },
  { key: "hermes-minimax-cn", registryId: "minimax-cn", label: "MiniMax · China", blurb: "MiniMax models through the domestic Anthropic-compatible API.", defaultModel: "minimax-cn/MiniMax-M3", env: "MINIMAX_CN_API_KEY" },
  { key: "hermes-minimax-oauth", registryId: "minimax-oauth", label: "MiniMax · OAuth token", blurb: "MiniMax Coding Plan using a reusable OAuth access token.", defaultModel: "minimax-oauth/MiniMax-M3", env: "MINIMAX_API_KEY", note: "paste a current MiniMax OAuth access token or configure a token file in Settings" },
  { key: "hermes-novita", registryId: "novita", label: "NovitaAI", blurb: "Hosted open models through Novita's OpenAI-compatible endpoint.", defaultModel: "novita/moonshotai/kimi-k2.5", env: "NOVITA_API_KEY", keyUrl: "https://novita.ai" },
  { key: "hermes-ollama-cloud", registryId: "ollama-cloud", label: "Ollama Cloud · direct", blurb: "Ollama's hosted catalog under the Hermes provider id.", defaultModel: "ollama-cloud/glm-5.2", env: "OLLAMA_API_KEY", keyUrl: "https://ollama.com/settings/keys" },
  { key: "hermes-openai-codex", registryId: "openai-codex", label: "OpenAI Codex · ChatGPT", blurb: "Sign in with ChatGPT or reuse the official Codex CLI login through the Responses backend.", defaultModel: "openai-codex/gpt-5.3-codex", env: "CODEX_API_KEY", note: "connect ChatGPT in Settings → Providers" },
  { key: "hermes-openai-api", registryId: "openai-api", label: "OpenAI API · Hermes id", blurb: "Direct OpenAI API access under Hermes-compatible model ids.", defaultModel: "openai-api/gpt-5.5", env: "OPENAI_API_KEY", keyUrl: "https://platform.openai.com/api-keys" },
  { key: "hermes-gemini", registryId: "gemini", label: "Google AI Studio · Hermes id", blurb: "Gemini models under the Hermes provider id.", defaultModel: "gemini/gemini-3.1-pro-preview", env: "GEMINI_API_KEY", keyUrl: "https://aistudio.google.com/apikey" },
  { key: "hermes-opencode-zen", registryId: "opencode-zen", label: "OpenCode Zen", blurb: "OpenCode's curated pay-as-you-go model gateway.", defaultModel: "opencode-zen/gpt-5.5", env: "OPENCODE_ZEN_API_KEY", keyUrl: "https://opencode.ai" },
  { key: "hermes-opencode-go", registryId: "opencode-go", label: "OpenCode Go", blurb: "OpenCode's subscription gateway for open coding models.", defaultModel: "opencode-go/kimi-k2.7-code", env: "OPENCODE_GO_API_KEY", keyUrl: "https://opencode.ai" },
  { key: "hermes-qwen-oauth", registryId: "qwen-oauth", label: "Qwen Portal", blurb: "Qwen Portal models using a reusable portal token.", defaultModel: "qwen-oauth/qwen3-coder-plus", env: "QWEN_API_KEY" },
  { key: "hermes-xai-oauth", registryId: "xai-oauth", label: "xAI Grok · Subscription", blurb: "Browser or device-code sign-in for eligible Grok plans, including Grok Build.", defaultModel: "xai-oauth/grok-build-0.1", env: "XAI_API_KEY", note: "connect xAI in Settings → Providers; existing Hermes tokens remain supported" },
  { key: "hermes-vertex", registryId: "vertex", label: "Google Vertex AI", blurb: "Vertex models using Google Application Default Credentials.", defaultModel: "vertex/gemini-3.1-pro-preview", localKeyless: true, note: "set project/location and Application Default Credentials in your environment" },
  { key: "hermes-bedrock", registryId: "bedrock", label: "AWS Bedrock", blurb: "Bedrock Converse models using the standard AWS credential chain.", defaultModel: "bedrock/us.anthropic.claude-sonnet-4-6", localKeyless: true, note: "uses AWS_PROFILE, IAM role, web identity, bearer token, or access-key credentials" },
];

const curatedRegistryIds = new Set(
  [...CURATED_PROVIDER_CHOICES, ...HERMES_PROVIDER_CHOICES]
    .map((choice) => choice.registryId)
    .filter(Boolean),
);

/**
 * Curated first-run choices stay first, then the complete models.dev registry
 * used by OpenCode is appended. This keeps the common path friendly without
 * making breadth depend on a hand-maintained UI list. Exact provider ids that
 * already have curated copy are deduplicated; aliases such as `fireworks` and
 * models.dev's `fireworks-ai` remain separate because both are valid engine ids.
 */
export const PROVIDER_CHOICES: ProviderChoice[] = [
  ...CURATED_PROVIDER_CHOICES,
  ...HERMES_PROVIDER_CHOICES,
  ...PROVIDER_MANIFEST
    .filter((provider) => !curatedRegistryIds.has(provider.id))
    .map((provider): ProviderChoice => {
      const needsEndpoint = provider.baseURL.length === 0;
      return {
        key: `catalog:${provider.id}`,
        registryId: provider.id,
        label: provider.name,
        blurb: needsEndpoint
          ? "Provider-specific endpoint and authentication."
          : `Models served through ${provider.name}.`,
        defaultModel: provider.defaultModel ? `${provider.id}/${provider.defaultModel}` : "",
        env: provider.env[0],
        requiresBaseURL: needsEndpoint,
        ...(needsEndpoint ? { note: "enter the endpoint URL required by this provider or deployment" } : {}),
      };
    }),
];

/**
 * Pick the menu entry to highlight first: the first choice whose key already
 * lives in the environment (so an Ollama Cloud user with `OLLAMA_API_KEY` set
 * lands on the right option), else the first choice whose provider is already
 * configured, else the first entry. Pure for testing.
 */
export function initialChoiceIndex(
  choices: ProviderChoice[],
  env: Record<string, string | undefined>,
  configuredIds?: ReadonlySet<string>,
): number {
  const detected = choices.findIndex(
    (c) =>
      !c.localKeyless &&
      ((c.env && env[c.env]) ||
        (!c.customEndpoint && c.registryId !== "" && (configuredIds?.has(c.registryId) ?? false))),
  );
  return detected >= 0 ? detected : 0;
}

/** Whether onboarding must collect a credential for the selected provider. */
export function providerChoiceNeedsApiKey(
  choice: ProviderChoice,
  configuredIds: ReadonlySet<string> = new Set(),
): boolean {
  const subscription = choice.registryId === "codex"
    || choice.registryId === "openai-codex"
    || choice.registryId === "xai-oauth";
  return !subscription
    && !choice.localKeyless
    && !choice.customEndpoint
    && choice.registryId !== ""
    && !configuredIds.has(choice.registryId);
}

/** Whether onboarding should offer a credential field, required or optional. */
export function providerChoiceAcceptsApiKey(
  choice: ProviderChoice,
  configuredIds: ReadonlySet<string> = new Set(),
): boolean {
  return choice.customEndpoint === true || providerChoiceNeedsApiKey(choice, configuredIds);
}

/** First-run setup is unnecessary when credentials exist for a remote provider
 * or a keyless/local provider has actually returned at least one live model.
 * A registry's `keyless` flag alone does not prove that Ollama/LM Studio is
 * running, so treating it as ready can strand a clean install without setup. */
/** Provider ids whose readiness comes from credentials, not merely from a
 * keyless registry definition. Shared ids such as Ollama must not make the
 * cloud onboarding choice skip its API-key field just because local Ollama is
 * keyless. */
export function configuredCredentialProviderIds(
  providers: readonly { id: string; configured: boolean; keyless: boolean }[],
): Set<string> {
  return new Set(
    providers
      .filter((provider) => provider.configured && !provider.keyless)
      .map((provider) => provider.id),
  );
}

/**
 * Build the global-config patch from onboarding answers (mirrors the CLI's
 * `buildOnboardingPatch`). Pure for testing.
 */
export function buildOnboardingPatch(answers: {
  model: string;
  providerId: string;
  apiKey?: string;
  baseURL?: string;
  transport?: "openai-compatible" | "openai-responses";
  models?: string[];
}): Record<string, unknown> {
  const patch: Record<string, unknown> = { model: answers.model };
  if (answers.providerId && (answers.apiKey || answers.baseURL || answers.transport || answers.models?.length)) {
    patch.providers = {
      [answers.providerId]: {
        ...(answers.apiKey ? { apiKey: answers.apiKey } : {}),
        ...(answers.baseURL ? { baseURL: answers.baseURL } : {}),
        ...(answers.transport ? { transport: answers.transport } : {}),
        ...(answers.models?.length ? { models: answers.models } : {}),
      },
    };
  }
  return patch;
}
