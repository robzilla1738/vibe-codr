import type { SectionProps } from "./types";
import { NumberInput, SettingField, SettingSection, TextInput } from "../FormControls";

export function SubagentsSection({ config, updateNested }: SectionProps) {
  const sa = config.subagent ?? {};
  return (
    <SettingSection title="Subagents" description="Limits and model tiers for spawned subagents. Each is a fresh agent with its own context.">
      <SettingField label="Max depth" description="Maximum nesting depth for subagent spawning.">
        <NumberInput value={sa.maxDepth} onChange={(v) => updateNested("subagent", { maxDepth: v })} min={1} placeholder="3" />
      </SettingField>
      <SettingField label="Max parallel" description="Max subagents one agent runs concurrently (fan-out cap).">
        <NumberInput value={sa.maxParallel} onChange={(v) => updateNested("subagent", { maxParallel: v })} min={1} placeholder="8" />
      </SettingField>
      <SettingField label="Max total" description="Hard ceiling on total subagents across a session tree.">
        <NumberInput value={sa.maxTotal} onChange={(v) => updateNested("subagent", { maxTotal: v })} min={1} placeholder="200" />
      </SettingField>
      <SettingField label="Provider concurrency" description="Tree-global ceiling on concurrent provider calls.">
        <NumberInput value={sa.providerConcurrency} onChange={(v) => updateNested("subagent", { providerConcurrency: v })} min={1} placeholder="16" />
      </SettingField>
      <SettingField label="Timeout (ms)" description="Per-subagent wall-clock timeout. 0 = disabled.">
        <NumberInput value={sa.timeoutMs} onChange={(v) => updateNested("subagent", { timeoutMs: v })} min={0} step={1000} placeholder="300000" />
      </SettingField>
      <SettingField label="Verify max attempts" description="Max re-runs for verify→retry tasks.">
        <NumberInput value={sa.verifyMaxAttempts} onChange={(v) => updateNested("subagent", { verifyMaxAttempts: v })} min={1} max={5} placeholder="2" />
      </SettingField>
      <SettingField label="Retain completed" description="How many completed children to retain for continuation. 0 = disabled.">
        <NumberInput value={sa.retainCompleted} onChange={(v) => updateNested("subagent", { retainCompleted: v })} min={0} placeholder="16" />
      </SettingField>
      <SettingField label="Structured max attempts" description="Max attempts to coerce a subagent's final message into schema-valid JSON when outputSchema is set.">
        <NumberInput value={sa.structuredMaxAttempts} onChange={(v) => updateNested("subagent", { structuredMaxAttempts: v })} min={1} placeholder="2" />
      </SettingField>
      <SettingField label="Max detached" description="Max concurrent background (detached) subagents.">
        <NumberInput value={sa.maxDetached} onChange={(v) => updateNested("subagent", { maxDetached: v })} min={0} placeholder="8" />
      </SettingField>
      <SettingField label="Default model" description="Dedicated model for subagents. Unset = inherit main model.">
        <TextInput
          value={sa.model ?? ""}
          onChange={(v) => updateNested("subagent", { model: v || undefined })}
          placeholder="inherit main"
          monospace
        />
      </SettingField>
    </SettingSection>
  );
}
