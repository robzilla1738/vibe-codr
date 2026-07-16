import { useEffect, useState } from "react";
import {
  isSubscriptionAuthStart,
  isSubscriptionAuthStatus,
  type SubscriptionAuthMethod,
  type SubscriptionAuthStatus,
} from "../../shared/provider-auth";
import type { SubscriptionProviderSetup } from "../../shared/subscription-providers";

function statusLabel(status: SubscriptionAuthStatus): string {
  switch (status.state) {
    case "connected": return "Connected";
    case "pending": return "Waiting for sign-in";
    case "error": return "Needs attention";
    case "cancelled": return "Cancelled";
    default: return "Not connected";
  }
}

function friendlyAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid rpc request/i.test(message)) {
    return "Subscription sign-in is unavailable because the app and bundled engine are out of sync. Install the latest Vibe Codr update and try again.";
  }
  if (/EADDRINUSE|address already in use/i.test(message)) {
    return "The sign-in callback is already in use. Close another Codex sign-in window and try again.";
  }
  return message;
}

export function SubscriptionAuthCard({
  provider,
  onStatusChange,
  currentModel,
  onSelectModel,
}: {
  provider: SubscriptionProviderSetup;
  onStatusChange?: (status: SubscriptionAuthStatus) => void;
  currentModel?: string;
  onSelectModel?: (model: string) => void;
}) {
  const [status, setStatus] = useState<SubscriptionAuthStatus>({ providerId: provider.id, state: "disconnected" });
  const [busy, setBusy] = useState(false);

  const readStatus = async (sessionId?: string) => {
    const result = await window.vibe.rpc("providerAuthStatus", { providerId: provider.id, ...(sessionId ? { authSessionId: sessionId } : {}) });
    if (!result.ok) throw new Error(result.error);
    if (!isSubscriptionAuthStatus(result.value)) throw new Error("The provider returned an invalid authentication status.");
    setStatus(result.value);
    return result.value;
  };

  useEffect(() => {
    let active = true;
    void readStatus().catch((error) => {
      if (active) setStatus({ providerId: provider.id, state: "error", error: friendlyAuthError(error) });
    });
    return () => { active = false; };
  }, [provider.id]);

  useEffect(() => {
    if (status.state !== "pending" || !status.sessionId) return;
    const sessionId = status.sessionId;
    const timer = window.setInterval(() => {
      void readStatus(sessionId).catch((error) => {
        setStatus({ providerId: provider.id, state: "error", error: friendlyAuthError(error) });
      });
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [provider.id, status.sessionId, status.state]);

  useEffect(() => {
    onStatusChange?.(status);
  }, [onStatusChange, status]);

  const connect = async (method: SubscriptionAuthMethod) => {
    setBusy(true);
    try {
      const result = await window.vibe.rpc("beginProviderAuth", { providerId: provider.id, authMethod: method });
      if (!result.ok) throw new Error(result.error);
      if (!isSubscriptionAuthStart(result.value)) throw new Error("The provider returned an invalid sign-in request.");
      const next: SubscriptionAuthStatus = { ...result.value, state: "pending" };
      setStatus(next);
      if (next.url) await window.vibe.openExternal(next.url);
    } catch (error) {
      setStatus({ providerId: provider.id, state: "error", error: friendlyAuthError(error) });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!status.sessionId) return;
    await window.vibe.rpc("cancelProviderAuth", { providerId: provider.id, authSessionId: status.sessionId });
    setStatus({ providerId: provider.id, state: "cancelled" });
  };

  const logout = async () => {
    setBusy(true);
    const result = await window.vibe.rpc("logoutProviderAuth", { providerId: provider.id });
    setBusy(false);
    setStatus(result.ok
      ? { providerId: provider.id, state: "disconnected" }
      : { providerId: provider.id, state: "error", error: result.error });
  };

  return (
    <div className="setting-card provider-auth-card">
      <div className="setting-card-header">
        <div className="setting-card-toggle provider-auth-heading">
          <span className="setting-card-title">{provider.title}</span>
          <span className="setting-field-desc">{provider.description}</span>
        </div>
        <span className={`setting-badge${status.state === "error" ? " is-warn" : ""}`}>
          {statusLabel(status)}
        </span>
      </div>
      <div className="provider-auth-actions">
        {status.state === "connected" ? (
          <>
            <span className="provider-auth-model">{status.accountLabel || "Subscription ready"}</span>
            <button type="button" className="button" disabled={busy} onClick={() => void logout()}>Sign out</button>
          </>
        ) : status.state === "pending" ? (
          <>
            {status.userCode && (
              <button type="button" className="provider-device-code" onClick={() => void window.vibe.writeClipboardText(status.userCode!)}>
                <span>Copy device code</span><strong>{status.userCode}</strong>
              </button>
            )}
            <span className="setting-field-desc">Finish signing in in the browser, then return here.</span>
            {status.url && <button type="button" className="button" onClick={() => void window.vibe.openExternal(status.url!)}>Open sign-in page</button>}
            <button type="button" className="button" onClick={() => void cancel()}>Cancel</button>
          </>
        ) : (
          <button type="button" className="button primary" disabled={busy} onClick={() => void connect(provider.authMethod)}>
            {busy ? "Starting sign-in…" : `Connect ${provider.id === "openai-codex" ? "ChatGPT" : "xAI"}`}
          </button>
        )}
      </div>
      <div className="provider-auth-models">
        <div className="provider-auth-models-heading">
          <strong>Use for new chats</strong>
          <span>{status.state === "connected" ? "Choose a model" : "Connect first, then choose"}</span>
        </div>
        <div className="provider-auth-model-options">
          {provider.models.map((model) => (
            <button
              key={model.id}
              type="button"
              className={`provider-auth-model-option${currentModel === model.id ? " selected" : ""}`}
              disabled={status.state !== "connected" || !onSelectModel}
              aria-pressed={currentModel === model.id}
              onClick={() => onSelectModel?.(model.id)}
            >
              <strong>{model.label}</strong>
              <span>{model.description}</span>
            </button>
          ))}
        </div>
      </div>
      {status.error && <p className="settings-save-error" role="alert">{status.error}</p>}
    </div>
  );
}
