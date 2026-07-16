/**
 * Project-scoped path safety: lexical resolve + realpath containment so a
 * symlink inside the project cannot escape to read/write outside the root.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

export interface PathSafeFs {
  realpathSync(path: string): string;
  existsSync(path: string): boolean;
  /** When true, target is a regular file (not a directory). */
  isFile(path: string): boolean;
}

export interface WritablePathSafeFs {
  realpathSync(path: string): string;
  existsSync(path: string): boolean;
  lstatSync(path: string): { isSymbolicLink(): boolean };
}

function escapesRoot(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Resolve `path` under `cwd` and ensure the real path stays inside the real
 * project root. Rejects absolute/parent escapes and symlink escapes.
 */
export function resolvePathInsideRoot(
  cwd: string,
  path: string,
  fs: PathSafeFs,
): { ok: true; root: string; target: string } | { ok: false; error: string } {
  if (typeof cwd !== "string" || !cwd || typeof path !== "string" || !path) {
    return { ok: false, error: "Invalid path" };
  }
  const rootLex = resolve(cwd);
  const targetLex = resolve(rootLex, path);
  const rel = relative(rootLex, targetLex);
  if (escapesRoot(rel)) {
    return { ok: false, error: "Path escapes the project" };
  }
  let rootReal: string;
  let targetReal: string;
  try {
    rootReal = fs.realpathSync(rootLex);
  } catch {
    return { ok: false, error: "Project root not found" };
  }
  try {
    targetReal = fs.realpathSync(targetLex);
  } catch {
    return { ok: false, error: "File not found" };
  }
  const realRel = relative(rootReal, targetReal);
  if (escapesRoot(realRel)) {
    return { ok: false, error: "Path escapes the project" };
  }
  if (!fs.existsSync(targetReal) || !fs.isFile(targetReal)) {
    return { ok: false, error: "File not found" };
  }
  return { ok: true, root: rootReal, target: targetReal };
}

/**
 * Resolve a future read/write target under a project root without following a
 * project-owned symlink component. The root itself may be a symlink (opening a
 * project through a Finder alias is legitimate); descendants may not redirect
 * privileged main-process I/O outside that canonical root.
 */
export function resolveWritablePathInsideRoot(
  cwd: string,
  path: string,
  fs: WritablePathSafeFs,
): { ok: true; root: string; target: string } | { ok: false; error: string } {
  if (typeof cwd !== "string" || !cwd || typeof path !== "string" || !path) {
    return { ok: false, error: "Invalid path" };
  }
  const rootLex = resolve(cwd);
  const targetLex = resolve(rootLex, path);
  const rel = relative(rootLex, targetLex);
  if (escapesRoot(rel)) return { ok: false, error: "Path escapes the project" };

  let rootReal: string;
  try {
    rootReal = fs.realpathSync(rootLex);
  } catch {
    return { ok: false, error: "Project root not found" };
  }

  let cursor = rootLex;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    if (!fs.existsSync(cursor)) break;
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) {
        return { ok: false, error: "Project path uses a symbolic link" };
      }
      const cursorReal = fs.realpathSync(cursor);
      if (escapesRoot(relative(rootReal, cursorReal))) {
        return { ok: false, error: "Path escapes the project" };
      }
    } catch {
      return { ok: false, error: "Project path could not be inspected" };
    }
  }
  return { ok: true, root: rootReal, target: targetLex };
}
