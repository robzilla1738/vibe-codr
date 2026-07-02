import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@vibe/shared";
import { z } from "zod";
import {
  Toolset,
  createSerialLock,
  createSemaphore,
  createFileLock,
  isConcurrencySafe,
  canonicalLockKey,
  toAISDKTool,
} from "./toolset.ts";
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

test("createSemaphore admits at most n concurrently", async () => {
  const sem = createSemaphore(2);
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const task = () =>
    sem(async () => {
      active++;
      peak = Math.max(peak, active);
      await barrier;
      active--;
    });
  const all = Promise.all([task(), task(), task(), task()]);
  await new Promise((r) => setTimeout(r, 10));
  expect(active).toBe(2); // only 2 of 4 admitted
  release();
  await all;
  expect(peak).toBe(2); // never exceeded the cap, even as the queue drained
});

test("createFileLock serializes the same path, FIFO", async () => {
  const lock = createFileLock();
  const order: string[] = [];
  let releaseA!: () => void;
  const aBarrier = new Promise<void>((r) => {
    releaseA = r;
  });
  const p1 = lock("/x", async () => {
    order.push("a-start");
    await aBarrier;
    order.push("a-end");
  });
  const p2 = lock("/x", async () => {
    order.push("b-start");
  });
  await new Promise((r) => setTimeout(r, 10));
  expect(order).toEqual(["a-start"]); // b is blocked behind a on the same path
  releaseA();
  await Promise.all([p1, p2]);
  expect(order).toEqual(["a-start", "a-end", "b-start"]);
});

test("createFileLock canonicalizes keys so different spellings of one file serialize", async () => {
  // A real file so realpath resolves; `./sub/../f.txt` and `f.txt` are the same.
  const dir = mkdtempSync(join(tmpdir(), "vibe-lockkey-"));
  mkdirSync(join(dir, "sub"));
  const f = join(dir, "f.txt");
  writeFileSync(f, "x");
  const lock = createFileLock();
  const order: string[] = [];
  let releaseA!: () => void;
  const aBarrier = new Promise<void>((r) => {
    releaseA = r;
  });
  const p1 = lock(f, async () => {
    order.push("a-start");
    await aBarrier;
    order.push("a-end");
  });
  const p2 = lock(join(dir, "sub", "..", "f.txt"), async () => {
    order.push("b-start");
  });
  await new Promise((r) => setTimeout(r, 10));
  expect(order).toEqual(["a-start"]); // same file via a different spelling → blocked
  releaseA();
  await Promise.all([p1, p2]);
  expect(order).toEqual(["a-start", "a-end", "b-start"]);
});

test("createFileLock overlaps different paths", async () => {
  const lock = createFileLock();
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const run = (p: string) =>
    lock(p, async () => {
      active++;
      peak = Math.max(peak, active);
      await barrier;
      active--;
    });
  const all = Promise.all([run("/x"), run("/y")]);
  await new Promise((r) => setTimeout(r, 10));
  expect(peak).toBe(2); // disjoint paths run concurrently
  release();
  await all;
});

test("createFileLock rejects a different agent's CONCURRENT write to one file", async () => {
  const lock = createFileLock();
  let release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  // Agent A claims /shared and holds it open.
  const a = lock("/shared", async () => barrier, "agent-A");
  await new Promise((r) => setTimeout(r, 5));
  // Agent B's concurrent write to the SAME file is hard-rejected.
  await expect(lock("/shared", async () => "B wrote", "agent-B")).rejects.toThrow(
    /being written by another subagent/,
  );
  release();
  await a;
  // Once A is done, the file is free — B can write it now (ownership released).
  await expect(lock("/shared", async () => "ok", "agent-B")).resolves.toBe("ok");
});

test("createFileLock SERIALIZES the same agent's writes to one file (no reject)", async () => {
  const lock = createFileLock();
  const order: number[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  // Same agent issues two parallel writes to one file — they serialize, not fail.
  const first = lock("/f", async () => {
    order.push(1);
    await barrier;
    order.push(2);
  }, "agent-A");
  const second = lock("/f", async () => {
    order.push(3);
  }, "agent-A");
  await new Promise((r) => setTimeout(r, 5));
  expect(order).toEqual([1]); // second waits for first
  release();
  await Promise.all([first, second]);
  expect(order).toEqual([1, 2, 3]); // serialized, both ran
});

test("createFileLock without an owner serializes (backward-compatible)", async () => {
  const lock = createFileLock();
  // No ownerId → legacy serialize behavior, never rejects.
  await expect(
    Promise.all([lock("/g", async () => "1"), lock("/g", async () => "2")]),
  ).resolves.toEqual(["1", "2"]);
});

test("canonicalLockKey folds a new file's leaf case on case-insensitive filesystems", () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-lockkey-"));
  const caseInsensitive = process.platform === "darwin" || process.platform === "win32";
  // Neither file exists yet (the `write`-a-new-file path).
  const newUpper = canonicalLockKey(join(dir, "App.ts"));
  const newLower = canonicalLockKey(join(dir, "app.ts"));
  if (caseInsensitive) {
    // Same on-disk file on a case-insensitive FS → must share a lock key, or two
    // subagents racing to create it bypass the cross-agent write guard.
    expect(newUpper).toBe(newLower);
  } else {
    expect(newUpper).not.toBe(newLower); // distinct files on a case-sensitive FS
  }

  // Now the file EXISTS: the key for the existing file (realpath resolves the real
  // casing) must STILL match the key computed when it didn't exist yet — otherwise
  // a new-file write and a later existing-file write to the same path could race.
  writeFileSync(join(dir, "App.ts"), "x");
  const existing = canonicalLockKey(join(dir, "app.ts"));
  if (caseInsensitive) expect(existing).toBe(newUpper);
});

test("createFileLock rejects a concurrent different-agent write to the same new file (case-insensitive)", async () => {
  // Only meaningful where the FS folds case; assert the guard on those platforms.
  if (process.platform !== "darwin" && process.platform !== "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "vibe-lock-case-"));
  const lock = createFileLock();
  let releaseA!: () => void;
  const aHolds = new Promise<void>((r) => (releaseA = r));
  // Agent A claims src/App.ts and holds it.
  const aRun = lock(join(dir, "App.ts"), () => aHolds, "agentA");
  // Agent B tries to write the same file spelled differently — must be rejected.
  await expect(lock(join(dir, "app.ts"), async () => "b", "agentB")).rejects.toThrow(
    /being written by another/,
  );
  releaseA();
  await aRun;
});

test("a THROWN tool error is normalized into the ERROR contract (not a raw throw)", async () => {
  const throwing: ToolDefinition = {
    name: "boomer",
    description: "throws",
    inputSchema: z.object({}),
    readOnly: true,
    concurrencySafe: true,
    execute: async () => {
      throw new Error("file is owned by another agent");
    },
  };
  const errors: [string, boolean][] = [];
  const aiTool = toAISDKTool(throwing, {
    cwd: "/",
    sessionId: "s",
    emit: () => {},
    recordToolResult: (id, isError) => errors.push([id, isError]),
  });
  const out = await (aiTool as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(
    {},
    { toolCallId: "t1", abortSignal: new AbortController().signal },
  );
  expect(String(out)).toContain("ERROR: boomer threw: file is owned by another agent");
  expect(errors).toEqual([["t1", true]]);
});

test("a read-only NETWORK tool still consults the permission gate (MCP egress governance)", async () => {
  // An MCP tool the server marks readOnlyHint:true is exposed as readOnly:true +
  // network:true. readOnly must NOT short-circuit the gate — a deny/ask rule on
  // its name has to be reachable, and it must consult rules with a fallback allow.
  const calls: string[] = [];
  const netTool: ToolDefinition = {
    name: "mcp__web__fetch",
    description: "network fetch",
    inputSchema: z.object({}),
    readOnly: true,
    network: true,
    concurrencySafe: true,
    execute: async () => {
      calls.push("ran");
      return { output: "fetched" };
    },
  };
  const seen: { name: string; fallback?: string }[] = [];
  const denied = await (
    toAISDKTool(netTool, {
      cwd: "/",
      sessionId: "s",
      emit: () => {},
      checkPermission: (name, _input, opts) => {
        seen.push({ name, fallback: opts?.fallback });
        return { allowed: false, reason: "policy" }; // a deny rule fires
      },
    }) as { execute: (i: unknown, o: unknown) => Promise<unknown> }
  ).execute({}, { toolCallId: "t1", abortSignal: new AbortController().signal });

  // The gate WAS consulted (not bypassed by readOnly), with the frictionless
  // allow-fallback for a read-only network tool — and the deny took effect.
  expect(seen).toEqual([{ name: "mcp__web__fetch", fallback: "allow" }]);
  expect(String(denied)).toContain("not permitted");
  expect(calls).toHaveLength(0); // never executed
});

test("an abort-driven throw still propagates (cancellation is not a tool failure)", async () => {
  const controller = new AbortController();
  const aborter: ToolDefinition = {
    name: "aborter",
    description: "aborts",
    inputSchema: z.object({}),
    readOnly: true,
    concurrencySafe: true,
    execute: async () => {
      controller.abort();
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    },
  };
  const aiTool = toAISDKTool(aborter, { cwd: "/", sessionId: "s", emit: () => {} });
  await expect(
    (aiTool as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(
      {},
      { toolCallId: "t1", abortSignal: controller.signal },
    ),
  ).rejects.toThrow("aborted");
});
