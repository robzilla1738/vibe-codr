import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolContext, ToolDefinition } from "@vibe/shared";
import type { ProviderDef } from "@vibe/providers";
import { HookBus, type HookName } from "./hooks.ts";
import type { Plugin, PluginApi } from "./plugin.ts";
import type { SlashCommand } from "./commands.ts";
import {
  PLUGIN_WORKER_LIMITS,
  encodedJsonBytes,
  isJsonValue,
  isSafeWorkerIdentifier,
  parseWorkerRequest,
  type IsolatedCommandMetadata,
  type IsolatedToolMetadata,
  type JsonValue,
  type PluginWorkerErrorCode,
  type PluginWorkerResponse,
  type PluginWorkerStartResult,
} from "./worker-protocol.ts";

const protocolWrite = process.stdout.write.bind(process.stdout);
// A plugin cannot corrupt the protocol or leak values through inherited stdout.
process.stdout.write = (() => true) as typeof process.stdout.write;

const tools = new Map<string, ToolDefinition>();
const commands = new Map<string, SlashCommand>();
const hooks = new HookBus();
let providers = 0;
let initialized = false;
let requestCount = 0;
let input = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
  input = Buffer.concat([input, chunk]);
  if (input.byteLength > PLUGIN_WORKER_LIMITS.frameBytes && !input.includes(10)) fatal("invalid-frame");
  while (true) {
    const newline = input.indexOf(10);
    if (newline < 0) break;
    const frame = input.subarray(0, newline);
    input = input.subarray(newline + 1);
    if (frame.byteLength === 0) continue;
    if (frame.byteLength > PLUGIN_WORKER_LIMITS.frameBytes) return fatal("invalid-frame");
    let decoded: unknown;
    try { decoded = JSON.parse(frame.toString("utf8")); }
    catch { return fatal("invalid-frame"); }
    const request = parseWorkerRequest(decoded);
    if (!request) return fatal("invalid-frame");
    requestCount += 1;
    if (requestCount > PLUGIN_WORKER_LIMITS.maxRequests) return fatal("request-limit");
    void dispatch(request).catch(() => reply(request.id, false, "plugin-call-failed"));
  }
});
process.stdin.on("end", () => process.exit(0));

async function dispatch(request: NonNullable<ReturnType<typeof parseWorkerRequest>>): Promise<void> {
  if (request.op === "init") {
    if (initialized) return reply(request.id, false, "invalid-frame");
    initialized = true;
    try {
      const specifier = localImportSpecifier(request.specifier);
      const mod = (await import(specifier)) as { default?: Plugin } & Partial<Plugin>;
      const plugin = mod.default ?? mod;
      if (typeof plugin.register !== "function") return reply(request.id, false, "plugin-load-failed");
      await plugin.register(pluginApi());
      const value: PluginWorkerStartResult = providers > 0
        ? { status: "trusted-in-process-approval-required", contribution: "providers" }
        : {
            status: "ready",
            metadata: {
              tools: [...tools.values()].map(toolMetadata),
              commands: [...commands.values()].map(commandMetadata),
              hooks: HOOK_NAMES.filter((name) => hooks.handlerCount(name) > 0),
            },
          };
      return reply(request.id, true, value as unknown as JsonValue);
    } catch {
      return reply(request.id, false, "plugin-load-failed");
    }
  }
  if (!initialized) return reply(request.id, false, "invalid-frame");
  if (request.op === "shutdown") {
    reply(request.id, true, null);
    return process.exit(0);
  }
  try {
    if (request.op === "tool") {
      const tool = tools.get(request.name);
      if (!tool) return reply(request.id, false, "invalid-contribution");
      const context = request.context as Record<string, JsonValue>;
      const result = await tool.execute(request.input, toolContext(context));
      return safeResult(request.id, result);
    }
    if (request.op === "command") {
      const command = commands.get(request.name);
      if (!command) return reply(request.id, false, "invalid-contribution");
      return safeResult(request.id, await command.run(request.args));
    }
    if (!HOOK_NAMES.includes(request.name)) return reply(request.id, false, "invalid-contribution");
    return safeResult(request.id, await hooks.run(request.name, request.payload as never));
  } catch {
    return reply(request.id, false, "plugin-call-failed");
  }
}

function pluginApi(): PluginApi {
  const logger = {
    debug() {}, info() {}, warn() {}, error() {}, child() { return logger; },
  };
  return {
    registerTool(def) {
      const metadata = toolMetadata(def);
      if (tools.size >= 256 || tools.has(metadata.name)) throw new Error("invalid tool");
      tools.set(metadata.name, def);
    },
    registerCommand(command) {
      commandMetadata(command);
      if (commands.size >= 256 || commands.has(command.name)) throw new Error("invalid command");
      commands.set(command.name, command);
    },
    registerProvider(_provider: ProviderDef) { providers += 1; },
    addSkillDir() { throw new Error("skills are not executable worker contributions"); },
    hooks,
    logger,
  };
}

function toolMetadata(tool: ToolDefinition): IsolatedToolMetadata {
  if (!isSafeWorkerIdentifier(tool.name) || typeof tool.description !== "string"
    || tool.description.length > PLUGIN_WORKER_LIMITS.descriptionChars
    || !isJsonValue(tool.inputSchema) || Array.isArray(tool.inputSchema) || tool.inputSchema === null) {
    throw new Error("invalid tool metadata");
  }
  if (tool.modes?.some((mode) => mode !== "execute" && mode !== "plan")) throw new Error("invalid tool modes");
  return {
    kind: "tool", name: tool.name, description: tool.description,
    inputSchema: tool.inputSchema as Record<string, JsonValue>, readOnly: tool.readOnly,
    ...(tool.concurrencySafe === undefined ? {} : { concurrencySafe: tool.concurrencySafe }),
    ...(tool.network === undefined ? {} : { network: tool.network }),
    ...(tool.modes === undefined ? {} : { modes: [...tool.modes] }),
  };
}

function commandMetadata(command: SlashCommand): IsolatedCommandMetadata {
  if (!isSafeWorkerIdentifier(command.name) || typeof command.description !== "string"
    || command.description.length > PLUGIN_WORKER_LIMITS.descriptionChars || typeof command.run !== "function") {
    throw new Error("invalid command metadata");
  }
  return { kind: "command", name: command.name, description: command.description };
}

function toolContext(raw: Record<string, JsonValue>): ToolContext {
  const freshness = { recordRead() {}, recordWrite() {}, assertFresh: () => ({ stale: false }), clearSession() {} };
  return {
    cwd: typeof raw.cwd === "string" ? raw.cwd : "",
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "isolated-plugin",
    toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : "isolated-plugin-call",
    abortSignal: new AbortController().signal,
    emit() {},
    freshness,
  };
}

function safeResult(id: number, value: unknown): void {
  if (!isJsonValue(value)) return reply(id, false, "invalid-contribution");
  if (encodedJsonBytes(value) > PLUGIN_WORKER_LIMITS.outputBytes) return reply(id, false, "output-too-large");
  reply(id, true, value);
}

function reply(id: number, ok: true, value: JsonValue): void;
function reply(id: number, ok: false, value: PluginWorkerErrorCode): void;
function reply(id: number, ok: boolean, value: JsonValue | PluginWorkerErrorCode): void {
  const response: PluginWorkerResponse = ok
    ? { v: 1, id, ok: true, value: value as JsonValue }
    : { v: 1, id, ok: false, error: value as PluginWorkerErrorCode };
  const encoded = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(encoded) > PLUGIN_WORKER_LIMITS.frameBytes) {
    const fallback: PluginWorkerResponse = { v: 1, id, ok: false, error: "output-too-large" };
    protocolWrite(`${JSON.stringify(fallback)}\n`);
  } else protocolWrite(encoded);
}

function fatal(code: PluginWorkerErrorCode): never {
  const response: PluginWorkerResponse = { v: 1, id: 1, ok: false, error: code };
  protocolWrite(`${JSON.stringify(response)}\n`);
  process.exit(1);
}

function localImportSpecifier(specifier: string): string {
  return specifier.startsWith(".") || specifier.startsWith("/")
    ? pathToFileURL(resolve(specifier)).href : specifier;
}

const HOOK_NAMES: HookName[] = [
  "session.start", "user.prompt.submit", "tool.before.execute", "tool.after.execute",
  "step.finish", "assistant.message", "session.idle", "session.end", "subagent.start",
  "subagent.stop", "permission.denied", "compact.before", "compact.after", "goal.transition", "turn.failure",
];
