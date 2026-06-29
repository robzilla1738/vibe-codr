/**
 * A minimal OpenAI-compatible server for end-to-end testing the REAL vibecodr
 * binary against a "live" model over HTTP — no paid API key needed. It speaks
 * the `/v1/chat/completions` SSE streaming wire format that
 * `@ai-sdk/openai-compatible` (the lmstudio/ollama adapter) expects.
 *
 * Two-phase script: the first request (no prior tool result in the messages)
 * returns a tool call; the follow-up request returns final text. The tool call
 * is parameterized by env so the harness can target a specific edit.
 *
 * Usage: PORT=… EDIT_PATH=… EDIT_OLD=… EDIT_NEW=… FINAL_TEXT=… bun mock-openai-server.ts
 */
const PORT = Number(process.env.PORT ?? 8099);
const EDIT_PATH = process.env.EDIT_PATH ?? "note.txt";
const EDIT_OLD = process.env.EDIT_OLD ?? "old";
const EDIT_NEW = process.env.EDIT_NEW ?? "new";
const FINAL_TEXT = process.env.FINAL_TEXT ?? "Done.";

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: 0, model: "mock-model" };

function toolCallStream(): string {
  const args = JSON.stringify({ path: EDIT_PATH, oldString: EDIT_OLD, newString: EDIT_NEW });
  return (
    sse({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }) +
    sse({
      ...base,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "edit", arguments: args } }] },
          finish_reason: null,
        },
      ],
    }) +
    sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) +
    "data: [DONE]\n\n"
  );
}

function textStream(): string {
  let out = sse({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  for (const ch of FINAL_TEXT) out += sse({ ...base, choices: [{ index: 0, delta: { content: ch }, finish_reason: null }] });
  out += sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
  out += "data: [DONE]\n\n";
  return out;
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: "mock-model", object: "model" }] });
    }
    if (url.pathname.endsWith("/chat/completions")) {
      const body = (await req.json()) as { messages?: { role: string }[] };
      // If a tool result is already present, this is the follow-up → final text.
      const hasToolResult = (body.messages ?? []).some((m) => m.role === "tool");
      const payload = hasToolResult ? textStream() : toolCallStream();
      return new Response(payload, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});
process.stdout.write(`mock-openai listening on http://127.0.0.1:${server.port}\n`);
