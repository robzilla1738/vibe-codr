import { test, expect, afterEach } from "bun:test";
import { streamText } from "ai";
import { defaultConfig, type Config } from "@vibe/config";
import { ProviderRegistry } from "./registry.ts";

/**
 * OpenAI-compatible endpoints have no first-class reasoning channel — hosted
 * open reasoning models emit their chain-of-thought inline as <think>…</think>.
 * `create` wraps the compat family with extractReasoningMiddleware so that
 * text becomes real reasoning stream parts (feeding the Thinking panel)
 * instead of leaking into the visible reply. Full-stack: a real HTTP server
 * speaking the OpenAI SSE wire format through the real provider + AI SDK.
 */

type Server = ReturnType<typeof Bun.serve>;
let server: Server | undefined;
afterEach(() => server?.stop(true));

const base = { id: "m", object: "chat.completion.chunk", created: 0, model: "mock-model" };
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

function startThinkModel(): Server {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      const payload =
        sse({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }) +
        sse({ ...base, choices: [{ index: 0, delta: { content: "<think>weighing options</think>" }, finish_reason: null }] }) +
        sse({ ...base, choices: [{ index: 0, delta: { content: "the answer" }, finish_reason: null }] }) +
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) +
        "data: [DONE]\n\n";
      return new Response(payload, { headers: { "content-type": "text/event-stream" } });
    },
  });
}

test("compat providers surface inline <think> as reasoning parts, not reply text", async () => {
  server = startThinkModel();
  const cfg: Config = {
    ...defaultConfig(),
    providers: { lmstudio: { baseURL: `http://127.0.0.1:${server.port}/v1` } },
  } as Config;
  const model = await new ProviderRegistry().resolveModel("lmstudio/mock-model", cfg);

  let reasoning = "";
  let text = "";
  const result = streamText({ model, prompt: "q" });
  for await (const part of result.fullStream) {
    if (part.type === "reasoning-delta") reasoning += part.text;
    if (part.type === "text-delta") text += part.text;
  }
  expect(reasoning).toBe("weighing options");
  expect(text).toBe("the answer");
  expect(text).not.toContain("<think>");
});
