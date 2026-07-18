// @-mention file attach — the native analog of the desktop composer's fuzzy
// @path picker. Detects an @-mention with the shared `atMentionState`, fetches
// project files over the relay `list-files` channel, ranks them with the shared
// `rankPaths`, and inserts the chosen path with the shared `applyAtMention` —
// so the fuzzy scoring and `@path` formatting are identical to desktop.
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View, Text, FlatList, Pressable } from "react-native";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T } from "../theme/tokens";
import { Txt, Spinner } from "./primitives";
import { atMentionState, applyAtMention } from "@shared/file-fuzzy";
import type { RelayOutbound } from "@relay/protocol";
import type { RemoteEngineClient } from "../remote/RemoteEngineClient";

interface Props {
  draft: string;
  cwd: string;
  client: RemoteEngineClient;
  onPick: (newDraft: string) => void;
}

export function AtMentionPicker({ draft, cwd, client, onPick }: Props) {
  const { colors } = useTheme();
  const mention = useMemo(() => atMentionState(draft), [draft]);
  const [paths, setPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const s = makeStyles(colors);

  useEffect(() => {
    if (!mention) { setPaths([]); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      setLoading(true);
      const off = client.onRelay((frame: RelayOutbound) => {
        if (frame.relay === "files" && !cancelled) { setPaths(frame.paths); setLoading(false); off(); }
      });
      client.listFiles(cwd, mention.query, 30);
    }, 80);
    return () => { cancelled = true; clearTimeout(t); };
  }, [mention, cwd, client]);

  if (!mention) return null;

  function pick(path: string) {
    onPick(applyAtMention(draft, mention!.atIndex, path, true) + " ");
  }

  return (
    <View style={{ marginHorizontal: T.sBase, marginBottom: T.sXs, borderRadius: T.radius, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.overlay, overflow: "hidden" }}>
      {loading && paths.length === 0 ? <View style={s.center}><Spinner /></View> :
        <FlatList
          keyboardShouldPersistTaps="handled"
          style={{ maxHeight: 220 }}
          data={paths}
          keyExtractor={(p) => p}
          renderItem={({ item }) => (
            <Pressable onPress={() => pick(item)} style={({ pressed }) => ({ ...s.row, backgroundColor: pressed ? colors.surfaceSubtle : "transparent" })}>
              <Text style={s.path} numberOfLines={1}>{item}</Text>
            </Pressable>
          )}
        />}
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    wrap: { backgroundColor: colors.elevated, borderRadius: T.radius, borderWidth: 1, borderColor: colors.borderSoft, marginBottom: T.sXs, overflow: "hidden" },
    center: { paddingVertical: T.sSm, alignItems: "center" },
    row: { paddingHorizontal: T.sSm, paddingVertical: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    path: { color: colors.assistant, fontFamily: "SF Mono", fontSize: T.textUi },
  });
}
