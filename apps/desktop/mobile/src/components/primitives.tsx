// Token-first native primitives. Each resolves colors from the active theme
// (mirroring the desktop CSS variables) and re-creates its StyleSheet only when
// the theme changes — the same token-first rule as the Electron design system.
import { useMemo, type ReactNode } from "react";
import { StyleSheet, Text, View, Pressable, ActivityIndicator, type ViewStyle, type TextStyle, type StyleProp, type PressableProps } from "react-native";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T } from "../theme/tokens";

export function Surface({ style, children, ...rest }: { style?: StyleProp<ViewStyle>; children?: ReactNode } & Omit<React.ComponentProps<typeof View>, "style">) {
  return <View style={style ? [style] : undefined} {...rest}>{children}</View>;
}

type Variant = "display" | "heading" | "title" | "prose" | "ui" | "label" | "caption" | "micro" | "code";
const SIZE: Record<Variant, number> = {
  display: T.textDisplay, heading: T.textHeading, title: T.textTitle, prose: T.textProse,
  ui: T.textUi, label: T.textLabel, caption: T.textCaption, micro: T.textMicro, code: T.textCode,
};

export function Txt({ variant = "prose", color, mono, weight, align, leading, size, style, children, numberOfLines }: {
  variant?: Variant; color?: string; mono?: boolean; weight?: string; align?: "auto" | "left" | "center" | "right"; leading?: number; size?: number; style?: StyleProp<TextStyle>; children?: ReactNode; numberOfLines?: number;
}) {
  const { colors } = useTheme();
  const textStyle = useMemo<TextStyle>(() => ({
    color: color ?? colors.assistant,
    fontSize: size ?? SIZE[variant],
    fontWeight: (weight ?? (variant === "ui" || variant === "label" ? T.weightUi : T.weightRegular)) as TextStyle["fontWeight"],
    fontFamily: mono ? "SF Mono" : undefined,
    letterSpacing: variant === "ui" || variant === "label" ? T.trackingUi : variant === "heading" || variant === "title" ? T.trackingTight : undefined,
    textAlign: align,
    lineHeight: leading != null ? leading : variant === "prose" ? T.textProse * T.leadingProse : variant === "code" ? T.textCode * T.leadingCode : undefined,
  }), [colors.assistant, color, variant, mono, weight, align, leading, size]);
  return <Text style={[textStyle, style]} numberOfLines={numberOfLines}>{children}</Text>;
}

export function Card({ children, inset = T.sSm, radius = T.radius, bordered = true, surface = "elevated", style }: {
  children?: ReactNode; inset?: number; radius?: number; bordered?: boolean; surface?: "elevated" | "panel" | "surfaceSubtle" | "cardBg"; style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const s = useMemo(() => StyleSheet.create({
    card: { backgroundColor: colors[surface], borderRadius: radius, borderWidth: bordered ? 1 : 0, borderColor: colors.borderSoft, padding: inset },
  }), [colors, inset, radius, bordered, surface]);
  return <View style={[s.card, style]}>{children}</View>;
}

export function Divider({ vertical }: { vertical?: boolean }) {
  const { colors } = useTheme();
  const s = useMemo(() => StyleSheet.create({
    line: { backgroundColor: colors.borderSoft, ...(vertical ? { width: 1, alignSelf: "stretch" } : { height: StyleSheet.hairlineWidth, width: "100%" }) },
  }), [colors, vertical]);
  return <View style={s.line} />;
}

export function Chip({ label, color, bg, onPress, selected }: { label: string; color?: string; bg?: string; onPress?: () => void; selected?: boolean }) {
  const { colors } = useTheme();
  const s = useMemo(() => StyleSheet.create({
    chip: { paddingHorizontal: T.sXs, height: T.composerChipH, borderRadius: T.radiusPill, flexDirection: "row", alignItems: "center", backgroundColor: bg ?? (selected ? colors.selBg : colors.surfaceSubtle), borderWidth: 1, borderColor: selected ? colors.borderActive : colors.borderSoft },
    label: { color: color ?? (selected ? colors.selFg : colors.textSecondary), fontSize: T.textLabel, fontWeight: T.weightUi as TextStyle["fontWeight"], letterSpacing: T.trackingUi },
  }), [colors, color, bg, selected]);
  if (onPress) {
    return <Pressable onPress={onPress} style={({ pressed }) => ({ ...s.chip, opacity: pressed ? 0.7 : 1 })}><Text style={s.label}>{label}</Text></Pressable>;
  }
  return <View style={s.chip}><Text style={s.label}>{label}</Text></View>;
}

export function Button({ label, onPress, variant = "primary", disabled, icon, style }: { label: string; onPress?: () => void; variant?: "primary" | "ghost" | "danger"; disabled?: boolean; icon?: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  const s = useMemo(() => {
    const base: ViewStyle = { paddingHorizontal: T.sBase, height: 44, borderRadius: T.radius, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: T.sXs };
    const text: TextStyle = { fontSize: T.textUi, fontWeight: T.weightMedium as TextStyle["fontWeight"], letterSpacing: T.trackingUi };
    if (variant === "primary") return StyleSheet.create({ btn: { ...base, backgroundColor: colors.accent }, txt: { ...text, color: colors.bg } });
    if (variant === "danger") return StyleSheet.create({ btn: { ...base, backgroundColor: "transparent", borderWidth: 1, borderColor: colors.del }, txt: { ...text, color: colors.del } });
    return StyleSheet.create({ btn: { ...base, backgroundColor: colors.surfaceSubtle, borderWidth: 1, borderColor: colors.borderSoft }, txt: { ...text, color: colors.assistant } });
  }, [colors, variant]);
  return (
    <Pressable onPress={onPress} disabled={disabled} style={({ pressed }) => ({ ...s.btn, opacity: pressed ? 0.7 : disabled ? 0.4 : 1, ...StyleSheet.flatten(style) })}>
      {icon}
      <Text style={s.txt}>{label}</Text>
    </Pressable>
  );
}

export function IconButton({ onPress, children, hitOffset = 12, disabled }: { onPress?: () => void; children: ReactNode; hitOffset?: number; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={hitOffset} style={({ pressed }) => ({ padding: T.sXs, borderRadius: T.radiusSm, opacity: pressed ? 0.5 : 1 })}>
      {children}
    </Pressable>
  );
}

export function Spinner({ color, size = "small" }: { color?: string; size?: "small" | "large" }) {
  const { colors } = useTheme();
  return <ActivityIndicator size={size} color={color ?? colors.muted} />;
}

export { staticTokens as T } from "../theme/tokens";
export type { PressableProps };

// Icon button — intuitive chrome control (Lucide glyph + haptic), matching the
// desktop's thin-stroke icon utilities. Accessible label; tint on active.
import { Icon, type IconName } from "./icons";
export function IconBtn({ name, onPress, size = 20, color, active, label, badge }: {
  name: IconName; onPress?: () => void; size?: number; color?: string; active?: boolean; label: string; badge?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityLabel={label} accessibilityRole="button" hitSlop={12}
      style={({ pressed }) => [iconBtnStyles(colors, active).btn, pressed && { opacity: 0.5 }]}>
      <Icon name={name} size={size} color={color ?? (active ? colors.accent : colors.textSecondary)} />
      {badge ? <View style={iconBtnStyles(colors, active).dot} /> : null}
    </Pressable>
  );
}
function iconBtnStyles(colors: ReturnType<typeof useTheme>["colors"], active?: boolean) {
  return StyleSheet.create({
    btn: { width: 44, height: 44, borderRadius: T.radiusPill, alignItems: "center", justifyContent: "center", backgroundColor: active ? colors.navActiveBg : "transparent" },
    dot: { position: "absolute", top: 7, right: 7, width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
  });
}
