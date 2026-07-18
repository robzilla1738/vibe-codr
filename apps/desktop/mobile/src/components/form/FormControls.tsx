// Native form primitives for the config Settings panel — token-first ports of
// the desktop FormControls (SettingField/TextInput/NumberInput/SelectInput/
// ToggleSwitch/TextArea/KeyValueTextArea/SettingSection). Same field semantics
// so the ported sections behave identically.
import { useState, type ReactNode } from "react";
import { StyleSheet, Text, View, TextInput as RNTextInput, Pressable, useWindowDimensions } from "react-native";
import { useTheme } from "../../theme/ThemeProvider";
import { staticTokens as T } from "../../theme/tokens";
import { Txt } from "../primitives";
import { parseKeyValueLines, formatKeyValueLines } from "@shared/key-value-lines";

export function SettingSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  return (
    <View style={s.section}>
      <Txt variant="title">{title}</Txt>
      {description ? <Txt variant="caption" color={colors.textSecondary} style={{ marginBottom: T.sXs }}>{description}</Txt> : null}
      <View style={s.fields}>{children}</View>
    </View>
  );
}

export function SettingField({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const s = makeStyles(colors);
  const compact = width < 700;
  return (
    <View style={[s.field, compact && s.fieldCompact]}>
      <View style={[s.fieldLabel, compact && s.fieldLabelCompact]}>
        <Txt variant="ui" style={{ fontWeight: "500" }}>{label}</Txt>
        {description ? <Txt variant="caption" color={colors.textSubtle}>{description}</Txt> : null}
      </View>
      <View style={s.fieldControl}>{children}</View>
    </View>
  );
}

export function TextInput({ value, onChange, placeholder, monospace, disabled }: { value: string; onChange: (v: string) => void; placeholder?: string; monospace?: boolean; disabled?: boolean }) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  return <RNTextInput style={[s.input, monospace && s.mono]} value={value ?? ""} placeholder={placeholder} placeholderTextColor={colors.textSubtle} editable={!disabled} autoCapitalize="none" autoCorrect={false} onChangeText={onChange} />;
}

export function NumberInput({ value, onChange, min, max, step, placeholder, disabled }: { value: number | undefined; onChange: (v: number | undefined) => void; min?: number; max?: number; step?: number; placeholder?: string; disabled?: boolean }) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  return <RNTextInput style={[s.input, s.mono]} value={value == null ? "" : String(value)} placeholder={placeholder} placeholderTextColor={colors.textSubtle} editable={!disabled} keyboardType="numeric" onChangeText={(t) => { if (t === "") { onChange(undefined); return; } const n = Number(t); onChange(Number.isFinite(n) ? n : undefined); }} />;
}

export function SelectInput<T extends string>({ value, onChange, options, disabled }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; disabled?: boolean }) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  return (
    <View style={s.selectWrap}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable key={opt.value} disabled={disabled} onPress={() => onChange(opt.value)} style={({ pressed }) => [s.selectOpt, active && s.selectOptActive, pressed && { opacity: 0.7 }, disabled && { opacity: 0.4 }]}>
            <Txt variant="ui" color={active ? colors.bg : colors.assistant}>{opt.label}</Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

export function ToggleSwitch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  return (
    <Pressable disabled={disabled} onPress={() => onChange(!checked)} style={({ pressed }) => [s.toggle, checked && s.toggleOn, pressed && { opacity: 0.7 }, disabled && { opacity: 0.4 }]}>
      <View style={[s.thumb, checked && s.thumbOn]} />
    </Pressable>
  );
}

export function TextArea({ value, onChange, placeholder, monospace, disabled }: { value: string; onChange: (v: string) => void; placeholder?: string; monospace?: boolean; disabled?: boolean }) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  return <RNTextInput style={[s.textarea, monospace && s.mono]} value={value ?? ""} placeholder={placeholder} placeholderTextColor={colors.textSubtle} editable={!disabled} multiline autoCapitalize="none" autoCorrect={false} onChangeText={onChange} />;
}

export function KeyValueTextArea({ value, onChange, separator = "=", placeholder, disabled }: { value: Record<string, string> | undefined; onChange: (v: Record<string, string>) => void; separator?: string; placeholder?: string; disabled?: boolean }) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  const [text, setText] = useState(formatKeyValueLines(value ?? {}, separator as "=" | ":"));
  return <RNTextInput style={[s.textarea, s.mono]} value={text} placeholder={placeholder} placeholderTextColor={colors.textSubtle} editable={!disabled} multiline autoCapitalize="none" autoCorrect={false} onChangeText={(t) => { setText(t); const parsed = parseKeyValueLines(t, separator as "=" | ":"); if (parsed.ok) onChange(parsed.value); }} />;
}

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    section: { marginBottom: T.sMd },
    fields: { gap: T.sSm },
    field: { flexDirection: "row", gap: T.sSm, alignItems: "flex-start" },
    fieldCompact: { flexDirection: "column", gap: T.sXs, paddingVertical: T.s2xs },
    fieldLabel: { width: 130, paddingTop: T.sXs },
    fieldLabelCompact: { width: "100%", paddingTop: 0 },
    fieldControl: { flex: 1 },
    input: { color: colors.assistant, fontSize: T.textUi, backgroundColor: colors.elevated, borderRadius: T.radiusSm, paddingHorizontal: T.sSm, paddingVertical: T.sXs, borderWidth: 1, borderColor: colors.borderSoft, minHeight: 40 },
    mono: { fontFamily: "SF Mono" },
    textarea: { color: colors.assistant, fontSize: T.textUi, backgroundColor: colors.elevated, borderRadius: T.radiusSm, paddingHorizontal: T.sSm, paddingVertical: T.sXs, borderWidth: 1, borderColor: colors.borderSoft, minHeight: 96, textAlignVertical: "top" },
    selectWrap: { flexDirection: "row", flexWrap: "wrap", gap: T.sXs },
    selectOpt: { paddingHorizontal: T.sSm, paddingVertical: T.sXs, borderRadius: T.radiusPill, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.surfaceSubtle },
    selectOptActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    toggle: { width: 44, height: 26, borderRadius: 13, backgroundColor: colors.surfaceSubtle, borderWidth: 1, borderColor: colors.borderSoft, padding: 2, justifyContent: "center" },
    toggleOn: { backgroundColor: colors.accent, borderColor: colors.accent },
    thumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.muted, alignSelf: "flex-start" },
    thumbOn: { backgroundColor: colors.bg, alignSelf: "flex-end" },
  });
}
