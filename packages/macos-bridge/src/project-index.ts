import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { globalStateDir, SessionStore, stateRoot, type SessionMeta } from "@vibe/core";
import type { Message } from "@vibe/shared";
import type { ProjectSessionSummary, ProjectSummary } from "./protocol.ts";

const TITLE_LIMIT = 72;
const PROJECT_NAME_LIMIT = 80;

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clippedTitle(value: string): string {
  const clean = normalizedText(value);
  if (clean.length <= TITLE_LIMIT) return clean;
  return `${clean.slice(0, TITLE_LIMIT - 1).trimEnd()}…`;
}

function clippedProjectName(value: string): string {
  const clean = normalizedText(value);
  if (clean.length <= PROJECT_NAME_LIMIT) return clean;
  return `${clean.slice(0, PROJECT_NAME_LIMIT - 1).trimEnd()}…`;
}

async function projectDisplayName(cwd: string): Promise<string> {
  try {
    const value = await readFile(join(globalStateDir(cwd), "name"), "utf8");
    const name = clippedProjectName(value);
    if (name) return name;
  } catch {
    /* legacy projects use their directory name */
  }
  return basename(cwd) || cwd;
}

/** Human session label for desktop navigation. */
export function sessionTitle(history: readonly Message[], meta: SessionMeta): string {
  if (meta.title && normalizedText(meta.title)) return clippedTitle(meta.title);
  const firstUserText = history
    .filter((message) => message.role === "user")
    .flatMap((message) => message.parts)
    .find((part) => part.type === "text" && normalizedText(part.text));
  if (firstUserText?.type === "text") return clippedTitle(firstUserText.text);
  if (meta.goal && normalizedText(meta.goal)) return clippedTitle(meta.goal);
  return `Session ${meta.id.slice(0, 8)}`;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function discoveredProjectPaths(root: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const paths = await Promise.all(
    entries.map(async (entry) => {
      try {
        if (await Bun.file(join(root, entry, "archived")).exists()) return null;
        const value = (await readFile(join(root, entry, "path"), "utf8")).trim();
        return value ? resolve(value) : null;
      } catch {
        return null;
      }
    }),
  );
  return paths.filter((path): path is string => Boolean(path));
}

async function isProjectArchived(cwd: string): Promise<boolean> {
  return Bun.file(join(globalStateDir(cwd), "archived")).exists();
}

async function summarizeProject(cwd: string): Promise<ProjectSummary | null> {
  if (!(await isDirectory(cwd)) || (await isProjectArchived(cwd))) return null;
  const store = new SessionStore(cwd);
  let metas: SessionMeta[];
  try {
    metas = await store.list();
  } catch {
    return null;
  }
  const sessions = (
    await Promise.all(
      metas.map(async (meta): Promise<ProjectSessionSummary | null> => {
        try {
          const history = await store.loadHistory(meta.id);
          return {
            id: meta.id,
            title: sessionTitle(history, meta),
            model: meta.model,
            mode: meta.mode,
            goal: meta.goal,
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
          };
        } catch {
          return null;
        }
      }),
    )
  )
    .filter((session): session is ProjectSessionSummary => session !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    cwd,
    name: await projectDisplayName(cwd),
    updatedAt: sessions[0]?.updatedAt ?? 0,
    sessions,
  };
}

export async function renameProject(
  cwd: string,
  rawName: string,
): Promise<{ name: string } | null> {
  const name = clippedProjectName(rawName);
  if (!name || !(await isDirectory(cwd))) return null;
  try {
    const dir = globalStateDir(cwd);
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "path"), `${resolve(cwd)}\n`);
    await Bun.write(join(dir, "name"), `${name}\n`);
    return { name };
  } catch {
    return null;
  }
}

export async function archiveProject(cwd: string): Promise<{ cwd: string } | null> {
  if (!(await isDirectory(cwd))) return null;
  try {
    const dir = globalStateDir(cwd);
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "path"), `${resolve(cwd)}\n`);
    await Bun.write(join(dir, "archived"), "1\n");
    return { cwd: resolve(cwd) };
  } catch {
    return null;
  }
}

export async function deleteProject(cwd: string): Promise<{ cwd: string } | null> {
  if (!(await isDirectory(cwd))) return null;
  try {
    await rm(globalStateDir(cwd), { recursive: true, force: true });
    return { cwd: resolve(cwd) };
  } catch {
    return null;
  }
}

/** Read-only desktop index over all registered vibe-codr project state. */
export async function listProjectSummaries(
  activeCwd: string,
  root = stateRoot(),
): Promise<ProjectSummary[]> {
  const paths = await discoveredProjectPaths(root);
  const ordered = [resolve(activeCwd), ...paths];
  const unique = [...new Set(ordered)];
  const projects = (await Promise.all(unique.map((cwd) => summarizeProject(cwd)))).filter(
    (project): project is ProjectSummary => project !== null,
  );
  return projects.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}
