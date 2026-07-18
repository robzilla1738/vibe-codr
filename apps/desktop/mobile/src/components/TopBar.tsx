// Top bar — liquid-glass floating chrome. Leading: sidebar toggle + brand +
// mode chip. Center: project + model. Trailing: terminal, activity, settings,
// disconnect — all intuitive Lucide icons (true to the desktop icon set).
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T } from "../theme/tokens";
import { Txt, Spinner, IconBtn } from "./primitives";
import type { SessionChrome } from "@hooks/session-state";
import type { RemoteConnectionState } from "../remote/RemoteEngineClient";
import { GlassBackdrop } from "./GlassBackdrop";

const tap = (fn: () => void) => () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined); fn(); };

export function TopBar({ chrome, modeColor, busy, connectionState, onDisconnect, onOpenSidebar }: {
  chrome: SessionChrome; modeColor: string; busy: boolean;
  connectionState: RemoteConnectionState;
  onDisconnect: () => void; onOpenSidebar: () => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const s = makeStyles(colors);
  return (
    <View style={[s.shell, { height: insets.top + T.topbarH }]}>
      <GlassBackdrop intensity={52} />
      <View style={[s.bar, { paddingTop: insets.top }]}>
        <View style={s.left}>
          <IconBtn name="PanelLeft" onPress={tap(onOpenSidebar)} label="Projects sidebar" />
        </View>
        <View style={s.center}>
          <Txt variant="ui" color={colors.assistant} numberOfLines={1} style={{ fontWeight: "600", letterSpacing: T.trackingUi }}>{cwdLabel(chrome.cwd)}</Txt>
          {chrome.model ? <Txt variant="caption" color={colors.muted} numberOfLines={1} style={{ letterSpacing: T.trackingUi }}>{chrome.model}</Txt> : null}
        </View>
        <View style={s.right}>
          {busy ? <View style={s.busyDot}><Spinner size="small" color={modeColor} /></View> : null}
          <View accessibilityLabel={`Remote ${connectionState}`} style={s.connectionPill}>
            <View style={[s.connectionDot, { backgroundColor: connectionState === "connected" ? colors.add : connectionState === "disconnected" ? colors.del : colors.notice }]} />
            {width >= 430 ? <Txt variant="micro" color={colors.textSecondary} style={s.connectionText}>{connectionState === "connected" ? "REMOTE" : connectionState === "reconnecting" ? "RETRY" : connectionState === "connecting" ? "LINK" : "OFFLINE"}</Txt> : null}
          </View>
          <IconBtn name="Laptop" onPress={tap(onDisconnect)} label="Return control to desktop" size={18} />
        </View>
      </View>
    </View>
  );
}

function cwdLabel(cwd: string): string {
  const segs = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return segs[segs.length - 1] || cwd || "~";
}

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    shell: { position: "absolute", top: 0, left: 0, right: 0, zIndex: 30, overflow: "hidden", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    bar: { flex: 1, flexDirection: "row", alignItems: "center", paddingHorizontal: T.sXs, paddingBottom: T.sXs },
    left: { width: 44, flexDirection: "row", alignItems: "center" },
    center: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: T.sXs, minWidth: 0 },
    right: { flexDirection: "row", alignItems: "center", gap: 2 },
    busyDot: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
    connectionPill: { minWidth: 32, height: 32, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, paddingHorizontal: 8, borderRadius: T.radiusPill, backgroundColor: colors.surfaceSubtle, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderSoft },
    connectionDot: { width: 6, height: 6, borderRadius: 3 },
    connectionText: { fontWeight: "600", letterSpacing: 0.3 },
  });
}
