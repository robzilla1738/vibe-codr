import type {
  EngineClient,
  EngineCommand,
  EngineSnapshot,
  ExecutionTarget,
  HandoffPreparation,
  ModelSummary,
  PortableSessionArchiveV1,
  ProviderInfo,
  AgentInfo,
  SkillInfo,
  UIEvent,
} from "@vibe/shared";
import type { Engine } from "@vibe/core";
import { AsyncQueue } from "@vibe/shared";

export type RuntimeServiceState = "starting" | "ready" | "closing" | "closed";

export interface RuntimeServiceErrorData {
  version: 1;
  code: "RUNTIME_CLOSED";
  state: "closing" | "closed";
  operation: string;
}

/** Stable lifecycle error exposed to transports without prescribing wire encoding. */
export class RuntimeServiceError extends Error {
  readonly code = "RUNTIME_CLOSED";
  readonly data: RuntimeServiceErrorData;

  constructor(state: "closing" | "closed", operation: string) {
    super(`runtime is ${state}; cannot ${operation}`);
    this.name = "RuntimeServiceError";
    this.data = { version: 1, code: this.code, state, operation };
  }
}

export interface RuntimeEngine extends EngineClient {
  bootstrap(): Promise<void>;
  start(): void;
  finalize(): Promise<void>;
  transcriptState?(): ReturnType<Engine["transcriptState"]>;
  listMcp?(): ReturnType<Engine["listMcp"]>;
  listPluginStatus?(): ReturnType<Engine["listPluginStatus"]>;
  prepareHandoff?(
    target: ExecutionTarget,
    expectedGeneration?: number,
  ): Promise<HandoffPreparation>;
  exportPortableSession?(
    engineRevision: string,
    ownershipGeneration: number,
  ): Promise<PortableSessionArchiveV1>;
}

export interface RuntimeServiceOptions {
  /** Best-effort resource cleanup that runs after engine finalization. */
  afterFinalize?: () => void | Promise<void>;
  /** Bounded replay for callers that subscribe after bootstrap completes. */
  eventHistoryLimit?: number;
}

/**
 * Transport-neutral lifecycle facade for one Engine session.
 *
 * It deliberately contains no EngineCommand branching: commands and query
 * values cross this boundary unchanged. Engine remains the sole owner of busy,
 * queueing, permission, goal, sandbox, and handoff semantics.
 */
export class RuntimeService implements EngineClient {
  readonly #engine: RuntimeEngine;
  readonly #afterFinalize?: () => void | Promise<void>;
  readonly #eventHistoryLimit: number;
  readonly #subscribers = new Set<AsyncQueue<UIEvent>>();
  readonly #eventHistory: UIEvent[] = [];
  #state: RuntimeServiceState = "starting";
  #openPromise: Promise<this> | undefined;
  #closePromise: Promise<void> | undefined;
  #eventIterator: AsyncIterator<UIEvent> | undefined;

  constructor(engine: RuntimeEngine, options: RuntimeServiceOptions = {}) {
    this.#engine = engine;
    this.#afterFinalize = options.afterFinalize;
    this.#eventHistoryLimit = Math.max(1, options.eventHistoryLimit ?? 64);
  }

  get state(): RuntimeServiceState {
    return this.#state;
  }

  /** Subscribe first, then bootstrap exactly once and start exactly once. */
  open(): Promise<this> {
    this.#assertOpen("open");
    this.#openPromise ??= this.#doOpen();
    return this.#openPromise;
  }

  async #doOpen(): Promise<this> {
    // Taking the iterator and requesting its first value happens before
    // bootstrap. A bootstrap event therefore lands in our bounded history even
    // when a presentation transport subscribes only after open() resolves.
    const iterator = this.#engine.events()[Symbol.asyncIterator]();
    this.#eventIterator = iterator;
    void this.#pumpEvents(iterator).catch(() => undefined);
    try {
      await this.#engine.bootstrap();
      if (this.#state !== "starting") throw this.#closedError("start");
      this.#engine.start();
      if (this.#state !== "starting") throw this.#closedError("start");
      this.#state = "ready";
      return this;
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  async #pumpEvents(iterator: AsyncIterator<UIEvent>): Promise<void> {
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        const event = next.value;
        this.#eventHistory.push(event);
        if (this.#eventHistory.length > this.#eventHistoryLimit) this.#eventHistory.shift();
        for (const subscriber of this.#subscribers) subscriber.push(event);
      }
    } finally {
      this.#closeSubscriptions();
    }
  }

  events(): AsyncIterable<UIEvent> {
    const queue = new AsyncQueue<UIEvent>();
    for (const event of this.#eventHistory) queue.push(event);
    if (this.#state === "closed") {
      queue.close();
      return queue;
    }
    this.#subscribers.add(queue);
    return this.#consume(queue);
  }

  async *#consume(queue: AsyncQueue<UIEvent>): AsyncGenerator<UIEvent> {
    try {
      yield* queue;
    } finally {
      this.#subscribers.delete(queue);
      queue.close();
    }
  }

  #closeSubscriptions(): void {
    for (const subscriber of this.#subscribers) subscriber.close();
    this.#subscribers.clear();
  }

  send(command: EngineCommand): Promise<void> | void {
    this.#assertOpen("send");
    return this.#engine.send(command);
  }

  snapshot(): EngineSnapshot {
    this.#assertOpen("snapshot");
    return this.#engine.snapshot();
  }

  async listModels(): Promise<ModelSummary[]> {
    this.#assertOpen("list models");
    return this.#engine.listModels();
  }

  async listProviders(): Promise<ProviderInfo[]> {
    this.#assertOpen("list providers");
    return this.#requiredQuery("listProviders")();
  }

  async listAgents(): Promise<AgentInfo[]> {
    this.#assertOpen("list agents");
    return this.#requiredQuery("listAgents")();
  }

  async listSkills(): Promise<SkillInfo[]> {
    this.#assertOpen("list skills");
    return this.#requiredQuery("listSkills")();
  }

  transcriptState(): ReturnType<Engine["transcriptState"]> {
    this.#assertOpen("read transcript");
    return this.#requiredQuery("transcriptState")();
  }

  listMcp(): ReturnType<Engine["listMcp"]> {
    this.#assertOpen("list MCP servers");
    return this.#requiredQuery("listMcp")();
  }

  listPluginStatus(): ReturnType<Engine["listPluginStatus"]> {
    this.#assertOpen("list plugin status");
    return this.#requiredQuery("listPluginStatus")();
  }

  async prepareHandoff(
    target: ExecutionTarget,
    expectedGeneration?: number,
  ): Promise<HandoffPreparation> {
    this.#assertOpen("prepare handoff");
    return this.#requiredQuery("prepareHandoff")(target, expectedGeneration);
  }

  async exportPortableSession(
    engineRevision: string,
    ownershipGeneration: number,
  ): Promise<PortableSessionArchiveV1> {
    this.#assertOpen("export portable session");
    return this.#requiredQuery("exportPortableSession")(engineRevision, ownershipGeneration);
  }

  #requiredQuery<K extends keyof RuntimeEngine>(name: K): NonNullable<RuntimeEngine[K]> {
    const value = this.#engine[name];
    if (typeof value !== "function") throw new Error(`runtime engine does not support ${String(name)}`);
    return value.bind(this.#engine) as NonNullable<RuntimeEngine[K]>;
  }

  finalize(): Promise<void> {
    return this.close();
  }

  /** Concurrent close/finalize calls share one teardown and one engine finalize. */
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#state === "closed") return Promise.resolve();
    this.#state = "closing";
    this.#closePromise = this.#doClose();
    return this.#closePromise;
  }

  async #doClose(): Promise<void> {
    let failure: unknown;
    try {
      await this.#engine.finalize();
    } catch (error) {
      failure = error;
    }
    try {
      await this.#afterFinalize?.();
    } catch (error) {
      failure ??= error;
    }
    this.#state = "closed";
    this.#closeSubscriptions();
    this.#eventHistory.length = 0;
    // Engine.finalize normally closes the source. The return is best-effort for
    // injected engines whose event iterable needs explicit cancellation.
    void this.#eventIterator?.return?.().catch(() => undefined);
    if (failure) throw failure;
  }

  #closedError(operation: string): RuntimeServiceError {
    return new RuntimeServiceError(this.#state === "closed" ? "closed" : "closing", operation);
  }

  #assertOpen(operation: string): void {
    if (this.#state === "closing" || this.#state === "closed") throw this.#closedError(operation);
  }
}
