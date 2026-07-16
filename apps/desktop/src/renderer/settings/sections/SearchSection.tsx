import type { SectionProps } from "./types";
import { NumberInput, SettingField, SettingSection, TextArea, TextInput, ToggleSwitch } from "../FormControls";

export function SearchSection({ config, updateConfig, updateNested }: SectionProps) {
  const search = config.search ?? {};
  const webfetch = config.webfetch ?? {};
  return (
    <>
      <SettingSection title="Web Search" description="Enabled by default and works keyless (DuckDuckGo). A TinyFish key is an optional higher-quality booster.">
        <SettingField label="Enable web search" description="Offer the web_search tool to the model.">
          <ToggleSwitch
            checked={search.enabled ?? true}
            onChange={(v) => updateConfig({ search: { ...search, enabled: v } })}
          />
        </SettingField>
        <SettingField label="TinyFish API key" description="Optional higher-quality search. $TINYFISH_API_KEY takes precedence.">
          <TextInput
            value={search.apiKey ?? ""}
            onChange={(v) => updateConfig({ search: { ...search, apiKey: v || undefined } })}
            placeholder="keyless (DuckDuckGo)"
            type="password"
            monospace
          />
        </SettingField>
      </SettingSection>

      <SettingSection title="Webfetch" description="SSRF policy and resource limits for fetching web pages.">
        <SettingField label="Allow private hosts" description="Allow fetching loopback/link-local/private/metadata hosts (intranet docs). Default-deny for safety.">
          <ToggleSwitch
            checked={webfetch.allowPrivateHosts ?? false}
            onChange={(v) => updateNested("webfetch", { allowPrivateHosts: v })}
          />
        </SettingField>
        <SettingField label="Always-allowed hosts" description="Hostnames always allowed even if they resolve to private addresses (one per line).">
          <TextArea
            value={(webfetch.allowHosts ?? []).join("\n")}
            onChange={(v) => updateNested("webfetch", { allowHosts: v.split("\n").map((s) => s.trim()).filter(Boolean) })}
            placeholder={"internal.example.com"}
            rows={3}
            monospace
          />
        </SettingField>
        <SettingField label="Timeout (ms)" description="Per-fetch wall-clock cap.">
          <NumberInput value={webfetch.timeoutMs} onChange={(v) => updateNested("webfetch", { timeoutMs: v })} min={1} placeholder="8000" />
        </SettingField>
        <SettingField label="Max bytes" description="Byte ceiling pulled off the wire.">
          <NumberInput value={webfetch.maxBytes} onChange={(v) => updateNested("webfetch", { maxBytes: v })} min={1} placeholder="4000000" />
        </SettingField>
      </SettingSection>
    </>
  );
}
