import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudProviderId, CloudSessionCatalogEntry, CloudSettingsPublic } from "../../../shared/cloud";
import { NumberInput, SettingField, SettingSection, TextArea, TextInput, ToggleSwitch } from "../FormControls";

const EMPTY_SETTINGS: CloudSettingsPublic = {
  experimentalEnabled: false,
  transferModelCredentials: true,
  lastProvider: "e2b",
  autoPauseMinutes: 10,
  deleteOnReturn: true,
  providers: {
    e2b: { configured: false },
    vercel: { configured: false },
  },
  credentialBindings: [],
  allowedDomains: [],
  additionalExclusions: [],
};

export function CloudSection({ showToast, onSessionRecovered, onDirtyChange }: {
  showToast: (message: string, severity?: "info" | "warn" | "error") => void;
  onSessionRecovered?: (sessionId: string, cwd: string) => void | Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [settings, setSettings] = useState<CloudSettingsPublic>(EMPTY_SETTINGS);
  const [sessions, setSessions] = useState<CloudSessionCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<CloudProviderId | "settings" | null>(null);
  const [e2bKey, setE2bKey] = useState("");
  const [vercelToken, setVercelToken] = useState("");
  const [vercelTeam, setVercelTeam] = useState("");
  const [vercelProject, setVercelProject] = useState("");
  const [bindingName, setBindingName] = useState("");
  const [bindingValue, setBindingValue] = useState("");
  const [policyDraft, setPolicyDraft] = useState({ allowedDomains: [] as string[], additionalExclusions: [] as string[] });
  const [policyDirty, setPolicyDirty] = useState(false);
  const policyDirtyRef = useRef(false);
  policyDirtyRef.current = policyDirty;

  const load = useCallback(async () => {
    setLoading(true);
    const [result, sessionResult] = await Promise.all([window.vibe.cloudSettings(), window.vibe.listCloudSessions()]);
    setLoading(false);
    if (!result.ok) {
      showToast(result.error, "error");
      return;
    }
    setSettings(result.value);
    if (!policyDirtyRef.current) {
      setPolicyDraft({
        allowedDomains: result.value.allowedDomains,
        additionalExclusions: result.value.additionalExclusions,
      });
    }
    if (sessionResult.ok) setSessions(sessionResult.value);
  }, [showToast]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { onDirtyChange?.(policyDirty); }, [onDirtyChange, policyDirty]);

  const patchSettings = async (patch: Partial<CloudSettingsPublic>) => {
    setWorking("settings");
    const result = await window.vibe.updateCloudSettings(patch);
    setWorking(null);
    if (!result.ok) {
      showToast(result.error, "error");
      return;
    }
    setSettings(result.value);
  };

  const connect = async (provider: CloudProviderId) => {
    setWorking(provider);
    const credentials = provider === "e2b"
      ? { apiKey: e2bKey.trim() }
      : { token: vercelToken.trim(), teamId: vercelTeam.trim(), projectId: vercelProject.trim() };
    const result = await window.vibe.connectCloudProvider(provider, credentials);
    setWorking(null);
    if (!result.ok) {
      showToast(result.error, "error");
      return;
    }
    setE2bKey("");
    setVercelToken("");
    showToast(`${provider === "e2b" ? "E2B" : "Vercel"} connected and tested`, "info");
    await load();
  };

  const test = async (provider: CloudProviderId) => {
    setWorking(provider);
    const result = await window.vibe.testCloudProvider(provider);
    setWorking(null);
    const ready = result.ok && result.value.ok;
    const error = result.ok ? (result.value.ok ? undefined : result.value.error) : result.error;
    showToast(ready ? `${provider === "e2b" ? "E2B" : "Vercel"} connection is ready` : error ?? "Cloud connection test failed", ready ? "info" : "error");
    await load();
  };

  const disconnect = async (provider: CloudProviderId) => {
    if (!window.confirm(`Remove the saved ${provider === "e2b" ? "E2B" : "Vercel"} credentials from this Mac?`)) return;
    setWorking(provider);
    const result = await window.vibe.disconnectCloudProvider(provider);
    setWorking(null);
    if (!result.ok) showToast(result.error, "error");
    else showToast("Cloud credentials removed", "info");
    await load();
  };

  const saveBinding = async () => {
    setWorking("settings");
    const result = await window.vibe.saveCloudCredentialBinding({ label: bindingName.trim(), kind: "environment", value: bindingValue });
    setWorking(null);
    if (!result.ok) { showToast(result.error, "error"); return; }
    setSettings(result.value);
    setBindingName("");
    setBindingValue("");
    showToast("Cloud credential binding saved securely", "info");
  };

  const saveTransferPolicy = async () => {
    setWorking("settings");
    const result = await window.vibe.updateCloudSettings(policyDraft);
    setWorking(null);
    if (!result.ok) { showToast(result.error, "error"); return; }
    setSettings(result.value);
    setPolicyDraft({
      allowedDomains: result.value.allowedDomains,
      additionalExclusions: result.value.additionalExclusions,
    });
    setPolicyDirty(false);
    showToast("Cloud network and transfer policy saved", "info");
  };

  const deleteCloudCopy = async (session: CloudSessionCatalogEntry) => {
    if (!window.confirm(`Delete the retained ${session.provider === "e2b" ? "E2B" : "Vercel"} sandbox for this session?`)) return;
    setWorking("settings");
    const result = await window.vibe.deleteCloudSessionCopy(session.sessionId);
    setWorking(null);
    if (!result.ok) showToast(result.error, "error");
    else showToast("Cloud copy deleted", "info");
    await load();
  };

  const recoverLostSession = async (session: CloudSessionCatalogEntry) => {
    if (!window.confirm("The provider confirmed this sandbox is gone. Recover the last local base and permanently discard any cloud-only work?")) return;
    setWorking("settings");
    const result = await window.vibe.recoverLostCloudSession(session.sessionId);
    setWorking(null);
    if (!result.ok) showToast(result.error, "error");
    else showToast("Local base recovered. Reopen the session to continue locally.", "warn");
    await load();
  };

  const returnRecoverableSessionLocal = async (session: CloudSessionCatalogEntry) => {
    setWorking("settings");
    const result = await window.vibe.resumeCloudSessionLocally(session.sessionId, true);
    setWorking(null);
    if (!result.ok) showToast(result.error, "error");
    else {
      await onSessionRecovered?.(session.sessionId, result.value.cwd);
      showToast("Cloud work returned safely to this Mac", "info");
    }
    await load();
  };

  const retryHandoffRecovery = async (session: CloudSessionCatalogEntry) => {
    setWorking("settings");
    const listed = await window.vibe.listCloudSessions();
    if (!listed.ok) {
      setWorking(null);
      showToast(listed.error, "error");
      return;
    }
    const pending = listed.value.find((entry) => entry.sessionId === session.sessionId);
    if (pending?.handoffTransition?.direction === "cloud-to-local") {
      const recovered = await window.vibe.reconnectCloudSession(session.sessionId);
      setWorking(null);
      if (!recovered.ok) showToast(recovered.error, "error");
      else {
        await onSessionRecovered?.(
          session.sessionId,
          pending.handoffTransition.localCwd ?? session.sourceRoot,
        );
        showToast("Interrupted return recovered and opened at the authoritative owner", "info");
      }
    } else {
      setWorking(null);
      showToast(pending ? "Ownership recovery still needs the provider; try again shortly" : "Interrupted handoff recovered locally", pending ? "warn" : "info");
    }
    await load();
  };

  if (loading) return <div className="settings-loading"><span className="spinner" aria-hidden /> Loading Cloud settings…</div>;

  const e2b = settings.providers.e2b;
  const vercel = settings.providers.vercel;
  return (
    <>
      <p className="setting-empty" role="note">
        Cloud is bring-your-own-account and stays controlled by this desktop installation. Vibe does not host an account, billing service, relay, or control plane.
      </p>

      <SettingSection title="Cloud sessions" description="Run the same revision-locked vibe-codr engine in an isolated Linux sandbox.">
        <SettingField label="Enable experimental Cloud" description="Cloud remains experimental until the local capability relay and Vercel credential broker complete their release gates.">
          <ToggleSwitch checked={settings.experimentalEnabled} onChange={(experimentalEnabled) => void patchSettings({ experimentalEnabled })} />
        </SettingField>
        <SettingField label="Include model access by default" description="Seal a session-scoped snapshot of the active model, configured provider keys, and connected subscription access for the remote engine. Cloud terminals never receive it. You can override this for each session.">
          <ToggleSwitch checked={settings.transferModelCredentials} onChange={(transferModelCredentials) => void patchSettings({ transferModelCredentials })} />
        </SettingField>
        <SettingField label="Idle auto-pause" description="Cloud resources pause after this many idle minutes and resume on access.">
          <NumberInput value={settings.autoPauseMinutes} min={1} max={120} onChange={(autoPauseMinutes) => void patchSettings({ autoPauseMinutes: autoPauseMinutes ?? 10 })} />
        </SettingField>
        <SettingField label="Delete after returning" description="Keep a seven-day local recovery archive, then destroy the remote sandbox after a verified local start.">
          <ToggleSwitch checked={settings.deleteOnReturn} onChange={(deleteOnReturn) => void patchSettings({ deleteOnReturn })} />
        </SettingField>
      </SettingSection>

      {sessions.some((session) => session.status === "suspended" || session.status === "cleanup-pending" || session.status === "handoff-interrupted" || session.status === "lost" || session.status === "recoverable-error") && (
        <SettingSection title="Cloud recovery" description="Return degraded sessions safely, manage suspended copies, and finish cleanup without changing ownership implicitly.">
          <div className="setting-list">
            {sessions.filter((session) => session.status === "suspended" || session.status === "cleanup-pending" || session.status === "handoff-interrupted" || session.status === "lost" || session.status === "recoverable-error").map((session) => (
              <div className="setting-card" key={session.sessionId}>
                <div className="setting-card-header">
                  <span className="setting-card-title">{session.sourceRoot}</span>
                  {session.status === "handoff-interrupted" ? (
                    <button type="button" className="button" disabled={working === "settings"} onClick={() => void retryHandoffRecovery(session)}>Retry recovery</button>
                  ) : session.status === "recoverable-error" ? (
                    <button type="button" className="button primary" disabled={working === "settings"} onClick={() => void returnRecoverableSessionLocal(session)}>Return Local</button>
                  ) : session.status === "lost" ? (
                    <button type="button" className="button danger" disabled={working === "settings"} onClick={() => void recoverLostSession(session)}>Recover local base</button>
                  ) : (
                    <button type="button" className="button danger" disabled={working === "settings"} onClick={() => void deleteCloudCopy(session)}>{session.localImportPending ? "Finish cleanup" : "Delete cloud copy"}</button>
                  )}
                </div>
                <p className="setting-empty">{session.provider === "e2b" ? "E2B" : "Vercel"} · {session.status === "lost" ? "sandbox missing" : session.status === "handoff-interrupted" ? "handoff recovery pending" : session.status === "recoverable-error" ? "Cloud ownership preserved · local recovery available" : session.status === "cleanup-pending" ? "cleanup needs retry" : "suspended"}</p>
                {session.error && <p className="settings-save-error" role="alert">{session.error}</p>}
              </div>
            ))}
          </div>
        </SettingSection>
      )}

      <SettingSection title="E2B" description="Secure, persistent sandbox with pause/resume and reconnectable terminal sessions.">
        <p className="setting-empty" role="note">
          E2B can preserve guest memory and processes while paused. Use revocable, sandbox-scoped credentials; injected process secrets may remain in guest memory.
        </p>
        {e2b.configured ? (
          <div className="setting-card expanded">
            <div className="setting-card-header"><span className="setting-card-title">Connected{e2b.account ? ` · ${e2b.account}` : ""}</span></div>
            {e2b.error && <p className="settings-save-error" role="alert">{e2b.error}</p>}
            <div className="setting-card-actions">
              <button type="button" className="button" disabled={working === "e2b"} onClick={() => void test("e2b")}>Test connection</button>
              <button type="button" className="button danger" disabled={working === "e2b"} onClick={() => void disconnect("e2b")}>Disconnect</button>
            </div>
          </div>
        ) : (
          <>
            <SettingField label="E2B API key" description="Encrypted with macOS Keychain-backed safe storage. Never exposed again to the renderer.">
              <TextInput value={e2bKey} onChange={setE2bKey} placeholder="e2b_…" monospace type="password" />
            </SettingField>
            <button type="button" className="button primary" disabled={!e2bKey.trim() || working === "e2b"} onClick={() => void connect("e2b")}>{working === "e2b" ? "Testing…" : "Connect and test"}</button>
          </>
        )}
      </SettingSection>

      <SettingSection title="Vercel Sandbox" description="Named persistent sandbox with filesystem restoration, restart hooks, and network policy.">
        <p className="setting-empty" role="note">
          Vercel credential brokering is preferred when the account supports it. Otherwise narrowly scoped credentials are injected only into cloud-agentd with an explicit handoff warning.
        </p>
        {vercel.configured ? (
          <div className="setting-card expanded">
            <div className="setting-card-header"><span className="setting-card-title">Connected{vercel.account ? ` · ${vercel.account}` : ""}</span></div>
            {vercel.error && <p className="settings-save-error" role="alert">{vercel.error}</p>}
            <div className="setting-card-actions">
              <button type="button" className="button" disabled={working === "vercel"} onClick={() => void test("vercel")}>Test connection</button>
              <button type="button" className="button danger" disabled={working === "vercel"} onClick={() => void disconnect("vercel")}>Disconnect</button>
            </div>
          </div>
        ) : (
          <>
            <SettingField label="Vercel access token (optional)" description="Leave blank to reuse your Vercel CLI sign-in. Vibe finds an eligible team and creates or reuses the default Sandbox project automatically."><TextInput value={vercelToken} onChange={setVercelToken} placeholder="Use Vercel CLI session" monospace type="password" /></SettingField>
            <SettingField label="Team ID (optional)" description="Use this only to target a specific team."><TextInput value={vercelTeam} onChange={setVercelTeam} placeholder="Auto-detect" monospace /></SettingField>
            <SettingField label="Project ID (optional)" description="Requires the team ID above; otherwise Vibe uses the default Sandbox project."><TextInput value={vercelProject} onChange={setVercelProject} placeholder="Auto-create or reuse" monospace /></SettingField>
            <button type="button" className="button primary" disabled={(!!vercelProject.trim() && !vercelTeam.trim()) || working === "vercel"} onClick={() => void connect("vercel")}>{working === "vercel" ? "Finding workspace and testing…" : vercelToken.trim() ? "Connect and test" : "Use Vercel CLI session"}</button>
          </>
        )}
      </SettingSection>

      <SettingSection title="Network and transfer" description="Default-deny transfer rules and sandbox egress policy.">
        <SettingField label="Allowed network domains" description="One hostname per line. Provider control-plane endpoints are added internally.">
          <TextArea rows={4} monospace value={policyDraft.allowedDomains.join("\n")} onChange={(value) => {
            setPolicyDraft((current) => ({ ...current, allowedDomains: value.split("\n").map((line) => line.trim()).filter(Boolean) }));
            setPolicyDirty(true);
          }} placeholder={"api.openai.com\ngithub.com"} />
        </SettingField>
        <SettingField label="Additional exclusions" description="One workspace-relative path per line, in addition to ignored files, .env files, SSH material, credentials, sockets, and escaping links.">
          <TextArea rows={4} monospace value={policyDraft.additionalExclusions.join("\n")} onChange={(value) => {
            setPolicyDraft((current) => ({ ...current, additionalExclusions: value.split("\n").map((line) => line.trim()).filter(Boolean) }));
            setPolicyDirty(true);
          }} placeholder={"fixtures/private\nlarge-models"} />
        </SettingField>
        <button type="button" className="button" disabled={working === "settings" || !policyDirty} onClick={() => void saveTransferPolicy()}>Save network and transfer policy</button>
      </SettingSection>

      <SettingSection title="Credential bindings" description="Approve narrowly scoped keys for sealed, session-only remote engine access. Values are deleted from the transfer file after startup and never reach Cloud terminals. Local token files and credential folders are never copied.">
        {settings.credentialBindings.length > 0 ? (
          <div className="setting-list">
            {settings.credentialBindings.map((binding) => (
              <div className="setting-card" key={binding.id}>
                <div className="setting-card-header">
                  <span className="setting-card-title">{binding.label}</span>
                  <button type="button" className="button danger" onClick={() => void window.vibe.removeCloudCredentialBinding(binding.id).then((result) => { if (result.ok) setSettings(result.value); else showToast(result.error, "error"); })}>Remove</button>
                </div>
                <p className="setting-empty">Environment · {binding.ready ? "ready" : "missing"}</p>
              </div>
            ))}
          </div>
        ) : <p className="setting-empty">No model, Git, MCP, or plugin credentials are bound for Cloud.</p>}
        <SettingField label="Environment variable" description="For example OPENAI_API_KEY, ANTHROPIC_API_KEY, or a narrowly scoped Git token variable.">
          <TextInput value={bindingName} onChange={setBindingName} placeholder="OPENAI_API_KEY" monospace />
        </SettingField>
        <SettingField label="Secret value" description="Encrypted immediately using macOS Keychain-backed storage and never shown again.">
          <TextInput value={bindingValue} onChange={setBindingValue} placeholder="Secret" monospace type="password" />
        </SettingField>
        <button type="button" className="button" disabled={!bindingName.trim() || !bindingValue || working === "settings"} onClick={() => void saveBinding()}>Add secure binding</button>
        <p className="setting-empty" role="note">Token-file, AWS/Google file, and firewall-brokered bindings are represented separately by the runtime contract; this build only enables explicit environment bindings until their provider contract tests are green.</p>
      </SettingSection>

      <SettingSection title="Local capability relay" description="Mac-bound integrations never receive silent cloud substitutes.">
        <p className="setting-empty">
          Ollama, LM Studio, local MCPs, macOS apps, browser automation, and other machine-bound tools require an explicit per-integration relay approval. If this Mac disconnects first, the cloud turn durably pauses as “Needs your Mac.” Arbitrary remote shell access remains disabled.
        </p>
      </SettingSection>
      {working === "settings" && <p className="settings-clean-indicator">Saving Cloud settings…</p>}
    </>
  );
}
