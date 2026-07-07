// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the expandServerConfig tests assert literal ${VAR} syntax
import { expect, test } from "bun:test";
import type { McpServer } from "@vibe/config";
import type { ToolDefinition } from "@vibe/shared";
import {
  expandServerConfig,
  MCP_MAX_OUTPUT,
  type McpClient,
  McpHub,
  mcpToolName,
  renderContent,
  toToolDefinition,
} from "./mcp.ts";

/** A fake MCP server exposing one echo tool. */
function fakeClient(calls: { name: string; args: unknown }[]): McpClient {
  return {
    async listTools() {
      return [
        {
          name: "echo",
          description: "Echo back",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      ];
    },
    async callTool(name, args) {
      calls.push({ name, args });
      return { content: [{ type: "text", text: `echo: ${(args as { text: string }).text}` }] };
    },
    async close() {},
  };
}

/** A minimal ToolContext for driving a tool's execute() directly. */
function ctx(signal: AbortSignal = new AbortController().signal) {
  return {
    cwd: "/",
    sessionId: "s",
    toolCallId: "t",
    emit: () => {},
    abortSignal: signal,
  } as never;
}

test("hub registers MCP tools as gated mcp__<server>__<tool> definitions", async () => {
  const registered: ToolDefinition[] = [];
  const hub = new McpHub({
    registerTool: (def) => registered.push(def),
    connect: async () => fakeClient([]),
  });
  await hub.start({ demo: { command: "irrelevant" } });

  expect(registered).toHaveLength(1);
  const tool = registered[0]!;
  expect(tool.name).toBe("mcp__demo__echo");
  expect(tool.readOnly).toBe(false); // side-effecting → permission-gated, execute-only
  expect(tool.inputSchema).toMatchObject({ type: "object" });
});

test("mcpToolName sanitizes disallowed chars and caps length for hosted providers", () => {
  const NAME = /^[A-Za-z0-9_-]+$/;
  // Clean names pass through unchanged.
  expect(mcpToolName("demo", "echo")).toBe("mcp__demo__echo");
  // Dots (and other illegal chars) become underscores.
  expect(mcpToolName("gh", "github.search")).toBe("mcp__gh__github_search");
  expect(mcpToolName("a b", "x/y:z")).toBe("mcp__a_b__x_y_z");
  // Over-long names are truncated to ≤64 chars but stay unique + valid.
  const long = mcpToolName("server", "a".repeat(120));
  expect(long.length).toBeLessThanOrEqual(64);
  expect(long).toMatch(NAME);
  const longB = mcpToolName("server", `${"a".repeat(119)}b`);
  expect(longB).not.toBe(long); // different source → different hash suffix
  for (const n of [mcpToolName("gh", "github.search"), long]) expect(n).toMatch(NAME);
});

test("two real tool names that sanitize to the same exposed name both stay callable", async () => {
  const reg = registry();
  const client: McpClient = {
    // `db.get` and `db/get` both sanitize to `mcp__srv__db_get` — a collision.
    listTools: async () => [{ name: "db.get" }, { name: "db/get" }],
    callTool: async () => ({ content: "ok" }),
    close: async () => {},
  };
  const hub = new McpHub({ ...reg, connect: async () => client });
  await hub.start({ srv: { command: "x" } });
  const names = reg.names();
  // Both tools are registered under DISTINCT exposed names (no silent overwrite).
  expect(names).toHaveLength(2);
  expect(new Set(names).size).toBe(2);
  expect(names).toContain("mcp__srv__db_get"); // the first keeps the readable name
  expect(names.every((n) => /^[A-Za-z0-9_-]+$/.test(n) && n.length <= 64)).toBe(true);
  await hub.close();
});

test("a sanitized MCP tool still calls the server with its real name", async () => {
  const calls: { name: string; args: unknown }[] = [];
  const client: McpClient = {
    listTools: async () => [{ name: "github.search" }],
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { content: "ok", isError: false };
    },
    close: async () => {},
  };
  const def = toToolDefinition("gh", (await client.listTools())[0]!, client);
  expect(def.name).toBe("mcp__gh__github_search"); // sanitized for the model
  await def.execute({ q: "x" }, {} as never);
  expect(calls).toEqual([{ name: "github.search", args: { q: "x" } }]); // real name to server
});

test("an adapted tool calls through to the MCP client and renders text", async () => {
  const calls: { name: string; args: unknown }[] = [];
  const client = fakeClient(calls);
  const def = toToolDefinition("demo", (await client.listTools())[0]!, client);

  const res = await def.execute({ text: "hi" }, {} as never);
  expect(calls).toEqual([{ name: "echo", args: { text: "hi" } }]);
  expect(res.output).toBe("echo: hi");
});

test("a server that fails to connect is skipped, not fatal", async () => {
  const registered: ToolDefinition[] = [];
  const hub = new McpHub({
    registerTool: (def) => registered.push(def),
    connect: async (name) => {
      if (name === "bad") throw new Error("boom");
      return fakeClient([]);
    },
  });
  await hub.start({ bad: { command: "x" }, good: { command: "y" } });
  expect(registered.map((t) => t.name)).toEqual(["mcp__good__echo"]);
});

test("renderContent flattens text parts and falls back to JSON", () => {
  expect(
    renderContent([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]),
  ).toBe("a\nb");
  expect(renderContent("plain")).toBe("plain");
  expect(renderContent([{ type: "image", data: "x" }])).toContain("image");
});

test("renderContent omits base64 image/blob payloads (no transcript flooding)", () => {
  const bigB64 = "A".repeat(100_000); // ~75KB of base64
  const out = renderContent([{ type: "image", mimeType: "image/png", data: bigB64 }]);
  expect(out).not.toContain(bigB64);
  expect(out).toContain("image/png");
  expect(out).toMatch(/omitted/);
  // Embedded resource blobs are summarized; resource text is passed through.
  expect(renderContent([{ type: "resource", resource: { uri: "x://y", blob: "QUJD" } }])).toMatch(
    /omitted/,
  );
  expect(renderContent([{ type: "resource", resource: { uri: "x://y", text: "hello" } }])).toBe(
    "hello",
  );
});

test("readOnlyHint maps to a read-only (un-gated) tool", async () => {
  const ro: McpClient = {
    listTools: async () => [
      { name: "search", annotations: { readOnlyHint: true } },
      { name: "write", annotations: { readOnlyHint: false } },
      { name: "plain" },
    ],
    callTool: async () => ({ content: "ok" }),
    close: async () => {},
  };
  const specs = await ro.listTools();
  expect(toToolDefinition("s", specs[0]!, ro).readOnly).toBe(true);
  expect(toToolDefinition("s", specs[1]!, ro).readOnly).toBe(false);
  expect(toToolDefinition("s", specs[2]!, ro).readOnly).toBe(false); // default conservative
});

test("a slow server is bounded by the connect timeout, not blocking others", async () => {
  const registered: ToolDefinition[] = [];
  const hub = new McpHub({
    registerTool: (def) => registered.push(def),
    connectTimeoutMs: 50,
    connect: async (name) => {
      if (name === "slow") {
        // Never resolves within the deadline.
        await new Promise((r) => setTimeout(r, 10_000));
      }
      return fakeClient([]);
    },
  });
  const t0 = performance.now();
  await hub.start({ slow: { command: "x" }, fast: { command: "y" } });
  const elapsed = performance.now() - t0;

  // The fast server's tool registered; the slow one timed out without blocking.
  expect(registered.map((t) => t.name)).toEqual(["mcp__fast__echo"]);
  expect(elapsed).toBeLessThan(5_000);
  const status = hub.status();
  expect(status.find((s) => s.name === "slow")?.connected).toBe(false);
  expect(status.find((s) => s.name === "fast")?.connected).toBe(true);
});

test("registers read_mcp_resource + get_mcp_prompt and they list/read/render", async () => {
  const registered: ToolDefinition[] = [];
  const client: McpClient = {
    listTools: async () => [{ name: "echo" }],
    callTool: async () => ({ content: "ok" }),
    listResources: async () => [
      {
        uri: "file:///readme.md",
        name: "Readme",
        description: "project readme",
        mimeType: "text/markdown",
      },
    ],
    readResource: async (uri) => ({ content: [{ type: "text", text: `contents of ${uri}` }] }),
    listPrompts: async () => [
      {
        name: "summarize",
        description: "summarize a file",
        arguments: [{ name: "path", required: true }],
      },
    ],
    getPrompt: async (name, args) => ({
      content: [{ type: "text", text: `prompt ${name} for ${JSON.stringify(args)}` }],
    }),
    close: async () => {},
  };
  const hub = new McpHub({ registerTool: (d) => registered.push(d), connect: async () => client });
  await hub.start({ demo: { command: "x" } });

  const names = registered.map((t) => t.name);
  expect(names).toContain("read_mcp_resource");
  expect(names).toContain("get_mcp_prompt");

  const readTool = registered.find((t) => t.name === "read_mcp_resource")!;
  expect(String((await readTool.execute({}, {} as never)).output)).toContain("file:///readme.md");
  expect(
    String((await readTool.execute({ uri: "file:///readme.md" }, {} as never)).output),
  ).toContain("contents of file:///readme.md");

  const promptTool = registered.find((t) => t.name === "get_mcp_prompt")!;
  expect(String((await promptTool.execute({}, {} as never)).output)).toContain("summarize");
  expect(
    String(
      (
        await promptTool.execute(
          { server: "demo", name: "summarize", args: { path: "a.ts" } },
          {} as never,
        )
      ).output,
    ),
  ).toContain("prompt summarize");

  expect(hub.resources()).toHaveLength(1);
  expect(hub.prompts()[0]!.server).toBe("demo");
});

test("read_mcp_resource requires server when a URI is exposed by multiple servers", async () => {
  const registered: ToolDefinition[] = [];
  const client = (label: string): McpClient => ({
    listTools: async () => [],
    callTool: async () => ({ content: "ok" }),
    listResources: async () => [{ uri: "file:///shared.md", name: "Shared" }],
    readResource: async (uri) => ({ content: [{ type: "text", text: `${label}: ${uri}` }] }),
    close: async () => {},
  });
  const hub = new McpHub({
    registerTool: (d) => registered.push(d),
    connect: async (name) => client(name),
  });
  await hub.start({ alpha: { command: "x" }, beta: { command: "y" } });
  const readTool = registered.find((t) => t.name === "read_mcp_resource")!;

  const ambiguous = await readTool.execute({ uri: "file:///shared.md" }, {} as never);
  expect(ambiguous.isError).toBe(true);
  expect(ambiguous.output).toContain("multiple servers (alpha, beta)");

  const scoped = await readTool.execute({ uri: "file:///shared.md", server: "beta" }, {} as never);
  expect(scoped.output).toContain("beta: file:///shared.md");
});

test("a server without resources/prompts capability degrades cleanly", async () => {
  const registered: ToolDefinition[] = [];
  const client: McpClient = {
    listTools: async () => [{ name: "echo" }],
    callTool: async () => ({ content: "ok" }),
    listResources: async () => {
      throw new Error("Method not found");
    },
    close: async () => {},
  };
  const hub = new McpHub({ registerTool: (d) => registered.push(d), connect: async () => client });
  await hub.start({ demo: { command: "x" } });
  expect(registered.map((t) => t.name)).toEqual(["mcp__demo__echo"]);
  expect(hub.resources()).toEqual([]);
});

/** A register/unregister sink that tracks the live tool set by name. */
function registry() {
  const tools = new Map<string, ToolDefinition>();
  return {
    registerTool: (d: ToolDefinition) => void tools.set(d.name, d),
    unregisterTool: (n: string) => void tools.delete(n),
    names: () => [...tools.keys()].sort(),
  };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("a disabled server is not connected", async () => {
  let connectCalls = 0;
  const reg = registry();
  const hub = new McpHub({
    ...reg,
    connect: async () => {
      connectCalls++;
      return fakeClient([]);
    },
  });
  await hub.start({ on: { command: "x" }, off: { command: "y", enabled: false } });
  expect(connectCalls).toBe(1);
  expect(reg.names()).toEqual(["mcp__on__echo"]);
  expect(hub.status().map((s) => s.name)).toEqual(["on"]); // disabled server omitted
});

test("close unregisters server and aggregate MCP tools", async () => {
  const reg = registry();
  const client: McpClient = {
    listTools: async () => [{ name: "echo" }],
    listResources: async () => [{ uri: "file://x", name: "X" }],
    listPrompts: async () => [{ name: "summarize" }],
    callTool: async () => ({ content: "ok" }),
    close: async () => {},
  };
  const hub = new McpHub({ ...reg, connect: async () => client });
  await hub.start({ demo: { command: "x" } });
  expect(reg.names()).toEqual(["get_mcp_prompt", "mcp__demo__echo", "read_mcp_resource"]);

  await hub.close();
  expect(reg.names()).toEqual([]);
});

test("tools/list_changed re-lists and swaps the server's registered tools", async () => {
  let toolSet: { name: string }[] = [{ name: "a" }];
  let fire: (() => void) | undefined;
  const client: McpClient = {
    listTools: async () => toolSet,
    callTool: async () => ({ content: "ok" }),
    onListChanged: (cb) => {
      fire = cb;
    },
    close: async () => {},
  };
  const reg = registry();
  const hub = new McpHub({ ...reg, connect: async () => client });
  await hub.start({ demo: { command: "x" } });
  expect(reg.names()).toEqual(["mcp__demo__a"]);

  // Server gains a tool → re-list registers it.
  toolSet = [{ name: "a" }, { name: "b" }];
  fire!();
  await tick();
  expect(reg.names()).toEqual(["mcp__demo__a", "mcp__demo__b"]);

  // Server drops a tool → re-list unregisters the stale one.
  toolSet = [{ name: "b" }];
  fire!();
  await tick();
  expect(reg.names()).toEqual(["mcp__demo__b"]);
});

test("a burst of list_changed notifications coalesces to one in-flight re-list + one trailing rerun", async () => {
  // A chatty/malicious server spamming tools/list_changed used to fan out into
  // one concurrent listTools() per notification (unbounded concurrency + churn).
  // The coalescer collapses a burst into a single in-flight re-list plus one
  // trailing rerun.
  let listCalls = 0;
  let releaseFirst: (() => void) | undefined;
  let fire: (() => void) | undefined;
  const client: McpClient = {
    listTools: async () => {
      listCalls += 1;
      // Let the initial start() list (call 1) complete; hold the first RE-LIST
      // (call 2) open so the notification burst lands while it runs.
      if (listCalls === 2) {
        await new Promise<void>((r) => {
          releaseFirst = r;
        });
      }
      return [{ name: "a" }];
    },
    callTool: async () => ({ content: "ok" }),
    onListChanged: (cb) => {
      fire = cb;
    },
    close: async () => {},
  };
  const reg = registry();
  const hub = new McpHub({ ...reg, connect: async () => client });
  await hub.start({ demo: { command: "x" } });
  await tick();
  expect(listCalls).toBe(1); // initial enumeration only
  // Storm: the first fire starts re-list #2 (which blocks); the rest coalesce.
  fire!();
  fire!();
  fire!();
  fire!();
  await tick();
  expect(listCalls).toBe(2); // one in-flight re-list, burst collapsed into a rerun
  releaseFirst?.();
  await tick(5);
  // Exactly ONE trailing rerun ran after the in-flight one completed (not four).
  expect(listCalls).toBe(3);
});

test("reconnects with backoff after the transport drops, re-registering tools", async () => {
  let dials = 0;
  let closeCb: (() => void) | undefined;
  const makeClient = (): McpClient => ({
    listTools: async () => [{ name: "echo" }],
    callTool: async () => ({ content: "ok" }),
    onClose: (cb) => {
      closeCb = cb;
    },
    close: async () => {},
  });
  const reg = registry();
  const hub = new McpHub({
    ...reg,
    reconnect: { baseDelayMs: 3, maxAttempts: 5 },
    connect: async () => {
      dials++;
      if (dials === 2) throw new Error("still down"); // first reconnect dial fails
      return makeClient();
    },
  });
  await hub.start({ demo: { command: "x" } });
  expect(reg.names()).toEqual(["mcp__demo__echo"]);

  closeCb!(); // transport drops
  await tick(); // let the reconnect loop start + unregister stale tools
  expect(reg.names()).toEqual([]); // dropped tools pulled immediately
  expect(hub.status()[0]!.connected).toBe(false);

  await tick(80); // backoff: dial 2 fails, dial 3 succeeds
  expect(dials).toBe(3);
  expect(reg.names()).toEqual(["mcp__demo__echo"]); // re-registered on reconnect
  expect(hub.status()[0]!.connected).toBe(true);
  await hub.close();
});

test("a reconnect that resolves after close() closes the new transport (no leak)", async () => {
  let closeCb: (() => void) | undefined;
  let closed = 0;
  let releaseDial!: () => void;
  const dialGate = new Promise<void>((r) => (releaseDial = r));
  let dials = 0;
  const reg = registry();
  const hub = new McpHub({
    ...reg,
    reconnect: { baseDelayMs: 1, maxAttempts: 5 },
    connect: async () => {
      dials++;
      if (dials === 2) await dialGate; // hold the RECONNECT dial mid-flight
      return {
        listTools: async () => [{ name: "echo" }],
        callTool: async () => ({ content: "ok" }),
        onClose: (cb) => {
          closeCb = cb;
        },
        close: async () => {
          closed++;
        },
      };
    },
  });
  await hub.start({ demo: { command: "x" } });

  closeCb!(); // transport drops → schedules a reconnect that will block on dialGate
  await tick(10); // let the reconnect loop reach the awaited dial
  const closedBefore = closed;

  await hub.close(); // shut down WHILE the reconnect dial is in flight
  releaseDial(); // the dial now resolves — its client must be torn down, not leaked
  await tick(10);

  // The freshly (re)connected transport got closed rather than left dangling.
  expect(closed).toBe(closedBefore + 1);
  // And it was never registered after shutdown.
  expect(reg.names()).toEqual([]);
});

test("a server that first exposes resources on RECONNECT gets read_mcp_resource registered", async () => {
  let dials = 0;
  let closeCb: (() => void) | undefined;
  const reg = registry();
  const hub = new McpHub({
    ...reg,
    reconnect: { baseDelayMs: 1, maxAttempts: 5 },
    connect: async () => {
      dials++;
      const hasResources = dials >= 2; // resources appear only on the reconnect
      return {
        listTools: async () => [{ name: "echo" }],
        callTool: async () => ({ content: "ok" }),
        listResources: async () => (hasResources ? [{ uri: "file:///readme" }] : []),
        readResource: async () => ({ content: "hi" }),
        onClose: (cb) => {
          closeCb = cb;
        },
        close: async () => {},
      };
    },
  });
  await hub.start({ demo: { command: "x" } });
  // No resources at boot → the aggregate tool isn't registered yet.
  expect(reg.names()).not.toContain("read_mcp_resource");

  closeCb!(); // transport drops → reconnect (dial 2 now advertises a resource)
  await tick(60);
  expect(dials).toBeGreaterThanOrEqual(2);
  // The aggregate resource tool is now registered, so the model can actually read them.
  expect(reg.names()).toContain("read_mcp_resource");
  await hub.close();
});

test("a per-server timeout overrides the hub default", async () => {
  const reg = registry();
  const hub = new McpHub({
    ...reg,
    connectTimeoutMs: 10_000, // hub default is generous
    connect: async (name) => {
      if (name === "slow") await new Promise((r) => setTimeout(r, 5_000));
      return fakeClient([]);
    },
  });
  const t0 = performance.now();
  // The server's own 30ms timeout fires long before the hub default.
  await hub.start({ slow: { command: "x", timeoutMs: 30 } });
  expect(performance.now() - t0).toBeLessThan(2_000);
  expect(hub.status()[0]!.connected).toBe(false);
});

test("status reflects a transport that dropped after connecting", async () => {
  let live = true;
  const client: McpClient = {
    listTools: async () => [{ name: "echo" }],
    callTool: async () => ({ content: "ok" }),
    isConnected: () => live,
    close: async () => {},
  };
  const hub = new McpHub({ registerTool: () => {}, connect: async () => client });
  await hub.start({ demo: { command: "x" } });
  expect(hub.status()[0]!.connected).toBe(true);
  live = false; // the transport drops mid-session
  expect(hub.status()[0]!.connected).toBe(false);
  expect(hub.status()[0]!.toolCount).toBe(1);
});

test("renderContent renders resources/read contents (no `type` field) — text and blob", () => {
  // The real transport's resources/read returns bare `{uri, mimeType, text|blob}`
  // items with NO `type` discriminator (unlike tool-call content parts).
  expect(renderContent([{ uri: "file:///a.md", mimeType: "text/markdown", text: "# hello" }])).toBe(
    "# hello",
  );
  const bigB64 = "A".repeat(80_000);
  const blobOut = renderContent([{ uri: "file:///img.png", mimeType: "image/png", blob: bigB64 }]);
  expect(blobOut).not.toContain(bigB64); // raw base64 is NOT dumped into the prompt
  expect(blobOut).toContain("image/png");
  expect(blobOut).toMatch(/omitted/);
  expect(blobOut).toContain("file:///img.png");
});

test("read_mcp_resource renders a text resource's contents (real transport shape)", async () => {
  const registered: ToolDefinition[] = [];
  const client: McpClient = {
    listTools: async () => [{ name: "echo" }],
    callTool: async () => ({ content: "ok" }),
    listResources: async () => [{ uri: "file:///readme.md", mimeType: "text/markdown" }],
    // The SDK returns bare content items with no `type` — text must pass through
    // verbatim, not be JSON-stringified.
    readResource: async (uri) => ({
      content: [{ uri, mimeType: "text/markdown", text: "project readme body" }],
    }),
    close: async () => {},
  };
  const hub = new McpHub({ registerTool: (d) => registered.push(d), connect: async () => client });
  await hub.start({ demo: { command: "x" } });
  const readTool = registered.find((t) => t.name === "read_mcp_resource")!;
  const out = String((await readTool.execute({ uri: "file:///readme.md" }, ctx())).output);
  expect(out).toBe("project readme body"); // not `{"uri":...,"text":...}`
});

test("MCP tool-call output is capped like a built-in (no unbounded blob into context)", async () => {
  const huge = "x".repeat(MCP_MAX_OUTPUT * 2);
  const client: McpClient = {
    listTools: async () => [{ name: "dump" }],
    callTool: async () => ({ content: [{ type: "text", text: huge }] }),
    close: async () => {},
  };
  const def = toToolDefinition("srv", { name: "dump" }, client);
  const out = String((await def.execute({}, ctx())).output);
  expect(out.length).toBeLessThan(huge.length); // truncated
  expect(out.length).toBeLessThanOrEqual(MCP_MAX_OUTPUT + 64); // ≤ cap + marker
  expect(out).toMatch(/chars omitted/);
});

test("every MCP tool is flagged network:true so the permission gate governs egress", async () => {
  // A server-declared readOnlyHint must NOT short-circuit the gate — the tool
  // still reaches an external server (egress). network:true keeps the gate live.
  const ro = toToolDefinition(
    "s",
    { name: "fetch", annotations: { readOnlyHint: true } },
    {} as McpClient,
  );
  expect(ro.readOnly).toBe(true);
  expect(ro.network).toBe(true);
  const rw = toToolDefinition("s", { name: "write" }, {} as McpClient);
  expect(rw.readOnly).toBe(false);
  expect(rw.network).toBe(true);
});

test("the aggregate read_mcp_resource / get_mcp_prompt tools are network:true so the gate governs them", async () => {
  // Both reach an external server (egress). readOnly:true alone would let the
  // toolset gate `(!def.readOnly || def.network)` short-circuit — a deny/ask rule
  // on read_mcp_resource / get_mcp_prompt could never fire. network:true keeps the
  // gate live while preserving the read-only, plan-mode-friendly default.
  const registered: ToolDefinition[] = [];
  const client: McpClient = {
    listTools: async () => [{ name: "echo" }],
    callTool: async () => ({ content: "ok" }),
    listResources: async () => [{ uri: "file:///r" }],
    readResource: async () => ({ content: "hi" }),
    listPrompts: async () => [{ name: "p" }],
    getPrompt: async () => ({ content: "rendered" }),
    close: async () => {},
  };
  const hub = new McpHub({ registerTool: (d) => registered.push(d), connect: async () => client });
  await hub.start({ demo: { command: "x" } });
  const readTool = registered.find((t) => t.name === "read_mcp_resource")!;
  const promptTool = registered.find((t) => t.name === "get_mcp_prompt")!;
  expect(readTool.readOnly).toBe(true);
  expect(readTool.network).toBe(true);
  expect(promptTool.readOnly).toBe(true);
  expect(promptTool.network).toBe(true);
});

test("resources/list_changed refreshes the aggregate resource list without a reconnect", async () => {
  let resources: { uri: string }[] = [];
  let fire: (() => void) | undefined;
  const client: McpClient = {
    listTools: async () => [{ name: "echo" }],
    callTool: async () => ({ content: "ok" }),
    listResources: async () => resources,
    readResource: async () => ({ content: "hi" }),
    onResourcesChanged: (cb) => {
      fire = cb;
    },
    close: async () => {},
  };
  const reg = registry();
  const hub = new McpHub({ ...reg, connect: async () => client });
  await hub.start({ demo: { command: "x" } });
  // No resources at boot → aggregate tool not registered, hub sees none.
  expect(reg.names()).not.toContain("read_mcp_resource");
  expect(hub.resources()).toEqual([]);

  // Server advertises a resource and fires the notification (no reconnect).
  resources = [{ uri: "file:///readme" }];
  fire!();
  await tick();
  expect(hub.resources().map((r) => r.uri)).toEqual(["file:///readme"]);
  expect(reg.names()).toContain("read_mcp_resource"); // aggregate tool now live
  await hub.close();
});

test("prompts/list_changed refreshes the aggregate prompt list without a reconnect", async () => {
  let prompts: { name: string }[] = [];
  let fire: (() => void) | undefined;
  const client: McpClient = {
    listTools: async () => [{ name: "echo" }],
    callTool: async () => ({ content: "ok" }),
    listPrompts: async () => prompts,
    getPrompt: async () => ({ content: "rendered" }),
    onPromptsChanged: (cb) => {
      fire = cb;
    },
    close: async () => {},
  };
  const reg = registry();
  const hub = new McpHub({ ...reg, connect: async () => client });
  await hub.start({ demo: { command: "x" } });
  expect(reg.names()).not.toContain("get_mcp_prompt");
  expect(hub.prompts()).toEqual([]);

  prompts = [{ name: "summarize" }];
  fire!();
  await tick();
  expect(hub.prompts().map((p) => p.name)).toEqual(["summarize"]);
  expect(reg.names()).toContain("get_mcp_prompt");
  await hub.close();
});

test("expandServerConfig resolves ${VAR}, ${VAR:-default}, warns on unresolved, leaves bare $ alone", () => {
  process.env.MCP_TEST_TOKEN = "sekret";
  delete process.env.MCP_TEST_MISSING;
  // Remote server: url + headers expand from the env; a :-default fills an absent var.
  const unresolved = new Set<string>();
  const remote = expandServerConfig(
    {
      url: "https://${MCP_TEST_HOST:-api.example.com}/mcp",
      headers: { Authorization: "Bearer ${MCP_TEST_TOKEN}", "X-Env": "${MCP_TEST_ENV:-prod}" },
    } as McpServer,
    unresolved,
  ) as { url: string; headers: Record<string, string> };
  expect(remote.url).toBe("https://api.example.com/mcp"); // :-default applied
  expect(remote.headers.Authorization).toBe("Bearer sekret"); // env resolved
  expect(remote.headers["X-Env"]).toBe("prod");
  expect(unresolved.size).toBe(0);

  // stdio server: command/args/env expand; an unresolved (no-default) var is left
  // LITERAL (not emptied) and its name collected so the hub can warn.
  const unresolved2 = new Set<string>();
  const stdio = expandServerConfig(
    {
      command: "${MCP_TEST_BIN:-node}",
      args: ["--token", "${MCP_TEST_TOKEN}", "--x", "$HOME/lit"],
      env: { KEY: "${MCP_TEST_MISSING}", RAW: "no-braces-$here" },
    } as McpServer,
    unresolved2,
  ) as { command: string; args: string[]; env: Record<string, string> };
  expect(stdio.command).toBe("node");
  expect(stdio.args).toEqual(["--token", "sekret", "--x", "$HOME/lit"]); // bare $ untouched
  expect(stdio.env.KEY).toBe("${MCP_TEST_MISSING}"); // unresolved → left literal, NOT empty
  expect(stdio.env.RAW).toBe("no-braces-$here"); // bare $ untouched
  expect([...unresolved2]).toEqual(["MCP_TEST_MISSING"]);
  delete process.env.MCP_TEST_TOKEN;
});

test("read_mcp_resource / get_mcp_prompt thread the abort signal and per-call deadline", async () => {
  let readOpts: { signal?: AbortSignal; timeoutMs?: number } | undefined;
  let promptOpts: { signal?: AbortSignal; timeoutMs?: number } | undefined;
  const client: McpClient = {
    listTools: async () => [{ name: "echo" }],
    callTool: async () => ({ content: "ok" }),
    listResources: async () => [{ uri: "file:///r" }],
    readResource: async (_uri, opts) => {
      readOpts = opts;
      return { content: "hi" };
    },
    listPrompts: async () => [{ name: "p" }],
    getPrompt: async (_name, _args, opts) => {
      promptOpts = opts;
      return { content: "rendered" };
    },
    close: async () => {},
  };
  const registered: ToolDefinition[] = [];
  const hub = new McpHub({ registerTool: (d) => registered.push(d), connect: async () => client });
  await hub.start({ demo: { command: "x" } });
  const controller = new AbortController();
  const readTool = registered.find((t) => t.name === "read_mcp_resource")!;
  await readTool.execute({ uri: "file:///r" }, ctx(controller.signal));
  expect(readOpts?.signal).toBe(controller.signal);
  expect(readOpts?.timeoutMs).toBeGreaterThan(0);
  const promptTool = registered.find((t) => t.name === "get_mcp_prompt")!;
  await promptTool.execute({ server: "demo", name: "p" }, ctx(controller.signal));
  expect(promptOpts?.signal).toBe(controller.signal);
  expect(promptOpts?.timeoutMs).toBeGreaterThan(0);
});

test("a server that STALLS on resources/list can't block boot past the connect deadline", async () => {
  const reg = registry();
  const client: McpClient = {
    listTools: async () => [{ name: "echo" }],
    callTool: async () => ({ content: "ok" }),
    // Answers tools/list fast but hangs forever on resources/list.
    listResources: () => new Promise<never>(() => {}),
    close: async () => {},
  };
  const hub = new McpHub({ ...reg, connectTimeoutMs: 50, connect: async () => client });
  const t0 = performance.now();
  await hub.start({ demo: { command: "x" } });
  const elapsed = performance.now() - t0;
  expect(elapsed).toBeLessThan(2_000); // bounded by the 50ms deadline, not the hang
  expect(reg.names()).toEqual(["mcp__demo__echo"]); // the fast tools still registered
  expect(hub.resources()).toEqual([]); // the hung enumeration degraded to none
});

test("two SERVERS whose keys sanitize to the same string keep both tools callable", async () => {
  const reg = registry();
  // `gh.prod` and `gh_prod` both sanitize to `gh_prod` → same `mcp__gh_prod__echo`.
  const hub = new McpHub({ ...reg, connect: async () => fakeClient([]) });
  await hub.start({ "gh.prod": { command: "x" }, gh_prod: { command: "y" } });
  const names = reg.names();
  expect(names).toHaveLength(2); // no silent overwrite across servers
  expect(new Set(names).size).toBe(2);
  expect(names).toContain("mcp__gh_prod__echo"); // the first keeps the readable name
  expect(names.every((n) => /^[A-Za-z0-9_-]+$/.test(n) && n.length <= 64)).toBe(true);
  await hub.close();
});

test("MCP tool calls thread the turn's abort signal and a per-call deadline", async () => {
  let seenOpts: { signal?: AbortSignal; timeoutMs?: number } | undefined;
  const client: McpClient = {
    listTools: async () => [{ name: "slow_tool" }],
    callTool: async (_name, _args, opts) => {
      seenOpts = opts;
      return { content: [{ type: "text", text: "ok" }] };
    },
    close: async () => {},
  };
  const def = toToolDefinition("srv", { name: "slow_tool" }, client);
  const controller = new AbortController();
  await def.execute(
    {},
    {
      cwd: "/",
      sessionId: "s",
      toolCallId: "t",
      emit: () => {},
      abortSignal: controller.signal,
    },
  );
  expect(seenOpts?.signal).toBe(controller.signal);
  expect(seenOpts?.timeoutMs).toBeGreaterThan(0);
});

test("close() during start() closes the freshly-connected client and does not repopulate entries", async () => {
  let clientClosed = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const registered: ToolDefinition[] = [];
  const hub = new McpHub({
    registerTool: (def) => registered.push(def),
    connect: async () => {
      await gate; // block the connect until we've called close()
      return {
        listTools: async () => [{ name: "echo" }],
        callTool: async () => ({ content: "ok" }),
        close: async () => {
          clientClosed = true;
        },
      } as unknown as McpClient;
    },
  });
  const startP = hub.start({ demo: { command: "x" } });
  await hub.close(); // teardown while the connect is still in flight
  release(); // now the connect resolves and start() resumes
  await startP;

  // The late-connecting client is closed (no orphan transport) and start() bailed
  // without registering tools or repopulating entries after teardown.
  expect(clientClosed).toBe(true);
  expect(registered.length).toBe(0);
  expect(hub.status().length).toBe(0);
});
