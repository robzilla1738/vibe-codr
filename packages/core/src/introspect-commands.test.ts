import { test, expect } from "bun:test";
import type { UIEvent } from "@vibe/shared";
import { defaultConfig } from "@vibe/config";
import { Engine } from "./engine.ts";

function collect(engine: Engine): UIEvent[] {
  const events: UIEvent[] = [];
  void (async () => {
    for await (const e of engine.events()) events.push(e);
  })();
  return events;
}

function notices(events: UIEvent[]): string {
  return events
    .filter((e): e is Extract<UIEvent, { type: "notice" }> => e.type === "notice")
    .map((e) => e.message)
    .join("\n");
}

test("/status, /config, /tools, /permissions, /mcp report state", async () => {
  const engine = new Engine({ config: defaultConfig() });
  const events = collect(engine);
  for (const name of ["status", "config", "tools", "permissions", "mcp"]) {
    engine.send({ type: "run-slash", name, args: "" });
  }
  await engine.whenIdle();
  const out = notices(events);
  expect(out).toContain("vibe-codr session");
  expect(out).toContain("Effective config");
  expect(out).toContain("Tools available in execute mode");
  expect(out).toContain("Permissions");
  expect(out).toContain("No MCP servers configured");
});

test("/approvals switches the approval mode at runtime", async () => {
  const engine = new Engine({ config: defaultConfig() });
  const events = collect(engine);
  engine.send({ type: "run-slash", name: "approvals", args: "auto" });
  await engine.whenIdle();
  expect(notices(events)).toContain("auto");

  engine.send({ type: "run-slash", name: "approvals", args: "nonsense" });
  await engine.whenIdle();
  expect(notices(events)).toContain("Usage: /approvals");
});

test("/reasoning sets and clears the effort", async () => {
  const engine = new Engine({ config: defaultConfig() });
  const events = collect(engine);
  engine.send({ type: "run-slash", name: "reasoning", args: "high" });
  engine.send({ type: "run-slash", name: "reasoning", args: "off" });
  await engine.whenIdle();
  const out = notices(events);
  expect(out).toContain("Reasoning effort: high");
  expect(out).toContain("cleared");
});

test("/new clears the conversation", async () => {
  const engine = new Engine({ config: defaultConfig() });
  const events = collect(engine);
  engine.send({ type: "run-slash", name: "new", args: "" });
  await engine.whenIdle();
  expect(notices(events)).toContain("cleared");
});

test("/cost reports a zero-cost session honestly", async () => {
  const engine = new Engine({ config: defaultConfig() });
  const events = collect(engine);
  engine.send({ type: "run-slash", name: "cost", args: "" });
  await engine.whenIdle();
  expect(notices(events)).toContain("Session cost");
});

test("/doctor runs the environment health check", async () => {
  const engine = new Engine({ config: defaultConfig() });
  const events = collect(engine);
  engine.send({ type: "run-slash", name: "doctor", args: "" });
  await engine.whenIdle();
  const out = notices(events);
  expect(out).toContain("vibe-codr doctor");
  expect(out).toContain("provider");
  expect(out).toContain("git");
});

test("/export reports an empty conversation honestly", async () => {
  const engine = new Engine({ config: defaultConfig() });
  const events = collect(engine);
  engine.send({ type: "run-slash", name: "export", args: "" });
  await engine.whenIdle();
  expect(notices(events)).toContain("Nothing to export");
});
