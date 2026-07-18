import { useEffect, useMemo, useState } from "react";
import { AppState, Linking, View, type AppStateStatus } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { ThemeProvider, useTheme } from "../theme/ThemeProvider";
import { loadConnection, saveConnection, type ConnectionConfig } from "./connection";
import { RemoteEngineClient } from "../remote/RemoteEngineClient";
import { ConnectScreen } from "../screens/ConnectScreen";
import { ChatScreen } from "../screens/ChatScreen";
import { MockRemoteClient } from "../preview/MockRemoteClient";
import { BrandIcon, BrandWordmark } from "../components/BrandWordmark";
import { shouldRefreshAfterForeground } from "./foreground-reconnect";
import { parsePairingDeepLink, validateConnectionConfig } from "./connection-validation";

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <Root />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function Root() {
  const { colors } = useTheme();
  const [connection, setConnection] = useState<ConnectionConfig | null>(null);
  const [draftConnection, setDraftConnection] = useState<ConnectionConfig | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [parked, setParked] = useState(false);

  const client = useMemo(() => {
    if (!connection) return null;
    return new RemoteEngineClient({
      url: connection.url,
      accessToken: connection.accessToken,
      cwd: connection.cwd,
      ...(connection.sessionId ? { resume: connection.sessionId } : { continueLatest: true }),
      readyTimeoutMs: 45_000,
      rpcTimeoutMs: 30_000,
    });
  }, [connection]);

  async function connect(cfg: ConnectionConfig) {
    const validated = validateConnectionConfig(cfg);
    if (!validated.ok) {
      setDraftConnection(cfg);
      setConnectionError(validated.error);
      return;
    }
    const active = { ...validated.value, parked: false };
    setParked(false);
    setDraftConnection(null);
    setConnectionError(null);
    setConnection(active);
    try { await saveConnection(active); } catch { /* optional */ }
  }

  async function returnToDesktop() {
    if (client) await client.shutdown().catch(() => undefined);
    if (connection) await saveConnection({ ...connection, parked: true }).catch(() => undefined);
    setParked(true);
  }

  async function rememberSession(cwd: string, sessionId: string) {
    if (!connection || !cwd || !sessionId) return;
    await saveConnection({ ...connection, cwd, sessionId, parked: false }).catch(() => undefined);
  }

  useEffect(() => {
    loadConnection().then((cfg) => {
      if (cfg) {
        const validated = validateConnectionConfig(cfg);
        if (validated.ok) {
          setConnection(validated.value);
          setParked(validated.value.parked === true);
        } else {
          setDraftConnection(cfg);
          setConnectionError(validated.error);
        }
      }
    }).finally(() => setHydrated(true));
  }, []);

  useEffect(() => () => { void client?.shutdown().catch(() => undefined); }, [client]);

  useEffect(() => {
    if (!client || parked) return;
    let previous: AppStateStatus = AppState.currentState;
    let suspendedAt: number | null = previous === "active" ? null : Date.now();
    const subscription = AppState.addEventListener("change", (next) => {
      const now = Date.now();
      if (shouldRefreshAfterForeground(previous, next, suspendedAt, now)) {
        void client.refreshAfterForeground().catch(() => undefined);
      }
      if (previous === "active" && next !== "active") suspendedAt = now;
      else if (next === "active") suspendedAt = null;
      previous = next;
    });
    return () => subscription.remove();
  }, [client, parked]);

  // Pairing deep link: scanning the relay QR opens vibecodr://connect?… and
  // auto-fills + connects. Replaces any manual entry on the Connect screen.
  useEffect(() => {
    const apply = (url: string | null) => {
      const parsed = parsePairingDeepLink(url);
      if (parsed?.ok) {
        const active = { ...parsed.value, parked: false };
        setParked(false);
        setDraftConnection(null);
        setConnectionError(null);
        setConnection(active);
        void saveConnection(active).catch(() => undefined);
      } else if (parsed) {
        setConnectionError(parsed.error);
      }
    };
    Linking.getInitialURL().then(apply).catch(() => undefined);
    const sub = Linking.addEventListener("url", ({ url }) => apply(url));
    return () => sub.remove();
  }, []);

  if (process.env.EXPO_PUBLIC_VIBE_PREVIEW) {
    const mock = new MockRemoteClient() as unknown as RemoteEngineClient;
    return (
      <>
        <StatusBar style={colors.scheme === "light" ? "dark" : "light"} />
        <ChatScreen client={mock} connection={{ url: "preview://mock", accessToken: "preview", cwd: "/Users/you/Code/vibe-codr/electron" }} onDisconnect={() => undefined} />
      </>
    );
  }
  if (!hydrated) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 14, backgroundColor: colors.bg }}>
        <StatusBar style={colors.scheme === "light" ? "dark" : "light"} />
        <BrandIcon size={74} />
        <BrandWordmark variant="splash" />
      </View>
    );
  }
  return (
    <>
      <StatusBar style={colors.scheme === "light" ? "dark" : "light"} />
      {connection && client && !parked
        ? <ChatScreen client={client} connection={connection} onDisconnect={returnToDesktop} onSessionChange={rememberSession} />
        : <ConnectScreen onConnect={connect} initial={connection ?? draftConnection ?? undefined} errorMessage={connectionError ?? undefined} />}
    </>
  );
}
