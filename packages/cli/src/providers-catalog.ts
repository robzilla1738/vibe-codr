/**
 * Curated provider choices for first-run onboarding. Kept separate from the
 * runtime `ProviderRegistry` (which only knows auth/endpoints) so the menu can
 * carry human-facing copy — labels, blurbs, where to get a key, and a sensible
 * default model — without leaking presentation into the engine.
 *
 * `registryId` maps a choice back to a real provider. Note that "Ollama Cloud"
 * and "Ollama (local)" are two choices that share the `ollama` registry id: the
 * provider is keyless for local use but auto-targets ollama.com when a key is
 * present, so onboarding treats the cloud option as key-required.
 */
export interface ProviderChoice {
  /** Stable choice id (unique within the menu). */
  key: string;
  /** Provider id understood by the registry. */
  registryId: string;
  /** Menu label. */
  label: string;
  /** One-line description shown under the label. */
  blurb: string;
  /** Recommended/default model string, used as a fallback and as the preselect. */
  defaultModel: string;
  /** Primary env var that supplies the key (for detection + prompts). */
  env?: string;
  /** Where to get a key. */
  keyUrl?: string;
  /** Local provider that needs no key at all (skip the key prompt entirely). */
  localKeyless?: boolean;
  /** Generic bring-your-own OpenAI-compatible endpoint — prompts for a base URL. */
  customEndpoint?: boolean;
  /** Extra setup note (e.g. "needs `ollama serve`"). */
  note?: string;
}

export const PROVIDER_CHOICES: ProviderChoice[] = [
  {
    key: "anthropic",
    registryId: "anthropic",
    label: "Anthropic · Claude",
    blurb: "Claude Fable / Opus / Sonnet — top-tier coding models.",
    defaultModel: "anthropic/claude-opus-4-8",
    env: "ANTHROPIC_API_KEY",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    key: "openai",
    registryId: "openai",
    label: "OpenAI · GPT",
    blurb: "GPT-5.5 / GPT-5.4 family via the OpenAI API.",
    defaultModel: "openai/gpt-5.5",
    env: "OPENAI_API_KEY",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    key: "codex",
    registryId: "codex",
    label: "OpenAI · Codex (ChatGPT login)",
    blurb: "Reuse your `codex login` session (~/.codex/auth.json) — no API key.",
    defaultModel: "codex/gpt-5.3-codex",
    env: "CODEX_API_KEY",
    keyUrl: "https://github.com/openai/codex",
    note: "run `codex login` once with the official Codex CLI",
  },
  {
    key: "google",
    registryId: "google",
    label: "Google · Gemini",
    blurb: "Gemini 3.x Pro / Flash via the OpenAI-compatible endpoint.",
    defaultModel: "google/gemini-3.1-pro-preview",
    env: "GEMINI_API_KEY",
    keyUrl: "https://aistudio.google.com/apikey",
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
    // The OpenAI-compatible endpoint lists plain ids (no `:cloud` suffix); the
    // live picker shows the real catalog, so this is just the preselect.
    defaultModel: "ollama/glm-5.2",
    env: "OLLAMA_API_KEY",
    keyUrl: "https://ollama.com/settings/keys",
  },
  {
    key: "ollama-local",
    registryId: "ollama",
    label: "Ollama · local",
    blurb: "Local models served by `ollama serve` — free, no key.",
    defaultModel: "ollama/gpt-oss:20b",
    env: "OLLAMA_BASE_URL",
    localKeyless: true,
    note: "needs the Ollama app running (`ollama serve`)",
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
    key: "xai",
    registryId: "xai",
    label: "xAI · Grok",
    blurb: "Grok models from console.x.ai.",
    defaultModel: "xai/grok-4.3",
    env: "XAI_API_KEY",
    keyUrl: "https://console.x.ai",
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

/**
 * Pick the menu entry to highlight first: the first choice whose key already
 * lives in the environment (so an Ollama Cloud user with `OLLAMA_API_KEY` set
 * lands on the right option), else the first choice whose provider is already
 * configured another way (a saved config key, or codex's `~/.codex/auth.json`
 * — pass only non-keyless configured ids), else the first entry. Pure for
 * testing.
 */
export function initialChoiceIndex(
  choices: ProviderChoice[],
  env: NodeJS.ProcessEnv,
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
