const DEFAULT_WINDOW_MS = 12;
const DEFAULT_MAX_BYTES = 64 * 1024;
type StreamEvent = { type: "assistant-text-delta" | "reasoning-delta" | "tool-call-progress"; sessionId: string; subagentId?: string; toolCallId?: string; delta?: string; chunk?: string };
function streamEvent(value: unknown): StreamEvent | null { if (!value || typeof value !== "object") return null; const event = value as Partial<StreamEvent>; if (event.type !== "assistant-text-delta" && event.type !== "reasoning-delta" && event.type !== "tool-call-progress") return null; if (typeof event.sessionId !== "string") return null; if (event.type === "tool-call-progress") return typeof event.toolCallId === "string" && typeof event.chunk === "string" ? event as StreamEvent : null; return typeof event.delta === "string" ? event as StreamEvent : null; }
function key(event: StreamEvent): string { return `${event.type}\0${event.sessionId}\0${event.subagentId ?? ""}\0${event.toolCallId ?? ""}`; }
function text(event: StreamEvent): string { return event.type === "tool-call-progress" ? event.chunk ?? "" : event.delta ?? ""; }
export class EngineEventCoalescer {
  readonly #emit: (event: unknown) => void; readonly #windowMs: number; readonly #maxBytes: number; #burstKey = ""; #pending: StreamEvent | null = null; #pendingBytes = 0; #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(emit: (event: unknown) => void, opts: { windowMs?: number; maxBytes?: number } = {}) { this.#emit = emit; this.#windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS; this.#maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES; }
  push(value: unknown): void { const event = streamEvent(value); if (!event) { this.flush(); this.#emit(value); return; } const eventKey = key(event); if (this.#burstKey !== eventKey) { this.flush(); this.#burstKey = eventKey; this.#emit(value); this.#arm(); return; } const addition = text(event); const bytes = Buffer.byteLength(addition); if (this.#pending && this.#pendingBytes + bytes > this.#maxBytes) this.#flushPending(); if (!this.#pending) this.#pending = { ...event }; else if (event.type === "tool-call-progress") this.#pending.chunk = `${this.#pending.chunk ?? ""}${addition}`; else this.#pending.delta = `${this.#pending.delta ?? ""}${addition}`; this.#pendingBytes += bytes; if (this.#pendingBytes >= this.#maxBytes) this.#flushPending(); this.#arm(); }
  flush(): void { if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined; this.#flushPending(); this.#burstKey = ""; }
  #flushPending(): void { if (this.#pending) this.#emit(this.#pending); this.#pending = null; this.#pendingBytes = 0; }
  #arm(): void { if (this.#timer) return; this.#timer = setTimeout(() => this.flush(), this.#windowMs); }
}
