/**
 * Structured subagent output: enforce that a child's FINAL message is exactly one
 * JSON object matching a caller-supplied JSON Schema. The AI SDK's `jsonSchema()`
 * does NO validation on its own (a schema with no `validate` fn makes
 * `safeValidateTypes` pass unconditionally), so we validate the common JSON-Schema
 * subset ourselves — the only way structured enforcement is real rather than a
 * rubber stamp. On mismatch the caller re-runs the child with these errors as
 * feedback; a final failure NEVER fabricates an object — it surfaces the errors
 * plus the raw text so the model can see what went wrong.
 */

import { validateJsonSchema } from "@vibe/shared";

export { validateJsonSchema } from "@vibe/shared";

type JsonSchema = Record<string, unknown>;

/** The kickoff directive appended when a subagent has an `outputSchema`. */
export function structuredDirective(schema: JsonSchema): string {
  return (
    "\n\nIMPORTANT: Your FINAL message must be EXACTLY ONE JSON object that conforms to " +
    "this JSON Schema — no prose, no explanation, no markdown around it, nothing else:\n" +
    "```json\n" +
    `${JSON.stringify(schema, null, 2)}\n` +
    "```"
  );
}

/** The feedback message re-run into a child after a schema mismatch. */
export function structuredRetryPrompt(errors: string[]): string {
  return (
    "Your previous final message did not satisfy the required JSON schema:\n" +
    errors.map((e) => `- ${e}`).join("\n") +
    "\n\nGather any missing information if you need to, then reply with ONLY the corrected " +
    "JSON object that matches the schema — nothing else."
  );
}

export type EnforceResult =
  | { ok: true; json: string; value: unknown }
  | { ok: false; errors: string[]; raw: string };

/**
 * Extract the last JSON value from `text` and validate it against `schema`.
 * Returns the canonical JSON string on success, or the validation errors + the
 * raw text on failure. Never throws.
 */
export function enforceSchema(text: string, schema: JsonSchema): EnforceResult {
  const extracted = extractLastJson(text);
  if (!extracted.ok) {
    return { ok: false, errors: [extracted.error], raw: text };
  }
  const errors = validateJsonSchema(schema, extracted.value, "");
  if (errors.length) return { ok: false, errors, raw: text };
  return { ok: true, json: JSON.stringify(extracted.value), value: extracted.value };
}

/**
 * Pull the JSON value a model intended as its answer out of `text`. Prefers the
 * whole trimmed message (the model was told to emit ONLY JSON), then the last
 * fenced ```json block, then the last balanced object/array anywhere in the text
 * — so a stray sentence before the JSON doesn't defeat extraction.
 */
export function extractLastJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = (text ?? "").trim();
  if (!trimmed)
    return { ok: false, error: "the subagent produced no final message to parse as JSON" };

  const tryParse = (s: string): { ok: true; value: unknown } | null => {
    try {
      return { ok: true, value: JSON.parse(s) };
    } catch {
      return null;
    }
  };

  // 1. The whole message (the intended shape).
  const whole = tryParse(trimmed);
  if (whole) return whole;

  // 2. The LAST fenced code block that parses.
  const fences = [...trimmed.matchAll(/```(?:json|jsonc)?\s*\n?([\s\S]*?)```/gi)]
    .map((m) => m[1]?.trim())
    .filter((s): s is string => !!s);
  for (let i = fences.length - 1; i >= 0; i--) {
    const parsed = tryParse(fences[i]!);
    if (parsed) return parsed;
  }

  // 3. The last balanced {…} / […] anywhere in the text.
  const balanced = lastBalanced(trimmed);
  if (balanced) {
    const parsed = tryParse(balanced);
    if (parsed) return parsed;
  }

  return {
    ok: false,
    error:
      "the subagent's final message was not valid JSON (expected exactly one JSON object matching the schema)",
  };
}

/** The last complete top-level `{…}` or `[…]` span in `s` (string/escape aware). */
function lastBalanced(s: string): string | null {
  let best: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{" || c === "[") {
      const end = matchFrom(s, i);
      if (end !== -1) {
        best = s.slice(i, end + 1);
        i = end; // skip past this span so nested opens aren't re-scanned
      }
    }
  }
  return best;
}

/** Index of the bracket that closes the one at `start`, or -1 if unbalanced. */
function matchFrom(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
