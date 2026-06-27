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
