import { generateObject, generateText, type LanguageModel } from "ai";
import type { z } from "zod";

/**
 * Produce a schema-validated object from a model, with a prompt-JSON fallback
 * when native structured outputs are unavailable.
 *
 * `generateObject` (AI SDK) sets `responseFormat: { type: "json", schema }`,
 * which many local/OpenAI-compatible models reject (ollama/gemma, etc.) with a
 * "responseFormat is not supported" warning and/or a failed generation —
 * which is what made /goal assessment report "assessment unavailable" on
 * those models. When the catalog knows the model lacks structured outputs, or
 * when the native path throws, we fall back to `generateText` + extract JSON
 * + Zod parse so goal assessment and loop `--until` keep working.
 */
export async function generateStructuredObject<SCHEMA extends z.ZodType>(opts: {
  model: LanguageModel;
  schema: SCHEMA;
  prompt: string;
  abortSignal?: AbortSignal;
  maxRetries?: number;
  /**
   * When false, skip native generateObject (model known not to support
   * structured JSON response format). When true/undefined, try native first.
   */
  supportsStructuredOutput?: boolean;
}): Promise<z.infer<SCHEMA>> {
  const { model, schema, prompt, abortSignal, maxRetries, supportsStructuredOutput } = opts;

  if (supportsStructuredOutput !== false) {
    try {
      const { object } = await generateObject({
        model,
        schema,
        prompt,
        abortSignal,
        maxRetries,
      });
      return object as z.infer<SCHEMA>;
    } catch (err) {
      // Never convert cancellation into a second model call — Esc / deadline
      // must stop assessment, not spend another turn on the text fallback.
      if (isAbortLike(err, abortSignal)) throw err;
      // Fall through to prompt-JSON. Native may fail because the provider
      // rejects response_format, the model returns non-JSON, or the schema
      // validation failed on a soft JSON attempt.
    }
  }

  // If the native path aborted mid-flight we rethrew; still re-check so a
  // supportsStructuredOutput:false path also respects a pre-aborted signal.
  if (abortSignal?.aborted) {
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  }

  const { text } = await generateText({
    model,
    abortSignal,
    maxRetries,
    prompt:
      `${prompt}\n\n` +
      `Respond with a single JSON object only (no markdown fences, no prose) ` +
      `that matches this shape. Required keys must be present.`,
  });

  const parsed = extractJsonObject(text);
  if (parsed === undefined) {
    throw new Error(
      `Model did not return parseable JSON for structured object (got ${JSON.stringify(text.slice(0, 200))})`,
    );
  }
  return schema.parse(parsed) as z.infer<SCHEMA>;
}

function isAbortLike(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const name = (err as { name?: string } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * Pull the first JSON object out of a model reply. Tolerates optional markdown
 * fences and leading/trailing prose — common when the model is not constrained
 * by native response_format. Pure.
 */
export function extractJsonObject(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  // Fenced ```json ... ``` (or bare ``` ... ```)
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence?.[1]?.trim() ?? trimmed;

  // Direct parse
  try {
    return JSON.parse(candidate);
  } catch {
    /* find a balanced object below */
  }

  // First {...} span (handles "Sure! { ... }" wrappers)
  const start = candidate.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
