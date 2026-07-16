/**
 * Validate git ref/branch/remote names so user-controlled strings cannot be
 * interpreted as git CLI options (leading `-`) or path tricks.
 */

/** Reject empty, leading-dash, and obviously unsafe ref tokens. */
export function assertGitRef(name: string, label = "ref"): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  if (trimmed.startsWith("-")) {
    throw new Error(`${label} must not start with '-' (would be parsed as a git option)`);
  }
  if (trimmed.includes("\0") || trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new Error(`${label} contains invalid control characters`);
  }
  // Git disallows these in ref names (simplified; full rules are more complex).
  if (trimmed.includes("..") || trimmed.includes("@{") || trimmed.endsWith(".lock")) {
    throw new Error(`${label} is not a valid git reference name`);
  }
  if (trimmed.includes("\\") || trimmed.includes("~") || trimmed.includes("^") || trimmed.includes(":")) {
    throw new Error(`${label} contains forbidden characters`);
  }
  if (trimmed === "@") throw new Error(`${label} is not a valid git reference name`);
  return trimmed;
}

export function assertGitRemote(name: string): string {
  return assertGitRef(name, "remote");
}

/** True when a string is a safe ref (for UI pre-checks without try/catch). */
export function isSafeGitRef(name: string): boolean {
  try {
    assertGitRef(name);
    return true;
  } catch {
    return false;
  }
}
