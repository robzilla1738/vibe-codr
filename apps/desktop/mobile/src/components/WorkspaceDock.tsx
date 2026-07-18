// Workspace dock — compact navigation that stays on the chat surface, the native
// analog of the desktop WorkspaceDock (Session/Changes/Git/Terminal/Jobs). A
// floating liquid-glass pill with quiet equal-width icon tabs; tapping an
// activity view opens the right activity sidebar on that tab, Terminal opens the
// full-screen terminal. Files is a Finder-reveal action (desktop-only), omitted.
import { StyleSheet, View, Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T } from "../theme/tokens";
import { Glass } from "./Glass";
import { Icon, type IconName } from "./icons";
import type { Tab } from "./ActivityDrawer";

const ACTIVITY: { tab: Tab; icon: IconName; label: string }[] = [
  { tab: "session", icon: "LayoutDashboard", label: "Session" },
  { tab: "changes", icon: "FileText", label: "Changes" },
  { tab: "git", icon: "GitBranch", label: "Git" },
  { tab: "jobs", icon: "SquareTerminal", label: "Jobs" },
];

export function WorkspaceDock({ active, onSelect, onTerminal, badges }: {
  active: Tab | "terminal" | null; onSelect: (t: Tab) => void; onTerminal: () => void; badges: Partial<Record<Tab, boolean>>;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const s = makeStyles(colors);
  const tap = (fn: () => void) => () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined); fn(); };
  return (
    <View style={[s.wrap, { bottom: insets.bottom + 104 }]} pointerEvents="box-none">
      <Glass intensity={70} radius={T.radiusLg} style={s.dock}>
        {ACTIVITY.slice(0, 3).map((it) => {
          const isActive = active === it.tab;
          return (
            <Pressable key={it.tab} onPress={tap(() => onSelect(it.tab))} accessibilityLabel={it.label} style={({ pressed }) => [s.item, isActive && s.itemActive, pressed && { opacity: 0.6 }]}>
              <Icon name={it.icon} size={17} color={isActive ? colors.bg : colors.textSecondary} />
              {badges[it.tab] ? <View style={s.dot} /> : null}
            </Pressable>
          );
        })}
        <Pressable onPress={tap(onTerminal)} accessibilityLabel="Terminal" style={({ pressed }) => [s.item, active === "terminal" && s.itemActive, pressed && { opacity: 0.6 }]}>
          <Icon name="SquareTerminal" size={17} color={active === "terminal" ? colors.assistant : colors.textSecondary} />
        </Pressable>
        {ACTIVITY.slice(3).map((it) => {
          const isActive = active === it.tab;
          return (
            <Pressable key={it.tab} onPress={tap(() => onSelect(it.tab))} accessibilityLabel={it.label} style={({ pressed }) => [s.item, isActive && s.itemActive, pressed && { opacity: 0.6 }]}>
              <Icon name={it.icon} size={17} color={isActive ? colors.assistant : colors.textSecondary} />
              {badges[it.tab] ? <View style={s.dot} /> : null}
            </Pressable>
          );
        })}
      </Glass>
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    wrap: { position: "absolute", left: T.sSm, right: T.sSm, alignItems: "center", zIndex: 25 },
    dock: { width: "100%", maxWidth: 440, flexDirection: "row", padding: T.s2xs, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.surfaceSubtle },
    item: { flex: 1, height: 40, borderRadius: T.radiusMd, alignItems: "center", justifyContent: "center" },
    itemActive: { backgroundColor: colors.navActiveBg },
    dot: { position: "absolute", top: 6, right: 8, width: 6, height: 6, borderRadius: 3, backgroundColor: colors.notice },
  });
}
