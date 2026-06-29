import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import type { UIEvent } from "@vibe/shared";
import { defaultConfig, type Config } from "@vibe/config";
import { Engine } from "./engine.ts";

// Each Engine gets an isolated temp cwd so `/recall`, `/memory`, checkpoints and
// session persistence never read or write the developer's real `.vibe/` — that
// made `/recall` flaky (it matched leftover sessions from prior runs).
function makeEngine(config: Config = defaultConfig()): Engine {
  return new Engine({ config, cwd: mkdtempSync(join(tmpdir(), "vibe-engine-test-")) });
}

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
  const engine = makeEngine();
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

test("snapshot.commandNames exposes built-ins, custom commands, and skills", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-engine-cmds-"));
  mkdirSync(join(cwd, ".vibe", "commands"), { recursive: true });
  writeFileSync(join(cwd, ".vibe", "commands", "shipit.md"), "Ship the feature: $ARGS");
  mkdirSync(join(cwd, ".vibe", "skills", "polish"), { recursive: true });
  writeFileSync(
    join(cwd, ".vibe", "skills", "polish", "SKILL.md"),
    "---\nname: polish\ndescription: Polish the UI\n---\nDo the polish.",
  );
  const engine = new Engine({ config: defaultConfig(), cwd });
  await engine.bootstrap();

  const names = engine.snapshot().commandNames;
  expect(names).toContain("help"); // built-in
  expect(names).toContain("cost"); // built-in
  expect(names).toContain("shipit"); // custom command
  expect(names).toContain("polish"); // skill (invocable as /polish)
});

test("/plan and /execute toggle mode", async () => {
  const engine = makeEngine();
  collect(engine);
  engine.send({ type: "run-slash", name: "plan", args: "" });
  await engine.whenIdle();
  expect(engine.snapshot().mode).toBe("plan");
  engine.send({ type: "run-slash", name: "execute", args: "" });
  await engine.whenIdle();
  expect(engine.snapshot().mode).toBe("execute");
});

test("/goal sets and clears the goal", async () => {
  const engine = makeEngine();
  collect(engine);
  engine.send({ type: "run-slash", name: "goal", args: "ship it" });
  await engine.whenIdle();
  expect(engine.snapshot().goal).toBe("ship it");
  engine.send({ type: "run-slash", name: "goal", args: "" });
  await engine.whenIdle();
  expect(engine.snapshot().goal).toBeNull();
});

test("/status, /context, /memory, /recall run and emit notices", async () => {
  const engine = makeEngine();
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
  const engine = makeEngine();
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
