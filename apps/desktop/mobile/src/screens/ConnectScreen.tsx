import { useState } from "react";
import { StyleSheet, View, TextInput, KeyboardAvoidingView, Platform, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme/ThemeProvider";
import { Txt, Button, Card, T } from "../components/primitives";
import { Icon } from "../components/icons";
import { AmbientBackground } from "../components/AmbientBackground";
import { BrandWordmark } from "../components/BrandWordmark";
import type { ConnectionConfig } from "../app/connection";

export function ConnectScreen({ onConnect, initial }: { onConnect: (cfg: ConnectionConfig) => void | Promise<void>; initial?: ConnectionConfig }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [url, setUrl] = useState(initial?.url ?? "");
  const [token, setToken] = useState(initial?.accessToken ?? "");
  const [cwd, setCwd] = useState(initial?.cwd ?? "");
  const [busy, setBusy] = useState(false);

  const s = makeStyles(colors);

  async function submit() {
    if (!url.trim() || !token.trim() || !cwd.trim()) return;
    setBusy(true);
    try { await onConnect({ url: url.trim(), accessToken: token.trim(), cwd: cwd.trim() }); }
    finally { setBusy(false); }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: "transparent" }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <AmbientBackground />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={[s.scroll, { paddingTop: insets.top + T.s2xl, paddingBottom: insets.bottom + T.s2xl }]} keyboardShouldPersistTaps="handled">
        <View style={s.content}>
        <View style={s.brand}>
          <BrandWordmark variant="splash" />
        </View>
        <Txt variant="display" style={s.title}>{initial?.parked ? "Ready when you are." : "Your desktop session, in hand."}</Txt>
        <Txt variant="prose" color={colors.textSecondary} style={s.subtitle}>
          {initial?.parked
            ? "Control is back on your Mac. Choose Tools → Continue on Phone on the Mac, then take control here with the same secure pairing."
            : "Continue the same project and conversation from your phone. Vibe keeps the engine on your Mac and this app becomes its remote workspace."}
        </Txt>

        <Card inset={T.sBase} radius={T.radiusXl} surface="surfaceSubtle" style={s.form}>
          <View style={s.formHead}>
            <View style={s.liveDot} />
            <View style={{ flex: 1 }}>
              <Txt variant="title">Desktop link</Txt>
              <Txt variant="caption" color={colors.textSubtle}>Use the details shown by the relay on your Mac</Txt>
            </View>
          </View>
          <Txt variant="label" color={colors.textSecondary} style={s.fieldLabel}>Relay URL</Txt>
          <TextInput
            style={s.input} placeholder="ws://192.168.1.5:7788" placeholderTextColor={colors.textSubtle}
            value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" textContentType="URL"
          />
          <Txt variant="label" color={colors.textSecondary} style={[s.fieldLabel, { marginTop: T.sSm }]}>Pairing token</Txt>
          <TextInput
            style={s.input} placeholder="pairing token" placeholderTextColor={colors.textSubtle}
            value={token} onChangeText={setToken} autoCapitalize="none" autoCorrect={false} secureTextEntry
          />
          <Txt variant="label" color={colors.textSecondary} style={[s.fieldLabel, { marginTop: T.sSm }]}>Project path</Txt>
          <TextInput
            style={s.input} placeholder="/Users/you/Code/project" placeholderTextColor={colors.textSubtle}
            value={cwd} onChangeText={setCwd} autoCapitalize="none" autoCorrect={false}
          />
        </Card>

        <Button label={busy ? "Connecting to desktop…" : initial?.parked ? "Take control after Mac is ready" : "Connect to desktop"} onPress={submit} disabled={busy || !url.trim() || !token.trim() || !cwd.trim()} style={{ marginBottom: T.sBase }} />

        <View style={s.tip}>
          <Icon name="QrCode" size={16} color={colors.textSecondary} />
          <Txt variant="caption" color={colors.textSecondary} style={{ flex: 1 }}>
            Fastest setup: run `npm run relay` in the desktop app folder, then scan the QR code with your phone camera.
          </Txt>
        </View>
        <Txt variant="caption" color={colors.textSubtle} style={s.security}>The pairing token stays in secure device storage. Use WSS when connecting outside your trusted local network.</Txt>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    scroll: { flexGrow: 1, paddingHorizontal: T.sLg, backgroundColor: colors.bg, justifyContent: "center" },
    content: { width: "100%", maxWidth: 520, alignSelf: "center" },
    brand: { alignItems: "center", marginBottom: T.sLg },
    title: { textAlign: "center", fontSize: 30, lineHeight: 35, marginBottom: T.sSm, letterSpacing: -0.7 },
    subtitle: { textAlign: "center", marginBottom: T.sLg, paddingHorizontal: T.sSm },
    form: { marginBottom: T.sBase },
    formHead: { flexDirection: "row", alignItems: "center", gap: T.sXs, paddingBottom: T.sSm, marginBottom: T.sSm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.add },
    fieldLabel: { marginBottom: T.s2xs },
    input: {
      color: colors.assistant, fontSize: T.textProse, paddingVertical: T.sXs,
      backgroundColor: colors.elevated, borderRadius: T.radiusMd, paddingHorizontal: T.sSm,
      borderWidth: 1, borderColor: colors.borderSoft, minHeight: 44,
    },
    tip: { flexDirection: "row", alignItems: "flex-start", gap: T.sXs, backgroundColor: colors.surfaceSubtle, borderRadius: T.radiusMd, padding: T.sSm, marginBottom: T.sSm },
    security: { textAlign: "center", paddingHorizontal: T.sBase },
  });
}
