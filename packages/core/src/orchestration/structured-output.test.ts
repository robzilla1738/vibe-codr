import { test, expect } from "bun:test";
import { enforceSchema, extractLastJson, validateJsonSchema } from "./structured-output.ts";

const schema = {
  type: "object",
  required: ["status", "count"],
  properties: {
    status: { type: "string", enum: ["ok", "fail"] },
    count: { type: "integer" },
    tags: { type: "array", items: { type: "string" } },
  },
} as const;

test("validateJsonSchema accepts a conforming object", () => {
  expect(validateJsonSchema(schema, { status: "ok", count: 3, tags: ["a"] }, "")).toEqual([]);
});

test("validateJsonSchema reports missing required + wrong type + bad enum", () => {
  const errors = validateJsonSchema(schema, { status: "maybe", count: "three" }, "");
  // status not in enum, count is a string not integer.
  expect(errors.some((e) => e.includes("status"))).toBe(true);
  expect(errors.some((e) => e.includes("count"))).toBe(true);
});

test("validateJsonSchema flags a missing required property", () => {
  const errors = validateJsonSchema(schema, { status: "ok" }, "");
  expect(errors.some((e) => e.includes("count") && e.includes("required"))).toBe(true);
});

test("validateJsonSchema recurses into array items", () => {
  const errors = validateJsonSchema(schema, { status: "ok", count: 1, tags: ["a", 2] }, "");
  expect(errors.some((e) => e.includes("tags[1]"))).toBe(true);
});

test("validateJsonSchema honors additionalProperties:false", () => {
  const strict = {
    type: "object",
    properties: { a: { type: "string" } },
    additionalProperties: false,
  };
  expect(validateJsonSchema(strict, { a: "x" }, "")).toEqual([]);
  expect(validateJsonSchema(strict, { a: "x", b: 1 }, "").some((e) => e.includes("b"))).toBe(true);
});

test("additionalProperties:false rejects a prototype-named key (no `in` false-pass)", () => {
  // `"constructor" in props` is true via Object.prototype, so a naive `in` check
  // would let this extra key slip past additionalProperties:false. It must be
  // flagged like any other unexpected property.
  const strict = {
    type: "object",
    properties: { answer: { type: "string" } },
    additionalProperties: false,
  };
  const errors = validateJsonSchema(strict, { answer: "x", constructor: "y" }, "");
  expect(errors.some((e) => e.includes("constructor"))).toBe(true);
});

test("required honors a prototype-named key as genuinely missing", () => {
  // `"toString" in {}` is true via the prototype chain — a naive check would call
  // the requirement satisfied. An empty object is missing `toString` as data.
  const schema = { type: "object", required: ["toString"], properties: {} };
  const errors = validateJsonSchema(schema, {}, "");
  expect(errors.some((e) => e.includes("toString") && e.includes("required"))).toBe(true);
});

test("validateJsonSchema is lenient about unknown keywords (no false reject)", () => {
  // A schema this validator doesn't fully model must never reject conforming data.
  const exotic = {
    type: "object",
    properties: { a: { type: "string", format: "email", pattern: ".*" } },
  };
  expect(validateJsonSchema(exotic, { a: "anything" }, "")).toEqual([]);
});

test("extractLastJson prefers the whole message, then fences, then a trailing object", () => {
  expect(extractLastJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  expect(extractLastJson('here you go:\n```json\n{"a":2}\n```')).toEqual({
    ok: true,
    value: { a: 2 },
  });
  expect(extractLastJson('prose then {"a":3} trailing')).toEqual({ ok: true, value: { a: 3 } });
});

test("extractLastJson fails on non-JSON", () => {
  const r = extractLastJson("no json here at all");
  expect(r.ok).toBe(false);
});

test("enforceSchema returns canonical JSON on success and errors + raw on failure", () => {
  const ok = enforceSchema('{"status":"ok","count":2}', schema);
  expect(ok.ok).toBe(true);
  if (ok.ok) expect(JSON.parse(ok.json)).toEqual({ status: "ok", count: 2 });

  const bad = enforceSchema("I could not produce the JSON.", schema);
  expect(bad.ok).toBe(false);
  if (!bad.ok) {
    expect(bad.errors.length).toBeGreaterThan(0);
    expect(bad.raw).toContain("could not produce");
  }
});
