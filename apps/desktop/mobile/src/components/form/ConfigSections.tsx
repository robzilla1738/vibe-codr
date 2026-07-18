// Native ports of the desktop config Settings sections. Each reuses the shared
// VibeConfig shape + the native FormControls, mutating an in-memory config via
// updateConfig/updateNested (same contract as the desktop SectionProps). The
// ConfigSettingsSheet builds a patch with the shared buildConfigPatch and writes
// via the relay config channel (same config-io/validate the desktop uses).
import { useState } from "react";
import { View, Pressable, Text } from "react-native";
import { useTheme } from "../../theme/ThemeProvider";
import { staticTokens as T } from "../../theme/tokens";
import { Txt } from "../primitives";
import { SettingSection, SettingField, TextInput, NumberInput, SelectInput, ToggleSwitch, TextArea } from "./FormControls";
import { THEME_NAMES, ACCENT_NAMES, ACCENT_PRESETS } from "@shared/themes";
import type { ConfigScope, VibeConfig, PermissionRule } from "@shared/config-schema";

export interface SectionProps {
  config: VibeConfig;
  scope: ConfigScope;
  updateConfig: (patch: Partial<VibeConfig>) => void;
  updateNested: <K extends keyof VibeConfig>(key: K, patch: Partial<VibeConfig[K]>) => void;
  cwd: string | null;
}

const THEME_OPTS = THEME_NAMES.map((n) => ({ value: n, label: n }));
const MODE_OPTS = [{ value: "plan", label: "Plan" }, { value: "execute", label: "Execute" }];
const APPROVAL_OPTS = [{ value: "ask", label: "Ask" }, { value: "auto", label: "Auto (YOLO)" }];
const SANDBOX_OPTS = [{ value: "off", label: "Off" }, { value: "read-only", label: "Read-only" }, { value: "workspace-write", label: "Workspace-write" }];
const NET_OPTS = [{ value: "on", label: "On" }, { value: "off", label: "Off" }];
const DENSITY_OPTS = [{ value: "quiet", label: "Quiet" }, { value: "normal", label: "Normal" }, { value: "verbose", label: "Verbose" }];
const EFFORT_OPTS = [{ value: "default", label: "Default" }, { value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }];
const ONEXCEED_OPTS = [{ value: "warn", label: "Warn" }, { value: "stop", label: "Stop" }];

export function ModelsSection({ config, updateConfig, updateNested }: SectionProps) {
  const reasoning = config.reasoning ?? {};
  return (
    <SettingSection title="Models" description="Default model, planning model, fallbacks, reasoning.">
      <SettingField label="Default model" description="Primary model string (provider/id)."><TextInput value={config.model ?? ""} onChange={(v) => updateConfig({ model: v || undefined })} placeholder="anthropic/claude-opus-4-8" monospace /></SettingField>
      <SettingField label="Planning model" description="Dedicated model for plan-mode turns. Unset = same as default."><TextInput value={config.planModel ?? ""} onChange={(v) => updateConfig({ planModel: v || undefined })} monospace /></SettingField>
      <SettingField label="Model fallbacks" description="Failover chain (one per line)."><TextArea value={(config.modelFallbacks ?? []).join("\n")} onChange={(v) => updateConfig({ modelFallbacks: v.split("\n").map((s) => s.trim()).filter(Boolean) })} monospace /></SettingField>
      <SettingField label="Reasoning effort"><SelectInput value={reasoning.effort ?? "default"} onChange={(v) => updateNested("reasoning", { effort: v === "default" ? undefined : (v as "low" | "medium" | "high") })} options={EFFORT_OPTS} /></SettingField>
      <SettingField label="Budget tokens" description="Extended-thinking budget (tokens). Unset = provider default."><NumberInput value={reasoning.budgetTokens} onChange={(v) => updateNested("reasoning", { budgetTokens: v })} placeholder="provider default" /></SettingField>
    </SettingSection>
  );
}

export function AppearanceSection({ config, updateConfig }: SectionProps) {
  return (
    <SettingSection title="Appearance" description="Theme, accent, density, mouse.">
      <SettingField label="Theme"><SelectInput value={THEME_NAMES.includes(config.theme ?? "default") ? (config.theme ?? "default") : "default"} onChange={(v) => updateConfig({ theme: v })} options={THEME_OPTS} /></SettingField>
      <SettingField label="Accent color" description="Hex override for chrome. Empty = theme default."><TextInput value={config.accentColor ?? ""} onChange={(v) => updateConfig({ accentColor: v || undefined })} placeholder="theme default" monospace /></SettingField>
      <SettingField label="Density"><SelectInput value={config.details ?? "normal"} onChange={(v) => updateConfig({ details: v as "quiet" | "normal" | "verbose" })} options={DENSITY_OPTS} /></SettingField>
      <SettingField label="Mouse capture" description="TUI-only; no-op on desktop/mobile."><ToggleSwitch checked={config.mouse ?? false} onChange={(v) => updateConfig({ mouse: v })} /></SettingField>
    </SettingSection>
  );
}

export function BehaviorSection({ config, updateConfig, updateNested }: SectionProps) {
  const sandbox = config.sandbox ?? { mode: "off", network: "on", writablePaths: [] };
  return (
    <SettingSection title="Behavior" description="Mode, approvals, sandbox, max steps.">
      <SettingField label="Start mode"><SelectInput value={config.mode ?? "execute"} onChange={(v) => updateConfig({ mode: v as "plan" | "execute" })} options={MODE_OPTS} /></SettingField>
      <SettingField label="Approval mode"><SelectInput value={config.approvalMode ?? "ask"} onChange={(v) => updateConfig({ approvalMode: v as "ask" | "auto" })} options={APPROVAL_OPTS} /></SettingField>
      <SettingField label="Sandbox mode"><SelectInput value={sandbox.mode ?? "off"} onChange={(v) => updateNested("sandbox", { mode: v as "off" | "read-only" | "workspace-write" })} options={SANDBOX_OPTS} /></SettingField>
      <SettingField label="Network"><SelectInput value={sandbox.network ?? "on"} onChange={(v) => updateNested("sandbox", { network: v as "on" | "off" })} options={NET_OPTS} /></SettingField>
      <SettingField label="Writable paths" description="Extra absolute paths (one per line)."><TextArea value={(sandbox.writablePaths ?? []).join("\n")} onChange={(v) => updateNested("sandbox", { writablePaths: v.split("\n").map((s) => s.trim()).filter(Boolean) })} monospace /></SettingField>
      <SettingField label="Max steps" description="Per-turn step ceiling."><NumberInput value={config.maxSteps} onChange={(v) => updateConfig({ maxSteps: v })} min={1} placeholder="75" /></SettingField>
      <SettingField label="Checkpoints"><ToggleSwitch checked={config.checkpoints?.enabled ?? true} onChange={(v) => updateConfig({ checkpoints: { enabled: v } })} /></SettingField>
    </SettingSection>
  );
}

export function SubagentsSection({ config, updateNested }: SectionProps) {
  const sa = config.subagent ?? {};
  const num = (k: keyof typeof sa) => (v: number | undefined) => updateNested("subagent", { [k]: v } as Partial<typeof sa>);
  return (
    <SettingSection title="Subagents" description="Depth, parallelism, timeouts, model tiers.">
      <SettingField label="Max depth"><NumberInput value={sa.maxDepth} onChange={num("maxDepth")} min={1} placeholder="3" /></SettingField>
      <SettingField label="Max parallel"><NumberInput value={sa.maxParallel} onChange={num("maxParallel")} min={1} placeholder="8" /></SettingField>
      <SettingField label="Max total"><NumberInput value={sa.maxTotal} onChange={num("maxTotal")} min={1} placeholder="200" /></SettingField>
      <SettingField label="Provider concurrency"><NumberInput value={sa.providerConcurrency} onChange={num("providerConcurrency")} min={1} placeholder="16" /></SettingField>
      <SettingField label="Timeout (ms)"><NumberInput value={sa.timeoutMs} onChange={num("timeoutMs")} min={0} step={1000} placeholder="300000" /></SettingField>
      <SettingField label="Subagent model" description="Dedicated model for subagents. Unset = inherit main."><TextInput value={sa.model ?? ""} onChange={(v) => updateNested("subagent", { model: v || undefined })} monospace /></SettingField>
    </SettingSection>
  );
}

export function CompactionSection({ config, updateNested }: SectionProps) {
  const c = config.compaction ?? {};
  const offload = c.offload ?? {};
  return (
    <SettingSection title="Compaction" description="Context thresholds and offload.">
      <SettingField label="Summary threshold"><NumberInput value={c.threshold} onChange={(v) => updateNested("compaction", { threshold: v })} min={0.1} max={0.95} step={0.05} placeholder="0.75" /></SettingField>
      <SettingField label="Enable offload"><ToggleSwitch checked={offload.enabled ?? true} onChange={(v) => updateNested("compaction", { offload: { enabled: v } })} /></SettingField>
      <SettingField label="Offload threshold"><NumberInput value={offload.threshold} onChange={(v) => updateNested("compaction", { offload: { threshold: v } })} min={0.1} max={0.9} step={0.05} placeholder="0.6" /></SettingField>
      <SettingField label="Max result bytes"><NumberInput value={offload.maxResultBytes} onChange={(v) => updateNested("compaction", { offload: { maxResultBytes: v } })} min={1} placeholder="16384" /></SettingField>
      <SettingField label="Keep live results"><NumberInput value={offload.keepLiveResults} onChange={(v) => updateNested("compaction", { offload: { keepLiveResults: v } })} min={0} placeholder="2" /></SettingField>
    </SettingSection>
  );
}

export function BudgetSection({ config, updateConfig, updateNested }: SectionProps) {
  const budget = config.budget ?? {};
  const retry = config.retry ?? {};
  const caching = config.caching ?? {};
  return (
    <SettingSection title="Budget & Retry" description="Spend limits, retry, caching.">
      <SettingField label="Limit (USD)"><NumberInput value={budget.limitUSD} onChange={(v) => updateNested("budget", { limitUSD: v })} min={0.01} step={0.01} placeholder="unbounded" /></SettingField>
      <SettingField label="On exceed"><SelectInput value={budget.onExceed ?? "warn"} onChange={(v) => updateNested("budget", { onExceed: v as "warn" | "stop" })} options={ONEXCEED_OPTS} /></SettingField>
      <SettingField label="Max attempts"><NumberInput value={retry.maxAttempts} onChange={(v) => updateNested("retry", { maxAttempts: v })} min={0} max={10} placeholder="2" /></SettingField>
      <SettingField label="Base delay (ms)"><NumberInput value={retry.baseDelayMs} onChange={(v) => updateNested("retry", { baseDelayMs: v })} min={0} placeholder="500" /></SettingField>
      <SettingField label="Enable caching"><ToggleSwitch checked={caching.enabled ?? true} onChange={(v) => updateConfig({ caching: { ...caching, enabled: v } })} /></SettingField>
      <SettingField label="Cache tools block"><ToggleSwitch checked={caching.cacheTools ?? true} onChange={(v) => updateConfig({ caching: { ...caching, cacheTools: v } })} /></SettingField>
    </SettingSection>
  );
}

export function SearchSection({ config, updateConfig, updateNested }: SectionProps) {
  const search = config.search ?? {};
  const webfetch = config.webfetch ?? {};
  return (
    <SettingSection title="Search & Web" description="Web search, webfetch SSRF policy.">
      <SettingField label="Enable web search"><ToggleSwitch checked={search.enabled ?? true} onChange={(v) => updateConfig({ search: { ...search, enabled: v } })} /></SettingField>
      <SettingField label="TinyFish API key"><TextInput value={(search as { apiKey?: string }).apiKey ?? ""} onChange={(v) => updateConfig({ search: { ...search, apiKey: v || undefined } })} monospace /></SettingField>
      <SettingField label="Allow private hosts"><ToggleSwitch checked={webfetch.allowPrivateHosts ?? false} onChange={(v) => updateNested("webfetch", { allowPrivateHosts: v })} /></SettingField>
      <SettingField label="Always-allowed hosts" description="One per line."><TextArea value={((webfetch as { allowHosts?: string[] }).allowHosts ?? []).join("\n")} onChange={(v) => updateNested("webfetch", { allowHosts: v.split("\n").map((s) => s.trim()).filter(Boolean) })} monospace /></SettingField>
      <SettingField label="Timeout (ms)"><NumberInput value={webfetch.timeoutMs} onChange={(v) => updateNested("webfetch", { timeoutMs: v })} min={1} placeholder="8000" /></SettingField>
    </SettingSection>
  );
}

export function BuildSection({ config, updateNested }: SectionProps) {
  const build = config.build ?? {};
  const gate = build.gate ?? {};
  return (
    <SettingSection title="Build & Verify" description="Gate, recon, review.">
      <SettingField label="Enable build intelligence"><ToggleSwitch checked={build.enabled ?? true} onChange={(v) => updateNested("build", { enabled: v })} /></SettingField>
      <SettingField label="Visual verify"><ToggleSwitch checked={build.visualVerify ?? true} onChange={(v) => updateNested("build", { visualVerify: v })} /></SettingField>
      <SettingField label="Enable recon"><ToggleSwitch checked={build.recon?.enabled ?? true} onChange={(v) => updateNested("build", { recon: { enabled: v } })} /></SettingField>
      <SettingField label="Enable gate"><ToggleSwitch checked={gate.enabled ?? true} onChange={(v) => updateNested("build", { gate: { enabled: v } })} /></SettingField>
      <SettingField label="Max fix rounds"><NumberInput value={gate.maxRounds} onChange={(v) => updateNested("build", { gate: { maxRounds: v } })} min={0} max={10} placeholder="5" /></SettingField>
      <SettingField label="Per-check timeout (s)"><NumberInput value={gate.timeoutSec} onChange={(v) => updateNested("build", { gate: { timeoutSec: v } })} min={1} placeholder="600" /></SettingField>
    </SettingSection>
  );
}

export function AdvancedSection({ config, updateConfig, updateNested }: SectionProps) {
  const lsp = config.lsp ?? {};
  const update = config.update ?? {};
  return (
    <SettingSection title="Runtime" description="Plugins, LSP, updates.">
      <SettingField label="Plugin modules" description="One per line."><TextArea value={(config.plugins ?? []).join("\n")} onChange={(v) => updateConfig({ plugins: v.split("\n").map((s) => s.trim()).filter(Boolean) })} monospace /></SettingField>
      <SettingField label="Enable LSP"><ToggleSwitch checked={lsp.enabled ?? true} onChange={(v) => updateNested("lsp", { enabled: v })} /></SettingField>
      <SettingField label="LSP timeout (ms)"><NumberInput value={lsp.timeoutMs} onChange={(v) => updateNested("lsp", { timeoutMs: v })} min={0} placeholder="2000" /></SettingField>
      <SettingField label="Check for updates"><ToggleSwitch checked={update.check ?? true} onChange={(v) => updateConfig({ update: { check: v } })} /></SettingField>
    </SettingSection>
  );
}

export function PermissionsSection({ config, updateConfig }: SectionProps) {
  const { colors } = useTheme();
  const rules = config.permissions ?? [];
  const TOOL_OPTS = ["bash", "edit", "write", "webfetch", "web_search"].map((t) => ({ value: t, label: t }));
  const ACTION_OPTS = [{ value: "allow", label: "Allow" }, { value: "ask", label: "Ask" }, { value: "deny", label: "Deny" }];
  return (
    <SettingSection title="Permissions" description="Tool allow/deny/ask rules.">
      {rules.map((rule, i) => (
        <View key={i} style={{ flexDirection: "row", gap: T.sXs, alignItems: "center" }}>
          <SelectInput value={rule.tool} onChange={(v) => updateConfig({ permissions: rules.map((r, j) => j === i ? { ...r, tool: v } : r) })} options={TOOL_OPTS} />
          <SelectInput value={rule.action} onChange={(v) => updateConfig({ permissions: rules.map((r, j) => j === i ? { ...r, action: v as PermissionRule["action"] } : r) })} options={ACTION_OPTS} />
          <Pressable onPress={() => updateConfig({ permissions: rules.filter((_, j) => j !== i) })}><Text style={{ color: colors.del, fontSize: T.textUi }}>✕</Text></Pressable>
        </View>
      ))}
      <Pressable onPress={() => updateConfig({ permissions: [...rules, { tool: "bash", action: "ask" }] })} style={({ pressed }) => [{ alignSelf: "flex-start", opacity: pressed ? 0.7 : 1 }]}><Txt variant="ui" color={colors.accent}>+ Add rule</Txt></Pressable>
    </SettingSection>
  );
}

export function McpSection({ config, updateNested }: SectionProps) {
  const servers = config.mcp?.servers ?? {};
  const names = Object.keys(servers);
  return (
    <SettingSection title="MCP Servers" description="Model Context Protocol server connections.">
      {names.length === 0 ? <Txt variant="ui" color={useTheme().colors.textSubtle}>No MCP servers configured</Txt> : null}
      {names.map((name) => {
        const srv = servers[name] as { command?: string; enabled?: boolean };
        return (
          <SettingField key={name} label={name}>
            <TextInput value={srv.command ?? ""} onChange={(v) => updateNested("mcp", { servers: { ...servers, [name]: { ...srv, command: v } } } as any)} monospace />
            <ToggleSwitch checked={srv.enabled ?? true} onChange={(v) => updateNested("mcp", { servers: { ...servers, [name]: { ...srv, enabled: v } } } as any)} />
          </SettingField>
        );
      })}
    </SettingSection>
  );
}

export function MemorySection({ config, updateNested }: SectionProps) {
  const memory = config.memory ?? {};
  return (
    <SettingSection title="Memory" description="Semantic recall + session digest.">
      <SettingField label="Enable semantic recall"><ToggleSwitch checked={(memory as { enabled?: boolean }).enabled ?? true} onChange={(v) => updateNested("memory", { enabled: v } as any)} /></SettingField>
      <SettingField label="Proactive injection"><ToggleSwitch checked={(memory as { proactive?: boolean }).proactive ?? false} onChange={(v) => updateNested("memory", { proactive: v } as any)} /></SettingField>
    </SettingSection>
  );
}

export function HooksSection({ config, updateConfig }: SectionProps) {
  const hooks = config.hooks ?? [];
  return (
    <SettingSection title="Hooks" description="Lifecycle hooks (shell/HTTP).">
      <SettingField label="Hook commands" description="One JSON object per line: {event, command}."><TextArea value={hooks.map((h) => JSON.stringify(h)).join("\n")} onChange={(v) => { const parsed = v.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); updateConfig({ hooks: parsed }); }} monospace /></SettingField>
    </SettingSection>
  );
}

export function InstructionsSection({ content, onChange }: { content: string; onChange: (v: string) => void }) {
  return (
    <SettingSection title="Custom Instructions" description="VIBE.md project + global memory.">
      <SettingField label="Instructions" description="Markdown instructions injected into the system prompt."><TextArea value={content} onChange={onChange} monospace /></SettingField>
    </SettingSection>
  );
}

export function ProvidersSection({ config, updateConfig }: SectionProps) {
  const providers = config.providers ?? {};
  const ids = Object.keys(providers);
  return (
    <SettingSection title="Providers" description="API keys and custom endpoints.">
      {ids.length === 0 ? <Txt variant="ui" color={useTheme().colors.textSubtle}>No provider overrides (keys come from env on the desktop)</Txt> : null}
      {ids.map((id) => {
        const p = providers[id] as { apiKey?: string; baseURL?: string };
        return (
          <SettingField key={id} label={id}>
            <TextInput value={p.apiKey ?? ""} onChange={(v) => updateConfig({ providers: { ...providers, [id]: { ...p, apiKey: v || undefined } } } as any)} placeholder="API key" monospace />
            <TextInput value={p.baseURL ?? ""} onChange={(v) => updateConfig({ providers: { ...providers, [id]: { ...p, baseURL: v || undefined } } } as any)} placeholder="base URL" monospace />
          </SettingField>
        );
      })}
    </SettingSection>
  );
}
