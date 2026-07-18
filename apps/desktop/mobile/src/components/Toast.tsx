// Toast — the auto-dismissing transient notice. Mirrors the desktop .toast:
// top-right (below the topbar), a left severity dot marker, elevated bg +
// elev-overlay shadow, text-caption, and subtle warn/error border+bg tints.
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T, shadowMenu } from "../theme/tokens";
import { Txt } from "./primitives";
import type { ToastState } from "../hooks/useRemoteSession";

export function Toast({ toast }: { toast: ToastState | null }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const dims = useWindowDimensions();
  if (!toast) return null;
  const dot = toast.severity === "error" ? colors.del : toast.severity === "warn" ? colors.notice : colors.borderStrong;
  const tint = toast.severity === "error" ? colors.del : toast.severity === "warn" ? colors.notice : colors.border;
  const s = StyleSheet.create({
    wrap: {
      position: "absolute", top: insets.top + T.topbarH + 12, right: 16, left: Math.max(16, dims.width - 360 - 16),
      flexDirection: "row", alignItems: "center", gap: T.sSm,
      paddingHorizontal: T.sBase, paddingVertical: T.sSm,
      backgroundColor: colors.elevated, borderRadius: T.radiusMd, borderWidth: 1, borderColor: tint,
      ...shadowMenu(colors), opacity: toast.closing ? 0.5 : 1, zIndex: 50,
    },
    marker: { width: 6, height: 6, borderRadius: 3, backgroundColor: dot },
  });
  return (
    <View pointerEvents="none" style={s.wrap}>
      <View style={s.marker} />
      <Txt variant="caption" style={{ flex: 1, color: colors.assistant, lineHeight: T.textCaption * T.leadingProse }}>{toast.message}</Txt>
    </View>
  );
}
