// Settings sheet — the native analog of the desktop SettingsPanel's
// engine-driven sections. Theme/accent/density/approvals/model are driven by
// the same shared registries (THEME_NAMES, ACCENT_PRESETS, DENSITY_LEVELS) and
// sent to the engine via the same slash commands / EngineCommands as desktop,
// so the engine remains the single source of truth and the mobile chrome syncs
// back through theme-changed/accent-changed/details-changed events.
import { StyleSheet, View, Text, ScrollView, Pressable, Modal, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T } from "../theme/tokens";
import { Txt, Card, Divider } from "./primitives";
import { THEME_NAMES, ACCENT_PRESETS, ACCENT_NAMES } from "@shared/themes";
import { DENSITY_LEVELS, densityLabel } from "@shared/density";
import type { EngineCommand } from "@shared/commands";
import type { SessionChrome } from "@hooks/session-state";

interface Props {
  open: boolean;
  onClose: () => void;
  chrome: SessionChrome;
  onSendSlash: (line: string) => void;
  onSendCommand: (c: EngineCommand) => void;
  onOpenModel: () => void;
  onOpenProviders: () => void;
}

export function SettingsSheet({ open, onClose, chrome, onSendSlash, onSendCommand, onOpenModel, onOpenProviders }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const dims = useWindowDimensions();
  const s = makeStyles(colors);
  if (!open) return null;
  const tap = (fn: () => void) => () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined); fn(); };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.scrim}>
        <Pressable style={s.scrimHit} onPress={onClose} />
        <View style={[s.sheet, { paddingBottom: insets.bottom, height: dims.height * 0.85 }]}>
          <View style={s.handle} />
          <View style={s.head}><Txt variant="title">Settings</Txt></View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: T.sBase, gap: T.sMd, paddingBottom: T.s2xl }}>
            <Section title="Theme">
              <View style={s.grid}>
                {THEME_NAMES.map((name) => (
                  <Chip key={name} label={name} selected={chrome.theme === name} onPress={tap(() => onSendSlash(`/theme ${name}`))} />
                ))}
              </View>
            </Section>
            <Section title="Accent">
              <View style={s.grid}>
                {ACCENT_NAMES.map((name) => (
                  <Chip key={name} label={name} selected={chrome.accent.toLowerCase() === ACCENT_PRESETS[name].toLowerCase()} onPress={tap(() => onSendSlash(`/accent ${name}`))} />
                ))}
              </View>
            </Section>
            <Section title="Density">
              <View style={s.row}>
                {DENSITY_LEVELS.map((d) => (
                  <Chip key={d} label={densityLabel(d)} selected={chrome.density === d} onPress={tap(() => onSendSlash(`/density ${d}`))} />
                ))}
              </View>
            </Section>
            <Section title="Approvals">
              <View style={s.row}>
                <Chip label="Ask" selected={chrome.approvals === "ask"} onPress={tap(() => onSendCommand({ type: "set-approvals", mode: "ask" }))} />
                <Chip label="Auto (YOLO)" selected={chrome.approvals === "auto"} onPress={tap(() => onSendCommand({ type: "set-approvals", mode: "auto" }))} />
              </View>
            </Section>
            <Section title="Providers">
              <Pressable onPress={tap(onOpenProviders)} style={({ pressed }) => [s.modelRow, pressed && { opacity: 0.7 }]}>
                <Txt variant="ui" style={{ flex: 1 }}>ChatGPT · Codex / xAI · Grok sign-in</Txt>
                <Txt variant="caption" color={colors.accent}>Manage</Txt>
              </Pressable>
            </Section>
            <Section title="Model">
              <Pressable onPress={tap(onOpenModel)} style={({ pressed }) => [s.modelRow, pressed && { opacity: 0.7 }]}>
                <Txt variant="ui" mono style={{ flex: 1 }} numberOfLines={1}>{chrome.model || "—"}</Txt>
                <Txt variant="caption" color={colors.accent}>Change</Txt>
              </Pressable>
            </Section>
            <Section title="Session">
              <View style={s.row}>
                <Chip label="Compact" onPress={tap(() => onSendCommand({ type: "compact" }))} />
                <Chip label="Clear" onPress={tap(() => onSendSlash("/clear"))} />
              </View>
            </Section>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View>
      <Txt variant="label" color={colors.textSubtle} style={{ marginBottom: T.sXs, textTransform: "uppercase" }}>{title}</Txt>
      {children}
    </View>
  );
}

function Chip({ label, selected, onPress }: { label: string; selected?: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ ...s.chip, backgroundColor: selected ? colors.selBg : colors.surfaceSubtle, borderColor: selected ? colors.accent : colors.borderSoft, opacity: pressed ? 0.7 : 1 })}>
      <Text style={[s.chipText, { color: selected ? colors.selFg : colors.assistant }]}>{label}</Text>
    </Pressable>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    scrim: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.45)" },
    scrimHit: { flex: 1 },
    sheet: { backgroundColor: colors.bg, borderTopLeftRadius: T.radiusXl, borderTopRightRadius: T.radiusXl, borderWidth: 1, borderColor: colors.borderSoft, paddingTop: T.sXs },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong, alignSelf: "center", marginBottom: T.sXs },
    head: { paddingHorizontal: T.sBase, paddingBottom: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    grid: { flexDirection: "row", flexWrap: "wrap", gap: T.sXs },
    row: { flexDirection: "row", flexWrap: "wrap", gap: T.sXs },
    chip: { paddingHorizontal: T.sSm, paddingVertical: T.sXs, borderRadius: T.radiusPill, borderWidth: 1 },
    chipText: { fontSize: T.textUi, fontWeight: "500" },
    modelRow: { flexDirection: "row", alignItems: "center", gap: T.sSm, backgroundColor: colors.surfaceSubtle, borderRadius: T.radius, paddingHorizontal: T.sSm, paddingVertical: T.sXs, borderWidth: 1, borderColor: colors.borderSoft },
  });
}
