import { useEffect, useState } from "react";
import { NumberInput, SelectInput, SettingBadge, SettingField, SettingSection, TextArea, TextInput } from "../FormControls";
import type { SectionProps } from "./types";

export function ModelsSection({
  config,
  scope,
  updateConfig,
  updateNested,
  cwd,
  onInvalidDraftChange,
  draftResetVersion = 0,
}: SectionProps) {
  const reasoning = config.reasoning ?? {};
  return (
    <>
      <SettingSection title="Model Selection" description="Choose which model new sessions use.">
        <SettingField label="Default model" description="The primary model string (e.g. anthropic/claude-opus-4-8, openai/gpt-5.5, ollama/llama3.3).">
          <TextInput
            value={config.model ?? ""}
            onChange={(v) => updateConfig({ model: v || undefined })}
            placeholder="anthropic/claude-opus-4-8"
            monospace
          />
        </SettingField>
      </SettingSection>

      <details className="settings-advanced-panel">
        <summary>
          <span>Advanced model settings</span>
          <small>Planning, fallbacks, reasoning, timeouts, pricing, and context overrides</small>
        </summary>
        <div className="settings-advanced-panel-body">
      <SettingSection title="Model Routing" description="Optional models for special cases. Most people can keep the default model for everything.">
        <SettingField label="Planning model" description="Dedicated model for plan-mode turns. Unset = same as default.">
          <TextInput
            value={config.planModel ?? ""}
            onChange={(v) => updateConfig({ planModel: v || undefined })}
            placeholder="inherit default"
            monospace
          />
        </SettingField>
        <SettingField label="Model fallbacks" description="Failover chain (one per line). Used when the active model can't be resolved.">
          <TextArea
            value={(config.modelFallbacks ?? []).join("\n")}
            onChange={(v) => updateConfig({ modelFallbacks: v.split("\n").map((s) => s.trim()).filter(Boolean) })}
            placeholder={"openai/gpt-5.5\nollama/llama3.3"}
            rows={3}
            monospace
          />
        </SettingField>
      </SettingSection>

      <SettingSection title="Reasoning" description="Extended-thinking controls passed to providers that support them.">
        <SettingField label="Reasoning effort" description="Maps to OpenAI reasoningEffort / OpenRouter.">
          <SelectInput
            value={reasoning.effort ?? "default"}
            onChange={(v) => updateNested("reasoning", { effort: v === "default" ? undefined : v as "low" | "medium" | "high" })}
            options={[
              { value: "default", label: "Provider default" },
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
            ]}
          />
        </SettingField>
        <SettingField label="Budget tokens" description="Anthropic extended-thinking budget (tokens). Unset = provider default.">
          <NumberInput
            value={reasoning.budgetTokens}
            onChange={(v) => updateNested("reasoning", { budgetTokens: v })}
            min={1}
            placeholder="auto"
          />
        </SettingField>
      </SettingSection>

      <SettingSection title="Performance" description="Step and stream limits that bound agent behavior.">
        <SettingField label="Max steps per turn" description="Hard cap on agentic steps in a single turn.">
          <NumberInput
            value={config.maxSteps}
            onChange={(v) => updateConfig({ maxSteps: v })}
            min={1}
            placeholder="64"
          />
        </SettingField>
        <SettingField label="Stream idle timeout (ms)" description="Watchdog for stalled provider streams (headless only). 0 = disabled.">
          <NumberInput
            value={config.streamIdleTimeoutMs}
            onChange={(v) => updateConfig({ streamIdleTimeoutMs: v })}
            min={0}
            step={1000}
            placeholder="600000"
          />
        </SettingField>
        <SettingField label="Queued item timeout (ms)" description="Ultimate safety net for a stuck queued turn or continuation. 0 = disabled.">
          <NumberInput
            value={config.itemTimeoutMs}
            onChange={(v) => updateConfig({ itemTimeoutMs: v })}
            min={0}
            step={1000}
            placeholder="1800000"
          />
        </SettingField>
      </SettingSection>

      <SettingSection title="Pricing Overrides" description="Per-model price overrides keyed by model string (provider/model), in USD per 1M tokens. Overrides catalog pricing for cost tracking.">
        <PricingEditor
          config={config}
          updateConfig={updateConfig}
          draftKey={`models:${scope}:${cwd ?? ""}:pricing-key`}
          draftResetVersion={draftResetVersion}
          onInvalidDraftChange={onInvalidDraftChange}
        />
      </SettingSection>

      <SettingSection title="Context Window Overrides" description="Per-model context-window overrides (tokens). Pins the real window for a model the catalog doesn't know, driving accurate context-fill % and compaction.">
        <ContextWindowEditor
          config={config}
          updateConfig={updateConfig}
          draftKey={`models:${scope}:${cwd ?? ""}:context-key`}
          draftResetVersion={draftResetVersion}
          onInvalidDraftChange={onInvalidDraftChange}
        />
      </SettingSection>
        </div>
      </details>
    </>
  );
}

function PricingEditor({
  config,
  updateConfig,
  draftKey,
  draftResetVersion,
  onInvalidDraftChange,
}: Pick<SectionProps, "config" | "updateConfig" | "onInvalidDraftChange"> & {
  draftKey: string;
  draftResetVersion: number;
}) {
  const pricing = config.pricing ?? {};
  const modelKeys = Object.keys(pricing);
  const [newKey, setNewKey] = useState("");

  useEffect(() => {
    const pending = Boolean(newKey.trim());
    onInvalidDraftChange?.(draftKey, pending);
    return () => onInvalidDraftChange?.(draftKey, false);
  }, [draftKey, newKey, onInvalidDraftChange]);
  useEffect(() => setNewKey(""), [draftKey, draftResetVersion]);

  const update = (model: string, patch: Partial<NonNullable<typeof pricing[string]>>) => {
    const next = { ...pricing, [model]: { ...pricing[model], ...patch } };
    updateConfig({ pricing: next });
  };
  const remove = (model: string) => {
    const next = { ...pricing };
    delete next[model];
    updateConfig({ pricing: next });
  };
  const add = () => {
    const key = newKey.trim();
    if (!key || pricing[key]) return;
    update(key, {});
    setNewKey("");
  };

  return (
    <>
      {modelKeys.length === 0 && (
        <p className="setting-empty">No pricing overrides. Add a model to pin its cost.</p>
      )}
      {modelKeys.length > 0 && (
        <div className="setting-list">
          {modelKeys.map((model) => {
            const price = pricing[model] ?? {};
            return (
              <div key={model} className="setting-card expanded">
                <div className="setting-card-header">
                  <span className="setting-card-title">{model}</span>
                  <button type="button" className="button danger" onClick={() => remove(model)}>Remove</button>
                </div>
                <div className="setting-card-body">
                  <SettingField label="Input ($/1M tokens)">
                    <NumberInput value={price.input} onChange={(v) => update(model, { input: v })} min={0} step={0.01} placeholder="catalog" />
                  </SettingField>
                  <SettingField label="Output ($/1M tokens)">
                    <NumberInput value={price.output} onChange={(v) => update(model, { output: v })} min={0} step={0.01} placeholder="catalog" />
                  </SettingField>
                  <SettingField label="Cache read ($/1M tokens)" description="Defaults to input when unset.">
                    <NumberInput value={price.cacheRead} onChange={(v) => update(model, { cacheRead: v })} min={0} step={0.01} placeholder="input" />
                  </SettingField>
                  <SettingField label="Cache write ($/1M tokens)" description="Defaults to input when unset.">
                    <NumberInput value={price.cacheWrite} onChange={(v) => update(model, { cacheWrite: v })} min={0} step={0.01} placeholder="input" />
                  </SettingField>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="git-create-row">
        <input
          type="text"
          className="setting-input is-mono"
          value={newKey}
          placeholder="provider/model-id"
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setNewKey("");
            }
          }}
        />
        <button type="button" className="button primary" disabled={!newKey.trim() || Boolean(pricing[newKey.trim()])} onClick={add}>Add</button>
      </div>
    </>
  );
}

function ContextWindowEditor({
  config,
  updateConfig,
  draftKey,
  draftResetVersion,
  onInvalidDraftChange,
}: Pick<SectionProps, "config" | "updateConfig" | "onInvalidDraftChange"> & {
  draftKey: string;
  draftResetVersion: number;
}) {
  const ctx = config.contextWindow ?? {};
  const modelKeys = Object.keys(ctx);
  const [newKey, setNewKey] = useState("");

  useEffect(() => {
    const pending = Boolean(newKey.trim());
    onInvalidDraftChange?.(draftKey, pending);
    return () => onInvalidDraftChange?.(draftKey, false);
  }, [draftKey, newKey, onInvalidDraftChange]);
  useEffect(() => setNewKey(""), [draftKey, draftResetVersion]);

  const update = (model: string, value: number | undefined) => {
    const next = { ...ctx };
    if (value === undefined) delete next[model];
    else next[model] = value;
    updateConfig({ contextWindow: next });
  };
  const add = () => {
    const key = newKey.trim();
    if (!key || ctx[key]) return;
    update(key, 128_000);
    setNewKey("");
  };

  return (
    <>
      {modelKeys.length === 0 && (
        <p className="setting-empty">No context-window overrides. Add a model to pin its window.</p>
      )}
      {modelKeys.length > 0 && (
        <div className="setting-list">
          {modelKeys.map((model) => (
            <div key={model} className="setting-perm-rule">
              <SettingBadge>{model}</SettingBadge>
              <NumberInput value={ctx[model]} onChange={(v) => update(model, v)} min={1} step={1000} placeholder="tokens" />
              <button type="button" className="button danger" onClick={() => update(model, undefined)}>Remove</button>
            </div>
          ))}
        </div>
      )}
      <div className="git-create-row">
        <input
          type="text"
          className="setting-input is-mono"
          value={newKey}
          placeholder="provider/model-id"
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setNewKey("");
            }
          }}
        />
        <button type="button" className="button primary" disabled={!newKey.trim() || Boolean(ctx[newKey.trim()])} onClick={add}>Add</button>
      </div>
    </>
  );
}
