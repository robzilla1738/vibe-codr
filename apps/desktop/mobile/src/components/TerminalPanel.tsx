// Remote terminal — the native analog of the desktop contextual terminal. The
// PTY lives on the desktop (relay's TerminalManager, reusing the Electron
// terminal-manager); this renders the streamed output with a small VT/ANSI
// screen model and sends input/resize back over the relay terminal channel.
// Close detaches the renderer only — the PTY + replay buffer persist (parity).
import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View, Text, TextInput, ScrollView, Pressable, Modal, useWindowDimensions, KeyboardAvoidingView, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T } from "../theme/tokens";
import { Txt, Spinner, IconBtn } from "./primitives";
import { terminalLineText, useTerminalScreen } from "../hooks/useTerminalScreen";
import { Icon } from "./icons";
import type { RelayOutbound } from "@relay/protocol";
import type { TerminalOpenResult } from "@shared/terminal";
import type { RemoteEngineClient } from "../remote/RemoteEngineClient";

interface Props {
  open: boolean;
  onClose: () => void;
  client: RemoteEngineClient;
  cwd: string;
}

export function TerminalPanel({ open, onClose, client, cwd }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const dims = useWindowDimensions();
  const { screen, write } = useTerminalScreen();
  const [id, setId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [exited, setExited] = useState<number | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const cols = Math.max(16, Math.floor((dims.width - T.sBase * 2) / 7));
  const rows = Math.max(4, Math.floor((dims.height * 0.5) / 18));
  const s = makeStyles(colors);

  useEffect(() => {
    if (!open) return;
    setError(null); setExited(null);
    const off = client.onRelay((frame: RelayOutbound) => {
      if (frame.relay === "term-opened") {
        const result = frame.result as TerminalOpenResult;
        if (result.ok) { setId(result.id); if (result.replay) write(result.replay); }
        else setError(result.error);
      } else if (frame.relay === "term-event") {
        const ev = frame.event;
        if (ev.type === "data") write(ev.data);
        else if (ev.type === "exit") setExited(ev.exitCode);
      } else if (frame.relay === "term-command") {
        if (!frame.result.ok) setError(frame.result.error);
      }
    });
    client.termOpen(cwd, cols, rows);
    return () => {
      off();
      if (id) client.termClose(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, client, cwd]);

  useEffect(() => {
    if (id) client.termResize(id, cols, rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, cols, rows]);

  useEffect(() => {
    const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 30);
    return () => clearTimeout(t);
  }, [screen]);

  if (!open) return null;

  function send() {
    if (!id || !input) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    client.termInput(id, input + "\n");
    setInput("");
  }

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={[s.shell, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={{ height: insets.top + 44, position: "absolute", top: 0, left: 0, right: 0, zIndex: 10, backgroundColor: colors.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft }}>
          <View style={[s.head, { paddingTop: insets.top }]}>
            <Icon name="SquareTerminal" size={16} color={colors.tool} />
            <Txt variant="caption" color={colors.textSecondary} style={{ flex: 1 }} numberOfLines={1}>{cwd}</Txt>
            {exited != null ? <Txt variant="caption" color={colors.textSubtle}>exit {exited}</Txt> : <Spinner size="small" />}
            <IconBtn name="X" onPress={onClose} label="Close terminal" size={18} />
          </View>
        </View>
        {error ? <Txt variant="caption" color={colors.del} style={s.err}>{error}</Txt> : null}
        <ScrollView ref={scrollRef} style={{ flex: 1, paddingTop: insets.top + 52 }} contentContainerStyle={{ paddingHorizontal: T.sBase, paddingVertical: T.sXs, paddingBottom: 96 }}>
          {screen.lines.map((line, r) => (
            <View key={r} style={s.line} accessible accessibilityLabel={terminalLineText(line)}>
              {line.length === 0 ? <Text accessible={false} style={s.blank}> </Text> :
                line.map((cell, c) => <Text accessible={false} key={c} style={[s.ch, cell.color ? { color: cell.color } : undefined]}>{cell.ch}</Text>)}
            </View>
          ))}
        </ScrollView>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={[s.inputRow, { paddingBottom: insets.bottom + T.sXs }]}>
            <TextInput
              style={s.input} value={input} onChangeText={setInput}
              placeholder="Type a command…" placeholderTextColor={colors.textSubtle}
              autoCapitalize="none" autoCorrect={false} editable={exited == null}
              accessibilityLabel="Terminal command"
              onSubmitEditing={send}
            />
            <Pressable accessibilityRole="button" accessibilityLabel="Run terminal command" onPress={send} disabled={!input || exited != null} style={({ pressed }) => [s.send, { backgroundColor: colors.accent }, pressed && { opacity: 0.7 }, (!input || exited != null) && { opacity: 0.3 }]}>
              <Icon name="ArrowUp" size={18} color={colors.bg} />
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    shell: { flex: 1, backgroundColor: colors.bg },
    head: { flexDirection: "row", alignItems: "center", gap: T.sXs, paddingHorizontal: T.sBase, paddingVertical: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    err: { paddingHorizontal: T.sBase, paddingVertical: T.s2xs },
    line: { flexDirection: "row", minHeight: 18 },
    blank: { color: colors.assistant, fontFamily: "SF Mono", fontSize: T.textCode, lineHeight: 18 },
    ch: { color: colors.assistant, fontFamily: "SF Mono", fontSize: T.textCode, lineHeight: 18 },
    inputRow: { flexDirection: "row", alignItems: "center", gap: T.sXs, paddingHorizontal: T.sBase, paddingTop: T.sXs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSoft },
    input: { flex: 1, color: colors.assistant, fontFamily: "SF Mono", fontSize: T.textCode, backgroundColor: colors.elevated, borderRadius: T.radiusSm, paddingHorizontal: T.sSm, paddingVertical: T.sXs, borderWidth: 1, borderColor: colors.borderSoft, minHeight: 44 },
    send: { height: 44, width: 44, borderRadius: T.radius, alignItems: "center", justifyContent: "center" },
    sendText: { fontSize: T.textUi, fontWeight: "600" },
  });
}
