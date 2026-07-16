import { useEffect, useState } from "react";
import { pluginSpecifiersFromLines } from "../../../shared/plugin-specifiers";
import { NumberInput, SettingField, SettingSection, TextArea, TextInput, ToggleSwitch } from "../FormControls";
import type { SectionProps } from "./types";

export function AdvancedSection({
  config,
  scope,
  updateConfig,
  updateNested,
  cwd,
  onInvalidDraftChange,
  draftResetVersion = 0,
}: SectionProps) {
  const lsp = config.lsp ?? {};
  const lspServers = lsp.servers ?? {};
  const vision = config.vision?.relay ?? {};
  const [newLspLanguage, setNewLspLanguage] = useState("");
  const lspDraftKey = `advanced:${scope}:${cwd ?? ""}:lsp-language`;

  useEffect(() => {
    const pending = Boolean(newLspLanguage.trim());
    onInvalidDraftChange?.(lspDraftKey, pending);
    return () => onInvalidDraftChange?.(lspDraftKey, false);
  }, [lspDraftKey, newLspLanguage, onInvalidDraftChange]);
  useEffect(() => setNewLspLanguage(""), [scope, cwd, draftResetVersion]);

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
