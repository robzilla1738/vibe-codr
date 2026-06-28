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
  /**
   * Force a key prompt even though the provider is keyless in the registry —
   * used for hosted tiers of an otherwise-local provider (Ollama Cloud).
   */
  cloud?: boolean;
  /** Local provider that needs no key at all (skip the key prompt entirely). */
  localKeyless?: boolean;
  /** Extra setup note (e.g. "needs `ollama serve`"). */
  note?: string;
}

export const PROVIDER_CHOICES: ProviderChoice[] = [
  {
    key: "anthropic",
    registryId: "anthropic",
    label: "Anthropic · Claude",
    blurb: "Claude Opus / Sonnet / Haiku — top-tier coding models.",
    defaultModel: "anthropic/claude-opus-4-8",
    env: "ANTHROPIC_API_KEY",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    key: "openai",
    registryId: "openai",
    label: "OpenAI · GPT",
    blurb: "GPT family via the OpenAI API.",
    defaultModel: "openai/gpt-4o",
    env: "OPENAI_API_KEY",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    key: "ollama-cloud",
    registryId: "ollama",
    label: "Ollama Cloud · subscription",
    blurb: "Run big open models on ollama.com with your subscription key.",
    // The OpenAI-compatible endpoint lists plain ids (no `:cloud` suffix); the
    // live picker shows the real catalog, so this is just the preselect.
    defaultModel: "ollama/gpt-oss:120b",
    env: "OLLAMA_API_KEY",
    keyUrl: "https://ollama.com/settings/keys",
    cloud: true,
  },
  {
    key: "ollama-local",
    registryId: "ollama",
    label: "Ollama · local",
    blurb: "Local models served by `ollama serve` — free, no key.",
    defaultModel: "ollama/llama3.1",
    env: "OLLAMA_BASE_URL",
    localKeyless: true,
    note: "needs the Ollama app running (`ollama serve`)",
  },
  {
    key: "deepseek",
    registryId: "deepseek",
    label: "DeepSeek",
    blurb: "deepseek-chat / deepseek-reasoner — strong + cheap.",
    defaultModel: "deepseek/deepseek-chat",
    env: "DEEPSEEK_API_KEY",
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    key: "xai",
    registryId: "xai",
    label: "xAI · Grok",
    blurb: "Grok models from console.x.ai.",
    defaultModel: "xai/grok-4",
    env: "XAI_API_KEY",
    keyUrl: "https://console.x.ai",
  },
  {
    key: "openrouter",
    registryId: "openrouter",
    label: "OpenRouter",
    blurb: "One key, hundreds of models from every major lab.",
    defaultModel: "openrouter/anthropic/claude-sonnet-4",
    env: "OPENROUTER_API_KEY",
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    key: "baseten",
    registryId: "baseten",
    label: "Baseten",
    blurb: "Hosted open models (DeepSeek, Kimi, GLM, Nemotron…).",
    defaultModel: "baseten/deepseek-ai/DeepSeek-V4-Pro",
    env: "BASETEN_API_KEY",
    keyUrl: "https://app.baseten.co/settings/api_keys",
  },
  {
    key: "lmstudio",
    registryId: "lmstudio",
    label: "LM Studio · local",
    blurb: "Local models via the LM Studio server — free, no key.",
    defaultModel: "lmstudio/local-model",
    env: "LMSTUDIO_BASE_URL",
    localKeyless: true,
    note: "needs LM Studio's local server running",
  },
  {
    key: "custom",
    registryId: "",
    label: "Other / custom",
    blurb: "Enter any provider/model string yourself.",
    defaultModel: "",
  },
];

/**
 * Pick the menu entry to highlight first: the first choice whose key already
 * lives in the environment (so an Ollama Cloud user with `OLLAMA_API_KEY` set
 * lands on the right option), else the first entry. Pure for testing.
 */
export function initialChoiceIndex(
  choices: ProviderChoice[],
  env: NodeJS.ProcessEnv,
): number {
  const detected = choices.findIndex(
    (c) => !c.localKeyless && c.env && env[c.env],
  );
  return detected >= 0 ? detected : 0;
}
