import { test, expect, afterEach } from "bun:test";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { listOpenAICompatibleModels } from "./openai-compat.ts";

// ── listOpenAICompatibleModels: /v1/models fetch + header plumbing ─────────────
// Fully offline: we stub the global fetch so no network is touched.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

/** Install a fetch stub, returning a handle to the last request it saw. */
function stubFetch(
  respond: (url: string) => { ok: boolean; json: () => Promise<unknown> } | Promise<never>,
): Captured {
  const cap: Captured = { url: "", init: undefined };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    cap.url = String(url);
    cap.init = init;
    return respond(String(url));
  }) as unknown as typeof fetch;
  return cap;
}

test("maps /v1/models data to {id, providerId} and hits the right URL", async () => {
  const cap = stubFetch(() => ({
    ok: true,
    json: async () => ({ data: [{ id: "model-a" }, { id: "model-b" }] }),
  }));
  // Trailing slash on the base URL must be normalized, then `/models` appended.
  const models = await listOpenAICompatibleModels(
    "myprov",
    "https://api.example.com/v1/",
    "sk-key",
  );
  expect(cap.url).toBe("https://api.example.com/v1/models");
  expect(models).toEqual([
    { id: "model-a", providerId: "myprov" },
    { id: "model-b", providerId: "myprov" },
  ]);
});

test("sends Accept + Bearer Authorization when an apiKey is given", async () => {
  const cap = stubFetch(() => ({ ok: true, json: async () => ({ data: [] }) }));
  await listOpenAICompatibleModels("p", "https://x/v1", "sk-123");
  const headers = cap.init!.headers as Record<string, string>;
  expect(headers.Accept).toBe("application/json");
  expect(headers.Authorization).toBe("Bearer sk-123");
});

test("omits Authorization when no apiKey is provided (keyless)", async () => {
  const cap = stubFetch(() => ({ ok: true, json: async () => ({ data: [] }) }));
  await listOpenAICompatibleModels("p", "https://x/v1", undefined);
  const headers = cap.init!.headers as Record<string, string>;
  expect(headers.Authorization).toBeUndefined();
  expect(headers.Accept).toBe("application/json");
});

test("plumbs extra headers, but Accept/Authorization take precedence over collisions", async () => {
  const cap = stubFetch(() => ({ ok: true, json: async () => ({ data: [] }) }));
  await listOpenAICompatibleModels("p", "https://x/v1", "sk-key", undefined, {
    "X-Account-Id": "acct_42",
    Accept: "text/plain", // collides — the standard Accept must win
    Authorization: "Bearer wrong", // collides — the resolved key must win
  });
  const headers = cap.init!.headers as Record<string, string>;
  expect(headers["X-Account-Id"]).toBe("acct_42");
  expect(headers.Accept).toBe("application/json");
  expect(headers.Authorization).toBe("Bearer sk-key");
});

test("filters out entries without a string id", async () => {
  stubFetch(() => ({
    ok: true,
    json: async () => ({ data: [{ id: "ok" }, { id: 123 }, {}, { id: "ok2" }] }),
  }));
  const models = await listOpenAICompatibleModels("p", "https://x/v1", undefined);
  expect(models.map((m) => m.id)).toEqual(["ok", "ok2"]);
});

test("returns [] on a non-ok response (unreachable provider never breaks the catalog)", async () => {
  stubFetch(() => ({ ok: false, json: async () => ({}) }));
  expect(await listOpenAICompatibleModels("p", "https://x/v1", undefined)).toEqual([]);
});

test("returns [] when fetch throws (network error)", async () => {
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  expect(await listOpenAICompatibleModels("p", "https://x/v1", undefined)).toEqual([]);
});

// ── The paired factory: providers route through @ai-sdk/openai-compatible ───────
// This module lists models for exactly the providers built with
// createOpenAICompatible. That factory must produce an AI SDK 7 spec-"v4"
// model with the model id passed straight through.

test("createOpenAICompatible builds an SDK 7 model with id passthrough (no network)", () => {
  const provider = createOpenAICompatible({
    name: "test-provider",
    apiKey: "sk-test",
    baseURL: "https://api.example.com/v1",
    headers: { "X-Custom": "1" },
  });
  const model = provider("vendor/model-x") as {
    specificationVersion?: string;
    modelId?: string;
  };
  expect(model.specificationVersion).toBe("v4");
  expect(model.modelId).toBe("vendor/model-x");
});

test("a builtin provider's listModels passes a bounded timeout signal to the fetch", async () => {
  // defs.ts used to pass `undefined` for the signal, so a blackholed baseURL hung
  // /models, --models, the picker, and onboarding until the OS TCP timeout. The
  // def must now hand the fetch a real (timeout-backed) AbortSignal.
  const { builtinProviders } = await import("./defs.ts");
  const cap = stubFetch(() => ({ ok: true, json: async () => ({ data: [] }) }));
  const openai = builtinProviders().find((p) => p.id === "openai");
  expect(openai).toBeDefined();
  await openai!.listModels({ apiKey: "sk-test" });
  expect(cap.init?.signal).toBeInstanceOf(AbortSignal);
});
