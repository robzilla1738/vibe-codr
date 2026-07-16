export interface ProviderRuntimeMetadata {
  id: string;
  env: string[];
  baseURL?: string;
  baseURLEnv?: string;
  cloudBaseURL?: string;
  externalAuth?: "aws" | "google-adc";
}

/** Fixed provider routing/auth metadata used at process-boundary handoffs.
 * models.dev-only providers continue to use provider-manifest.ts. */
export const PROVIDER_RUNTIME_METADATA: ProviderRuntimeMetadata[] = [
  { id: "anthropic", env: ["ANTHROPIC_API_KEY"], baseURL: "https://api.anthropic.com/v1" },
  { id: "openai", env: ["OPENAI_API_KEY"], baseURL: "https://api.openai.com/v1" },
  { id: "deepseek", env: ["DEEPSEEK_API_KEY"], baseURL: "https://api.deepseek.com/v1" },
  { id: "xai", env: ["XAI_API_KEY"], baseURL: "https://api.x.ai/v1", baseURLEnv: "XAI_BASE_URL" },
  { id: "meta", env: ["MODEL_API_KEY", "META_API_KEY"], baseURL: "https://api.meta.ai/v1", baseURLEnv: "META_BASE_URL" },
  { id: "minimax", env: ["MINIMAX_API_KEY"], baseURL: "https://api.minimax.io/v1", baseURLEnv: "MINIMAX_BASE_URL" },
  { id: "codex", env: ["VIBE_CODEX_OAUTH_TOKEN"], baseURL: "https://chatgpt.com/backend-api/codex", baseURLEnv: "CODEX_BASE_URL" },
  { id: "fireworks", env: ["FIREWORKS_API_KEY"], baseURL: "https://api.fireworks.ai/inference/v1" },
  { id: "baseten", env: ["BASETEN_API_KEY"], baseURL: "https://inference.baseten.co/v1" },
  { id: "openrouter", env: ["OPENROUTER_API_KEY"], baseURL: "https://openrouter.ai/api/v1" },
  { id: "google", env: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"], baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", baseURLEnv: "GOOGLE_BASE_URL" },
  { id: "zai", env: ["ZAI_API_KEY", "ZHIPU_API_KEY"], baseURL: "https://api.z.ai/api/paas/v4", baseURLEnv: "ZAI_BASE_URL" },
  { id: "moonshot", env: ["MOONSHOT_API_KEY"], baseURL: "https://api.moonshot.ai/v1", baseURLEnv: "MOONSHOT_BASE_URL" },
  { id: "alibaba", env: ["DASHSCOPE_API_KEY"], baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", baseURLEnv: "DASHSCOPE_BASE_URL" },
  { id: "huggingface", env: ["HF_TOKEN", "HUGGINGFACE_API_KEY"], baseURL: "https://router.huggingface.co/v1", baseURLEnv: "HF_BASE_URL" },
  { id: "groq", env: ["GROQ_API_KEY"], baseURL: "https://api.groq.com/openai/v1", baseURLEnv: "GROQ_BASE_URL" },
  { id: "mistral", env: ["MISTRAL_API_KEY"], baseURL: "https://api.mistral.ai/v1", baseURLEnv: "MISTRAL_BASE_URL" },
  { id: "together", env: ["TOGETHER_API_KEY"], baseURL: "https://api.together.xyz/v1", baseURLEnv: "TOGETHER_BASE_URL" },
  { id: "cerebras", env: ["CEREBRAS_API_KEY"], baseURL: "https://api.cerebras.ai/v1", baseURLEnv: "CEREBRAS_BASE_URL" },
  { id: "perplexity", env: ["PERPLEXITY_API_KEY"], baseURL: "https://api.perplexity.ai", baseURLEnv: "PERPLEXITY_BASE_URL" },
  { id: "nvidia", env: ["NVIDIA_API_KEY"], baseURL: "https://integrate.api.nvidia.com/v1", baseURLEnv: "NVIDIA_BASE_URL" },
  { id: "deepinfra", env: ["DEEPINFRA_API_KEY"], baseURL: "https://api.deepinfra.com/v1/openai", baseURLEnv: "DEEPINFRA_BASE_URL" },
  { id: "venice", env: ["VENICE_API_KEY"], baseURL: "https://api.venice.ai/api/v1", baseURLEnv: "VENICE_BASE_URL" },
  { id: "cohere", env: ["COHERE_API_KEY"], baseURL: "https://api.cohere.com/compatibility/v1", baseURLEnv: "COHERE_BASE_URL" },
  { id: "kilo", env: ["KILO_API_KEY"], baseURL: "https://api.kilo.ai/api/gateway", baseURLEnv: "KILO_BASE_URL" },
  { id: "llmgateway", env: ["LLMGATEWAY_API_KEY"], baseURL: "https://api.llmgateway.io/v1", baseURLEnv: "LLMGATEWAY_BASE_URL" },
  { id: "zenmux", env: ["ZENMUX_API_KEY"], baseURL: "https://zenmux.ai/api/v1", baseURLEnv: "ZENMUX_BASE_URL" },
  { id: "snowflake-cortex", env: ["SNOWFLAKE_CORTEX_TOKEN", "SNOWFLAKE_CORTEX_PAT"], baseURLEnv: "SNOWFLAKE_CORTEX_BASE_URL" },
  { id: "cloudflare-workers-ai", env: ["CLOUDFLARE_API_KEY"], baseURLEnv: "CLOUDFLARE_BASE_URL" },
  { id: "custom", env: ["CUSTOM_API_KEY"], baseURLEnv: "CUSTOM_BASE_URL" },
  { id: "lmstudio", env: [], baseURL: "http://localhost:1234/v1", baseURLEnv: "LMSTUDIO_BASE_URL" },
  { id: "ollama", env: ["OLLAMA_API_KEY"], baseURL: "http://localhost:11434/v1", baseURLEnv: "OLLAMA_BASE_URL", cloudBaseURL: "https://ollama.com/v1" },
  { id: "nous", env: ["NOUS_API_KEY"], baseURL: "https://inference.nousresearch.com/v1" },
  { id: "arcee", env: ["ARCEEAI_API_KEY"], baseURL: "https://api.arcee.ai/api/v1" },
  { id: "azure-foundry", env: ["AZURE_FOUNDRY_API_KEY"], baseURLEnv: "AZURE_FOUNDRY_BASE_URL" },
  { id: "copilot", env: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"], baseURL: "https://api.githubcopilot.com" },
  { id: "gmi", env: ["GMI_API_KEY", "GMICLOUD_API_KEY"], baseURL: "https://api.gmi-serving.com/v1", baseURLEnv: "GMI_BASE_URL" },
  { id: "kilocode", env: ["KILOCODE_API_KEY", "KILO_API_KEY"], baseURL: "https://api.kilo.ai/api/gateway" },
  { id: "kimi-coding", env: ["KIMI_API_KEY", "KIMI_CODING_API_KEY", "MOONSHOT_API_KEY"], baseURL: "https://api.moonshot.ai/v1", baseURLEnv: "KIMI_BASE_URL" },
  { id: "kimi-coding-cn", env: ["KIMI_CN_API_KEY", "MOONSHOT_API_KEY"], baseURL: "https://api.moonshot.cn/v1", baseURLEnv: "KIMI_CN_BASE_URL" },
  { id: "minimax-cn", env: ["MINIMAX_CN_API_KEY", "MINIMAX_API_KEY"], baseURL: "https://api.minimaxi.com/anthropic/v1", baseURLEnv: "MINIMAX_CN_BASE_URL" },
  { id: "minimax-oauth", env: ["MINIMAX_API_KEY"], baseURL: "https://api.minimax.io/anthropic/v1" },
  { id: "novita", env: ["NOVITA_API_KEY"], baseURL: "https://api.novita.ai/openai/v1", baseURLEnv: "NOVITA_BASE_URL" },
  { id: "ollama-cloud", env: ["OLLAMA_API_KEY"], baseURL: "https://ollama.com/v1" },
  { id: "openai-codex", env: ["VIBE_CODEX_OAUTH_TOKEN"], baseURL: "https://chatgpt.com/backend-api/codex", baseURLEnv: "CODEX_BASE_URL" },
  { id: "openai-api", env: ["OPENAI_API_KEY"], baseURL: "https://api.openai.com/v1", baseURLEnv: "OPENAI_BASE_URL" },
  { id: "gemini", env: ["GOOGLE_API_KEY", "GEMINI_API_KEY"], baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", baseURLEnv: "GOOGLE_BASE_URL" },
  { id: "opencode-zen", env: ["OPENCODE_ZEN_API_KEY", "OPENCODE_API_KEY"], baseURL: "https://opencode.ai/zen/v1" },
  { id: "opencode-go", env: ["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"], baseURL: "https://opencode.ai/zen/go/v1" },
  { id: "qwen-oauth", env: ["QWEN_API_KEY"], baseURL: "https://portal.qwen.ai/v1" },
  { id: "xai-oauth", env: ["XAI_API_KEY"], baseURL: "https://api.x.ai/v1" },
  { id: "amazon-bedrock", env: [], externalAuth: "aws" },
  { id: "bedrock", env: [], externalAuth: "aws" },
  { id: "google-vertex", env: [], externalAuth: "google-adc" },
  { id: "google-vertex-anthropic", env: [], externalAuth: "google-adc" },
  { id: "vertex", env: [], externalAuth: "google-adc" },
];
