import { useEffect, useState } from "react";
import type { ProviderConfig } from "../../../shared/config-schema";
import {
  PROVIDER_CHOICES,
  providerChoiceDefaultBaseURL,
  providerChoiceForId,
} from "../../../shared/providers-catalog";
import { IconExternalLink } from "../../icons";
import {
  SUBSCRIPTION_PROVIDERS,
  subscriptionProviderForRegistryId,
} from "../../../shared/subscription-providers";
import { SubscriptionAuthCard } from "../../providers/SubscriptionAuthCard";
import {
  KeyValueTextArea,
  SelectInput,
  SettingBadge,
  SettingField,
  SettingSection,
  TextArea,
  TextInput,
} from "../FormControls";
import type { SectionProps } from "./types";

export function ProvidersSection({
  config,
  scope,
  updateConfig,
  cwd,
  onInvalidDraftChange,
  draftResetVersion = 0,
}: SectionProps) {
  const providers = config.providers ?? {};
  const providerIds = Object.keys(providers);
  const editableProviderIds = providerIds.filter((id) => !subscriptionProviderForRegistryId(id));
  const providerOptions = Array.from(
    new Map(
      PROVIDER_CHOICES
        .filter((choice) => choice.registryId
          && !choice.customEndpoint
          && !subscriptionProviderForRegistryId(choice.registryId)
          && !providers[choice.registryId])
        .map((choice) => [choice.registryId, choice]),
    ).values(),
  );
  const [expanded, setExpanded] = useState<string | null>(editableProviderIds[0] ?? null);
  const [showAdd, setShowAdd] = useState(false);
  const [newId, setNewId] = useState("");
  const [useCustom, setUseCustom] = useState(false);
  const addDraftKey = `providers:${scope}:${cwd ?? ""}:new-id`;

  useEffect(() => {
    const pending = showAdd && Boolean(newId.trim());
    onInvalidDraftChange?.(addDraftKey, pending);
    return () => onInvalidDraftChange?.(addDraftKey, false);
  }, [addDraftKey, newId, onInvalidDraftChange, showAdd]);
  useEffect(() => {
    setNewId("");
    setShowAdd(false);
    setUseCustom(false);
  }, [scope, cwd, draftResetVersion]);

  const updateProvider = (id: string, patch: Partial<ProviderConfig>) => {
    const next = { ...providers, [id]: { ...providers[id], ...patch } };
    updateConfig({ providers: next });
  };

  const confirmAddForId = (id: string) => {
    const trimmed = id.trim();
    if (!trimmed || providers[trimmed]) return;
    updateProvider(trimmed, {});
    const choice = providerChoiceForId(trimmed);
    if (!config.model && choice?.defaultModel) updateConfig({ model: choice.defaultModel });
    setExpanded(trimmed);
    setNewId("");
    setShowAdd(false);
    setUseCustom(false);
  };

  const confirmAdd = () => {
    confirmAddForId(newId);
  };

  const removeProvider = (id: string) => {
    const next = { ...providers };
    delete next[id];
    updateConfig({ providers: next });
  };

  return (
    <SettingSection title="Providers" description="Connect a provider, choose its model, and start. Vibe fills known endpoints automatically; advanced overrides stay optional.">
      <div className="provider-setup-intro">
        <strong>Connect, choose a model, save</strong>
        <span>Subscriptions sign in directly. API and local providers keep technical overrides under Advanced settings.</span>
      </div>
      <div className="setting-list provider-auth-list">
        {SUBSCRIPTION_PROVIDERS.map((provider) => (
          <SubscriptionAuthCard
            key={provider.id}
            provider={provider}
            currentModel={config.model}
            onSelectModel={(model) => updateConfig({ model })}
          />
        ))}
      </div>
      <div className="settings-subsection-heading">
        <div>
          <strong>API key, local, and custom providers</strong>
          <span>Use these when you have a provider key or run the model on this computer.</span>
        </div>
      </div>
      {editableProviderIds.length === 0 && !showAdd && (
        <p className="setting-empty">No API-key or local providers configured.</p>
      )}
      {editableProviderIds.length > 0 && (
        <div className="setting-list">
          {editableProviderIds.map((id) => {
            const p = providers[id] ?? {};
            const isExpanded = expanded === id;
            const choice = providerChoiceForId(id);
            const customProvider = !choice || choice.customEndpoint === true;
            const needsBaseURL = customProvider || choice?.requiresBaseURL === true;
            const defaultBaseURL = choice ? providerChoiceDefaultBaseURL(choice) : "";
            const currentModel = config.model?.startsWith(`${id}/`) ? config.model : "";
            return (
              <div key={id} className={`setting-card${isExpanded ? " expanded" : ""}`}>
                <div className="setting-card-header">
                  <button type="button" className="setting-card-toggle" onClick={() => setExpanded(isExpanded ? null : id)}>
                    <span className="setting-card-title">{choice?.label ?? id}</span>
                    {choice?.localKeyless
                      ? <SettingBadge>no key needed</SettingBadge>
                      : p.apiKey
                        ? <SettingBadge>key set</SettingBadge>
                        : p.tokenFile
                          ? <SettingBadge>token file</SettingBadge>
                          : <SettingBadge tone="warn">needs credential</SettingBadge>}
                  </button>
                  <button type="button" className="button danger" onClick={() => removeProvider(id)}>Remove</button>
                </div>
                <div
                  className="setting-card-body"
                  hidden={!isExpanded}
                  aria-hidden={!isExpanded}
                >
                  <div className="provider-quick-fields">
                    {!choice?.localKeyless && (
                    <SettingField
                      label="API key"
                      description={choice?.env
                        ? `Paste a key here, or set ${choice.env} in your environment.`
                        : "Paste the credential issued by this provider."}
                    >
                      <TextInput
                        value={p.apiKey ?? ""}
                        onChange={(v) => updateProvider(id, { apiKey: v || undefined })}
                        placeholder={choice?.env ?? "Paste API key"}
                        type="password"
                        monospace
                      />
                      {choice?.keyUrl && (
                        <button
                          type="button"
                          className="provider-key-link"
                          onClick={() => void window.vibe.openExternal(choice.keyUrl!).catch(() => {
                            /* The setup form remains usable when the OS browser cannot open. */
                          })}
                        >
                          <IconExternalLink size={12} /> Get an API key
                        </button>
                      )}
                    </SettingField>
                    )}

                    <SettingField
                      label="Default model"
                      description={currentModel
                        ? "New sessions use this model."
                        : "Set a model for new sessions, or keep your current default."}
                    >
                      <TextInput
                        value={currentModel}
                        onChange={(value) => updateConfig({ model: value || undefined })}
                        placeholder={choice?.defaultModel || `${id}/model-id`}
                        monospace
                      />
                    </SettingField>

                    {needsBaseURL && (
                      <SettingField label="Base URL" description="The full API root, usually ending in /v1.">
                        <TextInput
                          value={p.baseURL ?? ""}
                          onChange={(value) => updateProvider(id, { baseURL: value || undefined })}
                          placeholder="https://api.example.com/v1"
                          type="url"
                          monospace
                        />
                      </SettingField>
                    )}

                    {(p.baseURL || defaultBaseURL) && (
                      <div className="provider-endpoint-summary">
                        <span>Endpoint</span>
                        <code>{p.baseURL || defaultBaseURL}</code>
                        <small>{p.baseURL ? "Custom override" : "Filled automatically"}</small>
                      </div>
                    )}
                  </div>

                  <details className="provider-advanced">
                    <summary>Advanced settings</summary>
                    <div className="provider-advanced-body">
                    {!needsBaseURL && (
                      <SettingField label="Endpoint override" description="Leave empty to use the filled provider endpoint above.">
                        <TextInput
                          value={p.baseURL ?? ""}
                          onChange={(value) => updateProvider(id, { baseURL: value || undefined })}
                          placeholder={defaultBaseURL || "https://api.example.com/v1"}
                          type="url"
                          monospace
                        />
                      </SettingField>
                    )}
                    {customProvider && (
                      <SettingField label="Transport" description="Choose the HTTP API dialect exposed by this custom endpoint.">
                        <SelectInput
                          value={p.transport ?? "openai-compatible"}
                          onChange={(transport) => updateProvider(id, { transport })}
                          options={[
                            { value: "openai-compatible", label: "Chat Completions (OpenAI compatible)" },
                            { value: "openai-responses", label: "OpenAI Responses" },
                          ]}
                        />
                      </SettingField>
                    )}
                    <SettingField label="Explicit models" description="Optional model IDs, one per line, for endpoints that do not expose /models.">
                      <TextArea
                        value={(p.models ?? []).join("\n")}
                        onChange={(value) => {
                          const models = value.split("\n").map((model) => model.trim()).filter(Boolean);
                          updateProvider(id, { models: models.length ? models : undefined });
                        }}
                        placeholder="model-id"
                        monospace
                      />
                    </SettingField>
                    <SettingField label="Token file" description="Path to a credential file (supports ~). Reuse OAuth tokens from other CLIs.">
                      <TextInput
                        value={p.tokenFile ?? ""}
                        onChange={(v) => updateProvider(id, { tokenFile: v || undefined })}
                        placeholder="~/.codex/auth.json"
                        monospace
                      />
                    </SettingField>
                    <SettingField label="Token path" description="Dot-path into a JSON token file (e.g. tokens.access_token).">
                      <TextInput
                        value={p.tokenPath ?? ""}
                        onChange={(v) => updateProvider(id, { tokenPath: v || undefined })}
                        placeholder="tokens.access_token"
                        monospace
                      />
                    </SettingField>
                    <SettingField label="Extra headers" description="One per line: key: value">
                      <KeyValueTextArea
                        value={p.headers}
                        onChange={(headers) => updateProvider(id, { headers })}
                        separator=":"
                        resetKey={`providers:${draftResetVersion}:${scope}:${cwd ?? ""}:${id}:headers`}
                        placeholder="X-Account-Id: 12345"
                        onInvalidDraftChange={onInvalidDraftChange}
                      />
                    </SettingField>
                    </div>
                  </details>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {showAdd ? (
        useCustom ? (
          <div className="git-create-row">
            <input
              type="text"
              className="setting-input is-mono"
              value={newId}
              placeholder="provider-id (for example team-gateway)"
              onChange={(e) => setNewId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmAdd();
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setShowAdd(false);
                  setNewId("");
                  setUseCustom(false);
                }
              }}
              // biome-ignore lint/a11y/noAutofocus: single autofocus owner in the custom add row
              autoFocus
            />
            <button type="button" className="button primary" disabled={!newId.trim()} onClick={confirmAdd}>Add</button>
            <button type="button" className="button" onClick={() => { setShowAdd(false); setNewId(""); setUseCustom(false); }}>Cancel</button>
          </div>
        ) : (
          <div className="provider-add-row">
            <select
              className="setting-select"
              value={newId}
              onChange={(e) => {
                const choice = PROVIDER_CHOICES.find((c) => c.registryId === e.target.value && c.registryId !== "");
                setNewId(e.target.value);
                if (choice && e.target.value) confirmAddForId(e.target.value);
              }}
              // biome-ignore lint/a11y/noAutofocus: single autofocus owner in the add row
              autoFocus
            >
              <option value="">Select a provider…</option>
              {providerOptions.map((c) => (
                <option key={c.key} value={c.registryId}>{c.label}</option>
              ))}
            </select>
            <button type="button" className="button" onClick={() => { setUseCustom(true); setNewId(""); }}>
              Custom endpoint
            </button>
            <button type="button" className="button" onClick={() => { setShowAdd(false); setNewId(""); setUseCustom(false); }}>Cancel</button>
          </div>
        )
      ) : (
        <div className="setting-actions">
          <button type="button" className="button" onClick={() => { setShowAdd(true); setUseCustom(false); setNewId(""); }}>Add provider</button>
        </div>
      )}
    </SettingSection>
  );
}
