import type { ModelMessage } from "ai";

/**
 * Flat char-cost charged for a binary part (image/file) in the estimate. A real
 * image is a handful of provider tokens, NOT the ~5-7 chars/byte that
 * `JSON.stringify`-ing its `Uint8Array` (`{"0":255,"1":12,…}`) would invent — a
 * single 500KB attachment would otherwise read as millions of "chars" and force
 * compaction every turn. The provider's real input-token count (threaded in via
 * `currentTokens`) is authoritative; this estimate is only the pre-first-step
 * fallback, so a coarse flat cost is sufficient and safe.
 */
const BINARY_PART_CHARS = 1_500;

/** Char weight of one message's content, treating binary parts as a flat cost. */
function messageChars(m: ModelMessage): number {
  const content = (m as { content?: unknown }).content;
  if (typeof content === "string") return content.length + 16;
  if (Array.isArray(content)) {
    let chars = 16;
    for (const part of content) {
      const type = (part as { type?: string })?.type;
      if (type === "image" || type === "file") chars += BINARY_PART_CHARS;
      else chars += JSON.stringify(part).length;
    }
    return chars;
  }
  return JSON.stringify(m).length;
}

/** Rough token estimate (~4 chars/token); binary parts counted flat, not by byte. */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += messageChars(m);
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
  /**
   * The TRUE current prompt size in tokens (the provider's real input count,
   * which already includes the system prompt + tool schemas + cache). When
   * provided, this — not the messages-only `estimateTokens` — drives the
   * threshold check, so a session no longer sails past the limit because the
   * estimate omitted ~40k of system/tool overhead. Falls back to the estimate.
   */
  currentTokens?: number;
}

export interface CompactResult {
  messages: ModelMessage[];
  freed: number;
}

/**
 * Context-window-aware compaction: when the current prompt size (the provider's
 * real `currentTokens` when known, else the messages-only estimate) crosses the
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
  const estimate = estimateTokens(messages);
  // Trigger on the provider's real prompt size when known (it counts the system
  // prompt + tool schemas the estimate can't see); fall back to the estimate.
  const trigger = opts.currentTokens && opts.currentTokens > 0 ? opts.currentTokens : estimate;
  if (!opts.force && trigger < opts.threshold * opts.contextWindow) return null;
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
  // The summary REPLACES `older` — committing an empty/whitespace summary would
  // irrecoverably delete that history and hand the model a bare header. A model
  // hiccup (refusal, content filter, a local model that emits nothing, a provider
  // that resolves with `text:""`) must not cost the conversation its past: treat
  // an empty summary as "couldn't compact" and leave the messages untouched.
  if (!summary.trim()) return null;
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
  // Report freed space as the drop in the (messages-only) estimate, so it
  // measures what compaction actually removed rather than the system/tool
  // overhead that `currentTokens` carries and compaction never touches.
  return { messages: next, freed: Math.max(0, estimate - estimateTokens(next)) };
}
