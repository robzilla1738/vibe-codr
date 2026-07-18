// Post-turn changed-files pill — the native analog of the desktop
// TurnChangesCard ChangedFilesPill. Summarizes session file changes (+/−) above
// the composer and opens the full Diff/File review. Reuses the shared
// changed-files totals so the summary is identical to desktop.
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T } from "../theme/tokens";
import { Txt } from "./primitives";
import { changedFilesTotals } from "@shared/changed-files";
import type { ChangedFile } from "@shared/reducer";

export function ChangedFilesPill({ files, onReview }: { files: readonly ChangedFile[]; onReview: () => void }) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  if (files.length === 0) return null;
  const totals = changedFilesTotals(files);
  const noun = totals.count === 1 ? "file" : "files";
  return (
    <View style={{ paddingHorizontal: T.sBase, paddingBottom: T.sXs }}>
      <Pressable onPress={onReview} style={({ pressed }) => [s.pill, pressed && { opacity: 0.7 }]}>
        <Text style={s.icon}>±</Text>
        <Txt variant="ui" color={colors.textSecondary} style={{ flex: 1 }}>{totals.count} {noun} changed</Txt>
        <Text style={[s.stat, { color: colors.add }]}>+{totals.added}</Text>
        <Text style={[s.stat, { color: colors.del }]}>−{totals.removed}</Text>
        <Text style={s.chev}>›</Text>
      </Pressable>
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    pill: { flexDirection: "row", alignItems: "center", gap: T.sXs, backgroundColor: colors.surfaceSubtle, borderRadius: T.radiusPill, paddingHorizontal: T.sSm, paddingVertical: T.s2xs, borderWidth: 1, borderColor: colors.borderSoft, alignSelf: "flex-start" },
    icon: { color: colors.tool, fontFamily: "SF Mono", fontSize: T.textUi },
    stat: { fontFamily: "SF Mono", fontSize: T.textCaption },
    chev: { color: colors.textSubtle, fontFamily: "SF Mono", fontSize: T.textUi },
  });
}
