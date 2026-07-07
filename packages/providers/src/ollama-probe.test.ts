import { test, expect } from "bun:test";
import { extractContextLength } from "./ollama-probe.ts";

test("extractContextLength reads model_info context_length", () => {
  expect(
    extractContextLength({
      model_info: { "glm.context_length": 131072, "glm.embedding_length": 4096 },
    }),
  ).toBe(131072);
});

test("extractContextLength falls back to num_ctx in parameters", () => {
  expect(extractContextLength({ parameters: "stop foo\nnum_ctx 8192\n" })).toBe(8192);
});

test("extractContextLength returns undefined when nothing usable", () => {
  expect(extractContextLength({})).toBeUndefined();
  expect(extractContextLength({ model_info: { "glm.context_length": 0 } })).toBeUndefined();
});

test("extractContextLength prefers the served num_ctx over the architectural max", () => {
  // A 128k-capable model served with an 8k window must report 8k, not 128k, so
  // the UI/compaction don't believe in headroom a request would 400 on.
  expect(
    extractContextLength({
      model_info: { "qwen3.context_length": 131072 },
      parameters: "stop <|im_end|>\nnum_ctx 8192\n",
    }),
  ).toBe(8192);
  // If num_ctx is somehow larger than the architectural cap, clamp to the cap.
  expect(
    extractContextLength({
      model_info: { "qwen3.context_length": 32768 },
      parameters: "num_ctx 131072\n",
    }),
  ).toBe(32768);
});

test("probeOllamaContextWindow does NOT memoize a transient failure (re-probes after recovery)", async () => {
  const { probeOllamaContextWindow } = await import("./ollama-probe.ts");
  const realFetch = globalThis.fetch;
  let fail = true;
  globalThis.fetch = (async (_url: string | URL) => {
    if (fail) throw new Error("daemon still starting");
    return new Response(JSON.stringify({ model_info: { "glm.context_length": 8192 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const model = "ollama/uniq-transient-probe-fixture"; // unique key → no cross-test cache
    expect(await probeOllamaContextWindow(model, "http://localhost:11434/v1")).toBeUndefined(); // transient fail
    fail = false;
    // The failure was NOT cached, so the daemon-recovered probe succeeds.
    expect(await probeOllamaContextWindow(model, "http://localhost:11434/v1")).toBe(8192);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("probeOllamaContextWindow uses a config API key for cloud routing and auth", async () => {
  const { probeOllamaContextWindow } = await import("./ollama-probe.ts");
  const realFetch = globalThis.fetch;
  const prevKey = process.env.OLLAMA_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  let seenUrl = "";
  let seenAuth = "";
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenAuth = String(new Headers(init?.headers).get("authorization") ?? "");
    return new Response(JSON.stringify({ model_info: { "glm.context_length": 32768 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const model = "ollama/uniq-config-key-probe-fixture";
    expect(await probeOllamaContextWindow(model, undefined, "ol-config-key")).toBe(32768);
    expect(seenUrl).toBe("https://ollama.com/api/show");
    expect(seenAuth).toBe("Bearer ol-config-key");
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = prevKey;
  }
});
