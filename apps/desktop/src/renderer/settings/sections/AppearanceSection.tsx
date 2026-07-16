import type { SectionProps } from "./types";
import { SelectInput, SettingField, SettingSection, TextInput, ToggleSwitch } from "../FormControls";

import { ACCENT_NAMES, ACCENT_PRESETS, THEME_NAMES } from "../../../shared/theme-registry";

/** Human-friendly labels for the theme names in THEME_NAMES. */
const THEME_LABELS: Record<string, string> = {
  default: "Vibe Dark (default)",
  dark: "Vibe Dark",
  light: "Light",
  contrast: "High Contrast",
  tokyonight: "Tokyo Night",
  catppuccin: "Catppuccin",
  gruvbox: "Gruvbox",
  nord: "Nord",
  "one-dark": "One Dark",
  dracula: "Dracula",
  rosepine: "Rose Pine",
  kanagawa: "Kanagawa",
  everforest: "Everforest",
  flexoki: "Flexoki",
  vesper: "Vesper",
};

const THEMES = THEME_NAMES.map((name) => ({
  value: name,
  label: THEME_LABELS[name] ?? name,
}));

export function AppearanceSection({ config, updateConfig }: SectionProps) {
  const activeAccent = config.accentColor?.trim().toLowerCase();

  return (
    <SettingSection title="Appearance" description="Visual theme, accent color, transcript density, and mouse behavior.">
      <SettingField label="Theme" description="Color palette for the UI.">
        <SelectInput
          value={THEME_NAMES.includes(config.theme ?? "default") ? (config.theme ?? "default") : "default"}
          onChange={(v) => updateConfig({ theme: v })}
          options={THEMES}
        />
      </SettingField>
      <SettingField label="Accent color" description="Hex color for UI chrome that overrides the theme's primary. Empty = theme default.">
        <TextInput
          value={config.accentColor ?? ""}
          onChange={(v) => updateConfig({ accentColor: v || undefined })}
          placeholder="theme default"
          monospace
        />
        <div className="accent-presets" role="group" aria-label="Accent presets">
          {ACCENT_NAMES.map((name) => (
            <button
              key={name}
              type="button"
              className={`accent-swatch${activeAccent === ACCENT_PRESETS[name]?.toLowerCase() ? " is-selected" : ""}`}
              title={name}
              aria-label={`Accent: ${name}`}
              aria-pressed={activeAccent === ACCENT_PRESETS[name]?.toLowerCase()}
              style={{ backgroundColor: ACCENT_PRESETS[name] }}
              onClick={() => updateConfig({ accentColor: ACCENT_PRESETS[name] })}
            />
          ))}
        </div>
      </SettingField>
      <SettingField label="Density" description="How much tool/thinking detail the transcript shows.">
        <SelectInput
          value={config.details ?? "normal"}
          onChange={(v) => updateConfig({ details: v as "quiet" | "normal" | "verbose" })}
          options={[
            { value: "quiet", label: "Quiet — collapsed tools, no thinking" },
            { value: "normal", label: "Normal — default detail" },
            { value: "verbose", label: "Verbose — diffs, errors, subagent replies" },
          ]}
        />
      </SettingField>
      <SettingField label="Mouse capture" description="Capture mouse for click-to-expand and select-to-copy (TUI). Disable for terminal-native selection.">
        <ToggleSwitch
          checked={config.mouse ?? true}
          onChange={(v) => updateConfig({ mouse: v })}
        />
      </SettingField>
    </SettingSection>
  );
}
