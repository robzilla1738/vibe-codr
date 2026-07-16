/**
 * First-run provider setup wizard — the GUI equivalent of the CLI's
 * `vibecodr setup`. Shows the curated provider catalog, collects an API key
 * (or skips for keyless/local providers), and saves the config patch so the
 * engine can use the provider on the next bootstrap.
 *
 * Replaces the passive OnboardingHint strip with an actionable modal that
 * mirrors the CLI's onboarding choices, key URLs, and default models.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildOnboardingPatch,
  configuredCredentialProviderIds,
  initialChoiceIndex,
  PROVIDER_CHOICES,
  type ProviderChoice,
  providerChoiceAcceptsApiKey,
  providerChoiceDefaultBaseURL,
  providerChoiceNeedsApiKey,
} from "../../shared/providers-catalog";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { IconClose, IconExternalLink } from "../icons";
import { SubscriptionAuthCard } from "../providers/SubscriptionAuthCard";
import type { SubscriptionAuthStatus, SubscriptionProviderId } from "../../shared/provider-auth";
import { subscriptionProviderForRegistryId } from "../../shared/subscription-providers";

export interface ProviderStatus {
  id: string;
  configured: boolean;
  keyless: boolean;
  env: string[];
}

export function OnboardingModal({
  providers,
  onSave,
  onDismiss,
  saving,
  saveError,
  initialProviderId,
  focusedSetup = false,
}: {
  /** Live provider status from the engine's listProviders RPC (may be empty
   * before the first bootstrap completes). */
  providers?: ProviderStatus[];
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  onDismiss: () => void;
  saving?: boolean;
  saveError?: string | null;
  /** Opens a provider selected from `/providers` directly on its setup form. */
  initialProviderId?: string;
  /** Uses action-oriented copy when opened from the model/provider menus. */
  focusedSetup?: boolean;
}) {
  const configuredIds = useMemo(
    () => configuredCredentialProviderIds(providers ?? []),
    [providers],
  );

  const initialIdx = useMemo(() => {
    const requestedId = initialProviderId === "codex" ? "openai-codex" : initialProviderId;
    const requested = requestedId
      ? PROVIDER_CHOICES.findIndex((choice) => choice.registryId === requestedId)
      : -1;
    return requested >= 0
      ? requested
      : initialChoiceIndex(PROVIDER_CHOICES, {}, configuredIds);
  }, [configuredIds, initialProviderId]);

  const [selectedIdx, setSelectedIdx] = useState(initialIdx);
  const [providerView, setProviderView] = useState<"recommended" | "local" | "all">(
    PROVIDER_CHOICES[initialIdx]?.featured
      ? "recommended"
      : PROVIDER_CHOICES[initialIdx]?.localKeyless
        ? "local"
        : "all",
  );
  const [providerQuery, setProviderQuery] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [customProviderId, setCustomProviderId] = useState("");
  const [model, setModel] = useState(PROVIDER_CHOICES[initialIdx]?.defaultModel ?? "");
  const [transport, setTransport] = useState<"openai-compatible" | "openai-responses">("openai-compatible");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [connectedSubscriptionId, setConnectedSubscriptionId] = useState<SubscriptionProviderId | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(true, dialogRef, onDismiss);

  const choice: ProviderChoice = PROVIDER_CHOICES[selectedIdx] ?? PROVIDER_CHOICES[0]!;
  const subscriptionProvider = subscriptionProviderForRegistryId(choice.registryId);
  const visibleChoices = useMemo(() => {
    const query = providerQuery.trim().toLocaleLowerCase();
    return PROVIDER_CHOICES
      .map((provider, index) => ({ provider, index }))
      .filter(({ provider }) => {
        if (query) {
          return `${provider.label} ${provider.registryId} ${provider.blurb}`.toLocaleLowerCase().includes(query);
        }
        if (providerView === "recommended") return provider.featured === true;
        if (providerView === "local") return provider.localKeyless === true;
        return true;
      });
  }, [providerQuery, providerView]);

  // Reset key/model when switching provider choice.
  useEffect(() => {
    setApiKey("");
    setBaseURL("");
    setCustomProviderId("");
    setTransport("openai-compatible");
    setShowAdvanced(false);
    setModel(subscriptionProvider?.model ?? choice.defaultModel);
  }, [selectedIdx, choice.defaultModel, subscriptionProvider?.model]);

  useEffect(() => {
    setSelectedIdx(initialIdx);
    const initialChoice = PROVIDER_CHOICES[initialIdx];
    setProviderView(initialChoice?.featured ? "recommended" : initialChoice?.localKeyless ? "local" : "all");
  }, [initialIdx]);

  const handleSubscriptionStatus = useCallback((status: SubscriptionAuthStatus) => {
    setConnectedSubscriptionId(status.state === "connected" ? status.providerId : null);
  }, []);

  const needsKey = !subscriptionProvider && providerChoiceNeedsApiKey(choice, configuredIds);
  const acceptsKey = !subscriptionProvider && providerChoiceAcceptsApiKey(choice, configuredIds);
  const needsBaseURL = choice.customEndpoint === true || choice.requiresBaseURL === true;
  const defaultBaseURL = providerChoiceDefaultBaseURL(choice);
  const effectiveProviderId = choice.customEndpoint
    ? customProviderId.trim()
    : subscriptionProvider?.id ?? choice.registryId;
  const canSave = model.trim().length > 0
    && (!choice.customEndpoint || effectiveProviderId.length > 0)
    && (!subscriptionProvider || connectedSubscriptionId === subscriptionProvider.id)
    && (!needsKey || apiKey.trim().length > 0)
    && (!needsBaseURL || baseURL.trim().length > 0);

  const handleSave = () => {
    if (!canSave || saving) return;
    const patch = buildOnboardingPatch({
      model: model.trim(),
      providerId: effectiveProviderId,
      apiKey: acceptsKey ? apiKey.trim() || undefined : undefined,
      baseURL: baseURL.trim() || undefined,
      transport: choice.customEndpoint ? transport : undefined,
      models: choice.customEndpoint
        ? [model.trim().startsWith(`${effectiveProviderId}/`)
            ? model.trim().slice(effectiveProviderId.length + 1)
            : model.trim()]
        : undefined,
    });
    void onSave(patch);
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="onboarding-modal-title">
      <div className="onboarding-modal" ref={dialogRef}>
        <header className="onboarding-modal-header">
          <div>
            <h2 id="onboarding-modal-title">{focusedSetup ? "Connect a model provider" : "Set up a model provider"}</h2>
            <p className="onboarding-modal-sub">
              {focusedSetup
                ? "Add what this model needs, then continue in the same task."
                : "Choose a provider to start coding. You can change this anytime in Settings."}
            </p>
          </div>
          <button type="button" className="icon-button no-drag" onClick={onDismiss} aria-label="Dismiss setup">
            <IconClose size={16} />
          </button>
        </header>

        <div className="onboarding-modal-body">
          <div className="onboarding-provider-list" ref={listRef}>
            <div className="onboarding-provider-tabs" role="tablist" aria-label="Provider groups">
              {([
                ["recommended", "Recommended"],
                ["local", "Local"],
                ["all", "All providers"],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={providerView === value}
                  className={providerView === value ? "selected" : ""}
                  onClick={() => {
                    setProviderView(value);
                    setProviderQuery("");
                    const first = PROVIDER_CHOICES.findIndex((provider) =>
                      value === "all"
                        ? true
                        : value === "recommended"
                          ? provider.featured === true
                          : provider.localKeyless === true,
                    );
                    if (first >= 0) setSelectedIdx(first);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <input
              type="search"
              className="setting-input onboarding-provider-search"
              value={providerQuery}
              onChange={(event) => setProviderQuery(event.target.value)}
              placeholder="Search every provider"
              aria-label="Search model providers"
            />
            {visibleChoices.map(({ provider: c, index: i }) => (
              <button
                key={c.key}
                type="button"
                className={`onboarding-provider-item${i === selectedIdx ? " selected" : ""}`}
                onClick={() => setSelectedIdx(i)}
              >
                <span className="onboarding-provider-label">{c.label}</span>
                <span className="onboarding-provider-blurb">{c.blurb}</span>
                {configuredIds.has(c.registryId) && c.registryId !== "" && (
                  <span className="onboarding-provider-check">✓ configured</span>
                )}
              </button>
            ))}
            {visibleChoices.length === 0 && (
              <p className="setting-empty">No matching providers.</p>
            )}
          </div>

          <div className="onboarding-provider-detail">
            <h3 className="onboarding-detail-title">{choice.label}</h3>
            <p className="onboarding-detail-blurb">{choice.blurb}</p>
            {choice.note && <p className="onboarding-detail-note">{choice.note}</p>}

            {subscriptionProvider && (
              <SubscriptionAuthCard
                key={subscriptionProvider.id}
                provider={subscriptionProvider}
                onStatusChange={handleSubscriptionStatus}
                currentModel={model}
                onSelectModel={setModel}
              />
            )}

            {choice.customEndpoint && (
              <div className="onboarding-field">
                <label htmlFor="onboarding-provider-id">Provider ID</label>
                <input
                  id="onboarding-provider-id"
                  type="text"
                  className="setting-input is-mono"
                  value={customProviderId}
                  onChange={(event) => setCustomProviderId(event.target.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
                  placeholder="team-gateway"
                  // biome-ignore lint/a11y/noAutofocus: custom provider id is the first required field
                  autoFocus
                />
              </div>
            )}

            {acceptsKey && (
              <div className="onboarding-field">
                <label htmlFor="onboarding-apikey">API key{needsKey ? "" : " (optional)"}</label>
                <input
                  id="onboarding-apikey"
                  type="password"
                  className="setting-input is-mono"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={choice.env ?? "Paste API key"}
                  // biome-ignore lint/a11y/noAutofocus: provider credential is the primary setup action
                  autoFocus={!choice.customEndpoint}
                />
                {choice.keyUrl && (
                  <a
                    href={choice.keyUrl}
                    className="onboarding-key-link"
                    onClick={(e) => {
                      e.preventDefault();
                      void window.vibe.openExternal(choice.keyUrl!).catch(() => {
                        /* Keep setup usable when the OS browser launch fails. */
                      });
                    }}
                  >
                    <IconExternalLink size={12} /> Get a key
                  </a>
                )}
              </div>
            )}

            {needsBaseURL && (
              <div className="onboarding-field">
                <label htmlFor="onboarding-baseurl">Base URL</label>
                <input
                  id="onboarding-baseurl"
                  type="url"
                  className="setting-input is-mono"
                  value={baseURL}
                  onChange={(e) => setBaseURL(e.target.value)}
                  placeholder={defaultBaseURL || "https://api.example.com/v1"}
                  // biome-ignore lint/a11y/noAutofocus: keyless deployment endpoints start here
                  autoFocus={!acceptsKey && !choice.customEndpoint}
                />
              </div>
            )}

            {!subscriptionProvider && (
              <div className="onboarding-field">
                <label htmlFor="onboarding-model">Model</label>
                <input
                  id="onboarding-model"
                  type="text"
                  className="setting-input is-mono"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={`${effectiveProviderId || "provider"}/model-id`}
                />
              </div>
            )}

            {!needsBaseURL && defaultBaseURL && (
              <div className="provider-endpoint-summary">
                <span>Endpoint</span>
                <code>{baseURL || defaultBaseURL}</code>
                <small>{baseURL ? "Custom override" : "Filled automatically"}</small>
              </div>
            )}

            <details
              className="provider-advanced"
              open={showAdvanced}
              onToggle={(event) => setShowAdvanced(event.currentTarget.open)}
            >
              <summary>Advanced settings</summary>
              <div className="provider-advanced-body">
                {!needsBaseURL && (
                  <div className="onboarding-field">
                    <label htmlFor="onboarding-baseurl-override">Endpoint override</label>
                    <input
                      id="onboarding-baseurl-override"
                      type="url"
                      className="setting-input is-mono"
                      value={baseURL}
                      onChange={(event) => setBaseURL(event.target.value)}
                      placeholder={defaultBaseURL || "https://api.example.com/v1"}
                    />
                    <small>Leave empty to keep the provider default.</small>
                  </div>
                )}
                {choice.customEndpoint && (
                  <div className="onboarding-field">
                    <label htmlFor="onboarding-transport">API format</label>
                    <select
                      id="onboarding-transport"
                      className="setting-select"
                      value={transport}
                      onChange={(event) => setTransport(event.target.value as typeof transport)}
                    >
                      <option value="openai-compatible">Chat Completions (OpenAI compatible)</option>
                      <option value="openai-responses">OpenAI Responses</option>
                    </select>
                  </div>
                )}
              </div>
            </details>

            {choice.localKeyless && (
              <p className="onboarding-detail-hint">
                This is a local provider — no API key needed. Just make sure the
                server is running and pick a model.
              </p>
            )}

            {!choice.localKeyless && choice.registryId !== "" && configuredIds.has(choice.registryId) && (
              <p className="onboarding-detail-hint">
                Existing credentials detected — no new API key is needed.
              </p>
            )}

            {saveError && (
              <p className="onboarding-save-error" role="alert">{saveError}</p>
            )}
          </div>
        </div>

        <footer className="onboarding-modal-footer">
          <button type="button" className="button" onClick={onDismiss}>{focusedSetup ? "Cancel" : "Skip for now"}</button>
          <button type="button" className="button primary" onClick={handleSave} disabled={!canSave || saving}>
            {saving ? "Saving & starting…" : "Save & start"}
          </button>
        </footer>
      </div>
    </div>
  );
}
