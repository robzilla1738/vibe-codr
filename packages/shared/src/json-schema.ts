type JsonSchemaLike = Readonly<Record<string, unknown>>;

/**
 * Validate a value against the common JSON-Schema subset used by tool and
 * structured-output contracts. Unknown keywords are deliberately ignored so
 * an extension is never rejected merely because this lightweight validator
 * does not implement an exotic annotation or composition keyword.
 */
export function validateJsonSchema(schema: JsonSchemaLike, value: unknown, path = ""): string[] {
  const errors: string[] = [];
  const at = path || "(root)";

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((entry) => deepEqual(entry, value))) {
      errors.push(
        `${at}: value ${short(value)} is not one of the allowed values ${short(schema.enum)}`,
      );
      return errors;
    }
  }
  if ("const" in schema && !deepEqual(schema.const, value)) {
    errors.push(`${at}: value ${short(value)} must equal ${short(schema.const)}`);
    return errors;
  }

  const types = normalizeTypes(schema.type);
  if (types.length && !types.some((type) => matchesType(type, value))) {
    errors.push(`${at}: expected ${types.join(" | ")}, got ${jsonType(value)}`);
    return errors;
  }

  const effectiveType = types.find((type) => matchesType(type, value)) ?? jsonType(value);
  if (effectiveType === "object" && isPlainObject(value)) {
    const properties = isPlainObject(schema.properties)
      ? (schema.properties as JsonSchemaLike)
      : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : [];
    for (const key of required) {
      if (!hasOwn(value, key)) errors.push(`${joinPath(path, key)}: required property is missing`);
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (hasOwn(value, key) && isPlainObject(childSchema)) {
        errors.push(
          ...validateJsonSchema(childSchema as JsonSchemaLike, value[key], joinPath(path, key)),
        );
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!hasOwn(properties, key)) {
          errors.push(
            `${joinPath(path, key)}: unexpected property (additionalProperties is false)`,
          );
        }
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
      value.forEach((item, index) => {
        errors.push(
          ...validateJsonSchema(schema.items as JsonSchemaLike, item, `${path}[${index}]`),
        );
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

function normalizeTypes(type: unknown): string[] {
  if (typeof type === "string") return [type];
  if (Array.isArray(type))
    return type.filter((entry): entry is string => typeof entry === "string");
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
      return true;
  }
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(object: object, key: string): boolean {
  return Object.hasOwn(object, key);
}

function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((entry, index) => deepEqual(entry, right[index]))
    );
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => hasOwn(right, key) && deepEqual(left[key], right[key]))
    );
  }
  return false;
}

function short(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}
