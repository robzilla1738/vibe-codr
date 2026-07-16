/** First-run setup is unnecessary when credentials exist for a remote provider
 * or a keyless/local provider has actually returned at least one live model. */
export function hasUsableOnboardingProvider(
  providers: readonly { configured: boolean; keyless: boolean }[],
  models: readonly unknown[],
): boolean {
  return models.length > 0 || providers.some((provider) => provider.configured && !provider.keyless);
}
