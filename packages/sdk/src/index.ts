import {
  ApiV1AcceptedResponseSchema,
  type ApiV1CapabilitiesResponse,
  ApiV1CapabilitiesResponseSchema,
  type ApiV1CommandRequest,
  type ApiV1CreateSessionRequest,
  type ApiV1Cursor,
  type ApiV1DecisionReceipt,
  ApiV1DecisionReceiptSchema,
  type ApiV1DecisionRequest,
  ApiV1ErrorSchema,
  type ApiV1ForkResponse,
  ApiV1ForkResponseSchema,
  type ApiV1GetSessionResponse,
  ApiV1GetSessionResponseSchema,
  type ApiV1ListSessionsResponse,
  ApiV1ListSessionsResponseSchema,
  type ApiV1MutationResponse,
  ApiV1MutationResponseSchema,
  type ApiV1SessionResponse,
  ApiV1SessionResponseSchema,
  type ApiV1SseFrame,
  ApiV1SseFrameSchema,
  encodeApiV1Cursor,
} from "@vibe/protocol";

export type {
  ApiV1CapabilitiesResponse,
  ApiV1Command,
  ApiV1CommandRequest,
  ApiV1CreateSessionRequest,
  ApiV1Cursor,
  ApiV1Decision,
  ApiV1DecisionReceipt,
  ApiV1DecisionRequest,
  ApiV1ForkResponse,
  ApiV1GetSessionResponse,
  ApiV1ListSessionsResponse,
  ApiV1MutationResponse,
  ApiV1Session,
  ApiV1SessionResponse,
  ApiV1SseFrame,
} from "@vibe/protocol";

export interface VibeClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}

export interface VibeEventOptions {
  cursor?: ApiV1Cursor;
  signal?: AbortSignal;
}

export class VibeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "VibeApiError";
  }
}

type Schema<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };

/** Typed fetch-only client. SSE is parsed from fetch so Authorization is sent. */
export class VibeClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: VibeClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
      throw new Error("@vibe/sdk only connects to http://127.0.0.1 loopback servers");
    }
    if (!options.token) throw new Error("a bearer token is required");
    this.#baseUrl = url.origin;
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  capabilities(): Promise<ApiV1CapabilitiesResponse> {
    return this.#request("GET", "/v1/capabilities", ApiV1CapabilitiesResponseSchema);
  }

  listSessions(): Promise<ApiV1ListSessionsResponse> {
    return this.#request("GET", "/v1/sessions", ApiV1ListSessionsResponseSchema);
  }

  createSession(input: ApiV1CreateSessionRequest = {}): Promise<ApiV1SessionResponse> {
    return this.#request("POST", "/v1/sessions", ApiV1SessionResponseSchema, input);
  }

  getSession(sessionId: string): Promise<ApiV1GetSessionResponse> {
    return this.#request("GET", this.#sessionPath(sessionId), ApiV1GetSessionResponseSchema);
  }

  prompt(sessionId: string, text: string): Promise<{ accepted: true }> {
    return this.#request(
      "POST",
      `${this.#sessionPath(sessionId)}/prompt`,
      ApiV1AcceptedResponseSchema,
      { text },
    );
  }

  command(sessionId: string, input: ApiV1CommandRequest): Promise<{ accepted: true }> {
    return this.#request(
      "POST",
      `${this.#sessionPath(sessionId)}/command`,
      ApiV1AcceptedResponseSchema,
      input,
    );
  }

  fork(sessionId: string, atTurnId: string): Promise<ApiV1ForkResponse> {
    return this.#request("POST", `${this.#sessionPath(sessionId)}/fork`, ApiV1ForkResponseSchema, {
      atTurnId,
    });
  }

  decide(sessionId: string, input: ApiV1DecisionRequest): Promise<ApiV1DecisionReceipt> {
    return this.#request(
      "POST",
      `${this.#sessionPath(sessionId)}/decision`,
      ApiV1DecisionReceiptSchema,
      input,
    );
  }

  archive(sessionId: string): Promise<ApiV1MutationResponse> {
    return this.#request(
      "POST",
      `${this.#sessionPath(sessionId)}/archive`,
      ApiV1MutationResponseSchema,
      {},
    );
  }

  delete(sessionId: string): Promise<ApiV1MutationResponse> {
    return this.#request("DELETE", this.#sessionPath(sessionId), ApiV1MutationResponseSchema);
  }

  async *events(sessionId: string, options: VibeEventOptions = {}): AsyncGenerator<ApiV1SseFrame> {
    const url = new URL(`${this.#baseUrl}${this.#sessionPath(sessionId)}/events`);
    if (options.cursor) url.searchParams.set("cursor", encodeApiV1Cursor(options.cursor));
    const response = await this.#fetch(url, {
      headers: { authorization: `Bearer ${this.#token}`, accept: "text/event-stream" },
      signal: options.signal,
    });
    if (!response.ok) throw await this.#apiError(response);
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
      throw new VibeApiError(
        response.status,
        "invalid-response",
        "server did not return an event stream",
        false,
      );
    }
    if (!response.body)
      throw new VibeApiError(
        response.status,
        "invalid-response",
        "event stream has no body",
        false,
      );
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const result = await reader.read();
        buffer += decoder.decode(result.value, { stream: !result.done });
        const parsed = drainSseFrames(buffer);
        buffer = parsed.remainder;
        for (const value of parsed.values) {
          const frame = ApiV1SseFrameSchema.safeParse(value);
          if (!frame.success)
            throw new VibeApiError(
              200,
              "invalid-response",
              "event frame failed API v1 validation",
              false,
            );
          yield frame.data;
        }
        if (result.done) break;
      }
      if (buffer.trim())
        throw new VibeApiError(
          200,
          "invalid-response",
          "event stream ended with a partial frame",
          false,
        );
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  #sessionPath(sessionId: string): string {
    if (!sessionId || sessionId.includes("/")) throw new Error("invalid session id");
    return `/v1/sessions/${encodeURIComponent(sessionId)}`;
  }

  async #request<T>(method: string, path: string, schema: Schema<T>, body?: unknown): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw await this.#apiError(response);
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new VibeApiError(
        response.status,
        "invalid-response",
        "response is not valid JSON",
        false,
      );
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new VibeApiError(
        response.status,
        "invalid-response",
        "response failed API v1 validation",
        false,
      );
    return parsed.data;
  }

  async #apiError(response: Response): Promise<VibeApiError> {
    const value = await response.json().catch(() => undefined);
    const parsed = ApiV1ErrorSchema.safeParse(value);
    if (!parsed.success)
      return new VibeApiError(
        response.status,
        "invalid-response",
        `HTTP ${response.status}`,
        response.status >= 500,
      );
    return new VibeApiError(
      response.status,
      parsed.data.error.code,
      parsed.data.error.message,
      parsed.data.error.retryable,
      parsed.data.error.details,
    );
  }
}

export function drainSseFrames(buffer: string): { values: unknown[]; remainder: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const remainder = blocks.pop() ?? "";
  const values: unknown[] = [];
  for (const block of blocks) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      values.push(JSON.parse(data));
    } catch {
      throw new VibeApiError(200, "invalid-response", "event data is not valid JSON", false);
    }
  }
  return { values, remainder };
}
