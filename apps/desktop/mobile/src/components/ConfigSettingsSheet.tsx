// Full config Settings sheet — the native 1:1 port of the desktop SettingsPanel.
// Reads/writes the SAME config files (via the relay config channel, which reuses
// the desktop config-io/validate), grouped by the shared CONFIG_SECTIONS, with
// patches built by the shared buildConfigPatch. The Instructions section edits
// VIBE.md via the relay memory channel. So config parity is by construction.
import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View, Text, ScrollView, Pressable, useWindowDimensions, ActivityIndicator } from "react-native";
import { Sheet } from "./Sheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T } from "../theme/tokens";
import { Txt, Button, Card } from "./primitives";
import { CONFIG_SECTIONS, type ConfigScope, type VibeConfig } from "@shared/config-schema";
import { buildConfigPatch } from "@shared/config-diff";
import type { RemoteEngineClient } from "../remote/RemoteEngineClient";
import {
  ModelsSection, AppearanceSection, BehaviorSection, SubagentsSection, CompactionSection,
  BudgetSection, SearchSection, BuildSection, AdvancedSection, PermissionsSection, McpSection,
  MemorySection, HooksSection, InstructionsSection, ProvidersSection, type SectionProps,
} from "./form/ConfigSections";

const EMPTY_CONFIG: VibeConfig = {};

export function ConfigSettingsSheet({ open, onClose, client, cwd }: {
  open: boolean; onClose: () => void; client: RemoteEngineClient; cwd: string;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const dims = useWindowDimensions();
  const [scope, setScope] = useState<ConfigScope>("project");
  const [config, setConfig] = useState<VibeConfig>(EMPTY_CONFIG);
  const [original, setOriginal] = useState<VibeConfig>(EMPTY_CONFIG);
  const [instructions, setInstructions] = useState("");
  const [instructionsOriginal, setInstructionsOriginal] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<string>("models");
  const s = makeStyles(colors);
  const compact = dims.width < 700;

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await client.configRead(scope, scope === "project" ? cwd : undefined);
      if (res.ok) { setConfig(res.config as VibeConfig); setOriginal(res.config as VibeConfig); }
      else setError(res.error);
      const mem = await client.memoryRead(scope, scope === "project" ? cwd : undefined);
      if (mem.ok) { setInstructions(mem.content); setInstructionsOriginal(mem.content); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [client, scope, cwd]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  const dirty = useMemo(() => Object.keys(buildConfigPatch(original as Record<string, unknown>, config as Record<string, unknown>)).length > 0 || instructions !== instructionsOriginal, [original, config, instructions, instructionsOriginal]);

  const updateConfig = useCallback((patch: Partial<VibeConfig>) => setConfig((c) => ({ ...c, ...patch })), []);
  const updateNested = useCallback(<K extends keyof VibeConfig>(key: K, patch: Partial<VibeConfig[K]>) => setConfig((c) => ({ ...c, [key]: { ...(c[key] as object ?? {}), ...patch } })), []);

  const sectionProps: SectionProps = { config, scope, updateConfig, updateNested, cwd: scope === "project" ? cwd : null };

  async function save() {
    setSaving(true); setError(null);
    try {
      const patch = buildConfigPatch(original as Record<string, unknown>, config as Record<string, unknown>);
      if (Object.keys(patch).length > 0) {
        const res = await client.configWrite({ scope, ...(scope === "project" ? { cwd } : {}), patch });
        if (!res.ok) { setError(res.error); setSaving(false); return; }
        setConfig(res.config as VibeConfig); setOriginal(res.config as VibeConfig);
      }
      if (instructions !== instructionsOriginal) {
        const res = await client.memoryWrite({ scope, ...(scope === "project" ? { cwd } : {}), content: instructions });
        if (!res.ok) { setError(res.error); setSaving(false); return; }
        setInstructionsOriginal(instructions);
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  function renderSection() {
    switch (activeSection) {
      case "models": return <ModelsSection {...sectionProps} />;
      case "providers": return <ProvidersSection {...sectionProps} />;
      case "appearance": return <AppearanceSection {...sectionProps} />;
      case "behavior": return <BehaviorSection {...sectionProps} />;
      case "subagents": return <SubagentsSection {...sectionProps} />;
      case "compaction": return <CompactionSection {...sectionProps} />;
      case "budget": return <BudgetSection {...sectionProps} />;
      case "search": return <SearchSection {...sectionProps} />;
      case "build": return <BuildSection {...sectionProps} />;
      case "advanced": return <AdvancedSection {...sectionProps} />;
      case "permissions": return <PermissionsSection {...sectionProps} />;
      case "mcp": return <McpSection {...sectionProps} />;
      case "memory": return <MemorySection {...sectionProps} />;
      case "hooks": return <HooksSection {...sectionProps} />;
      case "instructions": return <InstructionsSection content={instructions} onChange={setInstructions} />;
      default: return null;
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Settings" icon="Settings" heightRatio={0.92}
      footer={<View style={s.saveBar}>{dirty ? <Txt variant="caption" color={colors.notice}>Unsaved changes</Txt> : <Txt variant="caption" color={colors.textSubtle}>All changes saved</Txt>}<Button label={saving ? "Saving…" : "Save"} onPress={save} disabled={!dirty || saving} /></View>}>
      <View style={s.scopeRow}>
        {(["project", "global"] as ConfigScope[]).map((sc) => (
          <Pressable key={sc} onPress={() => setScope(sc)} style={({ pressed }) => [s.scopeChip, scope === sc && s.scopeChipActive, pressed && { opacity: 0.7 }]}><Txt variant="caption" color={scope === sc ? colors.bg : colors.textSecondary}>{sc}</Txt></Pressable>
        ))}
      </View>
      {loading ? <View style={s.center}><ActivityIndicator color={colors.muted} /></View> :
       error ? <View style={s.center}><Txt variant="ui" color={colors.del}>{error}</Txt></View> :
        <View style={[s.settingsBody, !compact && s.settingsBodyWide]}>
          <ScrollView horizontal={compact} showsHorizontalScrollIndicator={false} style={compact ? s.sectionNavCompact : s.sectionNavWide} contentContainerStyle={compact ? s.sectionNavContentCompact : s.sectionNavContentWide}>
            {CONFIG_SECTIONS.map((sec) => (
              <Pressable key={sec.id} onPress={() => setActiveSection(sec.id)} style={({ pressed }) => [s.sectionItem, compact && s.sectionItemCompact, activeSection === sec.id && s.sectionItemActive, pressed && { opacity: 0.7 }]}>
                <Txt variant="ui" color={activeSection === sec.id ? colors.accent : colors.textSecondary} numberOfLines={1}>{sec.label}</Txt>
              </Pressable>
            ))}
          </ScrollView>
          <ScrollView style={s.sectionContent} contentContainerStyle={s.sectionContentInner}>
            {renderSection()}
          </ScrollView>
        </View>}
    </Sheet>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    scrim: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.45)" },
    scrimHit: { flex: 1 },
    sheet: { backgroundColor: colors.bg, borderTopLeftRadius: T.radiusXl, borderTopRightRadius: T.radiusXl, borderWidth: 1, borderColor: colors.borderSoft, paddingTop: T.sXs },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong, alignSelf: "center", marginBottom: T.sXs },
    head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: T.sBase, paddingBottom: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    scopeRow: { flexDirection: "row", gap: T.sXs, paddingHorizontal: T.sBase, paddingVertical: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    scopeChip: { paddingHorizontal: T.sXs, paddingVertical: 2, borderRadius: T.radiusPill, borderWidth: 1, borderColor: colors.borderSoft },
    scopeChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    center: { flex: 1, alignItems: "center", justifyContent: "center" },
    settingsBody: { flex: 1 },
    settingsBodyWide: { flexDirection: "row" },
    sectionNavWide: { width: 160, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.borderSoft },
    sectionNavCompact: { flexGrow: 0, maxHeight: 48, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    sectionNavContentWide: { paddingVertical: T.sXs },
    sectionNavContentCompact: { paddingHorizontal: T.sSm, paddingVertical: T.s2xs, gap: T.s2xs },
    sectionItem: { paddingHorizontal: T.sSm, paddingVertical: T.sXs, borderRadius: T.radiusMd },
    sectionItemCompact: { height: 38, justifyContent: "center" },
    sectionItemActive: { backgroundColor: colors.surfaceSubtle },
    sectionContent: { flex: 1 },
    sectionContentInner: { padding: T.sBase, paddingBottom: T.s2xl },
    saveBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: T.sBase, paddingVertical: T.sXs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSoft },
  });
}
