import type { Message, Part } from "@vibe/shared";

interface ModelMessageLike {
  role: string;
  content: unknown;
}

const TEXT_MAX = 4 * 1024 * 1024;
const REASONING_MAX = 256 * 1024;
const TOOL_OUTPUT_MAX = 512 * 1024;
const PROTOCOL_PAYLOAD_MAX_BYTES = 24 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function capTail(value: string, max: number): string {
  if (value.length <= max) return value;
  let tailLength = Math.max(0, max);
  let marker = "";
  // The omission marker is part of the bound. Recalculate because the digit
  // count can change when reserving room for the marker itself.
  for (let pass = 0; pass < 3; pass += 1) {
    marker = `… ${value.length - tailLength} earlier characters omitted …\n`;
    tailLength = Math.max(0, max - marker.length);
  }
  return `${marker}${value.slice(-tailLength)}`.slice(0, max);
}

function displayText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const item = record(part);
      return item?.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function sanitizeJsonMedia(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= 20) return "[nested value omitted]";
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonMedia(item, depth + 1));
  const input = value as Record<string, unknown>;
  if (input.type === "media") return "[media omitted]";
  const hasBinaryPayload = "data" in input || "image" in input;
  if (
    hasBinaryPayload &&
    (input.type === "file" ||
      input.type === "file-data" ||
      input.type === "image" ||
      input.type === "image-data" ||
      input.type === "audio" ||
      input.type === "audio-data" ||
      input.type === "video" ||
      input.type === "video-data")
  ) {
    return "[binary omitted]";
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(input)) {
    output[key] = sanitizeJsonMedia(item, depth + 1);
  }
  return output;
}

function normalizeToolOutput(value: unknown): unknown {
  const output = record(value);
  if (output?.type === "content" && Array.isArray(output.value)) {
    const text = output.value
      .map((part) => {
        const item = record(part);
        if (item?.type === "text" && typeof item.text === "string") return item.text;
        if (item?.type === "media") return "[media omitted]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
    return capTail(text, TOOL_OUTPUT_MAX);
  }
  if (
    (output?.type === "text" || output?.type === "error-text") &&
    typeof output.value === "string"
  ) {
    return capTail(output.value, TOOL_OUTPUT_MAX);
  }
  if ((output?.type === "json" || output?.type === "error-json") && "value" in output) {
    const sanitized = sanitizeJsonMedia(output.value);
    try {
      const json = JSON.stringify(sanitized);
      return typeof json === "string" && json.length <= TOOL_OUTPUT_MAX
        ? sanitized
        : capTail(json ?? String(sanitized), TOOL_OUTPUT_MAX);
    } catch {
      return capTail(String(sanitized), TOOL_OUTPUT_MAX);
    }
  }
  if (typeof value === "string") return capTail(value, TOOL_OUTPUT_MAX);
  try {
    const json = JSON.stringify(value);
    if (json.length <= TOOL_OUTPUT_MAX) return value;
    return capTail(json, TOOL_OUTPUT_MAX);
  } catch {
    return String(value);
  }
}

function persistedToolResultIsError(value: unknown): boolean {
  const output = record(value);
  return output?.type === "error-text" || output?.type === "error-json";
}

function boundedInput(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return capTail(value, 64 * 1024);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 8) return "… nested input omitted …";
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => boundedInput(item, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    output[key] = boundedInput(item, depth + 1);
  }
  return output;
}

function projectPart(value: unknown): Part | null {
  const part = record(value);
  if (!part || typeof part.type !== "string") return null;
  if (part.type === "text" && typeof part.text === "string" && part.text) {
    return { type: "text", text: capTail(part.text, TEXT_MAX) };
  }
  if (part.type === "reasoning" && typeof part.text === "string" && part.text) {
    return { type: "reasoning", text: capTail(part.text, REASONING_MAX) };
  }
  if (
    part.type === "tool-call" &&
    typeof part.toolCallId === "string" &&
    typeof part.toolName === "string"
  ) {
    return {
      type: "tool-call",
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      input: boundedInput(part.input),
    };
  }
  if (
    part.type === "tool-result" &&
    typeof part.toolCallId === "string" &&
    typeof part.toolName === "string"
  ) {
    return {
      type: "tool-result",
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      output: normalizeToolOutput(part.output),
      ...(part.isError === true || persistedToolResultIsError(part.output)
        ? { isError: true }
        : {}),
    };
  }
  return null;
}

interface ModelTurn {
  userText: string;
  parts: Part[];
}

function modelTurns(messages: ModelMessageLike[]): ModelTurn[] {
  const turns: ModelTurn[] = [];
  let current: ModelTurn | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      current = { userText: displayText(message.content), parts: [] };
      turns.push(current);
      continue;
    }
    if (!current || (message.role !== "assistant" && message.role !== "tool")) continue;
    if (message.role === "assistant" && typeof message.content === "string") {
      if (message.content) {
        current.parts.push({ type: "text", text: capTail(message.content, TEXT_MAX) });
      }
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const raw of message.content) {
      const part = projectPart(raw);
      if (part) current.parts.push(part);
    }
  }
  return turns;
}

function historyText(message: Message): string {
  return message.parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function normalizedHistoryText(history: string): string {
  return history.replace(/(?:\n\[image: [^\n]*\])+$/u, "").trim();
}

function normalizedModelText(model: string): string {
  const workspace = model.lastIndexOf("\n\n<workspace-state>\n");
  return (
    workspace >= 0 && model.trimEnd().endsWith("</workspace-state>")
      ? model.slice(0, workspace)
      : model
  ).trim();
}

function modelAlignmentKey(model: string, historyTextCounts: Map<string, number>): string | null {
  const normalized = normalizedModelText(model);
  if (!normalized.startsWith("[Summary of earlier conversation]\n")) return normalized;
  const matches = new Set<string>();
  for (
    let index = normalized.indexOf("\n");
    index >= 0;
    index = normalized.indexOf("\n", index + 1)
  ) {
    const candidate = normalized.slice(index + 1).trim();
    if (historyTextCounts.has(candidate)) matches.add(candidate);
  }
  return matches.size === 1 ? [...matches][0]! : null;
}

function displayUser(message: Message): Message {
  const text = historyText(message);
  if (!text.startsWith("The plan you presented was approved by the user — proceed with")) {
    return message;
  }
  return {
    ...message,
    metadata: { ...message.metadata, origin: "engine", label: "Plan approved" },
  };
}

function compactInput(input: unknown): unknown {
  const value = record(input);
  if (!value) return { omitted: true };
  const path = ["path", "file_path", "filePath", "filename", "target"]
    .map((key) => value[key])
    .find((item): item is string => typeof item === "string");
  return path ? { path, omitted: true } : { omitted: true };
}

export function fitTranscriptPayload(messages: Message[]): Message[] {
  const serializedBytes = (items: Message[]): number => {
    let total = 2;
    for (const [index, message] of items.entries()) {
      total += Buffer.byteLength(JSON.stringify(message)) + (index > 0 ? 1 : 0);
    }
    return total;
  };
  let bytes = serializedBytes(messages);
  if (bytes <= PROTOCOL_PAYLOAD_MAX_BYTES) return messages;
  let remaining = bytes - PROTOCOL_PAYLOAD_MAX_BYTES + 1024 * 1024;
  const bounded = messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (remaining <= 0) return part;
      if (part.type === "tool-result") {
        const size = Buffer.byteLength(JSON.stringify(part.output));
        if (size > 256) {
          remaining -= size;
          return { ...part, output: "… older tool output omitted during transcript restore …" };
        }
      } else if (part.type === "reasoning" && part.text.length > 2_000) {
        remaining -= Buffer.byteLength(part.text) - 2_000;
        return { ...part, text: capTail(part.text, 2_000) };
      } else if (part.type === "tool-call") {
        const size = Buffer.byteLength(JSON.stringify(part.input));
        if (size > 8_000) {
          remaining -= size - 100;
          return { ...part, input: compactInput(part.input) };
        }
      }
      return part;
    }),
  }));
  bytes = serializedBytes(bounded);
  if (bytes <= PROTOCOL_PAYLOAD_MAX_BYTES) return bounded;

  const notice: Message = {
    id: "transcript:restore-window",
    role: "assistant",
    parts: [{ type: "text", text: "… earlier transcript omitted while reopening this session …" }],
    createdAt: bounded[0]?.createdAt ?? Date.now(),
  };
  const target = PROTOCOL_PAYLOAD_MAX_BYTES - 64 * 1024;
  let retainedBytes = Buffer.byteLength(JSON.stringify(notice));
  const retained: Message[] = [];
  for (let index = bounded.length - 1; index >= 0; index -= 1) {
    const message = bounded[index]!;
    const messageBytes = Buffer.byteLength(JSON.stringify(message));
    if (retainedBytes + messageBytes > target) break;
    retained.unshift(message);
    retainedBytes += messageBytes;
  }
  const firstUser = retained.findIndex((message) => message.role === "user");
  if (firstUser > 0) retained.splice(0, firstUser);
  return [notice, ...retained];
}

function historyTurnHasStructure(history: Message[], userIndex: number): boolean {
  for (let index = userIndex + 1; index < history.length; index += 1) {
    const message = history[index]!;
    if (message.role === "user") return false;
    if (message.parts.some((part) => part.type !== "text")) return true;
  }
  return false;
}

/**
 * Rebuild the desktop transcript from the provider messages that retain
 * reasoning/tool structure. The normal UI history remains authoritative for
 * user-visible turns, metadata, timestamps, and usage.
 */
export function structuredTranscript(session: {
  history: Message[];
  modelMessages: ModelMessageLike[];
}): Message[] {
  const historyUsers = session.history
    .map((message, index) => ({ message, index }))
    .filter((item) => item.message.role === "user");
  const turns = modelTurns(session.modelMessages);
  const historyTextCounts = new Map<string, number>();
  for (const item of historyUsers) {
    const text = normalizedHistoryText(historyText(item.message));
    historyTextCounts.set(text, (historyTextCounts.get(text) ?? 0) + 1);
  }
  // SessionStore commits model messages before display history. A crash between
  // those renames can leave the provider transcript one turn ahead; no text
  // heuristic can distinguish a repeated prompt in that state.
  if (turns.length > historyUsers.length) return fitTranscriptPayload(session.history);
  const followingAssistant = new Map<number, Message>();
  let activeUserIndex: number | null = null;
  for (let index = 0; index < session.history.length; index += 1) {
    const message = session.history[index]!;
    if (message.role === "user") {
      activeUserIndex = index;
    } else if (message.role === "assistant" && activeUserIndex !== null) {
      followingAssistant.set(activeUserIndex, message);
      activeUserIndex = null;
    }
  }
  const replacements = new Map<number, ModelTurn>();
  let historyIndex = historyUsers.length - 1;
  let modelIndex = turns.length - 1;
  // Compaction replaces the older model context while retaining full display
  // history. Match only the trustworthy newest suffix; unmatched older turns
  // keep their already-valid flat history instead of disabling all restore.
  while (historyIndex >= 0 && modelIndex >= 0) {
    const history = historyUsers[historyIndex]!;
    const turn = turns[modelIndex]!;
    // Persisted model messages can be one turn ahead of display history after
    // an interrupted save. Only exact/folded prompt alignment proves that the
    // provider parts belong to this display turn. Compact goal labels differ
    // intentionally, so legacy flat goal turns remain flat; new sessions keep
    // their native structured history and need no reconstruction.
    const modelText = modelAlignmentKey(turn.userText, historyTextCounts);
    if (modelText === null || normalizedHistoryText(historyText(history.message)) !== modelText)
      break;
    const matchingHistoryTurns = historyTextCounts.get(modelText) ?? 0;
    if (matchingHistoryTurns !== 1) break;
    if (turn.parts.length > 0 && !historyTurnHasStructure(session.history, history.index)) {
      replacements.set(history.index, turn);
    }
    historyIndex -= 1;
    modelIndex -= 1;
  }
  if (replacements.size === 0) return fitTranscriptPayload(session.history);

  let replacingTurn = false;
  const result: Message[] = [];
  for (let index = 0; index < session.history.length; index += 1) {
    const message = session.history[index]!;
    if (message.role !== "user") {
      if (replacingTurn && (message.role === "assistant" || message.role === "tool")) continue;
      result.push(message);
      continue;
    }

    const turn = replacements.get(index);
    replacingTurn = Boolean(turn);
    result.push(displayUser(message));
    if (!turn) continue;
    const template = followingAssistant.get(index);
    const parts = turn.parts;
    if (parts.length > 0) {
      result.push({
        id: template?.id ?? `${message.id}:structured`,
        role: "assistant",
        parts,
        createdAt: template?.createdAt ?? message.createdAt,
        ...(template?.usage ? { usage: template.usage } : {}),
        ...(template?.subagentId ? { subagentId: template.subagentId } : {}),
        ...(template?.metadata ? { metadata: template.metadata } : {}),
      });
    }
  }
  return fitTranscriptPayload(result);
}
