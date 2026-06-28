import {
  createLogger,
  type JsonSchema,
  type Logger,
  type ToolDefinition,
} from "@vibe/shared";
import type { McpServer } from "@vibe/config";

/** A connected MCP server, reduced to what the hub needs. */
export interface McpClient {
  listTools(): Promise<
    { name: string; description?: string; inputSchema?: JsonSchema }[]
  >;
  callTool(
    name: string,
    args: unknown,
  ): Promise<{ content: unknown; isError?: boolean }>;
  close(): Promise<void>;
}

/** Connects to an MCP server (injectable so the hub is testable offline). */
export type McpConnect = (name: string, config: McpServer) => Promise<McpClient>;

export interface McpHubDeps {
  registerTool: (def: ToolDefinition) => void;
  connect?: McpConnect;
  logger?: Logger;
}

/**
 * Connects configured MCP servers and registers each server tool as a
 * `mcp__<server>__<tool>` ToolDefinition, so they flow through the normal
 * mode/permission gate (treated as side-effecting). Connection or per-tool
 * failures are logged and skipped — never fatal.
 */
/** Connection outcome for one configured MCP server (for `/mcp`). */
export interface McpServerStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

export class McpHub {
  #deps: McpHubDeps;
  #connect: McpConnect;
  #log: Logger;
  #clients: McpClient[] = [];
  #status: McpServerStatus[] = [];

  constructor(deps: McpHubDeps) {
    this.#deps = deps;
    this.#connect = deps.connect ?? defaultConnect;
    this.#log = deps.logger ?? createLogger("mcp");
  }

  /** Connect every server and register its tools. Safe to call once at boot. */
  async start(servers: Record<string, McpServer>): Promise<void> {
    for (const [name, config] of Object.entries(servers)) {
      try {
        const client = await this.#connect(name, config);
        this.#clients.push(client);
        const tools = await client.listTools();
        for (const spec of tools) {
          this.#deps.registerTool(toToolDefinition(name, spec, client));
        }
        this.#status.push({ name, connected: true, toolCount: tools.length });
        this.#log.info(`connected MCP server "${name}" (${tools.length} tools)`);
      } catch (err) {
        const message = (err as Error).message;
        this.#status.push({ name, connected: false, toolCount: 0, error: message });
        this.#log.error(`MCP server "${name}" failed: ${message}`);
      }
    }
  }

  /** Connection status for every configured server (for `/mcp`). */
  status(): McpServerStatus[] {
    return this.#status.map((s) => ({ ...s }));
  }

  /** Close all connected clients. */
  async close(): Promise<void> {
    await Promise.all(
      this.#clients.map((c) => c.close().catch(() => undefined)),
    );
    this.#clients = [];
  }
}

/** Adapt one MCP tool spec into a gated ToolDefinition bound to its client. */
export function toToolDefinition(
  server: string,
  spec: { name: string; description?: string; inputSchema?: JsonSchema },
  client: McpClient,
): ToolDefinition {
  return {
    name: `mcp__${server}__${spec.name}`,
    description: spec.description ?? `MCP tool "${spec.name}" from "${server}".`,
    inputSchema: spec.inputSchema ?? { type: "object", properties: {} },
    readOnly: false,
    execute: async (args) => {
      const res = await client.callTool(spec.name, args);
      return { output: renderContent(res.content), isError: res.isError };
    },
  };
}

/** Flatten MCP tool-result content into text the model can read. */
export function renderContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content.map((p) => {
      const part = p as { type?: string; text?: string };
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      return JSON.stringify(p);
    });
    return parts.join("\n");
  }
  return JSON.stringify(content ?? "");
}

/**
 * Default transport: lazily import the official `@modelcontextprotocol/sdk`
 * (an optional peer dep). Throws a clear, actionable error if it's not
 * installed — the hub catches it and skips the server.
 */
const defaultConnect: McpConnect = async (_name, config) => {
  let ClientCtor: new (info: { name: string; version: string }) => McpSdkClient;
  let makeTransport: () => Promise<unknown>;
  // Non-literal specifiers so tsc does not try to resolve the optional peer dep.
  const sdk = "@modelcontextprotocol/sdk/client";
  try {
    const clientMod = (await import(`${sdk}/index.js`)) as {
      Client: typeof ClientCtor;
    };
    ClientCtor = clientMod.Client;
    if ("command" in config) {
      const stdioMod = (await import(`${sdk}/stdio.js`)) as {
        StdioClientTransport: new (o: unknown) => unknown;
      };
      makeTransport = async () =>
        new stdioMod.StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: config.env,
        });
    } else {
      const sseMod = (await import(`${sdk}/sse.js`)) as {
        SSEClientTransport: new (url: URL, o?: unknown) => unknown;
      };
      makeTransport = async () => new sseMod.SSEClientTransport(new URL(config.url));
    }
  } catch (err) {
    throw new Error(
      `MCP requires the "@modelcontextprotocol/sdk" package (bun add @modelcontextprotocol/sdk): ${
        (err as Error).message
      }`,
    );
  }

  const client = new ClientCtor({ name: "vibecodr", version: "0.0.0" });
  await client.connect(await makeTransport());
  return {
    async listTools() {
      const res = await client.listTools();
      return (res.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as JsonSchema | undefined,
      }));
    },
    async callTool(name, args) {
      const res = await client.callTool({
        name,
        arguments: (args ?? {}) as Record<string, unknown>,
      });
      return { content: res.content, isError: Boolean(res.isError) };
    },
    async close() {
      await client.close();
    },
  };
};

/** The slice of the official SDK client the default transport uses. */
interface McpSdkClient {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{
    tools?: { name: string; description?: string; inputSchema?: unknown }[];
  }>;
  callTool(req: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{ content: unknown; isError?: boolean }>;
  close(): Promise<void>;
}
