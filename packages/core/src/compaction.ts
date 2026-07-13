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

/** Count characters in CJK Unicode ranges (Han, Hiragana, Katakana, Hangul,
 * CJK punctuation/symbols). CJK text tokenizes at ~1.5 chars/token on most
 * providers (vs ~4 chars/token for Latin), so the flat 4-chars/token estimate
 * severely under-counts CJK content and lets the prompt sail past the window
 * before the first real provider token count lands. This function returns the
 * count of CJK characters so the estimate can weight them at ~1 token each. */
function countCJK(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    // CJK Unified Ideographs + Extensions A-F, Hiragana, Katakana, Hangul,
    // CJK Compatibility, CJK punctuation/symbols, Fullwidth forms.
    if (
      (cp >= 0x3000 && cp <= 0x30ff) ||  // CJK symbols, Hiragana, Katakana
      (cp >= 0x3400 && cp <= 0x4dbf) ||  // CJK Ext A
      (cp >= 0x4e00 && cp <= 0x9fff) ||  // CJK Unified
      (cp >= 0xac00 && cp <= 0xd7af) ||  // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) ||  // CJK Compatibility Ideographs
      (cp >= 0xff00 && cp <= 0xffef) ||  // Fullwidth forms
      (cp >= 0x20000 && cp <= 0x2ffff)   // CJK Ext B-F
    ) {
      count++;
      // Skip the surrogate pair if this is a supplementary character.
      if (cp > 0xffff) i++;
    }
  }
  return count;
}

/**
 * Token estimate that accounts for CJK text (which tokenizes at ~1 token per
 * character, not ~0.25 as the flat 4-chars/token assumes). The formula:
 *   tokens ≈ cjk_chars + (non_cjk_chars / 4)
 * where `cjk_chars` are weighted at ~1 token each and Latin/ASCII at ~4
 * chars/token. Binary parts are counted flat (BINARY_PART_CHARS), not by byte.
 *
 * This is still a rough estimate — the provider's real `inputTokens` (threaded
 * in via `currentTokens`) is authoritative once the first step lands. This
 * estimate is only the pre-first-step fallback and the offload projection
 * anchor, so a closer heuristic (not a perfect tokenizer) is sufficient.
 */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  let cjk = 0;
  for (const m of messages) {
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") {
      chars += content.length + 16;
      cjk += countCJK(content);
    } else if (Array.isArray(content)) {
      let partChars = 16;
      for (const part of content) {
        const type = (part as { type?: string })?.type;
        if (type === "image" || type === "file") {
          partChars += BINARY_PART_CHARS;
        } else {
          const json = JSON.stringify(part);
          partChars += json.length;
          cjk += countCJK(json);
        }
      }
      chars += partChars;
    } else {
      const json = JSON.stringify(m);
      chars += json.length;
      cjk += countCJK(json);
    }
  }
  // CJK characters cost ~1 token each; the remaining chars at ~4 chars/token.
  const nonCjkChars = chars - cjk;
  return Math.ceil(cjk + nonCjkChars / 4);
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
  /** True when compaction ran in EMERGENCY mode: the transcript had fewer
   * messages than `keep` normally preserves, but the prompt was already over
   * the threshold (or `force`d), so the keep window was shrunk to allow an
   * older prefix to summarize. Surfaced so the caller can warn instead of
   * reporting a clean "freed N tokens" success — the context may STILL exceed
   * the window after the shrink if the offending message sits in the kept
   * tail (e.g. a single massive paste), and a follow-up attempt may need a
   * manual `/clear` rather than another auto-compaction pass. */
  overrun: boolean;
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
  // Under-threshold AND not forced → nothing to do. Otherwise the prompt is over
  // the threshold (or the user forced it) — compaction MUST do work or the next
  // provider call 400s on length. If `messages.length <= opts.keep`, the old code
  // returned null here (no older prefix to summarize). That was correct for the
  // threshold-driven case when the threshold waited until enough messages piled
  // up, but it broke for a transcript with a SINGLE huge message (one large file
  // paste, one massive tool output) that sailed past the limit on a very short
  // message list. In that emergency case the keep window MUST shrink so the
  // boundary walk has an older prefix to summarize; without it the next turn
  // 400'd on length while compaction reported "nothing to compact."
  let overrun = false;
  let effectiveKeep = opts.keep;
  if (messages.length <= opts.keep) {
    // Fewer than 3 messages: no meaningfully older prefix exists — return null so
    // the caller can surface a manual-intervention notice ("prompt over window;
    // try /clear"). One or two big messages can't be sliced safely.
    if (messages.length < 3) return null;
    // Keep ONE recent message and summarize the rest. The boundary walk below
    // inflates this if it has to swallow orphan tool results, but at least the
    // bulk of the offending content (a paste in an early user turn, a giant tool
    // dump) becomes the `older` prefix and gets summarized. Flag `overrun` so
    // the caller knows this was an emergency shrink, not the normal keep-window
    // compaction, and may need follow-up help (the kept tail can STILL exceed the
    // window if it alone carries the bulk of the tokens).
    overrun = true;
    effectiveKeep = 1;
  }

  // Never cut between an assistant's `tool-call` and its `tool` result message:
  // `response.messages` records tool results as their own `role: "tool"` message,
  // so a naive tail slice can make `recent` begin with a `tool_result` whose
  // `tool_use` got summarized away into `older` — an orphan that Anthropic/OpenAI
  // reject with a hard 400 mid-session. Walk the boundary back until `recent`
  // starts on a non-`tool` message, pulling the owning assistant turn along with
  // it so the step stays whole. If that swallows everything, there is nothing
  // older left to summarize.
  let cut = messages.length - effectiveKeep;
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
  // Build a compact tool-call index from the older messages so the model
  // retains a structured memory of what it already investigated — which files
  // it read, what commands it ran, what it searched for — even after the full
  // results are summarized into prose. This prevents the model from blindly
  // re-reading a file it already read or re-running a command it already ran.
  const toolIndex = buildToolCallIndex(older);
  const note = toolIndex
    ? `[Summary of earlier conversation]\n${summary}\n\n## TOOL CALLS (already executed — don't repeat unless the file changed)\n${toolIndex}`
    : `[Summary of earlier conversation]\n${summary}`;

  // Keep strict user/assistant alternation with a leading user turn — Anthropic
  // (and others) 400 on two consecutive same-role messages and require the first
  // message to be a user turn. If the recent window already starts with a user
  // message, fold the summary into it; otherwise prepend it as its own user turn.
  const first = recent[0];
  let next: ModelMessage[];
  if (first && first.role === "user" && typeof first.content === "string") {
    next = [{ role: "user", content: `${note}\n\n${first.content}` }, ...recent.slice(1)];
  } else if (first && first.role === "user" && Array.isArray(first.content)) {
    next = [
      { role: "user", content: [{ type: "text", text: note }, ...first.content] },
      ...recent.slice(1),
    ];
  } else {
    // recent[0] is an assistant/tool turn, or a user turn with malformed/legacy
    // content (neither string nor array — spreading it would throw, and
    // #maybeCompact would misreport that as a summarizer failure). Prepend the
    // summary as its own leading user turn.
    next = [{ role: "user", content: note }, ...recent];
  }
  // Report freed space as the drop in the (messages-only) estimate, so it
  // measures what compaction actually removed rather than the system/tool
  // overhead that `currentTokens` carries and compaction never touches.
  return { messages: next, freed: Math.max(0, estimate - estimateTokens(next)), overrun };
}

/**
 * Build a compact one-line-per-call index of the tool calls in `older` so the
 * model retains a structured memory of what it already investigated even after
 * the full results are summarized away. Each line records the tool name, its
 * key input (path/command/URL), and a short result digest — enough for the model
 * to know what it already looked at without re-running the tool. Capped at 40
 * lines so the index itself doesn't bloat the compacted context.
 */
function buildToolCallIndex(messages: ModelMessage[]): string {
  const lines: string[] = [];
  // Collect tool-call inputs by callId so we can pair them with their results.
  const calls = new Map<
    string,
    { tool: string; input: string }
  >();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      const p = part as { type?: string; toolCallId?: string; toolName?: string; input?: unknown; args?: unknown };
      if (p?.type === "tool-call" && p.toolCallId) {
        const inp = (p.input ?? p.args) as Record<string, unknown> | undefined;
        let inputStr = "";
        if (inp) {
          if (typeof inp.path === "string") inputStr = inp.path;
          else if (typeof inp.command === "string") inputStr = inp.command.slice(0, 60);
          else if (typeof inp.url === "string") inputStr = inp.url;
          else if (typeof inp.query === "string") inputStr = inp.query;
          else if (typeof inp.pattern === "string") inputStr = inp.pattern;
        }
        calls.set(p.toolCallId, { tool: p.toolName ?? "tool", input: inputStr });
      }
    }
  }
  // Pair with results and build the index.
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      const p = part as {
        type?: string;
        toolCallId?: string;
        output?: unknown;
      };
      if (p?.type !== "tool-result" || !p.toolCallId) continue;
      const call = calls.get(p.toolCallId);
      if (!call) continue;
      // Extract a short result digest (first meaningful line, capped).
      const outText = typeof p.output === "string"
        ? p.output
        : typeof (p.output as { value?: unknown })?.value === "string"
          ? String((p.output as { value: string }).value)
          : "";
      const digest = outText.trim().split("\n")[0]?.slice(0, 80) ?? "";
      lines.push(`- ${call.tool} ${call.input}${digest ? ` — ${digest}` : ""}`);
      if (lines.length >= 40) return lines.join("\n");
    }
  }
  return lines.join("\n");
}
