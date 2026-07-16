import type { SectionProps } from "./types";
import { SelectInput, SettingField, SettingSection, TextArea, ToggleSwitch } from "../FormControls";

export function BehaviorSection({ config, scope, updateConfig, updateNested }: SectionProps) {
  const sandbox = config.sandbox ?? { mode: "off", network: "on", writablePaths: [] };
  return (
    <>
      <SettingSection title="Operating Mode" description="How the agent starts and handles tool approvals.">
        <SettingField label="Start mode" description="plan = read-only investigation; execute = permits side effects.">
          <SelectInput
            value={config.mode ?? "execute"}
            onChange={(v) => updateConfig({ mode: v as "plan" | "execute" })}
            options={[
              { value: "execute", label: "Execute" },
              { value: "plan", label: "Plan" },
            ]}
          />
        </SettingField>
        <SettingField label="Approval mode" description="How side-effecting tools are handled when no permission rule matches.">
          <SelectInput
            value={config.approvalMode ?? "ask"}
            onChange={(v) => updateConfig({ approvalMode: v as "ask" | "auto" })}
            options={[
              { value: "ask", label: "Ask — prompt for each tool" },
              { value: "auto", label: "Auto — run without asking" },
            ]}
          />
        </SettingField>
      </SettingSection>

      <SettingSection title="Sandbox" description="OS-level defense-in-depth under the permission engine. Off by default to avoid breaking commands that write outside cwd.">
        <SettingField label="Sandbox mode" description="read-only = no writes; workspace-write = writes confined to cwd/tmp + writablePaths.">
          <SelectInput
            value={sandbox.mode ?? "off"}
            onChange={(v) => updateNested("sandbox", { mode: v as "off" | "read-only" | "workspace-write" })}
            options={[
              { value: "off", label: "Off" },
              { value: "read-only", label: "Read-only" },
              { value: "workspace-write", label: "Workspace write" },
            ]}
          />
        </SettingField>
        <SettingField label="Network" description="on = allow egress; off = cut all network.">
          <SelectInput
            value={sandbox.network ?? "on"}
            onChange={(v) => updateNested("sandbox", { network: v as "on" | "off" })}
            options={[
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
          />
        </SettingField>
        <SettingField label="Writable paths" description="Extra absolute paths kept writable under workspace-write (one per line).">
          <TextArea
            value={(sandbox.writablePaths ?? []).join("\n")}
            onChange={(v) => updateNested("sandbox", { writablePaths: v.split("\n").map((s) => s.trim()).filter(Boolean) })}
            placeholder={"/Users/you/.npm\n/tmp/build"}
            rows={3}
            monospace
          />
        </SettingField>
      </SettingSection>

      <SettingSection title="Checkpoints" description="Workspace snapshots before each edit turn (git repos only).">
        <SettingField label="Enable checkpoints">
          <ToggleSwitch
            checked={config.checkpoints?.enabled ?? true}
            onChange={(v) => updateConfig({ checkpoints: { enabled: v } })}
          />
        </SettingField>
      </SettingSection>

      <SettingSection title="Security" description="Trust posture for repo-local .vibe/config.json.">
        <SettingField label="Trust project config" description={scope === "global" ? "When off (default), unsafe project providers, hooks/plugins/MCP, LSP or verify commands, sandbox/SSRF relaxations, auto approvals, and broad allows are filtered. Exact scoped grants and deny/ask rules remain. Enable only for repos you trust." : "This trust decision is only honored from Global settings; a project cannot authorize itself."}>
          <ToggleSwitch
            checked={scope === "global" && (config.security?.trustProjectConfig ?? false)}
            onChange={(v) => updateConfig({ security: { trustProjectConfig: v } })}
            disabled={scope !== "global"}
          />
        </SettingField>
      </SettingSection>
    </>
  );
}
