import { test, expect } from "bun:test";
import { z } from "zod";
import { MockLanguageModelV3 } from "ai/test";
import { extractJsonObject, generateStructuredObject } from "./structured-object.ts";

test("extractJsonObject parses bare JSON", () => {
  expect(extractJsonObject(`{"met":true,"gaps":[],"reason":"ok"}`)).toEqual({
    met: true,
    gaps: [],
    reason: "ok",
  });
});

test("extractJsonObject tolerates markdown fences and prose wrappers", () => {
  expect(extractJsonObject('Here you go:\n```json\n{"done":true,"reason":"yep"}\n```\n')).toEqual({
    done: true,
    reason: "yep",
  });
  expect(extractJsonObject('Sure! {"done":false,"reason":"nope"} thanks')).toEqual({
    done: false,
    reason: "nope",
  });
});

test("extractJsonObject returns undefined for non-JSON", () => {
  expect(extractJsonObject("no object here")).toBeUndefined();
  expect(extractJsonObject("")).toBeUndefined();
});

test("generateStructuredObject uses native path when supported (doGenerate JSON)", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ done: true, reason: "native" }) }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      warnings: [],
    }),
  });
  const object = await generateStructuredObject({
    model,
    schema: z.object({ done: z.boolean(), reason: z.string() }),
    prompt: "check condition",
    supportsStructuredOutput: true,
  });
  expect(object).toEqual({ done: true, reason: "native" });
});

test("generateStructuredObject falls back to prompt-JSON when structured outputs are disabled", async () => {
  let calls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      calls++;
      // Free-form style with fence — what local models often emit without response_format.
      return {
        content: [
          {
            type: "text" as const,
            text: '```json\n{"met":false,"gaps":["missing tests"],"reason":"incomplete"}\n```',
          },
        ],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      };
    },
  });
  const object = await generateStructuredObject({
    model,
    schema: z.object({
      met: z.boolean(),
      gaps: z.array(z.string()),
      reason: z.string(),
    }),
    prompt: "assess goal",
    supportsStructuredOutput: false,
  });
  expect(object).toEqual({
    met: false,
    gaps: ["missing tests"],
    reason: "incomplete",
  });
  // Only the text path ran (native skipped).
  expect(calls).toBe(1);
});

test("generateStructuredObject falls back when native generateObject fails", async () => {
  let n = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      n++;
      if (n === 1) {
        // First call is native generateObject — return unparseable text so it fails validation.
        return {
          content: [{ type: "text" as const, text: "I cannot do JSON today." }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          warnings: [],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ done: true, reason: "recovered" }),
          },
        ],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      };
    },
  });
  const object = await generateStructuredObject({
    model,
    schema: z.object({ done: z.boolean(), reason: z.string() }),
    prompt: "check",
    supportsStructuredOutput: true,
  });
  expect(object).toEqual({ done: true, reason: "recovered" });
  expect(n).toBe(2);
});

test("generateStructuredObject does not fall through to a second call on AbortError", async () => {
  let n = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      n++;
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
  });
  await expect(
    generateStructuredObject({
      model,
      schema: z.object({ done: z.boolean(), reason: z.string() }),
      prompt: "check",
      supportsStructuredOutput: true,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  // Native threw AbortError — must NOT spend a second generateText call.
  expect(n).toBe(1);
});

test("generateStructuredObject respects a pre-aborted signal without calling the model", async () => {
  let n = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      n++;
      return {
        content: [{ type: "text" as const, text: "{}" }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      };
    },
  });
  const ac = new AbortController();
  ac.abort();
  await expect(
    generateStructuredObject({
      model,
      schema: z.object({ done: z.boolean(), reason: z.string() }),
      prompt: "check",
      supportsStructuredOutput: false,
      abortSignal: ac.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(n).toBe(0);
});
