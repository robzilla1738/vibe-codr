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
export function extractLastJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { ok: false, error: "the subagent produced no final message to parse as JSON" };

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
    error: "the subagent's final message was not valid JSON (expected exactly one JSON object matching the schema)",
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

/**
 * Validate `value` against the common JSON-Schema subset models actually emit:
 * `type`, `enum`, `const`, `required`, `properties`, `additionalProperties:false`,
 * `items`, `minItems`/`maxItems`, `minLength`/`maxLength`, `minimum`/`maximum`.
 * Returns human-readable `path: problem` errors (empty = valid). Lenient by
 * design — an unrecognized/absent constraint is not an error, so a schema this
 * validator doesn't fully model never falsely rejects conforming output.
 */
export function validateJsonSchema(schema: JsonSchema, value: unknown, path: string): string[] {
  const errors: string[] = [];
  const at = path || "(root)";

  // enum / const first — they pin the value regardless of type.
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((e) => deepEqual(e, value))) {
      errors.push(`${at}: value ${short(value)} is not one of the allowed values ${short(schema.enum)}`);
      return errors;
    }
  }
  if ("const" in schema && !deepEqual(schema.const, value)) {
    errors.push(`${at}: value ${short(value)} must equal ${short(schema.const)}`);
    return errors;
  }

  const types = normalizeTypes(schema.type);
  if (types.length && !types.some((t) => matchesType(t, value))) {
    errors.push(`${at}: expected ${types.join(" | ")}, got ${jsonType(value)}`);
    return errors; // a wrong type makes deeper checks meaningless
  }

  const effectiveType = types.find((t) => matchesType(t, value)) ?? jsonType(value);

  if (effectiveType === "object" && isPlainObject(value)) {
    const props = isPlainObject(schema.properties) ? (schema.properties as JsonSchema) : {};
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    // `in` walks the prototype chain, so a key named like an Object.prototype
    // member (`constructor`, `toString`, `__proto__`, `hasOwnProperty`) would
    // spoof presence and let a modeled constraint false-pass — an honesty
    // violation for structured enforcement. Only OWN keys count.
    for (const key of required) {
      if (!hasOwn(value, key)) errors.push(`${join(path, key)}: required property is missing`);
    }
    for (const [key, sub] of Object.entries(props)) {
      if (hasOwn(value, key) && isPlainObject(sub)) {
        errors.push(...validateJsonSchema(sub as JsonSchema, (value as Record<string, unknown>)[key], join(path, key)));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!hasOwn(props, key)) errors.push(`${join(path, key)}: unexpected property (additionalProperties is false)`);
      }
    }
  }

  if (effectiveType === "array" && Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${at}: expected at least ${schema.minItems} items, got ${value.length}`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${at}: expected at most ${schema.maxItems} items, got ${value.length}`);
    }
    if (isPlainObject(schema.items)) {
      value.forEach((item, i) => {
        errors.push(...validateJsonSchema(schema.items as JsonSchema, item, `${path}[${i}]`));
      });
    }
  }

  if (effectiveType === "string" && typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${at}: string shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${at}: string longer than maxLength ${schema.maxLength}`);
    }
  }

  if ((effectiveType === "number" || effectiveType === "integer") && typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${at}: ${value} is below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${at}: ${value} is above maximum ${schema.maximum}`);
    }
  }

  return errors;
}

function normalizeTypes(t: unknown): string[] {
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true; // unknown type keyword — don't reject
  }
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value as number)) return "integer";
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Own-property test that never consults the prototype chain (so a key named
 * like an Object.prototype member can't spoof presence). */
function hasOwn(obj: object, key: string): boolean {
  return Object.hasOwn(obj, key);
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    return ak.length === bk.length && ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function short(value: unknown): string {
  const s = JSON.stringify(value) ?? String(value);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}
