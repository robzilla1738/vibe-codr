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
 * are therefore always preserved. The kept window is never cut across a
 * tool-call/tool-result boundary, so it stays a valid request. Returns null when
 * no compaction is needed.
 */
export async function compactMessages(
  messages: ModelMessage[],
  opts: CompactOptions,
): Promise<CompactResult | null> {
  const before = estimateTokens(messages);
  if (!opts.force && before < opts.threshold * opts.contextWindow) return null;
  if (messages.length <= opts.keep) return null;

  // Never cut between an assistant's `tool-call` and its `tool` result message:
  // `response.messages` records tool results as their own `role: "tool"` message,
  // so a naive tail slice can make `recent` begin with a `tool_result` whose
  // `tool_use` got summarized away into `older` — an orphan that Anthropic/OpenAI
  // reject with a hard 400 mid-session. Walk the boundary back until `recent`
  // starts on a non-`tool` message, pulling the owning assistant turn along with
  // it so the step stays whole. If that swallows everything, there is nothing
  // older left to summarize.
  let cut = messages.length - opts.keep;
  while (cut > 0 && messages[cut]?.role === "tool") cut--;
  if (cut <= 0) return null;

  const older = messages.slice(0, cut);
  const recent = messages.slice(cut);
  const summary = await opts.summarize(older);
  const note = `[Summary of earlier conversation]\n${summary}`;

  // Keep strict user/assistant alternation with a leading user turn — Anthropic
  // (and others) 400 on two consecutive same-role messages and require the first
  // message to be a user turn. If the recent window already starts with a user
  // message, fold the summary into it; otherwise prepend it as its own user turn.
  const first = recent[0];
  let next: ModelMessage[];
  if (first && first.role === "user") {
    const folded: ModelMessage =
      typeof first.content === "string"
        ? { role: "user", content: `${note}\n\n${first.content}` }
        : { role: "user", content: [{ type: "text", text: note }, ...first.content] };
    next = [folded, ...recent.slice(1)];
  } else {
    next = [{ role: "user", content: note }, ...recent];
  }
  return { messages: next, freed: Math.max(0, before - estimateTokens(next)) };
}
