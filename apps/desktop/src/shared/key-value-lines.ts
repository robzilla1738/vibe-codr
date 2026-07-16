export type KeyValueParseResult =
  | { ok: true; value: Record<string, string> }
  | { ok: false; error: string };

/** Parse one `key<separator>value` entry per line without dropping partial input. */
export function parseKeyValueLines(
  input: string,
  separator: "=" | ":",
  opts: { trimValues?: boolean } = {},
): KeyValueParseResult {
  const value: Record<string, string> = {};
  const lines = input.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    const delimiter = line.indexOf(separator);
    if (delimiter < 1) {
      return { ok: false, error: `Line ${index + 1} must use KEY${separator}value` };
    }
    const key = line.slice(0, delimiter).trim();
    if (!key) return { ok: false, error: `Line ${index + 1} needs a key` };
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      return { ok: false, error: `Line ${index + 1} uses a reserved key` };
    }
    if (Object.hasOwn(value, key)) {
      return { ok: false, error: `Line ${index + 1} duplicates “${key}”` };
    }
    const raw = line.slice(delimiter + 1);
    value[key] = opts.trimValues ? raw.trim() : raw;
  }
  return { ok: true, value };
}

export function formatKeyValueLines(
  value: Readonly<Record<string, string>>,
  separator: "=" | ":",
): string {
  const spacer = separator === ":" ? " " : "";
  return Object.entries(value).map(([key, entry]) => `${key}${separator}${spacer}${entry}`).join("\n");
}
