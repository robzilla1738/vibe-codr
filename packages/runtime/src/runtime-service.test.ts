import { describe, expect, test } from "bun:test";
import { RuntimeErrorDataV1Schema } from "@vibe/protocol";
import { AsyncQueue, type EngineCommand, type EngineSnapshot, type UIEvent } from "@vibe/shared";
import {
  RUNTIME_LIFECYCLE_ERROR_CODES,
  RuntimeService,
  RuntimeServiceError,
  type RuntimeEngine,
} from "./runtime-service.ts";

const SNAPSHOT = { sessionId: "session-1" } as EngineSnapshot;

class MockEngine implements RuntimeEngine {
  readonly stream = new AsyncQueue<UIEvent>();
  readonly calls: string[] = [];
  readonly commands: EngineCommand[] = [];
  readonly models = [{ id: "mock/model", providerId: "mock", name: "model" }];
  readonly providers = [{ id: "mock", configured: true, keyless: true, env: [] }];
  bootstrapError: Error | undefined;
  finalizeGate: Promise<void> | undefined;
  finalizeCount = 0;

  events(): AsyncIterable<UIEvent> {
    this.calls.push("events");
    return this.stream;
  }

  async bootstrap(): Promise<void> {
    this.calls.push("bootstrap");
    this.stream.push({ type: "notice", message: "bootstrap notice", level: "info" } as UIEvent);
    if (this.bootstrapError) throw this.bootstrapError;
  }

  start(): void {
    this.calls.push("start");
  }

  send(command: EngineCommand): void {
    this.commands.push(command);
  }

  snapshot(): EngineSnapshot {
    return SNAPSHOT;
  }

  async listModels() {
    return this.models;
  }

  listProviders() {
    return this.providers;
  }

  listAgents() {
    return [];
  }

  listSkills() {
    return [];
  }

  async finalize(): Promise<void> {
    this.finalizeCount += 1;
    await this.finalizeGate;
    this.stream.close();
  }
}

async function first<T>(iterable: AsyncIterable<T>): Promise<T | undefined> {
  return (await iterable[Symbol.asyncIterator]().next()).value;
}

describe("RuntimeService", () => {
  test("subscribes before bootstrap, starts once, and replays raw bootstrap events", async () => {
    const engine = new MockEngine();
    const service = new RuntimeService(engine);

    expect(await service.open()).toBe(service);
    expect(await service.open()).toBe(service);
    expect(engine.calls).toEqual(["events", "bootstrap", "start"]);

    const event = await first(service.events());
    expect(event).toEqual({ type: "notice", message: "bootstrap notice", level: "info" });
    await service.close();
  });

  test("failed bootstrap never starts and finalizes partial resources", async () => {
    const engine = new MockEngine();
    engine.bootstrapError = new Error("bootstrap failed");
    const service = new RuntimeService(engine);

    await expect(service.open()).rejects.toThrow("bootstrap failed");
    expect(engine.calls).toEqual(["events", "bootstrap"]);
    expect(engine.finalizeCount).toBe(1);
    expect(service.state).toBe("closed");
  });

  test("forwards commands and query results without transformation", async () => {
    const engine = new MockEngine();
    const service = await new RuntimeService(engine).open();
    const command = { type: "shutdown", extra: { preserved: true } } as unknown as EngineCommand;

    service.send(command);
    expect(engine.commands[0]).toBe(command);
    expect(service.snapshot()).toBe(SNAPSHOT);
    expect(await service.listModels()).toBe(engine.models);
    expect(await service.listProviders()).toBe(engine.providers);
    await service.close();
  });

  test("fans each live event out unchanged to independent subscribers", async () => {
    const engine = new MockEngine();
    const service = await new RuntimeService(engine).open();
    const left = service.events()[Symbol.asyncIterator]();
    const right = service.events()[Symbol.asyncIterator]();
    await Promise.all([left.next(), right.next()]); // bootstrap notice replay
    const leftNext = left.next();
    const rightNext = right.next();
    const event = { type: "notice", message: "live", level: "warn" } as UIEvent;

    engine.stream.push(event);

    expect((await leftNext).value).toBe(event);
    expect((await rightNext).value).toBe(event);
    await service.close();
  });

  test("concurrent close/finalize is idempotent and later work has versioned errors", async () => {
    const engine = new MockEngine();
    const service = await new RuntimeService(engine).open();
    let finishFinalize!: () => void;
    engine.finalizeGate = new Promise<void>((resolve) => {
      finishFinalize = resolve;
    });

    const closing = service.close();
    let closingError: unknown;
    try {
      service.snapshot();
    } catch (caught) {
      closingError = caught;
    }
    expect(closingError).toBeInstanceOf(RuntimeServiceError);
    expect((closingError as RuntimeServiceError).code).toBe(
      RUNTIME_LIFECYCLE_ERROR_CODES.closing,
    );
    expect(RuntimeErrorDataV1Schema.parse((closingError as RuntimeServiceError).data)).toEqual({
      schemaVersion: 1,
      code: "runtime-closing",
      message: "runtime is closing; cannot snapshot",
      retryable: false,
      details: { state: "closing", operation: "snapshot" },
    });

    finishFinalize();
    await Promise.all([closing, service.close(), service.finalize()]);
    expect(engine.finalizeCount).toBe(1);
    expect(service.state).toBe("closed");

    let error: unknown;
    try {
      service.snapshot();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RuntimeServiceError);
    expect(RuntimeErrorDataV1Schema.parse((error as RuntimeServiceError).data)).toEqual({
      schemaVersion: 1,
      code: "runtime-closed",
      message: "runtime is closed; cannot snapshot",
      retryable: false,
      details: { state: "closed", operation: "snapshot" },
    });
    expect(() => service.send({ type: "shutdown" })).toThrow(RuntimeServiceError);
    await expect(service.listModels()).rejects.toMatchObject({ code: "runtime-closed" });
    expect(await first(service.events())).toBeUndefined();
  });
});
