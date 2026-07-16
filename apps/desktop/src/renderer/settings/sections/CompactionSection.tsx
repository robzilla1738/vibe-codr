import {
  effectiveCompactionThresholds,
  formatThresholdPercent,
} from "../../../shared/compaction-thresholds";
import { NumberInput, SettingField, SettingSection, ToggleSwitch } from "../FormControls";
import type { SectionProps } from "./types";

export function CompactionSection({ config, updateNested }: SectionProps) {
  const compaction = config.compaction ?? {};
  const offload = compaction.offload ?? {};
  const thresholds = effectiveCompactionThresholds(compaction.threshold, offload.threshold);
  return (
    <SettingSection title="Compaction" description="Context-window management: lossless offload fires below the lossy summary threshold.">
      <SettingField label="Summary threshold" description="Fraction of context window at which to auto-compact (LLM summary).">
        <NumberInput value={compaction.threshold} onChange={(v) => updateNested("compaction", { threshold: v })} min={0.1} max={0.95} step={0.05} placeholder="0.75" />
      </SettingField>
      <SettingField label="Enable offload" description="Mid-turn microcompaction: bulky tool results offloaded to artifacts with preview left in context.">
        <ToggleSwitch checked={offload.enabled ?? true} onChange={(v) => updateNested("compaction", { offload: { enabled: v } })} />
      </SettingField>
      <SettingField label="Offload threshold" description="Fraction at which offload fires (below summary threshold).">
        <div className="setting-control-stack">
          <NumberInput value={offload.threshold} onChange={(v) => updateNested("compaction", { offload: { threshold: v } })} min={0.1} max={0.9} step={0.05} placeholder="0.6" />
          {thresholds?.adjusted ? (
            <p className="setting-effective-note" role="status">
              Effective threshold: {formatThresholdPercent(thresholds.effectiveOffload)}. The engine keeps lossless offload below the {formatThresholdPercent(thresholds.summary)} summary threshold.
            </p>
          ) : null}
        </div>
      </SettingField>
      <SettingField label="Max result bytes" description="Results at or above this many chars are offload-eligible.">
        <NumberInput value={offload.maxResultBytes} onChange={(v) => updateNested("compaction", { offload: { maxResultBytes: v } })} min={1} placeholder="16384" />
      </SettingField>
      <SettingField label="Preview bytes" description="Inline preview kept in context per offloaded result.">
        <NumberInput value={offload.previewBytes} onChange={(v) => updateNested("compaction", { offload: { previewBytes: v } })} min={1} placeholder="2048" />
      </SettingField>
      <SettingField label="Keep live results" description="Never offload the most recent N tool results.">
        <NumberInput value={offload.keepLiveResults} onChange={(v) => updateNested("compaction", { offload: { keepLiveResults: v } })} min={0} placeholder="2" />
      </SettingField>
      <SettingField label="Max artifact bytes" description="Cap on total on-disk offload artifacts per session (bytes). Oldest non-live artifacts evicted above this.">
        <NumberInput value={offload.maxArtifactBytes} onChange={(v) => updateNested("compaction", { offload: { maxArtifactBytes: v } })} min={1} step={1048576} placeholder="67108864" />
      </SettingField>
    </SettingSection>
  );
}
