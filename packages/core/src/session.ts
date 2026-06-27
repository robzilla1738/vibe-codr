import { streamText, stepCountIs, type ModelMessage } from "ai";
import { z } from "zod";
import {
  createId,
  type EngineSnapshot,
  type Message,
  type Mode,
  type Part,
  type ToolDefinition,
  type UIEvent,
  type Usage,
} from "@vibe/shared";
import type { Config } from "@vibe/config";
import type { ProviderRegistry } from "@vibe/providers";
import { Toolset, toAISDKTool, type ToolRuntimeBase } from "@vibe/tools";
import type { SkillRegistry } from "@vibe/plugins";
import type { EventBus } from "./event-bus.ts";
import { EventBus as EventBusImpl } from "./event-bus.ts";
import { composeSystemPrompt } from "./system-prompt.ts";
import { PermissionChecker, type PermissionResolver } from "./permissions.ts";
import type { NamedAgent } from "./agents.ts";

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
  permissionResolver?: PermissionResolver;
  /** Extra system-prompt blocks (e.g. a named agent's instructions). */
  extraSystem?: string[];
  /** Named subagents available to spawn. */
  agents?: Map<string, NamedAgent>;
  /** Skills available for progressive disclosure via `use_skill`. */
  skills?: SkillRegistry;
  /** Subagent recursion depth (0 = root). */
  depth?: number;
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

  /** Reset conversation history (model context and UI history). */
  clear(): void {
    this.#modelMessages = [];
    this.#history = [];
    this.#deps.bus.emit({
      type: "notice",
      level: "info",
      message: "Conversation cleared.",
    });
  }

  /** Number of model messages currently in context (for diagnostics/compaction). */
  get messageCount(): number {
    return this.#modelMessages.length;
  }

  /** Subagent recursion depth (0 = root). */
  get depth(): number {
    return this.#deps.depth ?? 0;
  }

  /** The concatenated text of the most recent assistant message. */
  lastAssistantText(): string {
    for (let i = this.#history.length - 1; i >= 0; i--) {
      const m = this.#history[i];
      if (m && m.role === "assistant") {
        return m.parts
          .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
          .map((p) => p.text)
          .join("");
      }
    }
    return "";
  }

  /** Build the per-session `spawn_subagent` tool (closes over this session). */
  #spawnTool(): ToolDefinition<{
    prompt: string;
    agent?: string;
    model?: string;
    mode?: Mode;
  }> {
    const Input = z.object({
      prompt: z.string().describe("The complete, self-contained subtask."),
      agent: z.string().optional().describe("Named agent to use (see /agents)."),
      model: z.string().optional().describe("Override the model for this subagent."),
      mode: z.enum(["plan", "execute"]).optional(),
    });
    return {
      name: "spawn_subagent",
      description:
        "Delegate an independent subtask to a fresh subagent that has its own context window and returns only its final answer. Use for parallel or independent workstreams; give a complete, self-contained prompt.",
      inputSchema: Input,
      readOnly: false,
      concurrencySafe: true,
      execute: async ({ prompt, agent, model, mode }) => {
        const named = agent ? this.#deps.agents?.get(agent) : undefined;
        if (agent && !named) {
          return { output: `Unknown agent "${agent}". Run /agents to list them.`, isError: true };
        }
        const child = this.fork({
          bus: new EventBusImpl(), // isolate the subagent's fine-grained stream
          model: model ?? named?.model ?? this.model,
          mode: mode ?? named?.mode ?? "execute",
          goal: this.goal,
          depth: this.depth + 1,
          ...(named?.system ? { extraSystem: [named.system] } : {}),
        });
        this.#deps.bus.emit({
          type: "subagent-started",
          sessionId: this.id,
          subagentId: child.id,
          prompt,
        });
        await child.run(prompt);
        const result = child.lastAssistantText() || "(subagent produced no output)";
        this.#deps.bus.emit({
          type: "subagent-finished",
          sessionId: this.id,
          subagentId: child.id,
          result,
        });
        return { output: result };
      },
    };
  }

  /** Execute one agentic turn for `input`. Resolves when the turn ends. */
  async run(input: string): Promise<void> {
    const { bus, registry, toolset, config } = this.#deps;
    this.busy = true;
    this.#pushUser(input);

    try {
      const model = await registry.resolveModel(this.model, config);
      const skills = this.#deps.skills;
      const system = composeSystemPrompt({
        mode: this.mode,
        goal: this.goal,
        projectMemory: this.#deps.projectMemory,
        pluginBlocks: this.#deps.extraSystem,
        ...(skills && skills.list().length
          ? { skillDescriptions: skills.descriptions() }
          : {}),
      });
      const checker = new PermissionChecker(
        config.permissions,
        this.#deps.permissionResolver,
      );
      const base: ToolRuntimeBase = {
        cwd: this.#deps.cwd,
        sessionId: this.id,
        emit: (e: UIEvent) => bus.emit(e),
        checkPermission: (name: string, input: unknown) =>
          checker.check(name, input),
      };

      const tools = toolset.aiTools(this.mode, base);
      // Subagents do real work, so only offer spawning in execute mode and
      // below the configured recursion depth.
      if (this.mode === "execute" && this.depth < config.subagent.maxDepth) {
        tools["spawn_subagent"] = toAISDKTool(this.#spawnTool(), base);
      }
      // Progressive disclosure: expose use_skill when skills are available.
      if (skills && skills.list().length) {
        tools["use_skill"] = toAISDKTool(this.#useSkillTool(), base);
      }

      const result = streamText({
        model,
        system,
        messages: this.#modelMessages,
        tools,
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

  /** Build the `use_skill` tool that loads a skill's full body into context. */
  #useSkillTool(): ToolDefinition<{ name: string }> {
    const skills = this.#deps.skills;
    return {
      name: "use_skill",
      description:
        "Load the full instructions for a named skill before performing a task it applies to. Call this when a listed skill is relevant.",
      inputSchema: z.object({
        name: z.string().describe("The skill name to load."),
      }),
      readOnly: true,
      execute: async ({ name }) => {
        const skill = skills?.get(name);
        if (!skill) {
          return { output: `Unknown skill "${name}".`, isError: true };
        }
        const body = await skill.load();
        return { output: `# Skill: ${skill.name}\n\n${body}` };
      },
    };
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
