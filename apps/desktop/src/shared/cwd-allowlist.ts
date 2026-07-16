/**
 * Allowlist of project roots the renderer may use for git/config/fs IPC.
 * Defense-in-depth against a compromised renderer pointing cwd at arbitrary trees.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";

/** True when `candidate` is the root itself or a descendant of it. */
export function pathIsInsideRoot(candidate: string, root: string): boolean {
  if (typeof candidate !== "string" || !candidate || typeof root !== "string" || !root) {
    return false;
  }
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Resolve existing paths so a symlinked project child cannot widen an IPC
 * capability outside the root. Non-existent paths retain lexical behavior and
 * are rejected later by the operation that requires them to exist. */
function canonicalPath(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

export class CwdAllowlist {
  private roots = new Set<string>();

  constructor(initial: readonly string[] = []) {
    for (const r of initial) this.add(r);
  }

  add(cwd: string): void {
    if (typeof cwd !== "string" || !cwd) return;
    this.roots.add(canonicalPath(cwd));
  }

  has(cwd: string): boolean {
    if (typeof cwd !== "string" || !cwd) return false;
    const abs = canonicalPath(cwd);
    if (this.roots.has(abs)) return true;
    // Also allow paths under an allowed root (subdirs of an opened project).
    for (const root of this.roots) {
      if (pathIsInsideRoot(abs, root)) return true;
    }
    return false;
  }

  hasExact(cwd: string): boolean {
    return typeof cwd === "string" && Boolean(cwd) && this.roots.has(canonicalPath(cwd));
  }

  snapshot(): string[] {
    return [...this.roots];
  }
}

/** Shared process-wide allowlist used by main IPC handlers. */
export const projectCwdAllowlist = new CwdAllowlist();

export function assertAllowedCwd(cwd: string, label = "cwd"): void {
  if (!projectCwdAllowlist.has(cwd)) {
    throw new Error(`${label} is not an opened project root`);
  }
}

export function isAllowedCwd(cwd: string): boolean {
  return projectCwdAllowlist.has(cwd);
}

export function isAllowedProjectRoot(cwd: string): boolean {
  return projectCwdAllowlist.hasExact(cwd);
}

/**
 * Finder Reveal accepts opened projects wherever they live (including external
 * volumes) plus the app's own process-scoped clipboard directory. It must not
 * grant broad access to every file under the user's home or the system temp
 * directory.
 */
export function isAllowedRevealPath(
  path: string,
  clipboardRoot: string,
  allowlist = projectCwdAllowlist,
): boolean {
  if (typeof path !== "string" || !path) return false;
  return allowlist.has(path) || pathIsInsideRoot(path, clipboardRoot);
}

/** Terminal additionally permits the exact user home used by one-off Chats. */
export function isAllowedTerminalCwd(cwd: string, home = homedir()): boolean {
  if (typeof cwd !== "string" || !cwd) return false;
  return resolve(cwd) === resolve(home) || projectCwdAllowlist.has(cwd);
}
