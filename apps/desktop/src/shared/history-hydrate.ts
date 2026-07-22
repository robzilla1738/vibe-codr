import {
  capTranscriptState,
  classifyAssistantPhases,
  initialTranscript,
  reduceTranscript,
  type TranscriptAction,
  type TranscriptState,
} from "./reducer";
import type { Message } from "./types";
import { stripVisionRelayContext } from "./vision-display";

const FILE_EDIT_TOOLS = new Set([
  "edit",
  "write",
  "apply_patch",
  "str_replace",
  "search_replace",
  "create_file",
  "Edit",
  "Write",
]);
const MAX_PENDING_HISTORY_TOOLS = 4_096;

function pathFromToolInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const rec = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "filename", "target"]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function actionFromTool(toolName: string): "write" | "edit" {
  const n = toolName.toLowerCase();
  if (n.includes("write") || n.includes("create")) return "write";
  return "edit";
}

/** Hydrate transcript blocks from snapshot history (resume UX). */
export function hydrateFromHistory(history: Message[]): TranscriptState {
  let s = initialTranscript();
  const apply = (action: TranscriptAction) => {
    // Cap incrementally so hydration never builds an oversized intermediate
    // state before the final replacement reducer gets a chance to enforce it.
    s = capTranscriptState(reduceTranscript(s, action));
  };
  /** toolCallId → { toolName, input } for reconstructing changed-files on resume. */
  const pendingTools = new Map<string, { toolName: string; input: unknown }>();

  for (const msg of history) {
    if (msg.role === "user") {
      const text = msg.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      if (text) {
        const firstTextPart = msg.parts.find((part) => part.type === "text");
        const turnId = msg.turnId
          ?? (typeof msg.metadata?.turnId === "string" ? msg.metadata.turnId : undefined);
        const origin = msg.metadata?.origin === "engine" ? "engine" : undefined;
        const label = typeof msg.metadata?.label === "string" ? msg.metadata.label : undefined;
        apply({
          type: "user",
          text: stripVisionRelayContext(text),
          timestamp: msg.createdAt,
          ...(origin ? { origin } : {}),
          ...(label ? { label } : {}),
          ...(turnId ? { turnId } : {}),
          messageId: msg.id,
          ...(firstTextPart?.id ? { partId: firstTextPart.id } : {}),
          ...(msg.revision !== undefined ? { revision: msg.revision } : {}),
        });
      }
    } else if (msg.role === "assistant" || msg.role === "tool") {
      for (const part of msg.parts) {
        if (msg.role === "assistant" && part.type === "text" && part.text) {
          apply({
            type: "delta",
            text: part.text,
            timestamp: part.startedAt ?? msg.createdAt,
            ...(part.phase ? { phase: part.phase } : {}),
            ...(part.turnId ?? msg.turnId ? { turnId: part.turnId ?? msg.turnId } : {}),
            messageId: msg.id,
            ...(part.id ? { partId: part.id } : {}),
            ...(part.revision !== undefined ? { revision: part.revision } : {}),
          });
          apply({ type: "finalize" });
        } else if (msg.role === "assistant" && part.type === "reasoning" && part.text) {
          apply({
            type: "thinking",
            text: part.text,
            ...(part.turnId ?? msg.turnId ? { turnId: part.turnId ?? msg.turnId } : {}),
            messageId: msg.id,
            ...(part.id ? { partId: part.id } : {}),
            ...(part.revision !== undefined ? { revision: part.revision } : {}),
          });
        } else if (msg.role === "assistant" && part.type === "tool-call") {
          if (pendingTools.size >= MAX_PENDING_HISTORY_TOOLS) {
            const oldest = pendingTools.keys().next().value;
            if (oldest !== undefined) pendingTools.delete(oldest);
          }
          pendingTools.set(part.toolCallId, { toolName: part.toolName, input: part.input });
          apply({
            type: "tool-start",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            at: part.startedAt,
            ...(part.turnId ?? msg.turnId ? { turnId: part.turnId ?? msg.turnId } : {}),
            messageId: msg.id,
            ...(part.id ? { partId: part.id } : {}),
            ...(part.revision !== undefined ? { revision: part.revision } : {}),
            ...(part.status ? { status: part.status } : {}),
          });
        } else if (part.type === "tool-result") {
          const meta = pendingTools.get(part.toolCallId);
          pendingTools.delete(part.toolCallId);
          // Rebuild session changed-files map from edit/write tools so Changes
          // dock / Inspector are not empty after resume (shell-only; no diff body
          // unless the result string looks like a unified diff).
          if (!part.isError && meta && FILE_EDIT_TOOLS.has(meta.toolName)) {
            const path = pathFromToolInput(meta.input);
            if (path) {
              const out =
                typeof part.output === "string"
                  ? part.output
                  : part.output != null
                    ? JSON.stringify(part.output)
                    : "";
              const looksLikeDiff = /^(diff --git|@@ )/m.test(out);
              const added = looksLikeDiff ? (out.match(/^\+[^+]/gm) ?? []).length : 0;
              const removed = looksLikeDiff ? (out.match(/^-[^-]/gm) ?? []).length : 0;
              apply({
                type: "file-changed",
                toolCallId: part.toolCallId,
                path,
                action: actionFromTool(meta.toolName),
                added,
                removed,
                countsKnown: looksLikeDiff,
                diff: looksLikeDiff ? out : undefined,
              });
            }
          }
          // Live file-changed precedes tool-finished and deliberately folds the
          // edit into that call's row. Keep history hydration in the same order.
          apply({
            type: "tool-finish",
            toolCallId: part.toolCallId,
            output: part.output,
            isError: !!part.isError,
            at: part.completedAt,
            ...(part.status ? { status: part.status } : {}),
            ...(part.outputPaths ? { outputPaths: part.outputPaths } : {}),
            ...(part.sources ? { sources: part.sources } : {}),
          });
        }
      }
    }
  }
  // History is complete — orphan tool-starts (no matching result) must not look
  // like live/running rows after resume.
  if (Object.keys(s.toolByCallId).length > 0) {
    s = {
      ...s,
      blocks: s.blocks.map((b) =>
        b.kind === "tool" && !b.done ? { ...b, done: true } : b,
      ),
      toolByCallId: {},
    };
  }
  return classifyAssistantPhases(s);
}
