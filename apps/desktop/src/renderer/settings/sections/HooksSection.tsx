import type { HookConfig } from "../../../shared/config-schema";
import type { SectionProps } from "./types";
import { SelectInput, SettingField, SettingSection, TextArea, TextInput, ToggleSwitch } from "../FormControls";

const HOOK_EVENTS: { value: HookConfig["event"]; label: string }[] = [
  { value: "session.start", label: "session.start" },
  { value: "user.prompt.submit", label: "user.prompt.submit" },
  { value: "tool.before.execute", label: "tool.before.execute" },
  { value: "tool.after.execute", label: "tool.after.execute" },
  { value: "step.finish", label: "step.finish" },
  { value: "assistant.message", label: "assistant.message" },
  { value: "session.idle", label: "session.idle" },
  { value: "session.end", label: "session.end" },
  { value: "subagent.start", label: "subagent.start" },
  { value: "subagent.stop", label: "subagent.stop" },
  { value: "permission.denied", label: "permission.denied" },
  { value: "compact.before", label: "compact.before" },
  { value: "compact.after", label: "compact.after" },
  { value: "goal.transition", label: "goal.transition" },
  { value: "turn.failure", label: "turn.failure" },
];

export function HooksSection({ config, updateConfig }: SectionProps) {
  const hooks = config.hooks ?? [];

  const updateHook = (index: number, patch: Partial<HookConfig>) => {
    const next = hooks.map((h, i) => (i === index ? { ...h, ...patch } : h));
    updateConfig({ hooks: next });
  };

  const addHook = () => {
    updateConfig({ hooks: [...hooks, { event: "session.start", command: "" }] });
  };

  const removeHook = (index: number) => {
    updateConfig({ hooks: hooks.filter((_, i) => i !== index) });
  };

  return (
    <SettingSection title="Lifecycle Hooks" description="Run a shell command or POST to a URL on lifecycle events. Payload is JSON on stdin; response is honored per event contract.">
      {hooks.length === 0 ? (
        <p className="setting-empty">No hooks configured. Add one to run scripts on lifecycle events.</p>
      ) : (
        <div className="setting-list">
          {hooks.map((hook, i) => (
            <div key={i} className="setting-hook-card">
              <div className="setting-hook-header">
                <SelectInput
                  value={hook.event}
                  onChange={(v) => updateHook(i, { event: v as HookConfig["event"] })}
                  options={HOOK_EVENTS}
                />
                <button type="button" className="button danger" onClick={() => removeHook(i)}>Remove</button>
              </div>
              <SettingField label="Tool matcher (optional)" description="Glob matched against the tool name for tool.* events. Omit = all tools.">
                <TextInput
                  value={hook.matcher ?? ""}
                  onChange={(v) => updateHook(i, { matcher: v || undefined })}
                  placeholder="all tools"
                  monospace
                />
              </SettingField>
              <SettingField label="Shell command" description="Receives payload as JSON on stdin. stdout JSON is honored per event.">
                <TextArea
                  value={hook.command ?? ""}
                  onChange={(v) => updateHook(i, { command: v || undefined, url: v ? undefined : hook.url })}
                  placeholder={"node ~/.config/vibe-codr/hooks/notify.js"}
                  rows={2}
                  monospace
                />
              </SettingField>
              <SettingField label="URL (alternative to command)" description="POST payload as JSON, JSON response honored.">
                <TextInput
                  value={hook.url ?? ""}
                  onChange={(v) => updateHook(i, { url: v || undefined, command: v ? undefined : hook.command })}
                  placeholder="https://webhook.example.com/vibe"
                  type="url"
                  monospace
                />
              </SettingField>
              <SettingField label="Async (fire-and-forget)">
                <ToggleSwitch
                  checked={hook.async ?? false}
                  onChange={(v) => updateHook(i, { async: v })}
                />
              </SettingField>
            </div>
          ))}
        </div>
      )}
      <div className="setting-actions">
        <button type="button" className="button" onClick={addHook}>Add hook</button>
      </div>
    </SettingSection>
  );
}
