import { useEffect, useRef, useState, type CSSProperties } from "react";
import type {
  CloudFailureDetails,
  CloudProviderId,
  CloudSessionCatalogEntry,
  CloudSettingsPublic,
  CloudStatusEvent,
} from "../../shared/cloud";
import { CLOUD_STARTUP_STAGES, cloudHandoffActionLabel } from "../../shared/cloud-progress";
import { IconArrowRight, IconCheck, IconCloud, IconLaptop } from "../icons";

export function CloudHandoffSheet({
  cwd,
  sessionId,
  model,
  cloudSession,
  busy,
  requestedTarget,
  requestedProvider,
  initialInstruction,
  progress,
  onClose,
  onComplete,
  onWorkingChange,
}: {
  cwd: string;
  sessionId: string;
  model: string;
  cloudSession: CloudSessionCatalogEntry | null;
  busy: boolean;
  requestedTarget?: "cloud" | "local";
  requestedProvider?: CloudProviderId;
  initialInstruction?: string;
  progress: CloudStatusEvent | null;
  onClose: () => void;
  onComplete: (result: {
    message: string;
    executionTarget: "local" | "cloud";
    cwd?: string;
    cloudSession?: CloudSessionCatalogEntry;
  }) => void | Promise<void>;
  onWorkingChange?: (working: boolean) => void;
}) {
  const [settings, setSettings] = useState<CloudSettingsPublic | null>(null);
  const [provider, setProvider] = useState<CloudProviderId>("e2b");
  const [instruction, setInstruction] = useState(initialInstruction ?? "");
  const [keepCloudCopy, setKeepCloudCopy] = useState(false);
  const [includeModelCredentials, setIncludeModelCredentials] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<CloudFailureDetails | null>(null);
  const [now, setNow] = useState(Date.now());
  const dialogRef = useRef<HTMLElement>(null);
  const resumeLocal = requestedTarget === "local" || (requestedTarget === undefined && cloudSession !== null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    onWorkingChange?.(working);
    return () => onWorkingChange?.(false);
  }, [onWorkingChange, working]);

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [working]);

  useEffect(() => {
    void window.vibe.cloudSettings().then((result) => {
      if (!result.ok) { setError(result.error); return; }
      setSettings(result.value);
      setIncludeModelCredentials(result.value.transferModelCredentials);
      setProvider(requestedProvider ?? result.value.lastProvider);
      if (resumeLocal && cloudSession) setKeepCloudCopy(!result.value.deleteOnReturn);
    });
  }, [cloudSession, requestedProvider, resumeLocal]);

  const configured = settings?.providers[provider].configured ?? false;
  const go = async () => {
    setWorking(true);
    setError(null);
    setFailure(null);
    if (resumeLocal) {
      if (!cloudSession) {
        setWorking(false);
        setError("This session is already running locally");
        return;
      }
      try {
        const result = await window.vibe.resumeCloudSessionLocally(sessionId, keepCloudCopy);
        if (!result.ok) { setError(result.error); return; }
        await onComplete({
          message: result.value.divergent ? "Cloud work resumed in a safe review worktree" : "Cloud work synced and resumed locally",
          executionTarget: "local",
          cwd: result.value.cwd,
        });
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Cloud return could not be started");
      } finally {
        setWorking(false);
      }
      return;
    }
    try {
      if (settings && !settings.experimentalEnabled) {
        const enabled = await window.vibe.updateCloudSettings({ experimentalEnabled: true });
        if (!enabled.ok) {
          setError(enabled.error);
          return;
        }
        setSettings(enabled.value);
      }
      const result = await window.vibe.handoffToCloud({
        cwd,
        provider,
        instruction: instruction.trim() || undefined,
        includeModelCredentials,
      });
      if (!result.ok) {
        setError(result.error);
        setFailure(result.details ?? null);
        return;
      }
      await onComplete({
        message: "Session is now running in Cloud",
        executionTarget: "cloud",
        cloudSession: result.value,
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Cloud handoff could not be started");
    } finally {
      setWorking(false);
    }
  };

  const activeStageIndex = progress?.stage ? CLOUD_STARTUP_STAGES.findIndex((stage) => stage.id === progress.stage) : -1;
  const elapsedSeconds = working && progress?.startedAt ? Math.max(0, Math.floor((now - progress.startedAt) / 1_000)) : 0;
  const providerName = provider === "e2b" ? "E2B" : "Vercel";
  const recoveryRequired = error !== null && failure !== null && !failure.retryable;

  return (
    <div className="modal-overlay cloud-handoff-backdrop">
      <section ref={dialogRef} tabIndex={-1} className="cloud-handoff-sheet" role="dialog" aria-modal="true" aria-labelledby="cloud-handoff-title">
        <header className="cloud-handoff-header">
          <div>
            <span className="cloud-handoff-eyebrow">Session handoff</span>
            <h2 id="cloud-handoff-title">{resumeLocal ? "Bring work back to this Mac" : "Move work to Cloud"}</h2>
            <p>{resumeLocal ? "Review the return path before local files change." : "Keep the same conversation and continue on remote compute."}</p>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose} disabled={working}>×</button>
        </header>

        <div className="cloud-handoff-body">
          {resumeLocal && cloudSession ? (
            <>
              <div className="cloud-route" aria-label="Cloud to Local handoff route">
                <div className="cloud-route-endpoint">
                  <span className="cloud-route-icon"><IconCloud size={18} /></span>
                  <span><small>Current runtime</small><strong>{cloudSession.provider === "e2b" ? "E2B Cloud" : "Vercel Cloud"}</strong></span>
                </div>
                <span className="cloud-route-arrow" aria-hidden><IconArrowRight size={16} /></span>
                <div className="cloud-route-endpoint is-destination">
                  <span className="cloud-route-icon"><IconLaptop size={18} /></span>
                  <span><small>Destination</small><strong>This Mac</strong></span>
                </div>
              </div>
              <section className="cloud-handoff-section" aria-labelledby="return-safety-title">
                <div className="cloud-section-heading">
                  <div><span className="cloud-section-kicker">Safety</span><h3 id="return-safety-title">Your local workspace is protected</h3></div>
                </div>
                <ul className="cloud-boundary-list">
                  <li><IconCheck size={13} /><span><strong>Verified sync</strong><small>Cloud changes are checked before they touch {cwd}</small></span></li>
                  <li><IconCheck size={13} /><span><strong>No silent overwrite</strong><small>Divergent work opens in a separate review worktree</small></span></li>
                </ul>
              </section>
              <label className="cloud-check-row"><input type="checkbox" checked={keepCloudCopy} onChange={(event) => setKeepCloudCopy(event.target.checked)} /><span><strong>Keep the cloud sandbox</strong><small>Leave the remote copy available after this Mac takes over.</small></span></label>
            </>
          ) : (
            <>
              <div className="cloud-route" aria-label={`Local to ${providerName} handoff route`}>
                <div className="cloud-route-endpoint">
                  <span className="cloud-route-icon"><IconLaptop size={18} /></span>
                  <span><small>Current runtime</small><strong>This Mac</strong></span>
                </div>
                <span className="cloud-route-arrow" aria-hidden><IconArrowRight size={16} /></span>
                <div className="cloud-route-endpoint is-destination">
                  <span className="cloud-route-icon"><IconCloud size={18} /></span>
                  <span><small>Destination</small><strong>{providerName} Cloud</strong></span>
                </div>
              </div>
              <section className="cloud-handoff-section" aria-labelledby="cloud-runtime-title">
                <div className="cloud-section-heading">
                  <div><span className="cloud-section-kicker">Cloud runtime</span><h3 id="cloud-runtime-title">Choose where Vibe keeps working</h3></div>
                  <span className={`cloud-boundary-state${busy ? " is-waiting" : ""}`}>{busy ? "Moves when idle" : "Ready to move"}</span>
                </div>
                <div className="cloud-provider-choice" role="radiogroup" aria-label="Cloud provider">
                  {(["e2b", "vercel"] as const).map((id) => {
                    const selected = provider === id;
                    const connected = settings?.providers[id].configured ?? false;
                    return (
                      <button key={id} type="button" role="radio" aria-checked={selected} className={`cloud-provider-option${selected ? " selected" : ""}`} onClick={() => setProvider(id)}>
                        <span className="cloud-provider-radio" aria-hidden>{selected ? <span /> : null}</span>
                        <span className="cloud-provider-copy"><strong>{id === "e2b" ? "E2B" : "Vercel"}</strong><small>{id === "e2b" ? "Persistent sandbox with pause and resume" : "Ephemeral compute through Vercel"}</small></span>
                        <span className={`cloud-provider-state${connected ? " is-connected" : ""}`}>{connected ? "Connected" : "Setup required"}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
              <section className="cloud-handoff-section cloud-boundary-section" aria-labelledby="cloud-boundary-title">
                <div className="cloud-section-heading"><div><span className="cloud-section-kicker">Transfer boundary</span><h3 id="cloud-boundary-title">Your complete working project moves</h3></div></div>
                <div className="cloud-boundary-columns">
                  <div><strong>Moves to Cloud</strong><ul><li>Conversation and session state</li><li>All project files, including Git-ignored files</li><li>{includeModelCredentials ? `Model ${model} and its configured access` : "Explicit Cloud credential bindings only"}</li><li>Git state and portable job commands</li></ul></div>
                  <div><strong>Stays on this Mac</strong><ul><li>.env files and machine credential stores</li><li>SSH/private keys and generated dependencies</li><li>Mac-only processes and tools</li></ul></div>
                </div>
              </section>
              <label className="cloud-check-row">
                <input type="checkbox" checked={includeModelCredentials} onChange={(event) => setIncludeModelCredentials(event.target.checked)} />
                <span>
                  <strong>Include model access</strong>
                  <small>{includeModelCredentials
                    ? "Seal configured provider keys and connected Codex/Grok subscription access for this session’s engine only. Cloud terminals cannot inherit it."
                    : "Use only explicit Cloud credential bindings. Handoff stops before upload if the model cannot authenticate."}</small>
                </span>
              </label>
              <label className="setting-field cloud-instruction-field">
                <span className="setting-label">Next task in Cloud <small>Optional</small></span>
                <textarea className="setting-textarea" rows={3} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="What should Vibe do after the handoff?" />
                <small className="cloud-field-help">Leave this empty to continue from the current conversation without starting a new task.</small>
              </label>
              <p className="cloud-cost-note" role="note"><strong>{providerName} and model usage may be billed</strong><span>Setup makes a tiny readiness call to each active model. The sandbox follows your Cloud auto-pause and deletion settings.</span></p>
            </>
          )}
          {resumeLocal && !cloudSession && <p className="settings-save-error" role="alert">This session is already running locally.</p>}
          {settings && !settings.experimentalEnabled && !resumeLocal && (
            <p className="cloud-cost-note" role="note">
              <strong>Cloud is experimental</strong>
              <span>Continuing enables it for this Mac. You can turn it off again in Settings → Cloud.</span>
            </p>
          )}
          {!configured && !resumeLocal && <p className="settings-save-error" role="alert">Connect and test {provider === "e2b" ? "E2B" : "Vercel"} in Settings → Cloud first.</p>}
          {error && <p className="settings-save-error" role="alert">{error}</p>}
          {failure && (
            <details className="cloud-failure-details">
              <summary>Technical details</summary>
              <pre>{`Stage: ${failure.stage}\nCode: ${failure.code}${failure.diagnostic ? `\n\n${failure.diagnostic}` : ""}`}</pre>
            </details>
          )}
          {recoveryRequired && (
            <p className="cloud-recovery-note" role="status">
              Close this review and open Settings → Cloud to resolve ownership safely before trying another handoff.
            </p>
          )}
          {!resumeLocal && working && (
            <section className="cloud-startup-progress" aria-label="Cloud handoff progress">
              <div className="cloud-progress-heading" role="status" aria-live="polite" aria-atomic="true">
                {working && <span className="spinner" aria-hidden />}
                <div>
                  <strong>{working ? progress?.message ?? "Starting cloud handoff…" : error ? "Cloud handoff stopped" : "Cloud handoff ready"}</strong>
                  {working && <span>{elapsedSeconds}s elapsed</span>}
                </div>
              </div>
              <div className="cloud-progress-track" aria-hidden>
                <span style={{ "--cloud-progress": progress?.progress ?? 0.03 } as CSSProperties} />
              </div>
              <ol className="cloud-stage-list">
                {CLOUD_STARTUP_STAGES.map((stage, index) => (
                  <li key={stage.id} className={index < activeStageIndex ? "is-complete" : index === activeStageIndex ? "is-active" : undefined}>
                    <span aria-hidden>{index < activeStageIndex ? "✓" : index === activeStageIndex ? "•" : ""}</span>
                    {stage.label}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>

        <footer className="cloud-handoff-footer">
          <button type="button" className="button" disabled={working} onClick={onClose}>{recoveryRequired ? "Close and recover in Settings" : resumeLocal ? "Keep running in Cloud" : "Keep running locally"}</button>
          <button type="button" className="button primary" disabled={working || recoveryRequired || (resumeLocal ? !cloudSession : (!settings || !configured))} onClick={() => void go()}>
            {resumeLocal
              ? working ? "Verifying and syncing…" : "Verify and resume locally"
              : cloudHandoffActionLabel(working, error, failure)}
          </button>
        </footer>
      </section>
    </div>
  );
}
