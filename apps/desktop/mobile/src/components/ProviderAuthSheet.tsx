// Provider auth — the native analog of the desktop SubscriptionAuthCard /
// Onboarding provider setup. Manages the subscription providers (openai-codex,
// xai-oauth) over the same RPCs the desktop uses (beginProviderAuth /
// providerAuthStatus / cancelProviderAuth / logoutProviderAuth), polls pending
// sign-in, opens the auth URL in the device browser, and selects the model.
import { useEffect, useState } from "react";
import { StyleSheet, View, Text, ScrollView, Pressable, Linking } from "react-native";
import { Sheet } from "./Sheet";
import * as Haptics from "expo-haptics";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T } from "../theme/tokens";
import { Txt, Card, Button, Spinner } from "./primitives";
import { isSubscriptionAuthStart, isSubscriptionAuthStatus, type SubscriptionAuthStatus } from "@shared/provider-auth";
import { SUBSCRIPTION_PROVIDERS, type SubscriptionProviderSetup } from "@shared/subscription-providers";
import type { RemoteEngineClient } from "../remote/RemoteEngineClient";

interface Props {
  open: boolean;
  onClose: () => void;
  client: RemoteEngineClient;
  currentModel: string;
  onSelectModel: (model: string) => void;
}

function statusLabel(s: SubscriptionAuthStatus): string {
  switch (s.state) {
    case "connected": return "Connected";
    case "pending": return "Waiting for sign-in";
    case "error": return "Needs attention";
    case "cancelled": return "Cancelled";
    default: return "Not connected";
  }
}

export function ProviderAuthSheet({ open, onClose, client, currentModel, onSelectModel }: Props) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  return (
    <Sheet open={open} onClose={onClose} title="Providers" icon="Cloud" heightRatio={0.85}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: T.sBase, gap: T.sMd, paddingBottom: T.s2xl }}>
        {SUBSCRIPTION_PROVIDERS.map((p) => (
          <ProviderCard key={p.id} provider={p} client={client} currentModel={currentModel} onSelectModel={onSelectModel} />
        ))}
        <Txt variant="caption" color={colors.textSubtle} style={{ marginTop: T.sXs }}>
          API-key providers are configured on the desktop engine (env vars / config). Subscription sign-in here opens in your browser.
        </Txt>
      </ScrollView>
    </Sheet>
  );
}

function ProviderCard({ provider, client, currentModel, onSelectModel }: {
  provider: SubscriptionProviderSetup; client: RemoteEngineClient; currentModel: string; onSelectModel: (m: string) => void;
}) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  const [status, setStatus] = useState<SubscriptionAuthStatus>({ providerId: provider.id, state: "disconnected" });
  const [busy, setBusy] = useState(false);

  const readStatus = async (sessionId?: string) => {
    const value = await client.rpc("providerAuthStatus", { providerId: provider.id, ...(sessionId ? { authSessionId: sessionId } : {}) });
    if (!isSubscriptionAuthStatus(value)) throw new Error("Invalid auth status");
    setStatus(value);
    return value as SubscriptionAuthStatus;
  };

  useEffect(() => {
    let active = true;
    void readStatus().catch((e) => { if (active) setStatus({ providerId: provider.id, state: "error", error: e instanceof Error ? e.message : String(e) }); });
    return () => { active = false; };
  }, [provider.id]);

  useEffect(() => {
    if (status.state !== "pending" || !status.sessionId) return;
    const sessionId = status.sessionId;
    const timer = setInterval(() => {
      void readStatus(sessionId).catch((e) => setStatus({ providerId: provider.id, state: "error", error: e instanceof Error ? e.message : String(e) }));
    }, 1500);
    return () => clearInterval(timer);
  }, [provider.id, status.sessionId, status.state]);

  const connect = async () => {
    setBusy(true);
    try {
      const value = await client.rpc("beginProviderAuth", { providerId: provider.id, authMethod: provider.authMethod });
      if (!isSubscriptionAuthStart(value)) throw new Error("Invalid sign-in request");
      const next: SubscriptionAuthStatus = { ...value, state: "pending" };
      setStatus(next);
      if (next.url) await Linking.openURL(next.url).catch(() => undefined);
    } catch (e) {
      setStatus({ providerId: provider.id, state: "error", error: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!status.sessionId) return;
    await client.rpc("cancelProviderAuth", { providerId: provider.id, authSessionId: status.sessionId }).catch(() => undefined);
    setStatus({ providerId: provider.id, state: "cancelled" });
  };
  const logout = async () => {
    setBusy(true);
    try { await client.rpc("logoutProviderAuth", { providerId: provider.id }); setStatus({ providerId: provider.id, state: "disconnected" }); }
    catch (e) { setStatus({ providerId: provider.id, state: "error", error: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };

  const pick = (m: string) => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined); onSelectModel(m); };

  return (
    <Card surface="surfaceSubtle" inset={T.sSm}>
      <View style={s.cardHead}>
        <View style={{ flex: 1 }}>
          <Txt variant="ui" style={{ fontWeight: "500" }}>{provider.title}</Txt>
          <Txt variant="caption" color={colors.textSecondary}>{provider.description}</Txt>
        </View>
        <View style={[s.badge, status.state === "error" && s.badgeWarn]}>
          <Txt variant="caption" color={status.state === "connected" ? colors.add : status.state === "error" ? colors.notice : colors.textSubtle}>{statusLabel(status)}</Txt>
        </View>
      </View>
      {status.state === "error" && status.error ? <Txt variant="caption" color={colors.del} style={s.err}>{status.error}</Txt> : null}
      {status.state === "pending" && status.userCode ? (
        <View style={s.codeBox}><Txt variant="caption" color={colors.textSecondary}>Code:</Txt><Txt variant="ui" mono style={s.code}>{status.userCode}</Txt></View>
      ) : null}
      <View style={s.actions}>
        {busy ? <Spinner /> : null}
        {status.state === "connected" ? (
          <>
            <Button label="Log out" variant="ghost" onPress={logout} style={{ flex: 1 }} />
            <Button label="Use model" variant="primary" onPress={() => pick(provider.model)} style={{ flex: 1 }} />
          </>
        ) : status.state === "pending" ? (
          <Button label="Cancel sign-in" variant="danger" onPress={cancel} style={{ flex: 1 }} />
        ) : (
          <Button label="Sign in" variant="primary" onPress={connect} disabled={busy} style={{ flex: 1 }} />
        )}
      </View>
      {provider.models.length > 1 ? (
        <View style={s.models}>
          {provider.models.map((m) => (
            <Pressable key={m.id} onPress={() => pick(m.id)} style={({ pressed }) => [s.modelPill, currentModel === m.id && s.modelPillActive, pressed && { opacity: 0.7 }]}>
              <Txt variant="caption" color={currentModel === m.id ? colors.accent : colors.textSecondary}>{m.label}</Txt>
            </Pressable>
          ))}
        </View>
      ) : null}
    </Card>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    scrim: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.45)" },
    scrimHit: { flex: 1 },
    sheet: { backgroundColor: colors.bg, borderTopLeftRadius: T.radiusXl, borderTopRightRadius: T.radiusXl, borderWidth: 1, borderColor: colors.borderSoft, paddingTop: T.sXs },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong, alignSelf: "center", marginBottom: T.sXs },
    head: { paddingHorizontal: T.sBase, paddingBottom: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    cardHead: { flexDirection: "row", alignItems: "flex-start", gap: T.sSm, marginBottom: T.sXs },
    badge: { paddingHorizontal: T.sXs, paddingVertical: 2, borderRadius: T.radiusPill, backgroundColor: colors.surfaceSubtle, borderWidth: 1, borderColor: colors.borderSoft },
    badgeWarn: { borderColor: colors.notice },
    err: { marginBottom: T.sXs },
    codeBox: { flexDirection: "row", gap: T.sXs, alignItems: "center", backgroundColor: colors.panel, borderRadius: T.radiusSm, padding: T.sXs, marginBottom: T.sXs },
    code: { color: colors.assistant, letterSpacing: 2 },
    actions: { flexDirection: "row", gap: T.sXs, alignItems: "center" },
    models: { flexDirection: "row", flexWrap: "wrap", gap: T.sXs, marginTop: T.sXs },
    modelPill: { paddingHorizontal: T.sSm, paddingVertical: T.s2xs, borderRadius: T.radiusPill, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.surfaceSubtle },
    modelPillActive: { borderColor: colors.accent, backgroundColor: colors.selBg },
  });
}
