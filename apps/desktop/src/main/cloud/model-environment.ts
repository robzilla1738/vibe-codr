import type { ProviderConfig, VibeConfig } from "../../shared/config-schema";
import { PROVIDER_MANIFEST } from "../../shared/provider-manifest";
import { PROVIDER_RUNTIME_METADATA, type ProviderRuntimeMetadata } from "../../shared/provider-runtime-metadata";
import { PROVIDER_CHOICES } from "../../shared/providers-catalog";
import { isNonPublicIpAddress } from "./domain-validation";

const BASE_URL_ENV: Record<string, string> = {
  xai: "XAI_BASE_URL",
  meta: "META_BASE_URL",
  minimax: "MINIMAX_BASE_URL",
  codex: "CODEX_BASE_URL",
  google: "GOOGLE_BASE_URL",
  zai: "ZAI_BASE_URL",
  moonshot: "MOONSHOT_BASE_URL",
  alibaba: "DASHSCOPE_BASE_URL",
  huggingface: "HF_BASE_URL",
  groq: "GROQ_BASE_URL",
  mistral: "MISTRAL_BASE_URL",
  together: "TOGETHER_BASE_URL",
  cerebras: "CEREBRAS_BASE_URL",
  perplexity: "PERPLEXITY_BASE_URL",
  nvidia: "NVIDIA_BASE_URL",
  deepinfra: "DEEPINFRA_BASE_URL",
  venice: "VENICE_BASE_URL",
  cohere: "COHERE_BASE_URL",
  kilo: "KILO_BASE_URL",
  llmgateway: "LLMGATEWAY_BASE_URL",
  zenmux: "ZENMUX_BASE_URL",
  "snowflake-cortex": "SNOWFLAKE_CORTEX_BASE_URL",
  "cloudflare-workers-ai": "CLOUDFLARE_BASE_URL",
  custom: "CUSTOM_BASE_URL",
  lmstudio: "LMSTUDIO_BASE_URL",
  ollama: "OLLAMA_BASE_URL",
  "azure-foundry": "AZURE_FOUNDRY_BASE_URL",
  gmi: "GMI_BASE_URL",
  "kimi-coding": "KIMI_BASE_URL",
  "kimi-coding-cn": "KIMI_CN_BASE_URL",
  "minimax-cn": "MINIMAX_CN_BASE_URL",
  novita: "NOVITA_BASE_URL",
  "openai-codex": "CODEX_BASE_URL",
  "openai-api": "OPENAI_BASE_URL",
  gemini: "GOOGLE_BASE_URL",
};

export type SubscriptionAuthProviderId = "openai-codex" | "xai-oauth";

export function subscriptionAuthProviderForModelProvider(
  providerId: string,
): SubscriptionAuthProviderId | null {
  if (providerId === "codex" || providerId === "openai-codex") return "openai-codex";
  if (providerId === "xai-oauth") return "xai-oauth";
  return null;
}

export function subscriptionCredentialEnvironment(
  providerId: SubscriptionAuthProviderId,
  credential: { access: string; accountId?: string },
): Record<string, string> {
  if (providerId === "xai-oauth") return { XAI_API_KEY: credential.access };
  return {
    VIBE_CODEX_OAUTH_TOKEN: credential.access,
    ...(credential.accountId ? { CODEX_ACCOUNT_ID: credential.accountId } : {}),
  };
}

/** Select only provider-scoped values that the local engine could already use.
 * The Cloud manager never copies the ambient process environment wholesale. */
export function ambientCloudModelEnvironment(
  models: readonly string[],
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const providerId of new Set(models.map((model) => model.split("/", 1)[0]?.trim()).filter(Boolean))) {
    const runtime = PROVIDER_RUNTIME_METADATA.find((item) => item.id === providerId);
    const manifest = PROVIDER_MANIFEST.find((item) => item.id === providerId);
    const names = new Set([
      ...(runtime?.env ?? []),
      ...(manifest?.env ?? []),
      ...PROVIDER_CHOICES.filter((choice) => choice.registryId === providerId && choice.env).map((choice) => choice.env!),
      ...(runtime?.baseURLEnv ? [runtime.baseURLEnv] : []),
      ...(BASE_URL_ENV[providerId] ? [BASE_URL_ENV[providerId]!] : []),
    ]);
    if (providerId === "amazon-bedrock" || providerId === "bedrock") {
      for (const name of [
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_REGION",
        "AWS_DEFAULT_REGION",
      ]) names.add(name);
    }
    if (providerId === "xai-oauth") names.add("XAI_BASE_URL");
    for (const name of names) {
      const value = source[name]?.trim();
      if (value) environment[name] = value;
    }
    if (providerId === "xai-oauth") {
      // An ambient XAI_API_KEY has no provenance: it may belong to a custom
      // standard-xAI endpoint. Never retarget it to the official subscription
      // route. The manager adds an exported Grok token afterward, while an
      // official Settings key is admitted separately by compatibleXaiApiKey.
      delete environment.XAI_API_KEY;
      delete environment.XAI_BASE_URL;
    }
  }
  return environment;
}

export function cloudModelEnvironment(
  model: string,
  globalConfig: VibeConfig | undefined,
  projectConfig: VibeConfig | undefined,
  boundEnvironment: Record<string, string>,
  options: { includeConfiguredCredentials?: boolean } = {},
): Record<string, string> {
  const providerId = model.split("/", 1)[0]?.trim();
  if (!providerId) throw new Error("Cloud handoff requires a provider-qualified model");
  const configuredProvider = configuredProviderForCloud(providerId, globalConfig, projectConfig, boundEnvironment);
  const providerConfig: ProviderConfig = options.includeConfiguredCredentials === false
    ? {}
    : configuredProvider;
  const runtime = PROVIDER_RUNTIME_METADATA.find((item) => item.id === providerId);
  const manifest = PROVIDER_MANIFEST.find((item) => item.id === providerId);
  const explicitArbitraryBaseUrl = boundEnvironment[configProviderEnvironmentName(providerId, "BASE_URL")];
  const isArbitraryProvider = !runtime && !manifest && Boolean(providerConfig.baseURL || explicitArbitraryBaseUrl);
  const authEnvironment = runtime?.env ?? (isArbitraryProvider
    ? [configProviderEnvironmentName(providerId, "API_KEY")]
    : [...new Set([
    ...PROVIDER_CHOICES.filter((choice) => choice.registryId === providerId && !choice.localKeyless && choice.env).map((choice) => choice.env!),
    ...(manifest?.env ?? []),
  ])]);
  const usesLocalCredentialChain = PROVIDER_CHOICES.some((choice) =>
    choice.registryId === providerId && choice.localKeyless,
  );
  const baseUrlEnvironment = runtime?.baseURLEnv ?? BASE_URL_ENV[providerId]
    ?? (isArbitraryProvider ? configProviderEnvironmentName(providerId, "BASE_URL") : undefined);
  const environment = { ...boundEnvironment };
  const hasIncompatibleXaiRoute = providerId === "xai-oauth"
    && Boolean(boundEnvironment.XAI_BASE_URL)
    && !isOfficialXaiBaseUrl(boundEnvironment.XAI_BASE_URL!);
  if (providerId === "xai-oauth") delete environment.XAI_BASE_URL;
  if (hasIncompatibleXaiRoute) delete environment.XAI_API_KEY;
  for (const name of authEnvironment) delete environment[name];
  const selectedAuthEnvironment = providerId === "amazon-bedrock"
    ? boundEnvironment.AWS_BEARER_TOKEN_BEDROCK
      ? ["AWS_BEARER_TOKEN_BEDROCK"]
      : boundEnvironment.AWS_ACCESS_KEY_ID && boundEnvironment.AWS_SECRET_ACCESS_KEY
        ? ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]
        : []
    : [authEnvironment.find((name) => Boolean(boundEnvironment[name]) && !(hasIncompatibleXaiRoute && name === "XAI_API_KEY"))]
      .filter((name): name is string => Boolean(name));
  for (const name of selectedAuthEnvironment) environment[name] = boundEnvironment[name];
  if (baseUrlEnvironment && boundEnvironment[baseUrlEnvironment]) {
    environment[baseUrlEnvironment] = boundEnvironment[baseUrlEnvironment];
  }
  const hasTransferableCredential = Boolean(providerConfig.apiKey)
    || authEnvironment.some((name) => Boolean(environment[name]));

  if ((providerConfig.tokenFile || providerConfig.tokenPath) && !hasTransferableCredential) {
    throw new Error(`Cloud handoff cannot use the local token file configured for ${providerId}. Add a session credential binding in Settings → Cloud.`);
  }
  if (usesLocalCredentialChain && providerId !== "ollama" && providerId !== "lmstudio") {
    throw new Error(`${providerId} uses a credential chain from this Mac that cannot be transferred safely. Choose an API-key provider before handing off.`);
  }
  if (providerConfig.headers && Object.keys(providerConfig.headers).length > 0) {
    environment[configProviderEnvironmentName(providerId, "HEADERS_JSON")] = JSON.stringify(providerConfig.headers);
  }
  if (providerConfig.apiKey && !authEnvironment.some((name) => environment[name])) {
    const name = authEnvironment[0];
    if (!name) throw new Error(`Cloud handoff does not know the credential variable for ${providerId}`);
    environment[name] = providerConfig.apiKey;
  }
  if (providerConfig.baseURL) {
    const name = baseUrlEnvironment;
    if (!name) {
      throw new Error(`Cloud handoff cannot preserve the custom ${providerId} endpoint yet. Add its base URL as a session credential binding in Settings → Cloud.`);
    }
    environment[name] = providerConfig.baseURL;
  }
  if (isArbitraryProvider && providerConfig.transport) {
    environment[configProviderEnvironmentName(providerId, "TRANSPORT")] = providerConfig.transport;
  }

  const hasProviderCredential = authEnvironment.some((name) => Boolean(environment[name]));
  // Pin dual local/cloud providers to the reviewed cloud route. The engine can
  // infer this for Ollama from its API key, but carrying the endpoint makes the
  // transferred route explicit and prevents an imported local default or a
  // launcher environment boundary from sending Cloud traffic to localhost.
  if (baseUrlEnvironment && !environment[baseUrlEnvironment] && hasProviderCredential && runtime?.cloudBaseURL) {
    environment[baseUrlEnvironment] = runtime.cloudBaseURL;
  }
  if (providerId === "lmstudio") {
    throw new Error("LM Studio runs only on this Mac. Choose a cloud-accessible model before handing off.");
  }
  const route = effectiveRoute(providerId, providerConfig, runtime, manifest?.baseURL, environment);
  if (route) {
    let parsed: URL;
    try { parsed = new URL(route); }
    catch { throw new Error(`${providerId} has an invalid provider endpoint. Configure a valid HTTPS URL before handing off.`); }
    if (isLocalNetworkUrl(parsed)) {
      throw new Error(`${providerId} points to ${parsed.hostname}, which the Cloud sandbox cannot reach. Choose a cloud-accessible provider endpoint before handing off.`);
    }
    if (parsed.protocol !== "https:") {
      throw new Error(`${providerId} must use an HTTPS provider endpoint before model credentials can move to Cloud.`);
    }
  }
  if (providerId === "ollama" && !hasProviderCredential) {
    throw new Error("This session uses Ollama on this Mac. Choose Ollama Cloud with an API key or another cloud-accessible model before handing off.");
  }
  if (authEnvironment.length > 0 && !hasProviderCredential && !isArbitraryProvider) {
    throw new Error(`Cloud handoff needs a ${providerId} model credential. Configure the provider key or add a session credential binding in Settings → Cloud.`);
  }
  return environment;
}

export function cloudModelRouteHostname(
  model: string,
  globalConfig: VibeConfig | undefined,
  projectConfig: VibeConfig | undefined,
  environment: Record<string, string>,
  options: { includeConfiguredCredentials?: boolean } = {},
): string | undefined {
  const providerId = model.split("/", 1)[0]?.trim();
  if (!providerId) return undefined;
  const providerConfig = options.includeConfiguredCredentials === false
    ? {}
    : configuredProviderForCloud(providerId, globalConfig, projectConfig, environment);
  const runtime = PROVIDER_RUNTIME_METADATA.find((item) => item.id === providerId);
  const manifest = PROVIDER_MANIFEST.find((item) => item.id === providerId);
  const explicitArbitraryBaseUrl = !runtime && !manifest
    ? environment[configProviderEnvironmentName(providerId, "BASE_URL")]
    : undefined;
  const routeProviderConfig = explicitArbitraryBaseUrl
    ? { ...providerConfig, baseURL: explicitArbitraryBaseUrl }
    : providerConfig;
  const route = effectiveRoute(
    providerId,
    routeProviderConfig,
    runtime,
    manifest?.baseURL,
    environment,
  );
  return route ? new URL(route).hostname : undefined;
}

function configuredProviderForCloud(
  providerId: string,
  globalConfig: VibeConfig | undefined,
  projectConfig: VibeConfig | undefined,
  environment: Record<string, string> = {},
): ProviderConfig {
  const trustProjectConfig = globalConfig?.security?.trustProjectConfig === true;
  const compatibleProviderConfig = providerId === "xai-oauth"
    ? {
        apiKey: compatibleXaiApiKey(globalConfig, projectConfig, environment),
      }
    : {};
  if (providerId === "xai-oauth") return compatibleProviderConfig;
  return {
    ...compatibleProviderConfig,
    ...(globalConfig?.providers?.[providerId] ?? {}),
    ...(trustProjectConfig ? projectConfig?.providers?.[providerId] ?? {} : {}),
  };
}

function compatibleXaiApiKey(
  globalConfig: VibeConfig | undefined,
  projectConfig: VibeConfig | undefined,
  environment: Record<string, string>,
): string | undefined {
  const trustProjectConfig = globalConfig?.security?.trustProjectConfig === true;
  const config: ProviderConfig = {
    ...(globalConfig?.providers?.xai ?? {}),
    ...(trustProjectConfig ? projectConfig?.providers?.xai ?? {} : {}),
  };
  if (!config.apiKey) return undefined;
  const route = config.baseURL ?? environment.XAI_BASE_URL;
  if (!route) return config.apiKey;
  try {
    return new URL(route).hostname.toLowerCase() === "api.x.ai" ? config.apiKey : undefined;
  } catch {
    return undefined;
  }
}

function isOfficialXaiBaseUrl(route: string): boolean {
  try {
    return new URL(route).hostname.toLowerCase() === "api.x.ai";
  } catch {
    return false;
  }
}

function effectiveRoute(
  providerId: string,
  providerConfig: ProviderConfig,
  runtime: ProviderRuntimeMetadata | undefined,
  manifestRoute: string | undefined,
  environment: Record<string, string>,
): string | undefined {
  const baseUrlEnvironment = runtime?.baseURLEnv ?? BASE_URL_ENV[providerId]
    ?? (providerConfig.baseURL ? configProviderEnvironmentName(providerId, "BASE_URL") : undefined);
  const hasRuntimeCredential = runtime?.env.some((name) => Boolean(environment[name])) ?? false;
  return (baseUrlEnvironment ? environment[baseUrlEnvironment] : undefined)
    || providerConfig.baseURL
    || (hasRuntimeCredential ? runtime?.cloudBaseURL : undefined)
    || runtime?.baseURL
    || manifestRoute
    || undefined;
}

function configProviderEnvironmentName(
  id: string,
  suffix: "API_KEY" | "BASE_URL" | "TRANSPORT" | "HEADERS_JSON",
): string {
  const normalized = id.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "CUSTOM";
  return `VIBE_PROVIDER_${normalized}_${suffix}`;
}

export function configuredCloudModels(
  globalConfig: VibeConfig | undefined,
  projectConfig: VibeConfig | undefined,
): string[] {
  const main = projectConfig?.model ?? globalConfig?.model;
  const plan = projectConfig?.planModel ?? globalConfig?.planModel;
  const subagent = projectConfig?.subagent?.model ?? globalConfig?.subagent?.model;
  const vision = projectConfig?.vision?.relay?.relayModel ?? globalConfig?.vision?.relay?.relayModel;
  const cheap = projectConfig?.build?.models?.cheap ?? globalConfig?.build?.models?.cheap;
  const strong = projectConfig?.build?.models?.strong ?? globalConfig?.build?.models?.strong;
  return [...new Set([main, plan, subagent, vision, cheap, strong].filter((model): model is string => Boolean(model)))];
}

export function configuredCloudFallbackModels(
  globalConfig: VibeConfig | undefined,
  projectConfig: VibeConfig | undefined,
): string[] {
  const semanticEnabled = projectConfig?.memory?.semantic?.enabled
    ?? globalConfig?.memory?.semantic?.enabled
    ?? false;
  const semanticModel = projectConfig?.memory?.semantic?.model
    ?? globalConfig?.memory?.semantic?.model;
  return [...new Set([
    ...(projectConfig?.modelFallbacks ?? globalConfig?.modelFallbacks ?? []),
    ...(semanticEnabled && semanticModel ? [semanticModel] : []),
  ])];
}

function isLocalNetworkUrl(value: URL): boolean {
  const hostname = value.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIPLiteral(hostname)) return isNonPublicIpAddress(hostname);
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname === "::1") return true;
  if (/^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^169\.254\./.test(hostname)) return true;
  const private172 = hostname.match(/^172\.(\d{1,3})\./);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return true;
  return false;
}

function isIPLiteral(hostname: string): boolean {
  return hostname.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}
