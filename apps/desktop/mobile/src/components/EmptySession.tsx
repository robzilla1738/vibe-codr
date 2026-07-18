import { StyleSheet, View } from "react-native";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T } from "../theme/tokens";
import { Txt } from "./primitives";
import { BrandIcon } from "./BrandWordmark";

export function EmptySession({ cwd, model }: { cwd: string; model?: string }) {
  const { colors } = useTheme();
  const project = cwd.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || "this project";
  const s = styles(colors);
  return (
    <View style={s.wrap}>
      <BrandIcon size={58} style={s.mark} />
      <Txt variant="heading" size={24} align="center" style={s.title}>What are we building?</Txt>
      <Txt variant="prose" color={colors.textSecondary} align="center" style={s.copy}>
        Start a task in {project}. Vibe can inspect the project, make changes, run commands, and keep the same session moving between this phone and your desktop.
      </Txt>
      <View style={s.hints}>
        <View style={s.hint}><Txt variant="caption" mono color={colors.textSecondary}>/</Txt><Txt variant="caption" color={colors.textSubtle}>commands</Txt></View>
        <View style={s.hint}><Txt variant="caption" mono color={colors.textSecondary}>@</Txt><Txt variant="caption" color={colors.textSubtle}>project files</Txt></View>
        {model ? <Txt variant="caption" color={colors.textSubtle} numberOfLines={1}>{model}</Txt> : null}
      </View>
    </View>
  );
}

function styles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    wrap: { flex: 1, width: "100%", maxWidth: 560, alignSelf: "center", alignItems: "center", justifyContent: "center", paddingHorizontal: T.sLg, paddingBottom: 72 },
    mark: { marginBottom: T.sBase },
    title: { marginBottom: T.sSm, letterSpacing: -0.35 },
    copy: { maxWidth: 460, marginBottom: T.sMd },
    hints: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: T.sSm },
    hint: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: T.sXs, height: 28, borderRadius: T.radiusMd, backgroundColor: colors.surfaceSubtle },
  });
}
