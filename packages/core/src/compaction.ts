import type { ModelMessage } from "ai";

/** Rough token estimate (~4 chars/token) over serialized messages. */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += JSON.stringify(m).length;
  return Math.ceil(chars / 4);
}

export interface CompactOptions {
  contextWindow: number;
  /** Fraction of the context window that triggers compaction. */
  threshold: number;
  /** Number of most-recent messages to always preserve verbatim. */
  keep: number;
  /** Summarize the older messages into a single note. */
  summarize: (messages: ModelMessage[]) => Promise<string>;
  /** Force compaction regardless of the threshold (e.g. /compact). */
  force?: boolean;
}

export interface CompactResult {
  messages: ModelMessage[];
  freed: number;
}

/**
 * Context-window-aware compaction: when the estimated token count crosses the
 * threshold (or `force`), summarize all but the last `keep` messages into one
 * note and prepend it. The system prompt and goal live outside `messages` and
 * are therefore always preserved. Returns null when no compaction is needed.
 */
export async function compactMessages(
  messages: ModelMessage[],
  opts: CompactOptions,
): Promise<CompactResult | null> {
  const before = estimateTokens(messages);
  if (!opts.force && before < opts.threshold * opts.contextWindow) return null;
  if (messages.length <= opts.keep) return null;

  const older = messages.slice(0, messages.length - opts.keep);
  const recent = messages.slice(messages.length - opts.keep);
  const summary = await opts.summarize(older);

  const next: ModelMessage[] = [
    {
      role: "user",
      content: `[Summary of earlier conversation]\n${summary}`,
    },
    ...recent,
  ];
  return { messages: next, freed: Math.max(0, before - estimateTokens(next)) };
}
