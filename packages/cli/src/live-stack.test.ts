import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./index.ts";

type Server = ReturnType<typeof Bun.serve>;

/**
 * Full-stack integration: drive the REAL CLI against a REAL HTTP server that
 * speaks the OpenAI-compatible streaming wire format — exercising config load,
 * the provider registry, @ai-sdk/openai-compatible, real fetch/SSE parsing, the
 * real `edit` tool, and the headless renderer. No paid key (lmstudio is
 * keyless); deterministic because the "model" is scripted.
 */
function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
const base = { id: "m", object: "chat.completion.chunk", created: 0, model: "mock-model" };

function startMockModel(edit: { path: string; oldString: string; newString: string }, finalText: string): Server {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "mock-model" }] });
      }
      const body = (await req.json()) as { messages?: { role: string }[] };
      const hasToolResult = (body.messages ?? []).some((m) => m.role === "tool");
      let payload: string;
      if (hasToolResult) {
        payload =
          sse({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }) +
          sse({ ...base, choices: [{ index: 0, delta: { content: finalText }, finish_reason: null }] }) +
          sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) +
          "data: [DONE]\n\n";
      } else {
        payload =
          sse({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }) +
          sse({
            ...base,
            choices: [
              { index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "edit", arguments: JSON.stringify(edit) } }] }, finish_reason: null },
            ],
          }) +
          sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) +
          "data: [DONE]\n\n";
      }
      return new Response(payload, { headers: { "content-type": "text/event-stream" } });
    },
  });
}

let server: Server | null = null;
const savedBase = process.env.LMSTUDIO_BASE_URL;
let restoreOut: (() => void) | null = null;
afterEach(() => {
  server?.stop(true);
  server = null;
  if (savedBase === undefined) delete process.env.LMSTUDIO_BASE_URL;
  else process.env.LMSTUDIO_BASE_URL = savedBase;
  restoreOut?.();
  restoreOut = null;
});

test("real CLI -> live HTTP model -> real edit tool edits a real file", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-live-"));
  writeFileSync(join(cwd, "note.txt"), "the old value\nkeep me\n");

  server = startMockModel(
    { path: "note.txt", oldString: "old value", newString: "NEW VALUE" },
    "Edited note.txt.",
  );
  process.env.LMSTUDIO_BASE_URL = `http://127.0.0.1:${server.port}/v1`;

  let out = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => {
    out += s;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  restoreOut = () => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  };

  const code = await run(["-p", "replace old value with NEW VALUE in note.txt", "-m", "lmstudio/mock-model", "--cwd", cwd]);
  restoreOut();
  restoreOut = null;

  expect(code).toBe(0);
  expect(out).toContain("Edited note.txt.");
  // The real edit tool actually modified the file on disk over the live stack.
  expect(readFileSync(join(cwd, "note.txt"), "utf8")).toBe("the NEW VALUE\nkeep me\n");
});
