import { test, expect } from "bun:test";
import type { ToolDefinition } from "@vibe/shared";
import { z } from "zod";
import { Toolset, createSerialLock, isConcurrencySafe } from "./toolset.ts";
import { builtinTools } from "./builtins/index.ts";

test("plan mode exposes only read-only tools", () => {
  const ts = new Toolset();
  const planNames = ts.names("plan");
  expect(planNames).toContain("read");
  expect(planNames).toContain("glob");
  expect(planNames).not.toContain("write");
  expect(planNames).not.toContain("edit");
  expect(planNames).not.toContain("bash");
});

test("execute mode exposes side-effecting tools", () => {
  const ts = new Toolset();
  const names = ts.names("execute");
  expect(names).toContain("write");
  expect(names).toContain("bash");
});

test("every plan-mode tool is marked readOnly", () => {
  const ts = new Toolset();
  for (const tool of ts.forMode("plan")) {
    expect(tool.readOnly).toBe(true);
  }
});

test("present_plan is available only in plan mode", () => {
  const ts = new Toolset();
  expect(ts.names("plan")).toContain("present_plan");
  expect(ts.names("execute")).not.toContain("present_plan");
});

test("web_search is included by default and omitted when disabled", () => {
  expect(builtinTools().map((t) => t.name)).toContain("web_search");
  expect(
    builtinTools({ search: { enabled: false } }).map((t) => t.name),
  ).not.toContain("web_search");
});

test("web_search is read-only (usable while planning)", () => {
  const search = builtinTools().find((t) => t.name === "web_search");
  expect(search?.readOnly).toBe(true);
  expect(new Toolset().names("plan")).toContain("web_search");
});

test("isConcurrencySafe: read-only or explicitly-safe tools, not mutating ones", () => {
  const byName = (n: string) => builtinTools().find((t) => t.name === n)!;
  expect(isConcurrencySafe(byName("read"))).toBe(true); // readOnly
  expect(isConcurrencySafe(byName("grep"))).toBe(true); // concurrencySafe
  expect(isConcurrencySafe(byName("edit"))).toBe(false);
  expect(isConcurrencySafe(byName("write"))).toBe(false);
  expect(isConcurrencySafe(byName("bash"))).toBe(false);
});

test("createSerialLock runs queued tasks strictly one-at-a-time", async () => {
  const lock = createSerialLock();
  const events: string[] = [];
  const task = (id: string, ms: number) =>
    lock(async () => {
      events.push(`start-${id}`);
      await new Promise((r) => setTimeout(r, ms));
      events.push(`end-${id}`);
      return id;
    });
  // Fire three concurrently; the lock must serialize them in FIFO order.
  const results = await Promise.all([task("a", 15), task("b", 1), task("c", 5)]);
  expect(results).toEqual(["a", "b", "c"]);
  expect(events).toEqual([
    "start-a",
    "end-a",
    "start-b",
    "end-b",
    "start-c",
    "end-c",
  ]);
});

test("a failing task doesn't wedge the serial lock", async () => {
  const lock = createSerialLock();
  await expect(lock(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  expect(await lock(async () => "ok")).toBe("ok");
});

test("beforeTool hook can veto a tool call; afterTool observes output", async () => {
  const calls: string[] = [];
  const tool: ToolDefinition = {
    name: "danger",
    description: "danger",
    inputSchema: z.object({}),
    readOnly: true,
    concurrencySafe: true,
    async execute() {
      calls.push("executed");
      return { output: "did it" };
    },
  };
  const seen: unknown[] = [];
  const ts = new Toolset([tool]);
  const exec = (base: Parameters<typeof ts.aiTools>[1]) => {
    const tools = ts.aiTools("execute", base);
    return (tools.danger as unknown as {
      execute: (i: unknown, o: { toolCallId: string }) => Promise<unknown>;
    }).execute({}, { toolCallId: "1" });
  };

  // Deny → the tool never executes and an error string comes back.
  const denied = await exec({
    cwd: ".",
    sessionId: "s",
    emit: () => {},
    beforeTool: async () => ({ deny: true, reason: "policy" }),
    afterTool: (_n, out) => void seen.push(out),
  });
  expect(calls).toHaveLength(0);
  expect(String(denied)).toContain("policy");
  expect(seen).toHaveLength(0); // afterTool not called when blocked

  // Allow → executes and afterTool sees the output.
  const ok = await exec({
    cwd: ".",
    sessionId: "s",
    emit: () => {},
    beforeTool: async () => ({}),
    afterTool: (_n, out) => void seen.push(out),
  });
  expect(calls).toEqual(["executed"]);
  expect(ok).toBe("did it");
  expect(seen).toEqual(["did it"]);
});

test("aiTools serializes mutating tools but lets read-only tools overlap", async () => {
  const order: string[] = [];
  const makeTool = (name: string, concurrencySafe: boolean, ms: number): ToolDefinition => ({
    name,
    description: name,
    inputSchema: z.object({}),
    readOnly: false,
    concurrencySafe,
    async execute() {
      order.push(`+${name}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`-${name}`);
      return { output: name };
    },
  });
  const ts = new Toolset([
    makeTool("mutA", false, 15),
    makeTool("mutB", false, 1),
    makeTool("safe", true, 8),
  ]);
  const tools = ts.aiTools("execute", { cwd: ".", sessionId: "s", emit: () => {} });
  const call = (n: string) => {
    const exec = (tools[n] as unknown as {
      execute: (i: unknown, o: { toolCallId: string }) => Promise<unknown>;
    }).execute;
    return exec({}, { toolCallId: n });
  };
  await Promise.all([call("mutA"), call("mutB"), call("safe")]);
  // mutA and mutB never overlap (serialized); the safe tool may interleave.
  const mutA = [order.indexOf("+mutA"), order.indexOf("-mutA")];
  const mutB = [order.indexOf("+mutB"), order.indexOf("-mutB")];
  const noOverlap = mutA[1]! < mutB[0]! || mutB[1]! < mutA[0]!;
  expect(noOverlap).toBe(true);
});
