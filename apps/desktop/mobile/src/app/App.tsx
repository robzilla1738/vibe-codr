import { useEffect, useMemo, useState } from "react";
import { Linking, View } from "react-native";
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

function parseDeepLink(url: string | null): ConnectionConfig | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "vibecodr:" || u.hostname !== "connect") return null;
    const urlParam = u.searchParams.get("url");
    const token = u.searchParams.get("token");
    const cwd = u.searchParams.get("cwd");
    const sessionId = u.searchParams.get("session");
    if (!urlParam || !token || !cwd) return null;
    return { url: urlParam, accessToken: token, cwd, ...(sessionId ? { sessionId } : {}) };
  } catch { return null; }
  }

function Root() {
  const { colors } = useTheme();
  const [connection, setConnection] = useState<ConnectionConfig | null>(null);
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
    const active = { ...cfg, parked: false };
    setParked(false);
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
        setConnection(cfg);
        setParked(cfg.parked === true);
      }
    }).finally(() => setHydrated(true));
  }, []);

  useEffect(() => () => { void client?.shutdown().catch(() => undefined); }, [client]);

  // Pairing deep link: scanning the relay QR opens vibecodr://connect?… and
  // auto-fills + connects. Replaces any manual entry on the Connect screen.
  useEffect(() => {
    const apply = (url: string | null) => {
      const cfg = parseDeepLink(url);
      if (cfg) {
        const active = { ...cfg, parked: false };
        setParked(false);
        setConnection(active);
        void saveConnection(active).catch(() => undefined);
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
        : <ConnectScreen onConnect={connect} initial={connection ?? undefined} />}
    </>
  );
}
