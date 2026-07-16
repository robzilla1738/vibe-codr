/**
 * Renderer-owned projection of permission input.
 *
 * Permission decisions are sent back by request id; the engine retains the
 * authoritative tool input. The renderer therefore needs only enough input to
 * explain the decision safely. Keeping the raw payload let one valid inbound
 * NDJSON line pin several MiB in React state until the user answered it.
 */

const MAX_DEPTH = 12;
const MAX_COLLECTION_ITEMS = 200;
const MAX_NODES = 2_000;
const MAX_STRING_CHARS = 128 * 1024;
const MAX_TOTAL_STRING_CHARS = 256 * 1024;
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const NESTED_OMISSION = "… nested input omitted …";
const BUDGET_OMISSION = "… additional input omitted …";

interface Budget {
  nodes: number;
  stringChars: number;
}

function boundedText(value: string, budget: Budget): string {
  const allowed = Math.min(MAX_STRING_CHARS, budget.stringChars);
  if (value.length <= allowed) {
    budget.stringChars -= value.length;
    return value;
  }
  if (allowed < 96) {
    budget.stringChars = 0;
    return `… ${value.length} characters omitted …`;
  }
  const marker = `\n… ${value.length - allowed} middle characters omitted …\n`;
  const kept = Math.max(2, allowed - marker.length);
  const head = Math.ceil(kept / 2);
  const tail = Math.floor(kept / 2);
  budget.stringChars -= allowed;
  return `${value.slice(0, head)}${marker}${value.slice(-tail)}`;
}

function arrayIndices(length: number): { indices: number[]; omitted: number } {
  if (length <= MAX_COLLECTION_ITEMS) {
    return { indices: Array.from({ length }, (_, index) => index), omitted: 0 };
  }
  const half = MAX_COLLECTION_ITEMS / 2;
  return {
    indices: [
      ...Array.from({ length: half }, (_, index) => index),
      ...Array.from({ length: half }, (_, index) => length - half + index),
    ],
    omitted: length - MAX_COLLECTION_ITEMS,
  };
}

/** Collect the first and last keys without allocating every key in a hostile object. */
function objectKeys(value: Record<string, unknown>): { keys: string[]; omitted: number } {
  const half = MAX_COLLECTION_ITEMS / 2;
  const head: string[] = [];
  const tail = new Array<string>(half);
  let tailSeen = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key) || RESERVED_KEYS.has(key)) continue;
    if (head.length < half) {
      head.push(key);
    } else {
      tail[tailSeen % half] = key;
      tailSeen += 1;
    }
  }
  const tailCount = Math.min(tailSeen, half);
  let orderedTail: string[];
  if (tailSeen <= half) {
    orderedTail = tail.slice(0, tailCount);
  } else {
    const start = tailSeen % half;
    orderedTail = [...tail.slice(start), ...tail.slice(0, start)];
  }
  return {
    keys: [...head, ...orderedTail],
    omitted: Math.max(0, tailSeen - tailCount),
  };
}

function omittedKey(output: Record<string, unknown>, source: Record<string, unknown>): string {
  let key = "… omitted fields …";
  while (Object.hasOwn(output, key) || Object.hasOwn(source, key)) key += " ";
  return key;
}

function project(value: unknown, budget: Budget, depth: number): unknown {
  if (budget.nodes <= 0) return BUDGET_OMISSION;
  budget.nodes -= 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return boundedText(value, budget);
  if (typeof value !== "object") return String(value);
  if (depth >= MAX_DEPTH) return NESTED_OMISSION;

  if (Array.isArray(value)) {
    const { indices, omitted } = arrayIndices(value.length);
    const output: unknown[] = [];
    const split = omitted > 0 ? MAX_COLLECTION_ITEMS / 2 : -1;
    for (let position = 0; position < indices.length; position += 1) {
      if (position === split) output.push(`… ${omitted} middle items omitted …`);
      if (budget.nodes <= 0) {
        output.push(BUDGET_OMISSION);
        break;
      }
      output.push(project(value[indices[position]!], budget, depth + 1));
    }
    return output;
  }

  const source = value as Record<string, unknown>;
  const { keys, omitted } = objectKeys(source);
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (budget.nodes <= 0) {
      output[omittedKey(output, source)] = BUDGET_OMISSION;
      return output;
    }
    output[key] = project(source[key], budget, depth + 1);
  }
  if (omitted > 0) output[omittedKey(output, source)] = `${omitted} middle fields omitted`;
  return output;
}

/** Keep approval-visible input bounded while preserving dangerous head and tail content. */
export function permissionInputForDisplay(input: unknown): unknown {
  return project(input, { nodes: MAX_NODES, stringChars: MAX_TOTAL_STRING_CHARS }, 0);
}
