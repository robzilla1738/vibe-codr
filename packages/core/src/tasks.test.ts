import { test, expect } from "bun:test";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import type { UIEvent } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { FreshnessRegistry } from "@vibe/tools";
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
    freshness: new FreshnessRegistry(),
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

test("update_tasks id-addressed patches flip statuses without resending the list", async () => {
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "update_tasks",
        // The primary shape: patch by t<N> id (string or bare number), append new.
        input: JSON.stringify({
          updates: [
            { id: "t1", status: "completed" },
            { id: 2, status: "in_progress" },
            { id: "t99", status: "completed" }, // out of range → ignored, reported
          ],
          add: ["Ship it"],
        }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Patched." },
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });

  const bus = new EventBus();
  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });
  // Seeded list (what plan approval produces) — ids are positional t1/t2.
  const seeded = session.setTasks([
    { title: "Scaffold the app", status: "pending" },
    { title: "Build the hero", status: "pending" },
  ]);

  const events = await collect(bus, () => session.run("continue the plan"));

  const finished = events.find((e) => e.type === "tool-call-finished");
  expect(finished && finished.type === "tool-call-finished" && String(finished.output)).toContain(
    "t99 does not exist",
  );
  const tasks = session.tasks;
  expect(tasks.map((t) => t.status)).toEqual(["completed", "in_progress", "pending"]);
  expect(tasks[2]!.title).toBe("Ship it");
  // Patching preserves identity — no id churn on the untouched entries.
  expect(tasks[0]!.id).toBe(seeded[0]!.id);
});

test("patchTasks applies positional updates, appends, and reports out-of-range refs", () => {
  const bus = new EventBus();
  const session = new Session({
    config: defaultConfig(),
    registry: new ProviderRegistry(),
    toolset: new Toolset([]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });
  session.setTasks([
    { title: "one", status: "pending" },
    { title: "two", status: "pending" },
  ]);
  const { applied, ignored, tasks } = session.patchTasks(
    [
      { index: 1, status: "completed" },
      { index: 5, status: "completed" },
    ],
    ["three"],
  );
  expect(applied).toBe(1);
  expect(ignored).toEqual([5]);
  expect(tasks.map((t) => `${t.title}:${t.status}`)).toEqual([
    "one:completed",
    "two:pending",
    "three:pending",
  ]);
});

test("task events carry fresh snapshots — a patch never aliases a prior emission", async () => {
  const bus = new EventBus();
  const session = new Session({
    config: defaultConfig(),
    registry: new ProviderRegistry(),
    toolset: new Toolset([]),
    bus,
    freshness: new FreshnessRegistry(),
    cwd: process.cwd(),
    model: "mock/test",
    mode: "execute",
  });

  const events = await collect(bus, async () => {
    session.setTasks([
      { title: "one", status: "pending" },
      { title: "two", status: "pending" },
    ]);
    session.patchTasks([{ index: 1, status: "completed" }]);
  });

  const emitted = events.filter((e) => e.type === "tasks-updated");
  expect(emitted.length).toBe(2);
  const [first, second] = emitted as Extract<UIEvent, { type: "tasks-updated" }>[];
  // Identity-based change detection (the TUI's signal) must see a NEW array of
  // NEW objects each time — an in-place patch on shared references reads as
  // "nothing changed" and the task panel freezes at 0/N.
  expect(second!.tasks).not.toBe(first!.tasks);
  expect(second!.tasks[0]).not.toBe(first!.tasks[0]);
  // The earlier emission is a stable snapshot, not retroactively mutated.
  expect(first!.tasks[0]!.status).toBe("pending");
  expect(second!.tasks[0]!.status).toBe("completed");
  // The engine snapshot doesn't alias the live list either.
  const snap = session.snapshot();
  expect(snap.tasks[0]).not.toBe(session.tasks[0]);
});

test("setTasks reuses ids for tasks whose title is unchanged", () => {
  const bus = new EventBus();
  const session = new Session({
    config: defaultConfig(),
    registry: new ProviderRegistry(),
    toolset: new Toolset([]),
    bus,
    freshness: new FreshnessRegistry(),
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
