import type { SectionProps } from "./types";
import { SettingField, SettingSection, TextInput, ToggleSwitch } from "../FormControls";

export function MemorySection({ config, updateNested }: SectionProps) {
  const memory = config.memory ?? {};
  const semantic = memory.semantic ?? {};
  return (
    <SettingSection title="Memory" description="Long-term memory: semantic recall, proactive injection, and session digests for cross-session continuity.">
      <SettingField label="Semantic recall" description="Embedding-based recall fused with lexical BM25. Needs optional @huggingface/transformers for local embeddings.">
        <ToggleSwitch
          checked={semantic.enabled ?? true}
          onChange={(v) => updateNested("memory", { semantic: { enabled: v } })}
        />
      </SettingField>
      <SettingField label="Embedding model" description="local for on-device ONNX, or provider/model for a cloud embedder.">
        <TextInput
          value={semantic.model ?? ""}
          onChange={(v) => updateNested("memory", { semantic: { model: v || undefined } })}
          placeholder="local"
          monospace
        />
      </SettingField>
      <SettingField label="Proactive recall" description="Inject goal-seeded relevant past context at session start.">
        <ToggleSwitch
          checked={memory.proactiveRecall ?? true}
          onChange={(v) => updateNested("memory", { proactiveRecall: v })}
        />
      </SettingField>
      <SettingField label="Session digest" description="Write a short digest at session end for future recall.">
        <ToggleSwitch
          checked={memory.sessionDigest ?? true}
          onChange={(v) => updateNested("memory", { sessionDigest: v })}
        />
      </SettingField>
    </SettingSection>
  );
}
