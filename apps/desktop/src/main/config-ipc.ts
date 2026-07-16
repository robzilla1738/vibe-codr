/**
 * Config IPC handlers for the Electron main process.
 *
 * Registers `config:*` and `memory:*` IPC channels so the renderer's Settings
 * panel can read/write the vibe-codr config files and memory (VIBE.md) files
 * directly. The engine reads these on bootstrap, so changes take effect on the
 * next session — or immediately via `run-slash` for the subset the engine
 * supports live.
 */

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { ipcMain } from "electron";
import {
  configPathForScope,
  readConfigFile,
  readMemoryFile,
  writeConfigFileValidated,
  writeMemoryFile,
  memoryPathForScope,
} from "../shared/config-io";
import { validateConfig } from "../shared/config-validate";
import type {
  ConfigReadResult,
  ConfigScope,
  ConfigWriteRequest,
  MemoryFileRequest,
  MemoryFileResult,
  MemoryWriteRequest,
} from "../shared/config-schema";
import type { AssertTrustedIpc } from "./ipc-security";
import { isAllowedCwd } from "../shared/cwd-allowlist";
import { resolveWritablePathInsideRoot } from "../shared/path-safe";

function projectCwdGuard(scope: ConfigScope, cwd?: string): string | null {
  if (scope !== "project") return null;
  if (typeof cwd !== "string" || !cwd) return "Project scope requires a cwd";
  if (!isAllowedCwd(cwd)) return "cwd is not an opened project root";
  return null;
}

function scopedPath(
  scope: ConfigScope,
  cwd: string | undefined,
  kind: "config" | "memory",
): string {
  if (scope === "global") {
    return kind === "config"
      ? configPathForScope(scope)
      : memoryPathForScope(scope);
  }
  if (!cwd) throw new Error("Project scope requires a cwd");
  const relativePath = kind === "config" ? ".vibe/config.json" : "VIBE.md";
  const located = resolveWritablePathInsideRoot(cwd, relativePath, {
    existsSync,
    lstatSync,
    realpathSync,
  });
  if (!located.ok) throw new Error(located.error);
  return located.target;
}

export function registerConfigIpc(assertTrusted: AssertTrustedIpc): void {
  ipcMain.handle("config:read", async (event, opts: { scope: ConfigScope; cwd?: string }) => {
    assertTrusted(event);
    if (!opts || (opts.scope !== "global" && opts.scope !== "project")) {
      return { ok: false as const, error: "Invalid scope" };
    }
    const guard = projectCwdGuard(opts.scope, opts.cwd);
    if (guard) return { ok: false as const, error: guard };
    try {
      const path = scopedPath(opts.scope, opts.cwd, "config");
      const read = await readConfigFile(path);
      if (!read) {
        return { ok: true as const, config: {}, path, raw: "" } as ConfigReadResult;
      }
      return { ok: true as const, config: read.config, path, raw: read.raw } as ConfigReadResult;
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("config:write", async (event, req: ConfigWriteRequest) => {
    assertTrusted(event);
    if (
      !req ||
      (req.scope !== "global" && req.scope !== "project") ||
      !req.patch ||
      typeof req.patch !== "object" ||
      Array.isArray(req.patch)
    ) {
      return { ok: false as const, error: "Invalid write request" };
    }
    const guard = projectCwdGuard(req.scope, req.cwd);
    if (guard) return { ok: false as const, error: guard };
    try {
      const path = scopedPath(req.scope, req.cwd, "config");
      // Single critical section: read → merge → validate → write under the
      // per-path lock so concurrent saves cannot persist an unvalidated merge.
      const result = await writeConfigFileValidated(path, req.patch, validateConfig);
      if (!result.ok) return { ok: false as const, error: result.error };
      return { ok: true as const, path };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("config:globalPath", (event) => {
    assertTrusted(event);
    return configPathForScope("global");
  });

  ipcMain.handle("config:projectPath", (event, cwd: string) => {
    assertTrusted(event);
    if (typeof cwd !== "string" || !cwd) {
      throw new Error("Project config path requires a cwd");
    }
    const guard = projectCwdGuard("project", cwd);
    if (guard) throw new Error(guard);
    return scopedPath("project", cwd, "config");
  });

  // ── Memory (VIBE.md / custom instructions) ───────────────────────────

  ipcMain.handle("memory:read", async (event, opts: MemoryFileRequest) => {
    assertTrusted(event);
    if (!opts || (opts.scope !== "global" && opts.scope !== "project")) {
      return { ok: false as const, error: "Invalid scope" };
    }
    const guard = projectCwdGuard(opts.scope, opts.cwd);
    if (guard) return { ok: false as const, error: guard };
    try {
      const path = scopedPath(opts.scope, opts.cwd, "memory");
      const read = await readMemoryFile(path);
      return { ok: true as const, path, content: read.content, exists: read.exists } as MemoryFileResult;
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("memory:write", async (event, req: MemoryWriteRequest) => {
    assertTrusted(event);
    if (!req || (req.scope !== "global" && req.scope !== "project") || typeof req.content !== "string") {
      return { ok: false as const, error: "Invalid write request" };
    }
    const guard = projectCwdGuard(req.scope, req.cwd);
    if (guard) return { ok: false as const, error: guard };
    try {
      const path = scopedPath(req.scope, req.cwd, "memory");
      await writeMemoryFile(path, req.content);
      return { ok: true as const, path };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
