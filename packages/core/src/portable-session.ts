import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix, resolve, sep } from "node:path";
import type {
  ExecutionTarget,
  HandoffPreparation,
  PendingCapabilityRequest,
  PortableSessionArchiveV1,
  PortableSessionFileV1,
} from "@vibe/shared";
import { withCheckpointFileLock } from "./checkpoints.ts";
import { isTaskReportFileName, sessionReportFilePrefix } from "./build/journal.ts";
import { globalStateDir } from "./state-dir.ts";
import { isSafeSessionId } from "./store.ts";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Base64 expansion keeps the full RPC response below the desktop's 32 MiB line cap. */
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const OWNERSHIP_FILE = "handoff-ownership.json";

interface OwnershipRecord {
  generation: number;
  owner: ExecutionTarget;
  state: "owned" | "prepared";
  nonce?: string;
  previousOwner?: ExecutionTarget;
  updatedAt: number;
}

interface ImportJournalV1 {
  schemaVersion: 1;
  phase: "importing";
  sessionId: string;
  ownershipGeneration: number;
  incomingReportNames: string[];
  hadSession: boolean;
  hadPlan: boolean;
  hadEvents: boolean;
  hadLegacyEvents: boolean;
  hadCheckpoints: boolean;
}

interface PortableCheckpoint {
  id: string;
  sessionId?: string;
  [key: string]: unknown;
}

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function orchestrationTag(id: string): string {
  const sanitized = id.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 64);
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${sanitized}-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

function assertPortablePath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new Error(`unsafe portable path: ${path}`);
  }
  const normalized = posix.normalize(path);
  if (normalized !== path || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`unsafe portable path: ${path}`);
  }
}

function canonicalArchiveHash(files: PortableSessionFileV1[]): string {
  return sha256(files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}\n`).join(""));
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

async function copyIfPresent(source: string, destination: string): Promise<boolean> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: info.isDirectory() });
  return true;
}

async function readCheckpoints(path: string): Promise<PortableCheckpoint[]> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(value)) throw new Error("invalid checkpoints file");
    return value as PortableCheckpoint[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function replaceSessionCheckpoints(
  state: string,
  sessionId: string,
  incoming: PortableCheckpoint[],
): Promise<void> {
  const path = join(state, "checkpoints.json");
  await withCheckpointFileLock(path, async () => {
    const current = await readCheckpoints(path);
    const byId = new Map(
      current.filter((item) => item.sessionId !== sessionId).map((item) => [item.id, item]),
    );
    for (const item of incoming) byId.set(item.id, item);
    const next = [...byId.values()];
    if (next.length) await atomicJson(path, next);
    else await rm(path, { force: true });
  });
}

async function readOwnership(path: string): Promise<OwnershipRecord> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<OwnershipRecord>;
    if (!Number.isSafeInteger(parsed.generation) || (parsed.generation ?? -1) < 0)
      throw new Error();
    if (parsed.state !== "owned" && parsed.state !== "prepared") throw new Error();
    if (!parsed.owner || (parsed.owner.kind !== "local" && parsed.owner.kind !== "cloud"))
      throw new Error();
    return parsed as OwnershipRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("invalid handoff ownership record");
    }
    return { generation: 0, owner: { kind: "local" }, state: "owned", updatedAt: 0 };
  }
}

async function collectFile(
  absolute: string,
  logical: string,
  files: PortableSessionFileV1[],
  budget: { bytes: number },
): Promise<void> {
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) return;
  if (stat.size > MAX_FILE_BYTES) throw new Error(`portable state file exceeds 8 MiB: ${logical}`);
  budget.bytes += stat.size;
  if (budget.bytes > MAX_ARCHIVE_BYTES) throw new Error("portable session archive exceeds 20 MiB");
  const data = await readFile(absolute);
  files.push({
    path: logical,
    bytes: data.byteLength,
    sha256: sha256(data),
    contentBase64: data.toString("base64"),
  });
}

async function collectTree(
  absolute: string,
  logical: string,
  files: PortableSessionFileV1[],
  budget: { bytes: number },
  accept: (name: string) => boolean = () => true,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!accept(entry.name)) continue;
    const abs = join(absolute, entry.name);
    const rel = posix.join(logical, entry.name);
    if (entry.isDirectory()) await collectTree(abs, rel, files, budget, accept);
    else if (entry.isFile()) await collectFile(abs, rel, files, budget);
  }
}

async function collectValidEventTree(
  absolute: string,
  logical: string,
  files: PortableSessionFileV1[],
  budget: { bytes: number },
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(absolute, entry.name);
    const relative = posix.join(logical, entry.name);
    if (entry.isDirectory()) {
      await collectValidEventTree(path, relative, files, budget);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const stat = await lstat(path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!stat) continue;
    if (stat.size > MAX_FILE_BYTES)
      throw new Error(`portable state file exceeds 8 MiB: ${relative}`);
    try {
      JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT")
        continue;
      throw error;
    }
    await collectFile(path, relative, files, budget);
  }
}

async function collectValidJsonlFile(
  absolute: string,
  logical: string,
  files: PortableSessionFileV1[],
  budget: { bytes: number },
): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile()) return;
  if (stat.size > MAX_FILE_BYTES) throw new Error(`portable state file exceeds 8 MiB: ${logical}`);
  const valid: string[] = [];
  for (const line of (await readFile(absolute, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
      valid.push(line);
    } catch {
      // Legacy orchestration journals tolerate torn best-effort event lines.
    }
  }
  if (!valid.length) return;
  const data = Buffer.from(`${valid.join("\n")}\n`);
  budget.bytes += data.byteLength;
  if (budget.bytes > MAX_ARCHIVE_BYTES) throw new Error("portable session archive exceeds 20 MiB");
  files.push({
    path: logical,
    bytes: data.byteLength,
    sha256: sha256(data),
    contentBase64: data.toString("base64"),
  });
}

async function collectReportNamesFromEvents(
  eventsRoot: string,
  reportsRoot: string,
  sessionId: string,
): Promise<Set<string>> {
  const names = new Set<string>();
  const resolvedReportsRoot = resolve(reportsRoot);
  async function visit(path: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = join(path, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const stat = await lstat(absolute).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!stat) continue;
      if (stat.size > MAX_FILE_BYTES)
        throw new Error(`portable orchestration event exceeds 8 MiB: ${entry.name}`);
      let event: { id?: unknown; reportPath?: unknown };
      try {
        event = JSON.parse(await readFile(absolute, "utf8")) as {
          id?: unknown;
          reportPath?: unknown;
        };
      } catch (error) {
        if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT")
          continue;
        throw error;
      }
      if (typeof event.id !== "string" || typeof event.reportPath !== "string") continue;
      const report = resolve(event.reportPath);
      const name = basename(report);
      if (
        dirname(report) === resolvedReportsRoot &&
        isTaskReportFileName(sessionId, event.id, name)
      ) {
        names.add(name);
      }
    }
  }
  await visit(eventsRoot);
  return names;
}

async function collectSessionReportNames(state: string, sessionId: string): Promise<Set<string>> {
  const reportsRoot = join(state, "orchestration", "reports");
  const names = await collectReportNamesFromEvents(
    join(state, "orchestration", "events", orchestrationTag(sessionId)),
    reportsRoot,
    sessionId,
  );
  const prefix = sessionReportFilePrefix(sessionId);
  for (const name of await listReportFiles(reportsRoot)) {
    if (name.startsWith(prefix)) names.add(name);
  }
  for (const name of await collectReportNamesFromLegacy(
    join(state, "orchestration", `${sessionId}.jsonl`),
    reportsRoot,
    sessionId,
  )) {
    names.add(name);
  }
  return names;
}

async function collectReportNamesFromLegacy(
  path: string,
  reportsRoot: string,
  sessionId: string,
): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    const legacy = await readFile(path, "utf8");
    for (const line of legacy.split("\n")) {
      if (!line.trim()) continue;
      let event: { id?: unknown; reportPath?: unknown };
      try {
        event = JSON.parse(line) as { id?: unknown; reportPath?: unknown };
      } catch {
        continue;
      }
      if (typeof event.id !== "string" || typeof event.reportPath !== "string") continue;
      const report = resolve(event.reportPath);
      const name = basename(report);
      if (
        dirname(report) === resolve(reportsRoot) &&
        isTaskReportFileName(sessionId, event.id, name)
      ) {
        names.add(name);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return names;
}

async function listReportFiles(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    if (entries.some((entry) => !entry.isFile())) {
      throw new Error("portable report archive contains a non-file entry");
    }
    return entries.map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function rebaseJson(
  value: unknown,
  fromRoot: string,
  toRoot: string,
  fromState: string,
  toState: string,
): unknown {
  if (typeof value === "string") {
    if (value === fromState || value.startsWith(`${fromState}${sep}`))
      return toState + value.slice(fromState.length);
    if (value === fromRoot || value.startsWith(`${fromRoot}${sep}`))
      return toRoot + value.slice(fromRoot.length);
    return value;
  }
  if (Array.isArray(value))
    return value.map((item) => rebaseJson(item, fromRoot, toRoot, fromState, toState));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      rebaseJson(item, fromRoot, toRoot, fromState, toState),
    ]),
  );
}

function rebaseStructuredFile(
  path: string,
  data: Buffer,
  archive: PortableSessionArchiveV1,
  targetRoot: string,
): Buffer {
  if (!(path.endsWith(".json") || path.endsWith(".jsonl"))) return data;
  const targetState = globalStateDir(targetRoot);
  try {
    if (path.endsWith(".jsonl")) {
      const lines = data
        .toString("utf8")
        .split("\n")
        .map((line) => {
          if (!line.trim()) return line;
          return JSON.stringify(
            rebaseJson(
              JSON.parse(line),
              archive.sourceRoot,
              targetRoot,
              archive.sourceStateRoot,
              targetState,
            ),
          );
        });
      return Buffer.from(lines.join("\n"));
    }
    return Buffer.from(
      `${JSON.stringify(rebaseJson(JSON.parse(data.toString("utf8")), archive.sourceRoot, targetRoot, archive.sourceStateRoot, targetState), null, 2)}\n`,
    );
  } catch {
    throw new Error(`invalid structured portable state: ${path}`);
  }
}

export class PortableSessionManager {
  readonly #cwd: string;
  readonly #sessionId: string;
  readonly #state: string;
  readonly #sessionDir: string;
  readonly #ownershipPath: string;

  constructor(cwd: string, sessionId: string) {
    if (!isSafeSessionId(sessionId)) throw new Error("invalid session id");
    this.#cwd = resolve(cwd);
    this.#sessionId = sessionId;
    this.#state = globalStateDir(this.#cwd);
    this.#sessionDir = join(this.#state, "sessions", sessionId);
    this.#ownershipPath = join(this.#sessionDir, OWNERSHIP_FILE);
  }

  static async assertOwner(
    cwd: string,
    sessionId: string,
    expected: ExecutionTarget,
  ): Promise<void> {
    const manager = new PortableSessionManager(cwd, sessionId);
    await withCheckpointFileLock(
      PortableSessionManager.#importLock(manager.#state, sessionId),
      async () => {
        const pendingImport = await PortableSessionManager.#hasPendingImport(
          manager.#state,
          sessionId,
        );
        const ownership = await readOwnership(manager.#ownershipPath);
        if (pendingImport) {
          try {
            await PortableSessionManager.#readImportJournal(
              PortableSessionManager.#importJournal(
                manager.#state,
                sessionId,
                ownership.generation,
              ),
              sessionId,
              ownership.generation,
            );
          } catch {
            throw new Error("portable import recovery is pending for this session");
          }
        }
        if (ownership.state !== "owned")
          throw new Error("session handoff is prepared but not committed");
        const sameOwner =
          ownership.owner.kind === expected.kind &&
          (ownership.owner.kind === "local" ||
            ownership.owner.provider ===
              (expected as Extract<ExecutionTarget, { kind: "cloud" }>).provider);
        if (!sameOwner) {
          throw new Error(
            `session is owned by ${ownership.owner.kind === "local" ? "local" : `cloud/${ownership.owner.provider}`}`,
          );
        }
      },
    );
  }

  async prepare(target: ExecutionTarget, expectedGeneration?: number): Promise<HandoffPreparation> {
    return withCheckpointFileLock(
      PortableSessionManager.#importLock(this.#state, this.#sessionId),
      async () => {
        if (await PortableSessionManager.#hasPendingImport(this.#state, this.#sessionId)) {
          throw new Error("portable import recovery is pending for this session");
        }
        const current = await readOwnership(this.#ownershipPath);
        if (current.state === "prepared")
          throw new Error("a handoff is already prepared for this session");
        if (expectedGeneration !== undefined && current.generation !== expectedGeneration) {
          throw new Error(
            `stale ownership generation: expected ${expectedGeneration}, current ${current.generation}`,
          );
        }
        const nonce = randomUUID();
        const next: OwnershipRecord = {
          generation: current.generation + 1,
          owner: target,
          previousOwner: current.owner,
          state: "prepared",
          nonce,
          updatedAt: Date.now(),
        };
        await atomicJson(this.#ownershipPath, next);
        return {
          sessionId: this.#sessionId,
          ownershipGeneration: next.generation,
          previousGeneration: current.generation,
          nonce,
          target,
          preparedAt: next.updatedAt,
        };
      },
    );
  }

  async commit(nonce: string): Promise<void> {
    await withCheckpointFileLock(
      PortableSessionManager.#importLock(this.#state, this.#sessionId),
      async () => {
        const current = await readOwnership(this.#ownershipPath);
        if (current.state !== "prepared" || current.nonce !== nonce)
          throw new Error("handoff preparation is stale");
        await atomicJson(this.#ownershipPath, {
          generation: current.generation,
          owner: current.owner,
          state: "owned",
          updatedAt: Date.now(),
        } satisfies OwnershipRecord);
      },
    );
  }

  async abort(nonce: string): Promise<void> {
    await withCheckpointFileLock(
      PortableSessionManager.#importLock(this.#state, this.#sessionId),
      async () => {
        const current = await readOwnership(this.#ownershipPath);
        if (current.state !== "prepared" || current.nonce !== nonce)
          throw new Error("handoff preparation is stale");
        await atomicJson(this.#ownershipPath, {
          generation: current.generation - 1,
          owner: current.previousOwner ?? { kind: "local" },
          state: "owned",
          updatedAt: Date.now(),
        } satisfies OwnershipRecord);
      },
    );
  }

  async abortInterrupted(
    target: ExecutionTarget,
    expectedGeneration?: number,
  ): Promise<number> {
    return withCheckpointFileLock(
      PortableSessionManager.#importLock(this.#state, this.#sessionId),
      async () => {
        const current = await readOwnership(this.#ownershipPath);
        const targetMatches =
          current.owner.kind === target.kind &&
          (current.owner.kind !== "cloud" ||
            (target.kind === "cloud" && current.owner.provider === target.provider));
        if (current.state !== "prepared" || !targetMatches) {
          throw new Error("interrupted handoff does not match the prepared owner");
        }
        if (expectedGeneration !== undefined && current.generation !== expectedGeneration) {
          throw new Error(
            `stale ownership generation: expected ${expectedGeneration}, current ${current.generation}`,
          );
        }
        const generation = current.generation - 1;
        await atomicJson(this.#ownershipPath, {
          generation,
          owner: current.previousOwner ?? { kind: "local" },
          state: "owned",
          updatedAt: Date.now(),
        } satisfies OwnershipRecord);
        return generation;
      },
    );
  }

  async recoverLostCloudOwnership(provider: "e2b" | "vercel", expectedGeneration: number): Promise<number> {
    return withCheckpointFileLock(
      PortableSessionManager.#importLock(this.#state, this.#sessionId),
      async () => {
        if (await PortableSessionManager.#hasPendingImport(this.#state, this.#sessionId)) {
          throw new Error("portable import recovery is pending for this session");
        }
        const current = await readOwnership(this.#ownershipPath);
        if (current.state !== "owned" || current.owner.kind !== "cloud" || current.owner.provider !== provider) {
          throw new Error("lost-cloud recovery does not match the current session owner");
        }
        if (current.generation !== expectedGeneration) {
          throw new Error(`stale ownership generation: expected ${expectedGeneration}, current ${current.generation}`);
        }
        const generation = current.generation + 1;
        await atomicJson(this.#ownershipPath, {
          generation,
          owner: { kind: "local" },
          state: "owned",
          updatedAt: Date.now(),
        } satisfies OwnershipRecord);
        return generation;
      },
    );
  }

  async export(
    engineRevision: string,
    ownershipGeneration: number,
    pendingCapabilities: PendingCapabilityRequest[] = [],
  ): Promise<PortableSessionArchiveV1> {
    const ownership = await readOwnership(this.#ownershipPath);
    if (ownership.state !== "prepared" || ownership.generation !== ownershipGeneration) {
      throw new Error("portable export requires the current prepared ownership generation");
    }
    const files: PortableSessionFileV1[] = [];
    const budget = { bytes: 0 };
    await collectTree(
      this.#sessionDir,
      "session",
      files,
      budget,
      (name) => name !== ".lease" && name !== OWNERSHIP_FILE && !name.endsWith(".tmp"),
    );
    const plan = join(this.#state, "plans", `${this.#sessionId}.md`);
    await collectFile(plan, "plan.md", files, budget).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    const tag = orchestrationTag(this.#sessionId);
    await collectValidEventTree(
      join(this.#state, "orchestration", "events", tag),
      "orchestration/events",
      files,
      budget,
    );
    await collectValidJsonlFile(
      join(this.#state, "orchestration", `${this.#sessionId}.jsonl`),
      "orchestration/legacy.jsonl",
      files,
      budget,
    );
    const reportNames = await collectSessionReportNames(this.#state, this.#sessionId);
    await collectTree(
      join(this.#state, "orchestration", "reports"),
      "orchestration/reports",
      files,
      budget,
      (name) => reportNames.has(name),
    );
    try {
      const checkpoints = JSON.parse(
        await readFile(join(this.#state, "checkpoints.json"), "utf8"),
      ) as Array<{ sessionId?: string }>;
      const mine = checkpoints.filter((checkpoint) => checkpoint.sessionId === this.#sessionId);
      if (mine.length) {
        const data = Buffer.from(`${JSON.stringify(mine, null, 2)}\n`);
        files.push({
          path: "checkpoints.json",
          bytes: data.byteLength,
          sha256: sha256(data),
          contentBase64: data.toString("base64"),
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("invalid checkpoint state prevents portable export", { cause: error });
      }
      // A genuinely absent checkpoint store is an authoritative empty set.
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      schemaVersion: 1,
      sessionId: this.#sessionId,
      sourceRoot: this.#cwd,
      sourceStateRoot: this.#state,
      ownershipGeneration,
      executionTarget: ownership.owner,
      engineRevision,
      createdAt: Date.now(),
      files,
      pendingCapabilities,
      archiveSha256: canonicalArchiveHash(files),
    };
  }

  static async import(
    targetRoot: string,
    archive: PortableSessionArchiveV1,
    expectedEngineRevision: string,
    options: { provisional?: boolean } = {},
  ): Promise<void> {
    if (archive.schemaVersion !== 1 || !isSafeSessionId(archive.sessionId))
      throw new Error("unsupported portable archive");
    if (archive.engineRevision !== expectedEngineRevision)
      throw new Error("engine revision mismatch");
    if (!Number.isSafeInteger(archive.ownershipGeneration) || archive.ownershipGeneration < 1)
      throw new Error("invalid ownership generation");
    if (canonicalArchiveHash(archive.files) !== archive.archiveSha256)
      throw new Error("portable archive manifest hash mismatch");
    const cwd = resolve(targetRoot);
    const state = globalStateDir(cwd);
    await withCheckpointFileLock(
      PortableSessionManager.#importLock(state, archive.sessionId),
      async () => {
        const manager = new PortableSessionManager(cwd, archive.sessionId);
        const current = await readOwnership(manager.#ownershipPath);
        if (current.generation >= archive.ownershipGeneration)
          throw new Error("stale imported ownership generation");
        const staging = join(state, `.handoff-import-${archive.sessionId}-${randomUUID()}`);
        let journalReady = false;
        try {
          for (const file of archive.files) {
            assertPortablePath(file.path);
            const encoded = Buffer.from(file.contentBase64, "base64");
            if (encoded.byteLength !== file.bytes || sha256(encoded) !== file.sha256)
              throw new Error(`portable file hash mismatch: ${file.path}`);
            const data = rebaseStructuredFile(file.path, encoded, archive, cwd);
            const out = join(staging, ...file.path.split("/"));
            if (!resolve(out).startsWith(`${resolve(staging)}${sep}`))
              throw new Error(`portable path escaped staging: ${file.path}`);
            await mkdir(dirname(out), { recursive: true });
            await writeFile(out, data, { mode: 0o600 });
          }
          const importedSession = join(staging, "session");
          const importedSessionStat = await lstat(importedSession).catch(() => null);
          if (!importedSessionStat?.isDirectory())
            throw new Error("portable archive has no session state");
          const targetSession = join(state, "sessions", archive.sessionId);
          const incomingReportNames = await listReportFiles(
            join(staging, "orchestration", "reports"),
          );
          const referencedReportNames = await collectReportNamesFromEvents(
            join(staging, "orchestration", "events"),
            join(state, "orchestration", "reports"),
            archive.sessionId,
          );
          for (const name of await collectReportNamesFromLegacy(
            join(staging, "orchestration", "legacy.jsonl"),
            join(state, "orchestration", "reports"),
            archive.sessionId,
          )) {
            referencedReportNames.add(name);
          }
          const reportPrefix = sessionReportFilePrefix(archive.sessionId);
          if (
            incomingReportNames.some(
              (name) => !referencedReportNames.has(name) && !name.startsWith(reportPrefix),
            )
          ) {
            throw new Error("portable reports are not scoped to the imported session");
          }
          await PortableSessionManager.#backupImportState(
            state,
            archive.sessionId,
            archive.ownershipGeneration,
            incomingReportNames,
          );
          journalReady = true;
          await mkdir(dirname(targetSession), { recursive: true });
          await rm(targetSession, { recursive: true, force: true });
          await rename(importedSession, targetSession);
          const plan = join(staging, "plan.md");
          const targetPlan = join(state, "plans", `${archive.sessionId}.md`);
          await rm(targetPlan, { force: true });
          try {
            await mkdir(join(state, "plans"), { recursive: true });
            await rename(plan, targetPlan);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await PortableSessionManager.#mergeAuxiliary(state, staging, archive.sessionId);
          await atomicJson(manager.#ownershipPath, {
            generation: archive.ownershipGeneration,
            owner: archive.executionTarget,
            state: "owned",
            updatedAt: Date.now(),
          } satisfies OwnershipRecord);
          if (!options.provisional) {
            await PortableSessionManager.#commitImportUnlocked(
              targetRoot,
              archive.sessionId,
              archive.ownershipGeneration,
            );
            journalReady = false;
          }
        } catch (error) {
          if (journalReady) {
            try {
              await PortableSessionManager.#restoreImportBackup(
                targetRoot,
                archive.sessionId,
                archive.ownershipGeneration,
                false,
              );
            } catch (rollbackError) {
              throw new AggregateError(
                [error, rollbackError],
                "portable import failed and its rollback did not complete",
              );
            }
          }
          throw error;
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
      },
    );
  }

  static async commitImport(
    targetRoot: string,
    sessionId: string,
    ownershipGeneration: number,
  ): Promise<void> {
    PortableSessionManager.#assertImportIdentity(sessionId, ownershipGeneration);
    const state = globalStateDir(resolve(targetRoot));
    await withCheckpointFileLock(PortableSessionManager.#importLock(state, sessionId), () =>
      PortableSessionManager.#commitImportUnlocked(targetRoot, sessionId, ownershipGeneration),
    );
  }

  static async #commitImportUnlocked(
    targetRoot: string,
    sessionId: string,
    ownershipGeneration: number,
  ): Promise<void> {
    const state = globalStateDir(resolve(targetRoot));
    const journal = PortableSessionManager.#importJournal(state, sessionId, ownershipGeneration);
    let journalPresent = true;
    try {
      await PortableSessionManager.#readImportJournal(journal, sessionId, ownershipGeneration);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      journalPresent = false;
    }
    const ownership = await readOwnership(join(state, "sessions", sessionId, OWNERSHIP_FILE));
    if (ownership.state !== "owned" || ownership.generation !== ownershipGeneration) {
      throw new Error("portable import generation is no longer current");
    }
    if (journalPresent) await PortableSessionManager.#retireImportJournal(state, sessionId);
  }

  static async abortImport(
    targetRoot: string,
    sessionId: string,
    ownershipGeneration: number,
  ): Promise<void> {
    PortableSessionManager.#assertImportIdentity(sessionId, ownershipGeneration);
    const state = globalStateDir(resolve(targetRoot));
    await withCheckpointFileLock(PortableSessionManager.#importLock(state, sessionId), () =>
      PortableSessionManager.#restoreImportBackup(targetRoot, sessionId, ownershipGeneration, true),
    );
  }

  static async #restoreImportBackup(
    targetRoot: string,
    sessionId: string,
    ownershipGeneration: number,
    requireCurrentGeneration: boolean,
  ): Promise<void> {
    const state = globalStateDir(resolve(targetRoot));
    const journal = PortableSessionManager.#importJournal(state, sessionId, ownershipGeneration);
    let record: ImportJournalV1;
    try {
      record = await PortableSessionManager.#readImportJournal(
        journal,
        sessionId,
        ownershipGeneration,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const ownership = await readOwnership(join(state, "sessions", sessionId, OWNERSHIP_FILE));
      if (
        ownership.generation < ownershipGeneration ||
        (ownership.generation === ownershipGeneration - 1 && ownership.owner.kind === "cloud")
      ) return;
      throw new Error("portable import journal is unavailable for rollback");
    }
    const rollbackPath = join(journal, "rollback.json");
    let rollbackStarted = false;
    let rollbackReportNames: string[] = [];
    try {
      const progress = JSON.parse(await readFile(rollbackPath, "utf8")) as {
        started?: boolean;
        reportNames?: unknown;
      };
      rollbackStarted = progress.started === true;
      if (
        rollbackStarted &&
        (!Array.isArray(progress.reportNames) ||
          !progress.reportNames.every(
            (name) => typeof name === "string" && name.length > 0 && basename(name) === name,
          ))
      ) {
        throw new Error("portable rollback progress is invalid");
      }
      if (rollbackStarted) rollbackReportNames = progress.reportNames as string[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (requireCurrentGeneration && !rollbackStarted) {
      const ownership = await readOwnership(join(state, "sessions", sessionId, OWNERSHIP_FILE));
      const exactImportedGeneration =
        ownership.state === "owned" && ownership.generation === ownershipGeneration;
      const interruptedBeforeOwnership =
        record.phase === "importing" && ownership.generation < ownershipGeneration;
      if (!exactImportedGeneration && !interruptedBeforeOwnership) {
        throw new Error("portable import generation is no longer current");
      }
    }
    if (!rollbackStarted) {
      const currentReportNames = await collectSessionReportNames(state, sessionId);
      rollbackReportNames = [...new Set([...record.incomingReportNames, ...currentReportNames])];
      await atomicJson(rollbackPath, { started: true, reportNames: rollbackReportNames });
    }
    const session = join(state, "sessions", sessionId);
    const plan = join(state, "plans", `${sessionId}.md`);
    const events = join(state, "orchestration", "events", orchestrationTag(sessionId));
    const legacyEvents = join(state, "orchestration", `${sessionId}.jsonl`);
    await rm(session, { recursive: true, force: true });
    await rm(plan, { force: true });
    await rm(events, { recursive: true, force: true });
    await rm(legacyEvents, { force: true });
    if (record.hadSession) {
      await mkdir(dirname(session), { recursive: true });
      await cp(join(journal, "session"), session, { recursive: true });
    }
    if (record.hadPlan) {
      await mkdir(dirname(plan), { recursive: true });
      await cp(join(journal, "plan.md"), plan);
    }
    if (record.hadEvents) {
      await mkdir(dirname(events), { recursive: true });
      await cp(join(journal, "events"), events, { recursive: true });
    }
    if (record.hadLegacyEvents) {
      await mkdir(dirname(legacyEvents), { recursive: true });
      await cp(join(journal, "legacy-events.jsonl"), legacyEvents);
    }
    const reportRoot = join(state, "orchestration", "reports");
    for (const name of rollbackReportNames) {
      await rm(join(reportRoot, name), { recursive: true, force: true });
    }
    try {
      await mkdir(reportRoot, { recursive: true });
      for (const name of await readdir(join(journal, "reports")))
        await cp(join(journal, "reports", name), join(reportRoot, name), { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const priorCheckpoints = record.hadCheckpoints
      ? await readCheckpoints(join(journal, "checkpoints.json"))
      : [];
    await replaceSessionCheckpoints(state, sessionId, priorCheckpoints);
    await PortableSessionManager.#retireImportJournal(state, sessionId);
  }

  static #importJournal(state: string, sessionId: string, generation: number): string {
    return join(PortableSessionManager.#importJournalRoot(state, sessionId), String(generation));
  }

  static #importJournalRoot(state: string, sessionId: string): string {
    return join(state, ".handoff-import-backups", sha256(sessionId).slice(0, 32));
  }

  static async #retireImportJournal(state: string, sessionId: string): Promise<void> {
    const active = PortableSessionManager.#importJournalRoot(state, sessionId);
    const retiredRoot = join(state, ".handoff-import-retired");
    const retired = join(retiredRoot, `${sha256(sessionId).slice(0, 32)}-${randomUUID()}`);
    await mkdir(retiredRoot, { recursive: true });
    await rename(active, retired);
    await rm(retired, { recursive: true, force: true }).catch(() => undefined);
  }

  static async #hasPendingImport(state: string, sessionId: string): Promise<boolean> {
    const journalRoot = PortableSessionManager.#importJournalRoot(state, sessionId);
    let names: string[];
    try {
      names = await readdir(journalRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    for (const name of names) {
      const pending = join(journalRoot, name);
      try {
        const record = JSON.parse(await readFile(join(pending, "journal.json"), "utf8")) as {
          phase?: unknown;
          sessionId?: unknown;
          ownershipGeneration?: unknown;
        };
        if (
          record.phase === "backing-up" &&
          record.sessionId === sessionId &&
          record.ownershipGeneration === Number(name)
        ) {
          await rm(pending, { recursive: true, force: true });
          continue;
        }
        if (
          record.phase !== "importing" ||
          record.sessionId !== sessionId ||
          record.ownershipGeneration !== Number(name)
        ) {
          throw new Error("portable import journal is invalid");
        }
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          await rm(pending, { recursive: true, force: true });
          continue;
        }
        throw error;
      }
    }
    return false;
  }

  static #importLock(state: string, sessionId: string): string {
    return join(state, ".handoff-import-locks", sha256(sessionId).slice(0, 32));
  }

  static #assertImportIdentity(sessionId: string, generation: number): void {
    if (!isSafeSessionId(sessionId)) throw new Error("invalid session id");
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error("invalid ownership generation");
    }
  }

  static async #backupImportState(
    state: string,
    sessionId: string,
    ownershipGeneration: number,
    incomingReportNames: string[],
  ): Promise<void> {
    const journal = PortableSessionManager.#importJournal(state, sessionId, ownershipGeneration);
    await mkdir(state, { recursive: true });
    const journalRoot = PortableSessionManager.#importJournalRoot(state, sessionId);
    await mkdir(journalRoot, { recursive: true });
    if (await PortableSessionManager.#hasPendingImport(state, sessionId))
      throw new Error("a provisional portable import is already pending");
    try {
      await atomicJson(join(journal, "journal.json"), {
        schemaVersion: 1,
        phase: "backing-up",
        sessionId,
        ownershipGeneration,
      });
      const session = join(state, "sessions", sessionId);
      const plan = join(state, "plans", `${sessionId}.md`);
      const events = join(state, "orchestration", "events", orchestrationTag(sessionId));
      const legacyEvents = join(state, "orchestration", `${sessionId}.jsonl`);
      const hadSession = await copyIfPresent(session, join(journal, "session"));
      const hadPlan = await copyIfPresent(plan, join(journal, "plan.md"));
      const hadEvents = await copyIfPresent(events, join(journal, "events"));
      const hadLegacyEvents = await copyIfPresent(
        legacyEvents,
        join(journal, "legacy-events.jsonl"),
      );
      const checkpoints = await withCheckpointFileLock(join(state, "checkpoints.json"), async () =>
        (await readCheckpoints(join(state, "checkpoints.json"))).filter(
          (item) => item.sessionId === sessionId,
        ),
      );
      const hadCheckpoints = checkpoints.length > 0;
      if (hadCheckpoints) await atomicJson(join(journal, "checkpoints.json"), checkpoints);
      const reportRoot = join(state, "orchestration", "reports");
      const reportNames = await collectSessionReportNames(state, sessionId);
      const namesToBackup = new Set([...reportNames, ...incomingReportNames]);
      try {
        for (const name of await readdir(reportRoot)) {
          if (!namesToBackup.has(name)) continue;
          await mkdir(join(journal, "reports"), { recursive: true });
          await cp(join(reportRoot, name), join(journal, "reports", name), { recursive: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await atomicJson(join(journal, "journal.json"), {
        schemaVersion: 1,
        phase: "importing",
        sessionId,
        ownershipGeneration,
        incomingReportNames,
        hadSession,
        hadPlan,
        hadEvents,
        hadLegacyEvents,
        hadCheckpoints,
      } satisfies ImportJournalV1);
    } catch (error) {
      await rm(journal, { recursive: true, force: true });
      throw error;
    }
  }

  static async #readImportJournal(
    path: string,
    sessionId: string,
    generation: number,
  ): Promise<ImportJournalV1> {
    const record = JSON.parse(
      await readFile(join(path, "journal.json"), "utf8"),
    ) as ImportJournalV1;
    if (
      record.schemaVersion !== 1 ||
      record.phase !== "importing" ||
      record.sessionId !== sessionId ||
      record.ownershipGeneration !== generation ||
      !Array.isArray(record.incomingReportNames) ||
      !record.incomingReportNames.every(
        (name) => typeof name === "string" && name.length > 0 && basename(name) === name,
      )
    ) {
      throw new Error("portable import journal is invalid");
    }
    return record;
  }

  static async #mergeAuxiliary(state: string, staging: string, sessionId: string): Promise<void> {
    const eventSource = join(staging, "orchestration", "events");
    const eventTarget = join(state, "orchestration", "events", orchestrationTag(sessionId));
    const previousReportNames = await collectSessionReportNames(state, sessionId);
    await rm(eventTarget, { recursive: true, force: true });
    try {
      await mkdir(dirname(eventTarget), { recursive: true });
      await rename(eventSource, eventTarget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const legacySource = join(staging, "orchestration", "legacy.jsonl");
    const legacyTarget = join(state, "orchestration", `${sessionId}.jsonl`);
    await rm(legacyTarget, { force: true });
    try {
      await mkdir(dirname(legacyTarget), { recursive: true });
      await rename(legacySource, legacyTarget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const reportSource = join(staging, "orchestration", "reports");
    const reportTarget = join(state, "orchestration", "reports");
    for (const name of previousReportNames) {
      await rm(join(reportTarget, name), { recursive: true, force: true });
    }
    try {
      await mkdir(reportTarget, { recursive: true });
      for (const name of await readdir(reportSource)) {
        await rename(join(reportSource, name), join(reportTarget, basename(name)));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const incoming = await readCheckpoints(join(staging, "checkpoints.json"));
    if (
      incoming.some(
        (checkpoint) =>
          typeof checkpoint.id !== "string" ||
          checkpoint.id.length === 0 ||
          checkpoint.sessionId !== sessionId,
      )
    ) {
      throw new Error("portable checkpoints are not scoped to the imported session");
    }
    await replaceSessionCheckpoints(state, sessionId, incoming);
  }
}
