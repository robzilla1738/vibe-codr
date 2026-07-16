/** Parse the Settings line editor into the ordered, duplicate-free plugin list. */
export function pluginSpecifiersFromLines(value: string): string[] {
  const seen = new Set<string>();
  const specifiers: string[] = [];
  for (const line of value.split("\n")) {
    const specifier = line.trim();
    if (!specifier || seen.has(specifier)) continue;
    seen.add(specifier);
    specifiers.push(specifier);
  }
  return specifiers;
}

/** Validate already-parsed config entries without silently changing file intent. */
export function validatePluginSpecifiers(specifiers: string[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < specifiers.length; index += 1) {
    const specifier = specifiers[index]!;
    const path = `plugins[${index}]`;
    if (!specifier.trim()) {
      errors.push(`${path}: must not be empty`);
      continue;
    }
    if (specifier !== specifier.trim()) {
      errors.push(`${path}: must not have leading or trailing whitespace`);
    }
    if (/\p{Cc}/u.test(specifier)) {
      errors.push(`${path}: must not contain control characters`);
    }
    if (seen.has(specifier)) {
      errors.push(`${path}: duplicates an earlier plugin module`);
    } else {
      seen.add(specifier);
    }
  }
  return errors;
}
