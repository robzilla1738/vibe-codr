import { useEffect, useState } from "react";
import { PERFORMANCE_PHASES, type PerformanceSummary } from "../../../shared/performance";
import { pluginSpecifiersFromLines } from "../../../shared/plugin-specifiers";
import type { PluginStatus } from "../../../shared/protocol";
import { NumberInput, SelectInput, SettingActions, SettingBadge, SettingField, SettingSection, TextArea, TextInput, ToggleSwitch } from "../FormControls";
import type { SectionProps } from "./types";

export function AdvancedSection({
  config,
  scope,
  updateConfig,
  updateNested,
  cwd,
  active = false,
  runtimeIdentity = "",
  onInvalidDraftChange,
  draftResetVersion = 0,
  showToast,
}: SectionProps) {
  const lsp = config.lsp ?? {};
  const lspServers = lsp.servers ?? {};
  const vision = config.vision?.relay ?? {};
  const [newLspLanguage, setNewLspLanguage] = useState("");
  const [performanceSummaries, setPerformanceSummaries] = useState<{
    day: PerformanceSummary;
    week: PerformanceSummary;
  } | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [copyingDiagnostics, setCopyingDiagnostics] = useState(false);
  const [pluginStatuses, setPluginStatuses] = useState<PluginStatus[]>([]);
  const [pluginHealthError, setPluginHealthError] = useState<string | null>(null);
  const [localCapacity, setLocalCapacity] = useState(3);
  const [capacitySaving, setCapacitySaving] = useState(false);
  const lspDraftKey = `advanced:${scope}:${cwd ?? ""}:lsp-language`;

  useEffect(() => {
    const pending = Boolean(newLspLanguage.trim());
    onInvalidDraftChange?.(lspDraftKey, pending);
    return () => onInvalidDraftChange?.(lspDraftKey, false);
  }, [lspDraftKey, newLspLanguage, onInvalidDraftChange]);
  useEffect(() => setNewLspLanguage(""), [scope, cwd, draftResetVersion]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    setPerformanceSummaries(null);
    setDiagnosticsError(null);
    void Promise.all([
      window.vibe.getPerformanceSummary({ days: 1 }),
      window.vibe.getPerformanceSummary({ days: 7 }),
    ]).then(([day, week]) => {
      if (!current) return;
      if (!day.ok) throw new Error(day.error);
      if (!week.ok) throw new Error(week.error);
      setPerformanceSummaries({ day: day.value, week: week.value });
      setDiagnosticsError(null);
    }).catch((error) => {
      if (current) setDiagnosticsError(error instanceof Error ? error.message : String(error));
    });
    return () => { current = false; };
  }, [active, cwd, runtimeIdentity]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void window.vibe.localRuntimeSettings().then((result) => {
      if (current && result.ok) setLocalCapacity(result.value.capacity);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [active]);

  const updateLocalCapacity = async (value: string) => {
    const capacity = Number(value);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8 || capacitySaving) return;
    setCapacitySaving(true);
    try {
      const result = await window.vibe.updateLocalRuntimeSettings({ capacity });
      if (!result.ok) throw new Error(result.error);
      setLocalCapacity(result.value.capacity);
      showToast?.(`Local runtime capacity set to ${result.value.capacity}`, "info");
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : "Couldn’t update local runtime capacity", "error");
    } finally {
      setCapacitySaving(false);
    }
  };
  useEffect(() => {
    if (!active) return;
    let current = true;
    setPluginStatuses([]);
    setPluginHealthError(null);
    void window.vibe.rpc("listPluginStatus").then((result) => {
      if (!current) return;
      if (result.ok) {
        setPluginStatuses(result.value as PluginStatus[]);
        setPluginHealthError(null);
      } else setPluginHealthError(result.error);
    }).catch((error) => {
      if (current) setPluginHealthError(error instanceof Error ? error.message : String(error));
    });
    return () => { current = false; };
  }, [active, cwd, runtimeIdentity]);

  const copyDiagnostics = async () => {
    if (copyingDiagnostics) return;
    setCopyingDiagnostics(true);
    try {
      const result = await window.vibe.exportDiagnosticsBundle();
      if (!result.ok) throw new Error(result.error);
      const copied = await window.vibe.writeClipboardText(JSON.stringify(result.value, null, 2));
      if (!copied.ok) throw new Error(copied.error);
      showToast?.("Local diagnostics copied", "info");
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : "Couldn’t copy diagnostics", "error");
    } finally {
      setCopyingDiagnostics(false);
    }
  };

  const updateLspServer = (
    language: string,
    patch: Partial<NonNullable<typeof lspServers[string]>>,
  ) => {
    updateNested("lsp", {
      servers: {
        ...lspServers,
        [language]: { ...lspServers[language], ...patch },
      },
    });
  };

  const removeLspServer = (language: string) => {
    const next = { ...lspServers };
    delete next[language];
    updateNested("lsp", { servers: next });
  };

  const addLspServer = () => {
    const language = newLspLanguage.trim();
    if (!language || lspServers[language]) return;
    updateLspServer(language, {});
    setNewLspLanguage("");
  };
  return (
    <>
      <SettingSection title="Desktop runtime pool" description="Keep local sessions alive in the background without exceeding this machine's safe engine-host capacity.">
        <SettingField label="Local capacity" description="One through eight. Changes apply immediately; protected foreground, working, review, input, and job-owning sessions are never stopped.">
          <SelectInput
            value={String(localCapacity)}
            onChange={(value) => void updateLocalCapacity(value)}
            disabled={capacitySaving}
            options={Array.from({ length: 8 }, (_, index) => {
              const value = String(index + 1);
              return { value, label: `${value} runtime${value === "1" ? "" : "s"}` };
            })}
          />
        </SettingField>
      </SettingSection>

      <SettingSection title="Plugins" description="NPM module specifiers or local paths for trusted engine plugins.">
        <SettingField label="Plugin modules" description="One per line. Plugins execute code with the agent's privileges at startup; project plugins are ignored unless project config is globally trusted.">
          <TextArea
            value={(config.plugins ?? []).join("\n")}
            onChange={(v) => updateConfig({ plugins: pluginSpecifiersFromLines(v) })}
            placeholder={"vibe-codr-jira\n./plugins/custom.ts"}
            rows={3}
            monospace
          />
        </SettingField>
        <SettingField label="Adaptive tool discovery" description="Auto keeps core and explicitly named tools visible, and defers only large MCP/plugin catalogs. Direct submits the full catalog on every turn.">
          <ToggleSwitch
            checked={(config.toolDiscovery?.mode ?? "auto") === "auto"}
            onChange={(enabled) => updateConfig({
              toolDiscovery: { ...(config.toolDiscovery ?? {}), mode: enabled ? "auto" : "direct" },
            })}
          />
        </SettingField>
        <SettingField label="Always-visible tools" description="Exact MCP/plugin tool names, one per line.">
          <TextArea
            value={(config.toolDiscovery?.directTools ?? []).join("\n")}
            onChange={(value) => updateConfig({
              toolDiscovery: {
                ...(config.toolDiscovery ?? {}),
                directTools: value.split("\n").map((tool) => tool.trim()).filter(Boolean),
              },
            })}
            rows={3}
            monospace
          />
        </SettingField>
        {pluginHealthError ? <p className="setting-empty" role="status">Plugin health unavailable: {pluginHealthError}</p> : null}
        {pluginStatuses.length > 0 ? (
          <div className="setting-list" aria-label="Loaded plugin health">
            {pluginStatuses.map((plugin) => {
              const registeredCount = Object.values(plugin.registeredContributions).reduce(
                (total, contributions) => total + contributions.length,
                0,
              );
              const tone = plugin.status === "degraded" ? "warn" : plugin.status === "loaded" ? "neutral" : "danger";
              return (
                <div key={plugin.specifier} className="setting-card expanded">
                  <div className="setting-card-header">
                    <span className="setting-card-title">{plugin.name}</span>
                    <SettingBadge tone={tone}>{plugin.status}</SettingBadge>
                  </div>
                  <div className="setting-card-body">
                    <SettingField
                      label={plugin.version ? `Version ${plugin.version}` : "Version unavailable"}
                      description={plugin.reason ?? `${registeredCount} registered contribution${registeredCount === 1 ? "" : "s"}.`}
                    >
                      <span>{plugin.provenance.source === "npm" && plugin.provenance.verified ? "verified package" : "unverified local code"}</span>
                    </SettingField>
                  </div>
                </div>
              );
            })}
          </div>
        ) : config.plugins?.length ? (
          <p className="setting-empty">No plugin status is available from the active engine yet.</p>
        ) : null}
      </SettingSection>

      <SettingSection title="Local Diagnostics" description="Content-free, machine-local performance history. No prompts, paths, credentials, tool inputs, or outputs are recorded or transmitted.">
        {diagnosticsError ? <p className="setting-empty" role="status">Diagnostics unavailable: {diagnosticsError}</p> : null}
        {performanceSummaries ? (
          <div className="setting-card expanded">
            <div className="setting-card-body">
              <SettingField label="Last 24 hours" description={`${performanceSummaries.day.turnCount} measured turn${performanceSummaries.day.turnCount === 1 ? "" : "s"}.`}>
                <span>
                  {performanceSummaries.day.dominantBottleneck
                    ? `${performanceSummaries.day.dominantBottleneck.phase.replaceAll("-", " ")} · p95 ${formatDuration(performanceSummaries.day.dominantBottleneck.p95Ms)}`
                    : "No completed measurements yet"}
                </span>
              </SettingField>
              <SettingField label="Last 7 days" description={`${performanceSummaries.week.turnCount} measured turn${performanceSummaries.week.turnCount === 1 ? "" : "s"}.`}>
                <span>
                  {performanceSummaries.week.dominantBottleneck
                    ? `${performanceSummaries.week.dominantBottleneck.phase.replaceAll("-", " ")} · p95 ${formatDuration(performanceSummaries.week.dominantBottleneck.p95Ms)}`
                    : "No completed measurements yet"}
                </span>
              </SettingField>
              {PERFORMANCE_PHASES.map((phase) => (
                <SettingField key={phase} label={performancePhaseLabel(phase)} description="7-day p50 / p95">
                  <span>{formatPercentiles(performanceSummaries.week.phases[phase])}</span>
                </SettingField>
              ))}
              <SettingField label="Tool schema" description="Estimated tokens · p50 / p95">
                <span>{formatPlainPercentiles(performanceSummaries.week.toolSchemaTokens)}</span>
              </SettingField>
            </div>
          </div>
        ) : null}
        <SettingActions>
          <button type="button" className="button" disabled={copyingDiagnostics} onClick={() => void copyDiagnostics()}>
            {copyingDiagnostics ? "Copying…" : "Copy diagnostics"}
          </button>
        </SettingActions>
      </SettingSection>

      <SettingSection title="LSP Diagnostics" description="Multi-language language-server diagnostics-in-the-loop after edits.">
        <SettingField label="Enable LSP">
          <ToggleSwitch checked={lsp.enabled ?? true} onChange={(v) => updateNested("lsp", { enabled: v })} />
        </SettingField>
        <SettingField label="Per-diagnose timeout (ms)" description="A slow server never blocks an edit past this.">
          <NumberInput value={lsp.timeoutMs} onChange={(v) => updateNested("lsp", { timeoutMs: v })} min={0} placeholder="2000" />
        </SettingField>
        <SettingField label="Idle server shutdown (ms)" description="Unused server killed after this long, re-spawned lazily.">
          <NumberInput value={lsp.idleShutdownMs} onChange={(v) => updateNested("lsp", { idleShutdownMs: v })} min={0} step={1000} placeholder="300000" />
        </SettingField>
        <SettingField label="Disabled languages" description="Never start a server for these (one per line: py, go, rust, …).">
          <TextArea
            value={(lsp.disabledLanguages ?? []).join("\n")}
            onChange={(v) => updateNested("lsp", { disabledLanguages: v.split("\n").map((s) => s.trim()).filter(Boolean) })}
            placeholder={"py\ngo"}
            rows={3}
            monospace
          />
        </SettingField>
      </SettingSection>

      <SettingSection title="LSP Server Overrides" description="Override the executable, arguments, or enabled state for a language key. Empty overrides keep the engine's built-in candidates.">
        {Object.keys(lspServers).length === 0 ? (
          <p className="setting-empty">No language-server overrides.</p>
        ) : (
          <div className="setting-list">
            {Object.entries(lspServers).map(([language, server]) => (
              <div key={language} className="setting-card expanded">
                <div className="setting-card-header">
                  <span className="setting-card-title">{language}</span>
                  <button type="button" className="button danger" onClick={() => removeLspServer(language)}>Remove</button>
                </div>
                <div className="setting-card-body">
                  <SettingField label="Command" description="Executable only. Leave empty to use the engine's detected default.">
                    <TextInput
                      value={server.command ?? ""}
                      onChange={(command) => updateLspServer(language, { command: command || undefined })}
                      placeholder="pyright-langserver"
                      monospace
                    />
                  </SettingField>
                  <SettingField label="Arguments" description="One argument per line. An empty list uses the built-in candidate's arguments.">
                    <TextArea
                      value={(server.args ?? []).join("\n")}
                      onChange={(value) => updateLspServer(language, {
                        args: value.split("\n").map((arg) => arg.trim()).filter(Boolean),
                      })}
                      placeholder={"--stdio"}
                      rows={3}
                      monospace
                    />
                  </SettingField>
                  <SettingField label="Enabled" description="Disable only this language without adding it to the global disabled list.">
                    <ToggleSwitch
                      checked={server.enabled ?? true}
                      onChange={(enabled) => updateLspServer(language, { enabled })}
                    />
                  </SettingField>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="git-create-row">
          <input
            type="text"
            className="setting-input is-mono"
            value={newLspLanguage}
            placeholder="language key (e.g. py, go, rust)"
            onChange={(event) => setNewLspLanguage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addLspServer();
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setNewLspLanguage("");
              }
            }}
          />
          <button
            type="button"
            className="button primary"
            disabled={!newLspLanguage.trim() || Boolean(lspServers[newLspLanguage.trim()])}
            onClick={addLspServer}
          >
            Add override
          </button>
        </div>
      </SettingSection>

      <SettingSection title="Vision Relay" description="Caption attached images via a vision-capable relay model when the primary model can't see images.">
        <SettingField label="Enable vision relay">
          <ToggleSwitch checked={vision.enabled ?? false} onChange={(v) => updateConfig({ vision: { relay: { ...vision, enabled: v } } })} />
        </SettingField>
        <SettingField label="Relay model" description="Vision-capable model (e.g. openai/gpt-4o, ollama/llama3.2-vision).">
          <TextInput
            value={vision.relayModel ?? ""}
            onChange={(v) => updateConfig({ vision: { relay: { ...vision, relayModel: v || undefined } } })}
            placeholder="openai/gpt-4o"
            monospace
          />
        </SettingField>
        <SettingField label="Timeout (ms)">
          <NumberInput value={vision.timeoutMs} onChange={(v) => updateConfig({ vision: { relay: { ...vision, timeoutMs: v } } })} min={1} placeholder="30000" />
        </SettingField>
        <SettingField label="Max caption chars">
          <NumberInput value={vision.maxCaptionChars} onChange={(v) => updateConfig({ vision: { relay: { ...vision, maxCaptionChars: v } } })} min={1} placeholder="2000" />
        </SettingField>
      </SettingSection>

      <SettingSection title="Verify" description="Self-verification command run after edit turns.">
        <SettingField label="Verify command" description="Shell command (e.g. 'bun run typecheck && bun test').">
          <TextInput
            value={config.verify?.command ?? ""}
            onChange={(v) => updateConfig({ verify: { ...(config.verify ?? {}), command: v || undefined } })}
            placeholder="bun run typecheck && bun test"
            monospace
          />
        </SettingField>
        <SettingField label="Auto-verify" description="Feed failures back so the agent self-corrects.">
          <ToggleSwitch
            checked={config.verify?.auto ?? false}
            onChange={(v) => updateConfig({ verify: { ...(config.verify ?? {}), auto: v } })}
          />
        </SettingField>
        <SettingField label="Max retries">
          <NumberInput
            value={config.verify?.maxRetries}
            onChange={(v) => updateConfig({ verify: { ...(config.verify ?? {}), maxRetries: v } })}
            min={0} max={10} placeholder="2"
          />
        </SettingField>
      </SettingSection>

      <SettingSection title="Update Check" description="Startup check for newer vibe-codr releases.">
        <SettingField label="Check for updates" description="Cached 24h lookup of the latest GitHub release. $VIBE_NO_UPDATE_CHECK also disables.">
          <ToggleSwitch
            checked={config.update?.check ?? true}
            onChange={(v) => updateConfig({ update: { check: v } })}
          />
        </SettingField>
      </SettingSection>

      <SettingSection title="Goal & Loop" description="Autonomous run and loop defaults.">
        <SettingField label="Goal max rounds" description="Continuation round budget for /goal.">
          <NumberInput
            value={config.goal?.maxRounds}
            onChange={(v) => updateNested("goal", { maxRounds: v })}
            min={1} max={100} placeholder="10"
          />
        </SettingField>
        <SettingField label="Goal plan first" description="Run a dedicated read-only plan turn before execution.">
          <ToggleSwitch
            checked={config.goal?.planFirst ?? true}
            onChange={(v) => updateNested("goal", { planFirst: v })}
          />
        </SettingField>
        <SettingField label="Loop default max" description="Default iteration cap for /loop. 0 = unlimited.">
          <NumberInput
            value={config.loop?.defaultMax}
            onChange={(v) => updateNested("loop", { defaultMax: v })}
            min={0} max={1000} placeholder="12"
          />
        </SettingField>
        <SettingField label="Loop max eval failures" description="Consecutive --until failures before loop stops.">
          <NumberInput
            value={config.loop?.maxUntilEvalFailures}
            onChange={(v) => updateNested("loop", { maxUntilEvalFailures: v })}
            min={1} max={50} placeholder="5"
          />
        </SettingField>
      </SettingSection>

      <SettingSection title="Orchestration" description="Deterministic task-DAG scheduling (spawn_tasks tool).">
        <SettingField label="Enable orchestration">
          <ToggleSwitch
            checked={config.orchestration?.enabled ?? true}
            onChange={(v) => updateConfig({ orchestration: { enabled: v } })}
          />
        </SettingField>
      </SettingSection>
    </>
  );
}

function formatDuration(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}s` : `${Math.round(value)}ms`;
}

function formatPercentiles(value: PerformanceSummary["phases"][keyof PerformanceSummary["phases"]]): string {
  return value ? `${formatDuration(value.p50)} / ${formatDuration(value.p95)}` : "Not measured";
}

function formatPlainPercentiles(value: PerformanceSummary["toolSchemaTokens"]): string {
  return value ? `${Math.round(value.p50).toLocaleString()} / ${Math.round(value.p95).toLocaleString()}` : "Not measured";
}

function performancePhaseLabel(phase: (typeof PERFORMANCE_PHASES)[number]): string {
  const labels: Record<(typeof PERFORMANCE_PHASES)[number], string> = {
    "host-spawn": "Host spawn",
    "host-ready": "Host ready",
    snapshot: "Snapshot",
    replay: "Event replay",
    "provider-ttft": "Provider first token",
    generation: "Generation",
    "tool-execution": "Tool execution",
    "bridge-delay": "Bridge delay",
    "first-paint": "First paint",
  };
  return labels[phase];
}
