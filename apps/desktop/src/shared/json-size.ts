/**
 * Estimate the UTF-8 byte length of JSON.stringify(value) without materializing
 * the serialized payload. Returns maxBytes + 1 once the budget is exceeded or
 * when a cyclic / unsupported value cannot be serialized safely.
 */
export function estimateJsonUtf8Bytes(value: unknown, maxBytes: number): number {
  const limit = Math.max(0, Math.trunc(maxBytes));
  const seen = new WeakSet<object>();

  const stringBytes = (text: string): number => {
    let bytes = 2; // surrounding quotes
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09
        || code === 0x0a || code === 0x0c || code === 0x0d) bytes += 2;
      else if (code < 0x20) bytes += 6;
      else if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff
        && index + 1 < text.length
        && text.charCodeAt(index + 1) >= 0xdc00
        && text.charCodeAt(index + 1) <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
      if (bytes > limit) return limit + 1;
    }
    return bytes;
  };

  const visit = (item: unknown, inArray = false): number => {
    if (item === null) return 4;
    if (typeof item === "string") return stringBytes(item);
    if (typeof item === "boolean") return item ? 4 : 5;
    if (typeof item === "number") return Number.isFinite(item) ? String(item).length : 4;
    if (typeof item === "undefined" || typeof item === "function" || typeof item === "symbol") {
      return inArray ? 4 : 0;
    }
    if (typeof item === "bigint" || typeof item !== "object") return limit + 1;
    if (seen.has(item)) return limit + 1;
    seen.add(item);
    let bytes = 2;
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index += 1) {
        if (index > 0) bytes += 1;
        bytes += visit(item[index], true);
        if (bytes > limit) break;
      }
    } else {
      let emitted = 0;
      for (const [key, nested] of Object.entries(item)) {
        if (nested === undefined || typeof nested === "function" || typeof nested === "symbol") continue;
        if (emitted > 0) bytes += 1;
        bytes += stringBytes(key) + 1 + visit(nested);
        emitted += 1;
        if (bytes > limit) break;
      }
    }
    seen.delete(item);
    return bytes > limit ? limit + 1 : bytes;
  };

  return visit(value);
}
