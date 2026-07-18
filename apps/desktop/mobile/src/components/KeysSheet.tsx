// Keys overlay — the native analog of the desktop /keys overlay. Renders the
// shared ESSENTIAL_KEYS list (the single source of truth for chords) so the
// discoverable surface never drifts. Most relevant on iPad with a hardware
// keyboard; touch equivalents are the on-screen controls.
import { StyleSheet, View, ScrollView } from "react-native";
import { Sheet } from "./Sheet";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T } from "../theme/tokens";
import { Txt, Card } from "./primitives";
import { ESSENTIAL_KEYS } from "@shared/keys-help";

export function KeysSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  return (
    <Sheet open={open} onClose={onClose} title="Keyboard" icon="Brain" maxHeightRatio={0.7}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: T.sBase, paddingBottom: T.s2xl }}>
        <Card surface="surfaceSubtle" inset={T.sSm}>
          {ESSENTIAL_KEYS.map((k) => (
            <View key={k.keys + k.action} style={s.row}>
              <Txt variant="ui" mono style={s.kbd}>{k.keys}</Txt>
              <Txt variant="ui" color={colors.textSecondary} style={{ flex: 1 }}>{k.action}</Txt>
            </View>
          ))}
        </Card>
        <Txt variant="caption" color={colors.textSubtle} style={{ marginTop: T.sSm }}>
          /details quiet|normal|verbose · /help for all slash commands.
        </Txt>
      </ScrollView>
    </Sheet>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    scrim: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.45)" },
    scrimHit: { flex: 1 },
    sheet: { backgroundColor: colors.bg, borderTopLeftRadius: T.radiusXl, borderTopRightRadius: T.radiusXl, borderWidth: 1, borderColor: colors.borderSoft, paddingTop: T.sXs },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong, alignSelf: "center", marginBottom: T.sXs },
    head: { paddingHorizontal: T.sBase, paddingBottom: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    row: { flexDirection: "row", gap: T.sSm, alignItems: "center", paddingVertical: T.s2xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    kbd: { minWidth: 150, color: colors.accent },
  });
}
