import type { LanguageModel } from "ai";
import { ProviderAuthError } from "@vibe/shared";
import type { ProviderDef, ProviderCreateOptions, ModelInfo } from "./types.ts";
import { listOpenAICompatibleModels } from "./openai-compat.ts";

/**
 * Dynamically import a provider SDK package. The packages are optional peer
 * deps so a user only installs the providers they use; the import failure
 * surfaces a clear, actionable error at call time rather than at startup.
 */
async function loadProviderModule(spec: string): Promise<any> {
  try {
    return await import(spec);
  } catch (err) {
    throw new ProviderAuthError(
      spec,
      [`install ${spec} (${(err as Error).message})`],
    );
  }
}

interface BuiltinSpec {
  id: string;
  env: string[];
  baseURL: string;
  baseURLEnv?: string;
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
    id: "xai",
    env: ["XAI_API_KEY"],
    baseURL: "https://api.x.ai/v1",
    baseURLEnv: "XAI_BASE_URL",
    module: "@ai-sdk/xai",
    factory: "createXai",
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
    id: "fireworks",
    env: ["FIREWORKS_API_KEY"],
    baseURL: "https://api.fireworks.ai/inference/v1",
    module: "@ai-sdk/fireworks",
    factory: "createFireworks",
  },
  {
    id: "baseten",
    env: ["BASETEN_API_KEY"],
    baseURL: "https://inference.baseten.co/v1",
    module: "@ai-sdk/baseten",
    factory: "createBaseten",
  },
  {
    id: "openrouter",
    env: ["OPENROUTER_API_KEY"],
    baseURL: "https://openrouter.ai/api/v1",
    module: "@openrouter/ai-sdk-provider",
    factory: "createOpenRouter",
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

function buildDef(spec: BuiltinSpec): ProviderDef {
  const baseURL = (opts: ProviderCreateOptions) =>
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
      keyless: spec.keyless,
      tokenFile: spec.tokenFile,
      tokenPath: spec.tokenPath,
    },

    async create(modelId, opts): Promise<LanguageModel> {
      const mod = await loadProviderModule(spec.module!);
      const factory = mod[spec.factory!];
      if (typeof factory !== "function") {
        throw new ProviderAuthError(spec.id, [
          `${spec.module} has no export "${spec.factory}"`,
        ]);
      }
      // openai-compatible needs a `name`; others ignore extra fields.
      const provider = factory({
        name: spec.id,
        apiKey: opts.apiKey ?? "not-needed",
        baseURL: baseURL(opts),
        ...(opts.headers ? { headers: opts.headers } : {}),
      });
      // Provider instances are callable: provider(modelId) -> LanguageModel.
      return provider(modelId) as LanguageModel;
    },

    async listModels(opts): Promise<ModelInfo[]> {
      return listOpenAICompatibleModels(spec.id, baseURL(opts), opts.apiKey);
    },
  };
}

/** The full set of built-in provider definitions. */
export function builtinProviders(): ProviderDef[] {
  return BUILTINS.map(buildDef);
}
