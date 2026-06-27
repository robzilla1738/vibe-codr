import { streamText, stepCountIs, type ModelMessage } from "ai";
import {
  createId,
  type EngineSnapshot,
  type Message,
  type Mode,
  type Part,
  type UIEvent,
  type Usage,
} from "@vibe/shared";
import type { Config } from "@vibe/config";
import type { ProviderRegistry } from "@vibe/providers";
import type { Toolset } from "@vibe/tools";
import type { EventBus } from "./event-bus.ts";
import { composeSystemPrompt } from "./system-prompt.ts";

export interface SessionDeps {
  config: Config;
  registry: ProviderRegistry;
  toolset: Toolset;
  bus: EventBus;
  cwd: string;
  model: string;
  mode: Mode;
  goal?: string | null;
  projectMemory?: string;
  id?: string;
}

/**
 * One stateful agent conversation. `run()` executes a full multi-step agentic
 * turn via the AI SDK and emits `UIEvent`s. Subagents are forks of a Session.
 */
export class Session {
  readonly id: string;
  model: string;
  mode: Mode;
  goal: string | null;
  busy = false;

  #deps: SessionDeps;
  #modelMessages: ModelMessage[] = [];
  #history: Message[] = [];
  #abort = new AbortController();

  constructor(deps: SessionDeps) {
    this.#deps = deps;
    this.id = deps.id ?? createId("ses");
    this.model = deps.model;
    this.mode = deps.mode;
    this.goal = deps.goal ?? null;
  }

  snapshot(): EngineSnapshot {
    return {
      sessionId: this.id,
      model: this.model,
      mode: this.mode,
      goal: this.goal,
      history: this.#history,
      busy: this.busy,
    };
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.#deps.bus.emit({ type: "mode-changed", sessionId: this.id, mode });
  }

  setModel(model: string): void {
    this.model = model;
    this.#deps.bus.emit({ type: "model-changed", sessionId: this.id, model });
  }

  setGoal(goal: string | null): void {
    this.goal = goal;
    this.#deps.bus.emit({ type: "goal-changed", sessionId: this.id, goal });
  }

  abort(): void {
    this.#abort.abort();
    this.#abort = new AbortController();
  }

  /** Execute one agentic turn for `input`. Resolves when the turn ends. */
  async run(input: string): Promise<void> {
    const { bus, registry, toolset, config } = this.#deps;
    this.busy = true;
    this.#pushUser(input);

    try {
      const model = await registry.resolveModel(this.model, config);
      const system = composeSystemPrompt({
        mode: this.mode,
        goal: this.goal,
        projectMemory: this.#deps.projectMemory,
      });
      const base = {
        cwd: this.#deps.cwd,
        sessionId: this.id,
        emit: (e: UIEvent) => bus.emit(e),
      };

      const result = streamText({
        model,
        system,
        messages: this.#modelMessages,
        tools: toolset.aiTools(this.mode, base),
        toolChoice: "auto",
        stopWhen: stepCountIs(config.maxSteps),
        abortSignal: this.#abort.signal,
        onStepFinish: ({ usage }) => {
          bus.emit({
            type: "step-finished",
            sessionId: this.id,
            usage: normalizeUsage(usage),
          });
        },
      });

      await this.#consume(result);
      const response = await result.response;
      this.#modelMessages.push(...response.messages);
    } catch (err) {
      bus.emit({
        type: "engine-error",
        sessionId: this.id,
        message: (err as Error).message,
      });
    } finally {
      this.busy = false;
      bus.emit({ type: "turn-finished", sessionId: this.id });
      bus.emit({ type: "session-idle", sessionId: this.id });
    }
  }

  /** Fork a child session for a subagent (own context, shared infra). */
  fork(overrides: Partial<SessionDeps> & { model?: string }): Session {
    return new Session({
      ...this.#deps,
      id: createId("sub"),
      model: overrides.model ?? this.model,
      mode: overrides.mode ?? this.mode,
      goal: overrides.goal ?? null,
      ...overrides,
    });
  }

  #pushUser(input: string): void {
    this.#modelMessages.push({ role: "user", content: input });
    this.#history.push({
      id: createId("msg"),
      role: "user",
      parts: [{ type: "text", text: input }],
      createdAt: Date.now(),
    });
    this.#deps.bus.emit({ type: "user-message", sessionId: this.id, text: input });
  }

  /** Translate AI-SDK stream parts into UIEvents and accumulate the message. */
  async #consume(result: { fullStream: AsyncIterable<unknown> }): Promise<void> {
    const bus = this.#deps.bus;
    let assistant: Message | null = null;
    const ensure = (): Message => {
      if (!assistant) {
        assistant = {
          id: createId("msg"),
          role: "assistant",
          parts: [],
          createdAt: Date.now(),
        };
      }
      return assistant;
    };

    for await (const raw of result.fullStream) {
      const part = raw as Record<string, any>;
      switch (part.type) {
        case "text-delta": {
          const delta: string = part.text ?? part.textDelta ?? "";
          appendText(ensure(), delta);
          bus.emit({ type: "assistant-text-delta", sessionId: this.id, delta });
          break;
        }
        case "reasoning-delta": {
          const delta: string = part.text ?? part.textDelta ?? "";
          bus.emit({ type: "reasoning-delta", sessionId: this.id, delta });
          break;
        }
        case "tool-call": {
          bus.emit({
            type: "tool-call-started",
            sessionId: this.id,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input ?? part.args,
          });
          break;
        }
        case "tool-result": {
          bus.emit({
            type: "tool-call-finished",
            sessionId: this.id,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: part.output,
            isError: false,
          });
          break;
        }
        case "tool-error": {
          bus.emit({
            type: "tool-call-finished",
            sessionId: this.id,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: String((part.error as Error)?.message ?? part.error),
            isError: true,
          });
          break;
        }
        case "abort": {
          bus.emit({
            type: "notice",
            level: "warn",
            message: "Turn aborted.",
          });
          break;
        }
        case "error": {
          bus.emit({
            type: "engine-error",
            sessionId: this.id,
            message: String(part.error?.message ?? part.error),
          });
          break;
        }
        default:
          break;
      }
    }
    if (assistant) this.#history.push(assistant);
  }
}

function appendText(message: Message, delta: string): void {
  const last = message.parts[message.parts.length - 1] as Part | undefined;
  if (last && last.type === "text") {
    last.text += delta;
  } else {
    message.parts.push({ type: "text", text: delta });
  }
}

function normalizeUsage(usage: unknown): Usage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, number | undefined>;
  return {
    inputTokens: u.inputTokens ?? u.promptTokens,
    outputTokens: u.outputTokens ?? u.completionTokens,
    totalTokens: u.totalTokens,
  };
}
