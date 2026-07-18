// Liquid-glass surface — a BlurView (real frost on iOS, translucent on Android)
// with a token-derived translucent tint + edge highlight, mirroring the desktop
// glass chrome (--glass-float-bg / --blur-surface / --edge-highlight). Use for
// floating chrome (topbar, composer, sidebar, sheets) so content refracts through.
import { StyleSheet, View, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T, withAlpha } from "../theme/tokens";

export function Glass({ intensity = 80, tint, style, children, radius }: {
  intensity?: number; tint?: "light" | "dark" | "default"; style?: ViewStyle; children?: React.ReactNode; radius?: number;
}) {
  const { colors } = useTheme();
  const s = StyleSheet.create({
    overlay: {
      position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: withAlpha(colors.elevated, colors.scheme === "light" ? 0.74 : 0.66),
      borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: withAlpha("#ffffff", colors.scheme === "light" ? 0.6 : 0.08),
    },
  });
  return (
    <View style={[{ position: "relative", borderRadius: radius, overflow: "hidden" }, style]}>
      <BlurView intensity={intensity} tint={tint ?? (colors.scheme === "light" ? "light" : "dark")} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} />
      <View style={s.overlay} pointerEvents="none" />
      <View style={{ position: "relative", flex: 1 }}>{children}</View>
    </View>
  );
}

export { T };
