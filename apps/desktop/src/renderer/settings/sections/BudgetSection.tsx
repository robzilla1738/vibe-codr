import type { SectionProps } from "./types";
import { NumberInput, SelectInput, SettingField, SettingSection, ToggleSwitch } from "../FormControls";

export function BudgetSection({ config, updateConfig, updateNested }: SectionProps) {
  const budget = config.budget ?? {};
  const retry = config.retry ?? {};
  const caching = config.caching ?? {};
  return (
    <>
      <SettingSection title="Spend Guard" description="When cumulative session cost crosses the limit, warn or stop. No limit = unbounded.">
        <SettingField label="Limit (USD)" description="Spend threshold. Leave empty for unbounded.">
          <NumberInput value={budget.limitUSD} onChange={(v) => updateNested("budget", { limitUSD: v })} min={0.01} step={0.01} placeholder="unbounded" />
        </SettingField>
        <SettingField label="On exceed" description="What happens when the limit is crossed.">
          <SelectInput
            value={budget.onExceed ?? "warn"}
            onChange={(v) => updateNested("budget", { onExceed: v as "warn" | "stop" })}
            options={[
              { value: "warn", label: "Warn — emit a notice" },
              { value: "stop", label: "Stop — also abort the turn" },
            ]}
          />
        </SettingField>
      </SettingSection>

      <SettingSection title="Retry Policy" description="Transient-error retry for provider calls (network / 429 / 5xx).">
        <SettingField label="Max attempts" description="Total tries including the initial call.">
          <NumberInput value={retry.maxAttempts} onChange={(v) => updateNested("retry", { maxAttempts: v })} min={0} max={10} placeholder="2" />
        </SettingField>
        <SettingField label="Base delay (ms)" description="Exponential backoff base.">
          <NumberInput value={retry.baseDelayMs} onChange={(v) => updateNested("retry", { baseDelayMs: v })} min={0} max={60000} placeholder="500" />
        </SettingField>
      </SettingSection>

      <SettingSection title="Prompt Caching" description="Send the stable system prefix with provider cache markers so repeated turns reuse it.">
        <SettingField label="Enable caching">
          <ToggleSwitch checked={caching.enabled ?? true} onChange={(v) => updateConfig({ caching: { ...caching, enabled: v } })} />
        </SettingField>
        <SettingField label="Cache tools block" description="Cache breakpoint on the tool block (schemas are large and stable).">
          <ToggleSwitch checked={caching.cacheTools ?? true} onChange={(v) => updateConfig({ caching: { ...caching, cacheTools: v } })} />
        </SettingField>
        <SettingField label="Cache conversation prefix" description="Cache breakpoint on the trailing conversation prefix each turn.">
          <ToggleSwitch checked={caching.cacheConversation ?? true} onChange={(v) => updateConfig({ caching: { ...caching, cacheConversation: v } })} />
        </SettingField>
      </SettingSection>
    </>
  );
}
