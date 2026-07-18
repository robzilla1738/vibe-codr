import { StyleSheet, View } from "react-native";
import { BlurView } from "expo-blur";
import { useAccessibilitySettings } from "../hooks/useAccessibilitySettings";
import { useTheme } from "../theme/ThemeProvider";
import { fade } from "../theme/tokens";

/** Functional glass for floating chrome only. Content cards, messages, lists,
 * and sheets deliberately remain opaque. */
export function GlassBackdrop({ intensity = 58 }: { intensity?: number }) {
  const { colors } = useTheme();
  const { reduceTransparency } = useAccessibilitySettings();
  if (reduceTransparency) {
    return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.elevated }]} />;
  }
  return <View pointerEvents="none" style={StyleSheet.absoluteFill}>
    <BlurView tint={colors.scheme === "light" ? "light" : "dark"} intensity={intensity} style={StyleSheet.absoluteFill} />
    <View style={[StyleSheet.absoluteFill, { backgroundColor: fade(colors.elevated, colors.scheme === "light" ? 78 : 72) }]} />
  </View>;
}
