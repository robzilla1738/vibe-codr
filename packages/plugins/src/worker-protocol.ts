import type { HookName, HookPayloads } from "./hooks.ts";
import type { SlashResult } from "./commands.ts";

export const PLUGIN_WORKER_LIMITS = Object.freeze({
  frameBytes: 1_048_576,
  outputBytes: 262_144,
  errorChars: 1_024,
  identifierChars: 200,
  descriptionChars: 4_096,
  maxPending: 64,
  maxRequests: 10_000,
  startupMs: 10_000,
  rpcMs: 30_000,
} as const);

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface IsolatedToolMetadata {
  kind: "tool";
  name: string;
  description: string;
  inputSchema: Record<string, JsonValue>;
  readOnly: boolean;
  concurrencySafe?: boolean;
  network?: boolean;
  modes?: ("execute" | "plan")[];
}

export interface IsolatedCommandMetadata {
  kind: "command";
  name: string;
  description: string;
}

export interface IsolatedPluginMetadata {
  tools: IsolatedToolMetadata[];
  commands: IsolatedCommandMetadata[];
  hooks: HookName[];
}

export type PluginWorkerStartResult =
  | { status: "ready"; metadata: IsolatedPluginMetadata }
  | { status: "trusted-in-process-approval-required"; contribution: "providers" };

export type PluginWorkerRequest =
  | { v: 1; id: number; op: "init"; specifier: string }
  | { v: 1; id: number; op: "tool"; name: string; input: JsonValue; context: Record<string, JsonValue> }
  | { v: 1; id: number; op: "command"; name: string; args: string }
  | { v: 1; id: number; op: "hook"; name: HookName; payload: JsonValue }
  | { v: 1; id: number; op: "shutdown" };
export type PluginWorkerRequestBody = PluginWorkerRequest extends infer Request
  ? Request extends PluginWorkerRequest ? Omit<Request, "v" | "id"> : never
  : never;

export type PluginWorkerSuccess =
  | PluginWorkerStartResult
  | JsonValue
  | SlashResult
  | HookPayloads[HookName]
  | null;

export type PluginWorkerResponse =
  | { v: 1; id: number; ok: true; value: PluginWorkerSuccess }
  | { v: 1; id: number; ok: false; error: PluginWorkerErrorCode };

export type PluginWorkerErrorCode =
  | "aborted"
  | "closed"
  | "crashed"
  | "invalid-contribution"
  | "invalid-frame"
  | "output-too-large"
  | "plugin-call-failed"
  | "plugin-load-failed"
  | "request-limit"
  | "timeout";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function isSafeWorkerIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 10_000 && value.every((item) => isJsonValue(item, depth + 1));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 10_000
    && entries.every(([key, item]) => key.length <= 1_024 && !key.includes("\0") && isJsonValue(item, depth + 1));
}

export function encodedJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

export function parseWorkerRequest(value: unknown): PluginWorkerRequest | null {
  if (!record(value) || value.v !== 1 || !positiveId(value.id) || typeof value.op !== "string") return null;
  if (value.op === "init") {
    return only(value, ["v", "id", "op", "specifier"])
      && typeof value.specifier === "string" && value.specifier.length > 0
      && value.specifier.length <= 4_096 && !value.specifier.includes("\0")
      ? value as PluginWorkerRequest : null;
  }
  if (value.op === "tool") {
    return only(value, ["v", "id", "op", "name", "input", "context"])
      && isSafeWorkerIdentifier(value.name) && isJsonValue(value.input)
      && record(value.context) && isJsonValue(value.context)
      ? value as PluginWorkerRequest : null;
  }
  if (value.op === "command") {
    return only(value, ["v", "id", "op", "name", "args"])
      && isSafeWorkerIdentifier(value.name) && typeof value.args === "string"
      && value.args.length <= PLUGIN_WORKER_LIMITS.outputBytes
      ? value as PluginWorkerRequest : null;
  }
  if (value.op === "hook") {
    return only(value, ["v", "id", "op", "name", "payload"])
      && isSafeWorkerIdentifier(value.name) && isJsonValue(value.payload)
      ? value as PluginWorkerRequest : null;
  }
  return value.op === "shutdown" && only(value, ["v", "id", "op"])
    ? value as PluginWorkerRequest : null;
}

export function parseWorkerResponse(value: unknown): PluginWorkerResponse | null {
  if (!record(value) || value.v !== 1 || !positiveId(value.id) || typeof value.ok !== "boolean") return null;
  if (value.ok) {
    return only(value, ["v", "id", "ok", "value"]) && isJsonValue(value.value)
      ? value as PluginWorkerResponse : null;
  }
  return only(value, ["v", "id", "ok", "error"])
    && typeof value.error === "string" && WORKER_ERROR_CODES.has(value.error as PluginWorkerErrorCode)
    ? value as PluginWorkerResponse : null;
}

export function parsePluginWorkerStartResult(value: unknown): PluginWorkerStartResult | null {
  if (!record(value) || typeof value.status !== "string") return null;
  if (value.status === "trusted-in-process-approval-required") {
    return only(value, ["status", "contribution"]) && value.contribution === "providers"
      ? value as unknown as PluginWorkerStartResult : null;
  }
  if (value.status !== "ready" || !only(value, ["status", "metadata"]) || !record(value.metadata)) return null;
  const metadata = value.metadata;
  if (!only(metadata, ["tools", "commands", "hooks"])
    || !boundedArray(metadata.tools, validTool)
    || !boundedArray(metadata.commands, validCommand)
    || !boundedArray(metadata.hooks, (name): name is HookName => typeof name === "string" && HOOK_NAMES.has(name as HookName))) return null;
  const names = [...metadata.tools, ...metadata.commands].map((item) => (item as { name: string }).name);
  if (new Set(names).size !== names.length || new Set(metadata.hooks).size !== metadata.hooks.length) return null;
  return value as unknown as PluginWorkerStartResult;
}

const WORKER_ERROR_CODES = new Set<PluginWorkerErrorCode>([
  "aborted", "closed", "crashed", "invalid-contribution", "invalid-frame",
  "output-too-large", "plugin-call-failed", "plugin-load-failed", "request-limit", "timeout",
]);
const HOOK_NAMES = new Set<HookName>([
  "session.start", "user.prompt.submit", "tool.before.execute", "tool.after.execute",
  "step.finish", "assistant.message", "session.idle", "session.end", "subagent.start",
  "subagent.stop", "permission.denied", "compact.before", "compact.after", "goal.transition", "turn.failure",
]);
function validTool(value: unknown): value is IsolatedToolMetadata {
  if (!record(value) || !only(value, ["kind", "name", "description", "inputSchema", "readOnly", "concurrencySafe", "network", "modes"])) return false;
  return value.kind === "tool" && isSafeWorkerIdentifier(value.name)
    && typeof value.description === "string" && value.description.length <= PLUGIN_WORKER_LIMITS.descriptionChars
    && record(value.inputSchema) && isJsonValue(value.inputSchema) && typeof value.readOnly === "boolean"
    && (value.concurrencySafe === undefined || typeof value.concurrencySafe === "boolean")
    && (value.network === undefined || typeof value.network === "boolean")
    && (value.modes === undefined || (Array.isArray(value.modes) && value.modes.length <= 2
      && value.modes.every((mode) => mode === "execute" || mode === "plan")));
}
function validCommand(value: unknown): value is IsolatedCommandMetadata {
  return record(value) && only(value, ["kind", "name", "description"])
    && value.kind === "command" && isSafeWorkerIdentifier(value.name)
    && typeof value.description === "string" && value.description.length <= PLUGIN_WORKER_LIMITS.descriptionChars;
}
function boundedArray<T>(value: unknown, guard: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.length <= 256 && value.every(guard);
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function only(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function positiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
