import type { PermissionRule } from "../../../shared/config-schema";
import type { SectionProps } from "./types";
import { SelectInput, SettingSection, TextInput } from "../FormControls";

export function PermissionsSection({ config, updateConfig }: SectionProps) {
  const rules = config.permissions ?? [];

  const updateRule = (index: number, patch: Partial<PermissionRule>) => {
    const next = rules.map((r, i) => (i === index ? { ...r, ...patch } : r));
    updateConfig({ permissions: next });
  };

  const addRule = () => {
    updateConfig({ permissions: [...rules, { tool: "bash", action: "ask" }] });
  };

  const removeRule = (index: number) => {
    updateConfig({ permissions: rules.filter((_, i) => i !== index) });
  };

  return (
    <SettingSection title="Permission Rules" description="Tool allow/deny/ask policy. Among matching rules: deny > ask > allow. Choose either a content glob or an exact literal scope per rule; setting one clears the other.">
      {rules.length === 0 ? (
        <p className="setting-empty">No permission rules. The engine uses approvalMode (ask/auto) for tools without a matching rule.</p>
      ) : (
        <div className="setting-list">
          {rules.map((rule, i) => (
            <div key={i} className="setting-perm-rule">
              <TextInput
                value={rule.tool}
                onChange={(v) => updateRule(i, { tool: v })}
                placeholder="tool name (glob)"
                monospace
              />
              <TextInput
                value={rule.match ?? ""}
                onChange={(v) => updateRule(i, {
                  match: v || undefined,
                  ...(v ? { matchExact: undefined } : {}),
                })}
                placeholder="match pattern (glob)"
                monospace
              />
              <TextInput
                value={rule.matchExact ?? ""}
                onChange={(v) => updateRule(i, {
                  matchExact: v || undefined,
                  ...(v ? { match: undefined } : {}),
                })}
                placeholder="exact match (no glob)"
                monospace
              />
              <SelectInput
                value={rule.action}
                onChange={(v) => updateRule(i, { action: v })}
                options={[
                  { value: "allow", label: "Allow" },
                  { value: "ask", label: "Ask" },
                  { value: "deny", label: "Deny" },
                ]}
              />
              <button type="button" className="button danger" onClick={() => removeRule(i)}>Remove</button>
            </div>
          ))}
        </div>
      )}
      <div className="setting-actions">
        <button type="button" className="button" onClick={addRule}>Add rule</button>
      </div>
    </SettingSection>
  );
}
