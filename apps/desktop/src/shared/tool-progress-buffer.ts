import { appendRollingText } from "./stream-cap";

/** Match the transcript tool-tail ceiling so the coalescing layer can never
 * retain more data than the reducer will display. */
export const TOOL_PROGRESS_TAIL_MAX_CHARS = 600;
/** A 24ms flush normally keeps this map tiny. Bound its cardinality as defense
 * in depth against a synchronous burst of progress events for many calls. */
export const TOOL_PROGRESS_BUFFER_MAX_CALLS = 128;

export function bufferToolProgress(
  buffer: Map<string, string>,
  toolCallId: string,
  chunk: string,
  options?: { maxCalls?: number; maxChars?: number },
): void {
  const maxCalls = Math.max(
    0,
    Math.floor(options?.maxCalls ?? TOOL_PROGRESS_BUFFER_MAX_CALLS),
  );
  const maxChars = Math.max(
    0,
    Math.floor(options?.maxChars ?? TOOL_PROGRESS_TAIL_MAX_CHARS),
  );
  if (maxCalls === 0 || maxChars === 0 || !chunk) return;

  const current = buffer.get(toolCallId) ?? "";
  // Reinsert existing calls so Map iteration remains least-recently-updated
  // first; if a pathological burst overflows, active/newest calls survive.
  if (buffer.has(toolCallId)) buffer.delete(toolCallId);
  while (buffer.size >= maxCalls) {
    const oldest = buffer.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    buffer.delete(oldest);
  }
  buffer.set(toolCallId, appendRollingText(current, chunk, maxChars));
}
