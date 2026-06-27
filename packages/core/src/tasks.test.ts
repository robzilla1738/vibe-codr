import { test, expect } from "bun:test";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import type { UIEvent } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { defaultConfig } from "@vibe/config";
import { EventBus } from "./event-bus.ts";
import { Session } from "./session.ts";

function stream(chunks: unknown[]) {
  return {
    stream: simulateReadableStream({
      chunks: chunks as never[],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
}

const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

function mockRegistry(model: MockLanguageModelV2): ProviderRegistry {
  return new ProviderRegistry([
    {
      id: "mock",
      auth: { env: [], keyless: true },
      create: () => model,
      listModels: async () => [],
    },
  ]);
}

async function collect(bus: EventBus, run: () => Promise<void>): Promise<UIEvent[]> {
  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();
  await run();
  bus.close();
  await collector;
  return events;
}

test("update_tasks records the task list and emits tasks-updated", async () => {
  const tasks = [
    { title: "Read the config", status: "completed" },
    { title: "Write the patch", status: "in_progress" },
    { title: "Run the tests", status: "pending" },
  ];
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "update_tasks",
        input: JSON.stringify({ tasks }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "On it." },
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => steps[call++] as never,
  });

  const bus = new EventBus();
  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });

  const events = await collect(bus, () => session.run("do the multi-step thing"));

  const update = events.find((e) => e.type === "tasks-updated");
  expect(update && update.type === "tasks-updated" && update.tasks.length).toBe(3);

  const snap = session.snapshot();
  expect(snap.tasks.map((t) => t.status)).toEqual([
    "completed",
    "in_progress",
    "pending",
  ]);
  // Every task gets a stable id.
  expect(snap.tasks.every((t) => t.id.length > 0)).toBe(true);
});

test("setTasks reuses ids for tasks whose title is unchanged", () => {
  const bus = new EventBus();
  const session = new Session({
    config: defaultConfig(),
    registry: new ProviderRegistry(),
    toolset: new Toolset([]),
    bus,
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });

  const first = session.setTasks([
    { title: "Step one", status: "in_progress" },
    { title: "Step two", status: "pending" },
  ]);
  const second = session.setTasks([
    { title: "Step one", status: "completed" },
    { title: "Step two", status: "in_progress" },
  ]);

  expect(second[0]!.id).toBe(first[0]!.id);
  expect(second[1]!.id).toBe(first[1]!.id);
  expect(second[0]!.status).toBe("completed");

  // Clearing the list empties it.
  session.clear();
  expect(session.tasks.length).toBe(0);
});
