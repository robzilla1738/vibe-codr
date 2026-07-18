import * as SecureStore from "expo-secure-store";

export interface ConnectionConfig {
  url: string;        // ws(s)://host:port
  accessToken: string;
  cwd: string;
  /** Last engine session controlled from this device. */
  sessionId?: string;
  /** True after the phone explicitly returns ownership to the desktop. */
  parked?: boolean;
}

const KEY = "vibe.connection.v1";

export async function loadConnection(): Promise<ConnectionConfig | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ConnectionConfig;
    if (typeof parsed.url !== "string" || typeof parsed.accessToken !== "string" || typeof parsed.cwd !== "string") return null;
    if (parsed.sessionId !== undefined && typeof parsed.sessionId !== "string") return null;
    if (parsed.parked !== undefined && typeof parsed.parked !== "boolean") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveConnection(cfg: ConnectionConfig): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(cfg));
}

export async function clearConnection(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
