// Full changed-files review — the native analog of the desktop master-detail
// Diff/File review. A file list (with +/- deltas) drills into the selected
// file's unified diff with per-line +/- coloring (parity with the desktop diff
// viewer). Fed by the transcript changedFiles (carried per ChangedFile).
import { useState } from "react";
import { StyleSheet, View, Text, ScrollView, Pressable } from "react-native";
import { Sheet } from "./Sheet";
import { Icon } from "./icons";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T } from "../theme/tokens";
import { Txt, Card, Divider } from "./primitives";
import { sortChangedFilesForDisplay } from "@shared/changed-files";
import type { ChangedFile } from "@shared/reducer";

export function DiffReviewSheet({ open, onClose, changedFiles }: {
  open: boolean; onClose: () => void; changedFiles: readonly ChangedFile[];
}) {
  const { colors } = useTheme();
  const [selected, setSelected] = useState<string | null>(null);
  const s = makeStyles(colors);
  const files = sortChangedFilesForDisplay([...changedFiles]);
  const current = files.find((f) => f.path === selected) ?? null;

  return (
    <Sheet open={open} onClose={onClose} title="Changes" icon="FileText" heightRatio={0.9}>
      {files.length === 0 ? (
        <View style={s.center}><Txt variant="ui" color={colors.textSubtle}>No changed files this session</Txt></View>
      ) : current ? (
        <View style={{ flex: 1 }}>
          <Pressable onPress={() => setSelected(null)} style={s.back}><Icon name="ChevronLeft" size={16} color={colors.accent} /><Text style={s.backText}>Files</Text></Pressable>
          <View style={s.fileHead}>
            <Txt variant="ui" mono style={{ flex: 1 }} numberOfLines={1}>{current.path}</Txt>
            <Txt variant="caption" color={colors.add}>+{current.added}</Txt>
            <Txt variant="caption" color={colors.del}>−{current.removed}</Txt>
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: T.sBase, paddingBottom: T.s2xl }}>
            {current.diff ? renderDiff(current.diff, colors, s) : <Txt variant="ui" color={colors.textSubtle}>No diff text available</Txt>}
          </ScrollView>
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: T.sBase, paddingBottom: T.s2xl }}>
          {files.map((f) => (
            <Pressable key={f.path} onPress={() => setSelected(f.path)} style={({ pressed }) => [s.fileRow, pressed && { opacity: 0.7 }]}>
              <Txt variant="ui" mono style={{ flex: 1 }} numberOfLines={1}>{f.path}</Txt>
              <Txt variant="caption" color={colors.add}>+{f.added}</Txt>
              <Txt variant="caption" color={colors.del}>−{f.removed}</Txt>
              <Icon name="ChevronRight" size={14} color={colors.textSubtle} />
            </Pressable>
          ))}
        </ScrollView>
      )}
    </Sheet>
  );
}

function renderDiff(diff: string, colors: ReturnType<typeof useTheme>["colors"], s: ReturnType<typeof makeStyles>) {
  return diff.split("\n").map((line, i) => {
    const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "ctx";
    const color = kind === "add" ? colors.add : kind === "del" ? colors.del : kind === "hunk" ? colors.ctx : colors.textSecondary;
    const bg = kind === "add" ? colors.diffAddBg : kind === "del" ? colors.diffDelBg : "transparent";
    return (
      <View key={i} style={[s.diffLine, { backgroundColor: bg }]}>
        <Text style={[s.diffText, { color }]}>{line || " "}</Text>
      </View>
    );
  });
}

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    scrim: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.45)" },
    scrimHit: { flex: 1 },
    sheet: { backgroundColor: colors.bg, borderTopLeftRadius: T.radiusXl, borderTopRightRadius: T.radiusXl, borderWidth: 1, borderColor: colors.borderSoft, paddingTop: T.sXs },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong, alignSelf: "center", marginBottom: T.sXs },
    head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: T.sBase, paddingBottom: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    center: { flex: 1, alignItems: "center", justifyContent: "center" },
    back: { paddingHorizontal: T.sBase, paddingVertical: T.sXs },
    backText: { color: colors.accent, fontSize: T.textUi },
    fileHead: { flexDirection: "row", alignItems: "center", gap: T.sXs, paddingHorizontal: T.sBase, paddingVertical: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    fileRow: { flexDirection: "row", alignItems: "center", gap: T.sXs, paddingVertical: T.sXs, paddingHorizontal: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    chev: { color: colors.textSubtle, fontFamily: "SF Mono", fontSize: T.textUi },
    diffLine: { paddingVertical: 1, paddingHorizontal: T.sXs },
    diffText: { fontFamily: "SF Mono", fontSize: T.textCode, lineHeight: T.textCode * 1.35 },
  });
}
