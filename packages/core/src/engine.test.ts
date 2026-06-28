import { test, expect } from "bun:test";
import type { UIEvent } from "@vibe/shared";
import { defaultConfig } from "@vibe/config";
import { Engine } from "./engine.ts";

function collect(engine: Engine): { events: UIEvent[]; stop: () => void } {
  const events: UIEvent[] = [];
  const sub = engine.events();
  let active = true;
  void (async () => {
    for await (const e of sub) {
      if (!active) break;
      events.push(e);
    }
  })();
  return { events, stop: () => (active = false) };
}

test("/help lists commands, /model switches, /clear clears", async () => {
  const engine = new Engine({ config: defaultConfig() });
  const { events, stop } = collect(engine);

  engine.send({ type: "run-slash", name: "help", args: "" });
  engine.send({ type: "run-slash", name: "model", args: "openai/gpt-x" });
  engine.send({ type: "run-slash", name: "clear", args: "" });
  await engine.whenIdle();
  stop();

  const help = events.find(
    (e) => e.type === "notice" && e.message.includes("/help"),
  );
  expect(help).toBeDefined();

  expect(engine.snapshot().model).toBe("openai/gpt-x");
  expect(events.some((e) => e.type === "model-changed")).toBe(true);
  expect(
    events.some((e) => e.type === "notice" && e.message.includes("cleared")),
  ).toBe(true);
});

test("/plan and /execute toggle mode", async () => {
  const engine = new Engine({ config: defaultConfig() });
  collect(engine);
  engine.send({ type: "run-slash", name: "plan", args: "" });
  await engine.whenIdle();
  expect(engine.snapshot().mode).toBe("plan");
  engine.send({ type: "run-slash", name: "execute", args: "" });
  await engine.whenIdle();
  expect(engine.snapshot().mode).toBe("execute");
});

test("/goal sets and clears the goal", async () => {
  const engine = new Engine({ config: defaultConfig() });
  collect(engine);
  engine.send({ type: "run-slash", name: "goal", args: "ship it" });
  await engine.whenIdle();
  expect(engine.snapshot().goal).toBe("ship it");
  engine.send({ type: "run-slash", name: "goal", args: "" });
  await engine.whenIdle();
  expect(engine.snapshot().goal).toBeNull();
});

test("/status, /context, /memory, /recall run and emit notices", async () => {
  const engine = new Engine({ config: defaultConfig() });
  const { events, stop } = collect(engine);

  engine.send({ type: "run-slash", name: "status", args: "" });
  engine.send({ type: "run-slash", name: "context", args: "" });
  engine.send({ type: "run-slash", name: "memory", args: "" });
  engine.send({ type: "run-slash", name: "recall", args: "" });
  engine.send({ type: "run-slash", name: "recall", args: "anything" });
  await engine.whenIdle();
  stop();

  const notices = events.filter((e) => e.type === "notice").map((e) => e.message);
  expect(notices.some((m) => m.includes("context"))).toBe(true); // /status row
  expect(notices.some((m) => m.includes("Context window"))).toBe(true); // /context
  expect(notices.some((m) => m.includes("memory") || m.includes("Memory"))).toBe(true);
  // Empty /recall warns about usage; a query with no saved sessions reports no matches.
  expect(notices.some((m) => m.includes("Usage: /recall"))).toBe(true);
  expect(notices.some((m) => m.includes("No matches"))).toBe(true);
});

test("/reasoning warns on a non-reasoning (local) model", async () => {
  const engine = new Engine({ config: defaultConfig() });
  const { events, stop } = collect(engine);
  engine.send({ type: "run-slash", name: "model", args: "ollama/llama3.1" });
  engine.send({ type: "run-slash", name: "reasoning", args: "high" });
  await engine.whenIdle();
  stop();
  const warned = events.some(
    (e) => e.type === "notice" && e.level === "warn" && e.message.includes("ignores it"),
  );
  expect(warned).toBe(true);
});
