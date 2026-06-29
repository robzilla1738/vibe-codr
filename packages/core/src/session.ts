import {
  streamText,
  generateText,
  stepCountIs,
  type ModelMessage,
  type LanguageModel,
} from "ai";
import { z } from "zod";
import {
  createId,
  type EngineSnapshot,
  type Message,
  type Mode,
  type Part,
  type Task,
  type TaskStatus,
  type ToolDefinition,
  type UIEvent,
  type Usage,
} from "@vibe/shared";
import type { Config, ModelPrice } from "@vibe/config";
import type { ProviderRegistry } from "@vibe/providers";
import { type Toolset, toAISDKTool, type ToolRuntimeBase } from "@vibe/tools";
import type { HookBus, SkillRegistry } from "@vibe/plugins";
import type { EventBus } from "./event-bus.ts";
import { EventBus as EventBusImpl } from "./event-bus.ts";
import { composeSystemPrompt } from "./system-prompt.ts";
import { PermissionChecker, type PermissionResolver } from "./permissions.ts";
import type { NamedAgent } from "./agents.ts";
import { compactMessages, estimateTokens } from "./compaction.ts";
import type { SessionStore } from "./store.ts";
import { searchSessions, formatRecall } from "./recall.ts";
import { addUsage, computeCost, type TokenTotals } from "./usage.ts";
import { buildModelTuning, ANTHROPIC_CACHE_CONTROL } from "./model-tuning.ts";
import type { ImageAttachment } from "./mentions.ts";
import { withRetry } from "./retry.ts";
import type { SessionUsage } from "@vibe/shared";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const COMPACT_KEEP_RECENT = 6;

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
  /** Plugin hook bus for tool.before/after.execute and assistant.message. */
  hooks?: HookBus;
  /** Subagent recursion depth (0 = root). */
  depth?: number;
  id?: string;
  /** Persistence backend; when set, the session is saved after each turn. */
  store?: SessionStore;
  /** Seed context/history when resuming a persisted session. */
  initialModelMessages?: ModelMessage[];
  initialHistory?: Message[];
  /** Seed the working task list when resuming a persisted session. */
  initialTasks?: Task[];
  /** Seed cumulative token usage when resuming a persisted session. */
  initialUsage?: TokenTotals;
  /** Seed accrued cost (USD) when resuming a persisted session. */
  initialCostUSD?: number;
  createdAt?: number;
  /** Resolve the active model's context window (for compaction). */
  getContextWindow?: (model: string) => Promise<number | undefined>;
  /** Resolve the active model's price (USD per 1M tokens) for cost tracking. */
  getPricing?: (model: string) => Promise<(ModelPrice & { estimated?: boolean }) | undefined>;
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
  #modelMessages: ModelMessage[];
  #history: Message[];
  #tasks: Task[];
  #usage: TokenTotals;
  /** Cost accrued per step at the price in effect then (correct across model switches). */
  #costUSD: number;
  #price: (ModelPrice & { estimated?: boolean }) | undefined;
  #turnMutated = false;
  /** Set once the session's cumulative cost crosses the configured budget. */
  #budgetTripped = false;
  #createdAt: number;
  #abort = new AbortController();
  /** The last turn's fatal error message, if any (null on success). Lets a
   * parent detect a failed subagent — the child runs on an isolated bus so its
   * `engine-error` never reaches the parent UI. */
  #lastError: string | null = null;

  constructor(deps: SessionDeps) {
    this.#deps = deps;
    this.id = deps.id ?? createId("ses");
    this.model = deps.model;
    this.mode = deps.mode;
    this.goal = deps.goal ?? null;
    this.#modelMessages = deps.initialModelMessages ?? [];
    this.#history = deps.initialHistory ?? [];
    this.#tasks = deps.initialTasks ?? [];
    this.#usage = {
      inputTokens: deps.initialUsage?.inputTokens ?? 0,
      outputTokens: deps.initialUsage?.outputTokens ?? 0,
    };
    this.#costUSD = deps.initialCostUSD ?? 0;
    this.#createdAt = deps.createdAt ?? Date.now();
  }

  snapshot(): EngineSnapshot {
    return {
      sessionId: this.id,
      model: this.model,
      mode: this.mode,
      goal: this.goal,
      history: this.#history,
      tasks: this.#tasks,
      usage: this.#usageSnapshot(),
      busy: this.busy,
      theme: this.#deps.config.theme,
      approvalMode: this.#deps.config.approvalMode,
    };
  }

  /** Current cumulative token + accrued-cost view for the UI. */
  #usageSnapshot(): SessionUsage {
    return {
      inputTokens: this.#usage.inputTokens,
      outputTokens: this.#usage.outputTokens,
      totalTokens: this.#usage.inputTokens + this.#usage.outputTokens,
      costUSD: this.#costUSD,
      // The cost is an estimate when the active price came from a base-model
      // catalog fallback (e.g. an Ollama Cloud tag) rather than an exact entry.
      ...(this.#price?.estimated && this.#costUSD > 0 ? { costEstimated: true } : {}),
      ...(this.#usage.cachedInputTokens
        ? { cachedInputTokens: this.#usage.cachedInputTokens }
        : {}),
    };
  }

  /**
   * Enforce the configured spend guard against cumulative cost. Warns once per
   * crossing; under `stop`, also aborts the active turn. Returns true if the
   * budget is exceeded.
   */
  #enforceBudget(): boolean {
    const budget = this.#deps.config.budget;
    if (!budget.limitUSD || this.#costUSD < budget.limitUSD) return false;
    if (!this.#budgetTripped) {
      this.#budgetTripped = true;
      this.#deps.bus.emit({
        type: "notice",
        level: "warn",
        message: `Spend limit reached: $${this.#costUSD.toFixed(4)} ≥ $${budget.limitUSD} (${budget.onExceed}).`,
      });
      if (budget.onExceed === "stop") this.#abort.abort();
    }
    return true;
  }

  /** Cumulative token totals for this session (for persistence/diagnostics). */
  get usage(): TokenTotals {
    return { ...this.#usage };
  }

  /** Accrued cost in USD for this session (incl. folded-in subagent cost). */
  get costUSD(): number {
    return this.#costUSD;
  }

  /** The last turn's fatal error message, or null if it succeeded. */
  get lastError(): string | null {
    return this.#lastError;
  }

  /** The current working task list (live reference; treat as read-only). */
  get tasks(): Task[] {
    return this.#tasks;
  }

  /** Whether the most recent turn ran a side-effecting (non-read-only) tool. */
  get didMutate(): boolean {
    return this.#turnMutated;
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

  /** A marker of the current conversation length (for checkpoint rollback). */
  conversationMark(): { messages: number; history: number } {
    return { messages: this.#modelMessages.length, history: this.#history.length };
  }

  /**
   * Roll the conversation back to a previous mark (after `/undo` reverts files),
   * so the model context no longer claims edits that were just undone.
   */
  rewindConversation(mark: { messages: number; history: number }): void {
    if (mark.messages < this.#modelMessages.length) {
      this.#modelMessages = this.#modelMessages.slice(0, mark.messages);
    }
    if (mark.history < this.#history.length) {
      this.#history = this.#history.slice(0, mark.history);
    }
  }

  /** Reset conversation history (model context and UI history). */
  clear(): void {
    this.#modelMessages = [];
    this.#history = [];
    if (this.#tasks.length) this.setTasks([]);
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

  /** Estimated tokens currently held in the model context (for /status, /context). */
  get contextTokens(): number {
    return estimateTokens(this.#modelMessages);
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
      execute: async ({ prompt, agent, model, mode }, ctx) => {
        const named = agent ? this.#deps.agents?.get(agent) : undefined;
        if (agent && !named) {
          return { output: `Unknown agent "${agent}". Run /agents to list them.`, isError: true };
        }
        const child = this.fork({
          bus: new EventBusImpl(), // isolate the subagent's fine-grained stream
          model:
            model ?? named?.model ?? this.#deps.config.subagent.model ?? this.model,
          mode: mode ?? named?.mode ?? "execute",
          goal: this.goal,
          depth: this.depth + 1,
          ...(named?.system ? { extraSystem: [named.system] } : {}),
        });
        // Aborting the parent turn (e.g. /abort, spend stop) cancels the child.
        const onAbort = () => child.abort();
        ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });
        this.#deps.bus.emit({
          type: "subagent-started",
          sessionId: this.id,
          subagentId: child.id,
          prompt,
        });
        try {
          await child.run(prompt);
        } finally {
          ctx.abortSignal?.removeEventListener("abort", onAbort);
        }
        // Fold the child's tokens + cost into the parent so `/cost` and the
        // spend guard account for delegated work (the child runs on an isolated
        // bus, so its own usage events never reach the parent UI).
        addUsage(this.#usage, child.usage);
        this.#costUSD += child.costUSD;
        this.#deps.bus.emit({
          type: "usage-updated",
          sessionId: this.id,
          usage: this.#usageSnapshot(),
        });
        this.#enforceBudget();
        // Surface a child failure to the parent model (and as a notice) instead
        // of masking it as "no output".
        if (child.lastError) {
          this.#deps.bus.emit({
            type: "subagent-finished",
            sessionId: this.id,
            subagentId: child.id,
            result: `failed: ${child.lastError}`,
          });
          return {
            output: `Subagent failed: ${child.lastError}`,
            isError: true,
          };
        }
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

  /**
   * Replace the working task list. Reuses the id of any existing task with the
   * same title so UI list keys stay stable across updates. Emits `tasks-updated`.
   */
  setTasks(incoming: { title: string; status: TaskStatus }[]): Task[] {
    const byTitle = new Map(this.#tasks.map((t) => [t.title, t]));
    this.#tasks = incoming.map((t) => ({
      id: byTitle.get(t.title)?.id ?? createId("task"),
      title: t.title,
      status: t.status,
    }));
    this.#deps.bus.emit({
      type: "tasks-updated",
      sessionId: this.id,
      tasks: this.#tasks,
    });
    return this.#tasks;
  }

  /** Build the per-session `update_tasks` tool (closes over this session). */
  #tasksTool(): ToolDefinition<{
    tasks: { title: string; status: TaskStatus }[];
  }> {
    const Task = z.object({
      title: z.string().describe("Short imperative description of the task."),
      status: z
        .enum(["pending", "in_progress", "completed"])
        .describe("Exactly one task should be in_progress at a time."),
    });
    return {
      name: "update_tasks",
      description:
        "Record and update your working task list for a multi-step request. " +
        "Pass the COMPLETE list every time (it replaces the previous one). " +
        "Keep exactly one task in_progress, mark tasks completed as you finish " +
        "them, and add new tasks as they emerge. Use this to plan and to show " +
        "the user live progress on non-trivial work.",
      inputSchema: z.object({ tasks: z.array(Task) }),
      readOnly: true,
      concurrencySafe: false,
      execute: async ({ tasks }) => {
        const updated = this.setTasks(tasks);
        const done = updated.filter((t) => t.status === "completed").length;
        return { output: `Task list updated (${done}/${updated.length} complete).` };
      },
    };
  }

  /** Execute one agentic turn for `input`. Resolves when the turn ends. */
  async run(input: string, images: ImageAttachment[] = []): Promise<void> {
    const { bus, registry, toolset, config } = this.#deps;
    this.busy = true;
    this.#turnMutated = false;
    this.#lastError = null;
    this.#pushUser(input, images);

    try {
      // If a prior turn already blew the spend limit under `stop`, don't start
      // another one — warn and end the turn immediately.
      if (this.#enforceBudget() && config.budget.onExceed === "stop") return;

      const model = await withRetry(() => registry.resolveModel(this.model, config), {
        maxAttempts: config.retry.maxAttempts,
        baseDelayMs: config.retry.baseDelayMs,
      });
      // Resolve the active model's price once per turn for live cost tracking.
      this.#price = await this.#deps.getPricing?.(this.model);
      await this.#maybeCompact(model, false);
      const skills = this.#deps.skills;
      const system = composeSystemPrompt({
        mode: this.mode,
        goal: this.goal,
        projectMemory: this.#deps.projectMemory,
        pluginBlocks: this.#deps.extraSystem,
        ...(skills?.list().length
          ? { skillDescriptions: skills.descriptions() }
          : {}),
      });
      const checker = new PermissionChecker(
        config.permissions,
        this.#deps.permissionResolver,
        config.approvalMode === "auto" ? "allow" : "ask",
      );
      const hooks = this.#deps.hooks;
      const base: ToolRuntimeBase = {
        cwd: this.#deps.cwd,
        sessionId: this.id,
        emit: (e: UIEvent) => bus.emit(e),
        checkPermission: (name: string, input: unknown) =>
          checker.check(name, input),
        ...(hooks
          ? {
              beforeTool: async (toolName: string, input: unknown) => {
                const r = await hooks.run("tool.before.execute", { toolName, input });
                return { deny: r.deny, reason: r.reason };
              },
              afterTool: (toolName: string, output: unknown) =>
                void hooks.run("tool.after.execute", { toolName, output }),
            }
          : {}),
      };

      const tools = toolset.aiTools(this.mode, base);
      // The task list is available in both modes: the model can lay out tasks
      // while planning, and they carry over into execution.
      tools.update_tasks = toAISDKTool(this.#tasksTool(), base);
      // Subagents do real work, so only offer spawning in execute mode and
      // below the configured recursion depth.
      if (this.mode === "execute" && this.depth < config.subagent.maxDepth) {
        tools.spawn_subagent = toAISDKTool(this.#spawnTool(), base);
      }
      // Progressive disclosure: expose use_skill when skills are available.
      if (skills?.list().length) {
        tools.use_skill = toAISDKTool(this.#useSkillTool(), base);
      }
      // Long-term memory: let the model search prior sessions on demand.
      tools.recall_memory = toAISDKTool(this.#recallTool(), base);

      // Per-provider tuning: reasoning/thinking budget + (Anthropic) caching of
      // the stable system prefix so repeated turns don't re-bill the full prompt.
      const tuning = buildModelTuning(this.model, config);
      const messages: ModelMessage[] = tuning.cacheSystem
        ? [
            { role: "system", content: system, providerOptions: ANTHROPIC_CACHE_CONTROL },
            ...this.#modelMessages,
          ]
        : this.#modelMessages;

      const result = streamText({
        model,
        // When caching, the system prompt rides in `messages` with a cache
        // marker; otherwise it's passed plainly.
        ...(tuning.cacheSystem ? {} : { system }),
        messages,
        tools,
        toolChoice: "auto",
        stopWhen: stepCountIs(config.maxSteps),
        abortSignal: this.#abort.signal,
        maxRetries: config.retry.maxAttempts,
        onError: ({ error }) => {
          bus.emit({
            type: "notice",
            level: "warn",
            message: `provider error: ${(error as Error)?.message ?? String(error)}`,
          });
        },
        ...(tuning.providerOptions
          ? {
              providerOptions: tuning.providerOptions as NonNullable<
                Parameters<typeof streamText>[0]["providerOptions"]
              >,
            }
          : {}),
        onStepFinish: ({ usage }) => {
          const stepUsage = normalizeUsage(usage);
          bus.emit({
            type: "step-finished",
            sessionId: this.id,
            usage: stepUsage,
          });
          addUsage(this.#usage, stepUsage);
          // Accrue cost at the price in effect for this step, so a mid-session
          // model/price change doesn't retroactively reprice earlier tokens.
          this.#costUSD += computeCost(
            stepUsage?.inputTokens ?? 0,
            stepUsage?.outputTokens ?? 0,
            this.#price,
          );
          bus.emit({
            type: "usage-updated",
            sessionId: this.id,
            usage: this.#usageSnapshot(),
          });
          this.#enforceBudget();
        },
      });

      // Build the assistant message from the stream, then commit it to BOTH the
      // model context and the UI history together. On abort/error mid-turn,
      // `result.response` rejects, so we record the partial assistant text in
      // the model context too — keeping `#history` and `#modelMessages` in
      // lockstep (otherwise the next turn's context would be missing this turn).
      const assistant = await this.#consume(result);
      let responseOk = false;
      try {
        const response = await result.response;
        this.#modelMessages.push(...response.messages);
        responseOk = true;
      } finally {
        if (assistant) {
          this.#history.push(assistant);
          // On failure the authoritative model messages never arrived; record
          // the partial assistant text so model context matches UI history.
          if (!responseOk) {
            const text = assistant.parts
              .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
              .map((p) => p.text)
              .join("");
            if (text) this.#modelMessages.push({ role: "assistant", content: text });
          }
        }
      }
      // Notify plugins of the completed assistant message (best-effort).
      if (this.#deps.hooks && assistant) {
        const text = assistant.parts
          .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
          .map((p) => p.text)
          .join("");
        if (text) await this.#deps.hooks.run("assistant.message", { sessionId: this.id, text });
      }
    } catch (err) {
      this.#lastError = (err as Error).message;
      bus.emit({
        type: "engine-error",
        sessionId: this.id,
        message: (err as Error).message,
      });
    } finally {
      this.busy = false;
      await this.#persist();
      bus.emit({ type: "turn-finished", sessionId: this.id });
      bus.emit({ type: "session-idle", sessionId: this.id });
    }
  }

  /** Force a compaction pass now (used by /compact). */
  async compact(): Promise<void> {
    const model = await this.#deps.registry.resolveModel(
      this.model,
      this.#deps.config,
    );
    await this.#maybeCompact(model, true);
  }

  /** Summarize older context when over the threshold (or when forced). */
  async #maybeCompact(model: LanguageModel, force: boolean): Promise<void> {
    const contextWindow =
      (await this.#deps.getContextWindow?.(this.model)) ??
      DEFAULT_CONTEXT_WINDOW;
    // Surface live context-window fill so the UI can show how close we are to
    // the limit (and when auto-compaction is about to kick in).
    this.#deps.bus.emit({
      type: "context-updated",
      sessionId: this.id,
      usedTokens: estimateTokens(this.#modelMessages),
      contextWindow,
    });
    const result = await compactMessages(this.#modelMessages, {
      contextWindow,
      threshold: this.#deps.config.compaction.threshold,
      keep: COMPACT_KEEP_RECENT,
      force,
      summarize: (msgs) => this.#summarize(model, msgs),
    });
    if (!result) {
      if (force) {
        this.#deps.bus.emit({
          type: "notice",
          level: "info",
          message: "Nothing to compact yet.",
        });
      }
      return;
    }
    this.#modelMessages = result.messages;
    this.#deps.bus.emit({
      type: "compacted",
      sessionId: this.id,
      freedTokens: result.freed,
    });
  }

  async #summarize(model: LanguageModel, messages: ModelMessage[]): Promise<string> {
    const transcript = messages
      .map(
        (m) =>
          `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`,
      )
      .join("\n");
    const { text } = await generateText({
      model,
      prompt:
        "Summarize the following conversation excerpt for an AI coding agent. " +
        "Preserve decisions made, facts learned, file paths touched, and any open tasks. Be concise.\n\n" +
        transcript,
    });
    return text;
  }

  async #persist(): Promise<void> {
    const store = this.#deps.store;
    if (!store) return;
    try {
      await store.save(
        {
          id: this.id,
          model: this.model,
          mode: this.mode,
          goal: this.goal,
          tasks: this.#tasks,
          usage: { ...this.#usage, costUSD: this.#costUSD },
          createdAt: this.#createdAt,
          updatedAt: Date.now(),
        },
        this.#modelMessages,
        this.#history,
      );
    } catch (err) {
      this.#deps.bus.emit({
        type: "notice",
        level: "warn",
        message: `Failed to persist session: ${(err as Error).message}`,
      });
    }
  }

  /** Fork a child session for a subagent (own context, shared infra). */
  fork(overrides: Partial<SessionDeps> & { model?: string }): Session {
    return new Session({
      ...this.#deps,
      // A subagent is a FRESH conversation with its own context window. Never
      // inherit the parent's seeded/resumed history, usage, cost, or tasks
      // (that would corrupt isolation and double-count cost on `--resume`), its
      // persistence store (subagents are ephemeral — persisting them pollutes
      // `/resume` and can hijack `--continue`), or its system extras/identity.
      // `...overrides` below re-applies any the caller intends (e.g. extraSystem
      // for a named agent, depth).
      initialModelMessages: undefined,
      initialHistory: undefined,
      initialTasks: undefined,
      initialUsage: undefined,
      initialCostUSD: undefined,
      store: undefined,
      extraSystem: undefined,
      createdAt: undefined,
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

  /** Build the read-only `recall_memory` tool: search past sessions' history. */
  #recallTool(): ToolDefinition<{ query: string; limit?: number }> {
    const cwd = this.#deps.cwd;
    const selfId = this.id;
    return {
      name: "recall_memory",
      description:
        "Search the user's past vibe-codr sessions (long-term memory) for relevant prior context, decisions, or code discussion. Use this when the user references earlier work, asks 'what did we decide', or you need history beyond the current conversation.",
      inputSchema: z.object({
        query: z.string().describe("What to look for in past sessions."),
        limit: z.number().int().positive().max(20).optional().describe("Max matches (default 8)."),
      }),
      readOnly: true,
      concurrencySafe: true,
      execute: async ({ query, limit }) => {
        const hits = await searchSessions(cwd, query, {
          excludeId: selfId,
          ...(limit ? { limit } : {}),
        });
        return { output: formatRecall(query, hits) };
      },
    };
  }

  #pushUser(input: string, images: ImageAttachment[] = []): void {
    // Multimodal user turn when images are attached; plain string otherwise so
    // existing text-only behaviour and persistence are unchanged.
    const content = images.length
      ? [
          { type: "text" as const, text: input },
          ...images.map((img) => ({
            type: "image" as const,
            image: img.data,
            mediaType: img.mediaType,
          })),
        ]
      : input;
    this.#modelMessages.push({ role: "user", content });
    const parts: Part[] = [{ type: "text", text: input }];
    for (const img of images) parts.push({ type: "text", text: `[image: ${img.path}]` });
    this.#history.push({
      id: createId("msg"),
      role: "user",
      parts,
      createdAt: Date.now(),
    });
    this.#deps.bus.emit({ type: "user-message", sessionId: this.id, text: input });
  }

  /** Translate AI-SDK stream parts into UIEvents and accumulate the message. */
  async #consume(
    result: { fullStream: AsyncIterable<unknown> },
  ): Promise<Message | null> {
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
          // Track whether this turn changed the workspace (drives auto-verify).
          const def = this.#deps.toolset.get(part.toolName);
          if ((def && !def.readOnly) || part.toolName === "spawn_subagent") {
            this.#turnMutated = true;
          }
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
    return assistant;
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
    cachedInputTokens: u.cachedInputTokens ?? u.cachedPromptTokens,
  };
}
