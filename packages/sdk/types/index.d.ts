export interface ApiV1Cursor { epoch: string; sequence: number }
export interface ApiV1Session {
  id: string;
  model: string;
  mode: "plan" | "execute";
  goal: string | null;
  title?: string;
  createdAt: number;
  updatedAt: number;
  active: boolean;
  forkedFrom?: { sessionId: string; turnId: string };
}
export type ApiV1EngineSnapshot = Record<string, unknown> & {
  sessionId: string;
  model: string;
  mode: "plan" | "execute";
  goal: string | null;
  busy: boolean;
};
export type ApiV1UiEvent = Record<string, unknown> & { type: string };
export type ApiV1SseFrame =
  | { type: "ready"; cursor: ApiV1Cursor; truncated: boolean; snapshot?: ApiV1EngineSnapshot }
  | { type: "event"; cursor: ApiV1Cursor; event: ApiV1UiEvent; pendingDecisionId?: string };
export interface ApiV1CapabilitiesResponse {
  apiVersion: 1;
  workspace: string;
  transport: "loopback";
  events: "authenticated-sse";
  capabilities: string[];
  commandTypes: string[];
}
export interface ApiV1ListSessionsResponse { sessions: ApiV1Session[] }
export interface ApiV1CreateSessionRequest { model?: string; mode?: "plan" | "execute" }
export interface ApiV1SessionResponse { session: ApiV1Session; snapshot: ApiV1EngineSnapshot }
export interface ApiV1GetSessionResponse { session: ApiV1Session; snapshot?: ApiV1EngineSnapshot }
export type ApiV1Command =
  | { type: "abort" }
  | { type: "compact" }
  | { type: "set-mode"; mode: "plan" | "execute"; start?: boolean }
  | { type: "set-approvals"; mode: "ask" | "auto" }
  | { type: "set-model"; model: string }
  | { type: "set-goal"; goal: string | null }
  | { type: "run-slash"; name: string; args: string };
export interface ApiV1CommandRequest { command: ApiV1Command }
export type ApiV1Decision =
  | { kind: "permission"; id: string; decision: "once" | "always" | "always-project" | "deny"; feedback?: string }
  | { kind: "plan"; id: string; decision: "accept" | "edit" | "keep-planning"; edit?: string; approvals?: "auto" }
  | { kind: "question"; id: string; answers: string[]; freeform?: string }
  | { kind: "external-capability"; id: string; decision: "approve" | "deny"; result?: unknown; error?: string };
export interface ApiV1DecisionRequest { idempotencyKey: string; decision: ApiV1Decision }
export interface ApiV1DecisionReceipt { receiptId: string; idempotencyKey: string; sessionId: string; pendingId: string; acceptedAt: number }
export interface ApiV1ForkResponse { session: ApiV1Session }
export interface ApiV1MutationResponse { id: string; ok: true }
export interface VibeClientOptions { baseUrl: string; token: string; fetch?: typeof globalThis.fetch }
export interface VibeEventOptions { cursor?: ApiV1Cursor; signal?: AbortSignal }
export declare class VibeApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}
export declare class VibeClient {
  constructor(options: VibeClientOptions);
  capabilities(): Promise<ApiV1CapabilitiesResponse>;
  listSessions(): Promise<ApiV1ListSessionsResponse>;
  createSession(input?: ApiV1CreateSessionRequest): Promise<ApiV1SessionResponse>;
  getSession(sessionId: string): Promise<ApiV1GetSessionResponse>;
  prompt(sessionId: string, text: string): Promise<{ accepted: true }>;
  command(sessionId: string, input: ApiV1CommandRequest): Promise<{ accepted: true }>;
  fork(sessionId: string, atTurnId: string): Promise<ApiV1ForkResponse>;
  decide(sessionId: string, input: ApiV1DecisionRequest): Promise<ApiV1DecisionReceipt>;
  archive(sessionId: string): Promise<ApiV1MutationResponse>;
  delete(sessionId: string): Promise<ApiV1MutationResponse>;
  events(sessionId: string, options?: VibeEventOptions): AsyncGenerator<ApiV1SseFrame>;
}
export declare function drainSseFrames(buffer: string): { values: unknown[]; remainder: string };
