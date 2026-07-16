/**
 * Deep-diff patch builder for the Settings panel.
 *
 * The Settings panel edits an in-memory config object and, on Save, needs to
 * persist only the CHANGED keys. The engine's `writeConfigFile` (and
 * `@vibe/config`'s `writeGlobalConfig`) deep-merge a patch where:
 *   - `undefined` is a no-op (key untouched)
 *   - `null`     DELETES the key
 *   - any other value SETS / deep-merges into the key
 *
 * A naïve "send the whole config" patch breaks the clear/unset flow: when a
 * section clears a field it sets the in-memory value to `undefined`, and
 * `undefined` is a no-op in the merge — so the on-disk value survives and the
 * user can never unset an API key, accent color, or model string. Computing a
 * real diff fixes this: a key that was present in the original but is now
 * absent/undefined becomes `null` (delete) in the patch.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const RESERVED_CONFIG_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Apply the same null-delete/deep-merge semantics used by config writes. */
export function applyConfigPatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (RESERVED_CONFIG_KEYS.has(key) || value === undefined) continue;
    if (value === null) {
      delete output[key];
      continue;
    }
    const current = output[key];
    output[key] = isPlainObject(current) && isPlainObject(value)
      ? applyConfigPatch(current, value)
      : value;
  }
  return output;
}

/** Structural deep equality — avoids JSON.stringify key-order / undefined quirks. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    if (Array.isArray(a) || Array.isArray(b)) return false;
    const ak = Object.keys(a as object).sort();
    const bk = Object.keys(b as object).sort();
    if (ak.length !== bk.length) return false;
    if (!ak.every((k, i) => k === bk[i])) return false;
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    return ak.every((k) => deepEqual(ao[k], bo[k]));
  }
  return false;
}

/**
 * Compute the patch value for a single key path.
 *
 * @returns `undefined` when nothing changed (caller omits the key), `null` when
 * the key should be deleted, or the value/sub-diff to set.
 */
function diffValue(original: unknown, current: unknown): unknown {
  const origDefined = original !== undefined && original !== null;
  const currDefined = current !== undefined && current !== null;

  // Both absent → no change.
  if (!origDefined && !currDefined) return undefined;

  // Was present, now cleared → delete.
  if (origDefined && !currDefined) return null;

  // Was absent, now set. For a newly-created object, recurse against an empty
  // object so transient `undefined` leaves do not turn a cleared form field
  // into a meaningless persisted `{}` block.
  if (!origDefined && currDefined) {
    if (isPlainObject(current)) {
      if (Object.keys(current).length === 0) return {};
      return diffValue({}, current);
    }
    return current;
  }

  // Both present — recurse into plain objects, compare everything else by value.
  if (isPlainObject(original) && isPlainObject(current)) {
    const diff: Record<string, unknown> = {};
    const keys = new Set([...Object.keys(original), ...Object.keys(current)]);
    let changed = false;
    for (const key of keys) {
      const sub = diffValue(
        (original as Record<string, unknown>)[key],
        (current as Record<string, unknown>)[key],
      );
      if (sub !== undefined) {
        diff[key] = sub;
        changed = true;
      }
    }
    return changed ? diff : undefined;
  }

  // Primitives, arrays, or a type mismatch — replace if different.
  return deepEqual(original, current) ? undefined : current;
}

/**
 * Build a merge-patch from the original (on-disk) config to the edited
 * (in-memory) config. Only changed key paths appear; cleared values become
 * `null` so the engine's `mergeForWrite` deletes them.
 */
export function buildConfigPatch(
  original: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(original), ...Object.keys(current)]);
  for (const key of keys) {
    const sub = diffValue(original[key], current[key]);
    if (sub !== undefined) diff[key] = sub;
  }
  return diff;
}
