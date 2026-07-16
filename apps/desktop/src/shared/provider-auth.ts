export type SubscriptionProviderId = "openai-codex" | "xai-oauth";
export type SubscriptionAuthMethod = "browser" | "device";

export interface SubscriptionAuthStatus {
  sessionId?: string;
  providerId: SubscriptionProviderId;
  state: "disconnected" | "pending" | "connected" | "error" | "cancelled";
  method?: SubscriptionAuthMethod;
  url?: string;
  userCode?: string;
  expiresAt?: number;
  accountLabel?: string;
  error?: string;
}

export function isSubscriptionAuthStatus(value: unknown): value is SubscriptionAuthStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Record<string, unknown>;
  return (status.providerId === "openai-codex" || status.providerId === "xai-oauth")
    && ["disconnected", "pending", "connected", "error", "cancelled"].includes(String(status.state))
    && (status.sessionId === undefined || typeof status.sessionId === "string")
    && (status.url === undefined || typeof status.url === "string")
    && (status.userCode === undefined || typeof status.userCode === "string")
    && (status.error === undefined || typeof status.error === "string");
}

export function isSubscriptionAuthStart(value: unknown): value is Omit<SubscriptionAuthStatus, "state"> & { sessionId: string; method: SubscriptionAuthMethod; url: string; expiresAt: number } {
  if (!value || typeof value !== "object") return false;
  const start = value as Record<string, unknown>;
  return (start.providerId === "openai-codex" || start.providerId === "xai-oauth")
    && (start.method === "browser" || start.method === "device")
    && typeof start.sessionId === "string" && start.sessionId.length > 0
    && typeof start.url === "string" && start.url.length > 0
    && typeof start.expiresAt === "number" && Number.isFinite(start.expiresAt)
    && (start.userCode === undefined || typeof start.userCode === "string");
}
