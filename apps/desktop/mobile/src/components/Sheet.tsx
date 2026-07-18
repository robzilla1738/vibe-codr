// Reusable bottom sheet for settings/inspector/catalog/etc. An opaque native
// surface with modal elevation, a
// Reanimated slide-up + scrim fade, a grab handle, and an icon header with close.
// Mirrors the desktop modal elevation (--shadow-modal + --edge-highlight).
import { useEffect, type ReactNode } from "react";
import { StyleSheet, View, Pressable, Modal, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T, shadowModal } from "../theme/tokens";
import { Txt, IconBtn } from "./primitives";
import { Icon, type IconName } from "./icons";
import { useAccessibilitySettings } from "../hooks/useAccessibilitySettings";

export function Sheet({ open, onClose, title, icon, children, heightRatio = 0.9, maxHeightRatio, footer }: {
  open: boolean; onClose: () => void; title: string; icon?: IconName; children: ReactNode; heightRatio?: number; maxHeightRatio?: number; footer?: ReactNode;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const dims = useWindowDimensions();
  const { reduceMotion } = useAccessibilitySettings();
  const translateY = useSharedValue(open ? 0 : dims.height);
  const scrimOp = useSharedValue(open ? 1 : 0);

  useEffect(() => {
    translateY.value = reduceMotion ? (open ? 0 : dims.height) : open ? withSpring(0, { damping: 30, stiffness: 300 }) : withTiming(dims.height, { duration: 220 });
    scrimOp.value = reduceMotion ? (open ? 1 : 0) : open ? withTiming(1, { duration: 200 }) : withTiming(0, { duration: 200 });
  }, [open, dims.height, reduceMotion, translateY, scrimOp]);

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrimOp.value }));

  const height = maxHeightRatio ? dims.height * maxHeightRatio : dims.height * heightRatio;
  return (
    <Modal visible={open} transparent animationType="none" onRequestClose={onClose}>
      <View style={StyleSheet.absoluteFill}>
        <Animated.View style={[scrim(colors), scrimStyle]}><Pressable style={{ flex: 1 }} onPress={onClose} /></Animated.View>
        <Animated.View style={[{ position: "absolute", left: 0, right: 0, bottom: 0, height }, sheetStyle]}>
          <View style={{ flex: 1, borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: "hidden", backgroundColor: colors.bg, borderTopWidth: 1, borderColor: colors.borderSoft, ...shadowModal(colors), paddingBottom: insets.bottom }}>
            <View style={sheetStyles(colors).handle} />
            <View style={sheetStyles(colors).head}>
              {icon ? <Icon name={icon} size={18} color={colors.accent} /> : null}
              <Txt variant="title" style={{ flex: 1 }}>{title}</Txt>
              <IconBtn name="X" onPress={onClose} label={`Close ${title}`} size={18} />
            </View>
            <View style={{ flex: 1 }}>{children}</View>
            {footer ? <View style={sheetStyles(colors).footer}>{footer}</View> : null}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

function scrim(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({ s: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: "rgba(0,0,0,0.5)" } }).s;
}
function sheetStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong, alignSelf: "center", marginTop: T.s2xs, marginBottom: T.sXs },
    head: { flexDirection: "row", alignItems: "center", gap: T.sXs, paddingHorizontal: T.sBase, paddingBottom: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    footer: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSoft, paddingHorizontal: T.sBase, paddingVertical: T.sXs },
  });
}
