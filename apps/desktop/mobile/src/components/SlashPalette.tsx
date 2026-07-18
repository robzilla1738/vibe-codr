// Slash-command palette — opens while the composer draft is a slash line. Reuses
// the shared `paletteState` / `applyPalette` / `PALETTE_COMMANDS` so the command
// list, tiered fuzzy matching, and enum value lists are identical to desktop.
import { useMemo, useState } from "react";
import { FlatList, StyleSheet, View, Pressable, Text } from "react-native";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T } from "../theme/tokens";
import { Txt } from "./primitives";
import { paletteState, applyPalette, type PaletteState } from "@shared/commands-catalog";

interface Props {
  draft: string;
  commandNames: readonly string[];
  onPick: (draft: string, done: boolean) => void;
}

export function SlashPalette({ draft, commandNames, onPick }: Props) {
  const { colors } = useTheme();
  const [sel, setSel] = useState(0);
  const state = useMemo(() => paletteState(draft, commandNames), [draft, commandNames]);
  const s = makeStyles(colors);
  if (!state.open) return null;

  const rows: { name: string; description: string }[] = state.mode === "command"
    ? state.items.map((c) => ({ name: c.name, description: c.description }))
    : state.items.map((v) => ({ name: String(v), description: state.command.description ?? "" }));
  const safeSel = Math.min(sel, Math.max(0, rows.length - 1));

  function pick(index: number) {
    const result = applyPalette(state as PaletteState, index);
    if (result) onPick(result.draft, result.done);
  }

  return (
    <View style={{ marginHorizontal: T.sXs, marginBottom: T.sXs, borderRadius: T.radius, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.overlay, overflow: "hidden" }}>
      <FlatList
        keyboardShouldPersistTaps="handled"
        style={{ maxHeight: 260 }}
        data={rows}
        keyExtractor={(item) => item.name}
        renderItem={({ item, index }) => {
          const active = index === safeSel;
          return (
            <Pressable onPress={() => pick(index)} style={({ pressed }) => ({ ...s.row, backgroundColor: active ? colors.selBg : pressed ? colors.surfaceSubtle : "transparent" })}>
              <Text style={[s.name, { color: active ? colors.selFg : colors.assistant }]}>{item.name}</Text>
              <Txt variant="caption" color={colors.textSubtle} style={{ flex: 1 }} numberOfLines={1}>{item.description}</Txt>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    wrap: { backgroundColor: colors.elevated, borderRadius: T.radius, borderWidth: 1, borderColor: colors.borderSoft, marginBottom: T.sXs, overflow: "hidden" },
    row: { flexDirection: "row", alignItems: "center", gap: T.sSm, paddingHorizontal: T.sSm, paddingVertical: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    name: { fontFamily: "SF Mono", fontSize: T.textUi, fontWeight: "500" },
  });
}
