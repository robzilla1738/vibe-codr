import type {
  SubscriptionAuthMethod,
  SubscriptionProviderId,
} from "./provider-auth";

export interface SubscriptionProviderSetup {
  id: SubscriptionProviderId;
  title: string;
  description: string;
  model: string;
  authMethod: SubscriptionAuthMethod;
  models: Array<{ id: string; label: string; description: string }>;
}

export const SUBSCRIPTION_PROVIDERS: SubscriptionProviderSetup[] = [
  {
    id: "openai-codex",
    title: "ChatGPT · Codex",
    description: "Use your eligible ChatGPT plan. This is separate from an OpenAI API key.",
    model: "openai-codex/gpt-5.3-codex",
    authMethod: "browser",
    models: [
      {
        id: "openai-codex/gpt-5.3-codex",
        label: "Codex 5.3",
        description: "Recommended for coding tasks",
      },
    ],
  },
  {
    id: "xai-oauth",
    title: "xAI · Grok",
    description: "Use your eligible Grok/X subscription without creating an API key.",
    model: "xai-oauth/grok-4.5",
    authMethod: "device",
    models: [
      {
        id: "xai-oauth/grok-4.5",
        label: "Grok 4.5",
        description: "Recommended · code and general work",
      },
      {
        id: "xai-oauth/grok-build-0.1",
        label: "Grok Build",
        description: "Coding-focused Grok agent model",
      },
    ],
  },
];

export function subscriptionProviderForRegistryId(
  providerId: string,
): SubscriptionProviderSetup | null {
  if (providerId === "codex" || providerId === "openai-codex") {
    return SUBSCRIPTION_PROVIDERS[0]!;
  }
  if (providerId === "xai-oauth") return SUBSCRIPTION_PROVIDERS[1]!;
  return null;
}
