import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix, resolve, sep } from "node:path";
import type {
  ExecutionTarget,
  HandoffPreparation,
  PendingCapabilityRequest,
  PortableSessionArchiveV1,
  PortableSessionFileV1,
} from "@vibe/shared";
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

async function readOwnership(path: string): Promise<OwnershipRecord> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<OwnershipRecord>;
    if (!Number.isSafeInteger(parsed.generation) || (parsed.generation ?? -1) < 0) throw new Error();
    if (parsed.state !== "owned" && parsed.state !== "prepared") throw new Error();
    if (!parsed.owner || (parsed.owner.kind !== "local" && parsed.owner.kind !== "cloud")) throw new Error();
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

function rebaseJson(value: unknown, fromRoot: string, toRoot: string, fromState: string, toState: string): unknown {
  if (typeof value === "string") {
    if (value === fromRoot || value.startsWith(`${fromRoot}${sep}`)) return toRoot + value.slice(fromRoot.length);
    if (value === fromState || value.startsWith(`${fromState}${sep}`)) return toState + value.slice(fromState.length);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => rebaseJson(item, fromRoot, toRoot, fromState, toState));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, rebaseJson(item, fromRoot, toRoot, fromState, toState)]),
  );
}

function rebaseStructuredFile(path: string, data: Buffer, archive: PortableSessionArchiveV1, targetRoot: string): Buffer {
  if (!(path.endsWith(".json") || path.endsWith(".jsonl"))) return data;
  const targetState = globalStateDir(targetRoot);
  try {
    if (path.endsWith(".jsonl")) {
      const lines = data.toString("utf8").split("\n").map((line) => {
        if (!line.trim()) return line;
        return JSON.stringify(rebaseJson(JSON.parse(line), archive.sourceRoot, targetRoot, archive.sourceStateRoot, targetState));
      });
      return Buffer.from(lines.join("\n"));
    }
    return Buffer.from(`${JSON.stringify(rebaseJson(JSON.parse(data.toString("utf8")), archive.sourceRoot, targetRoot, archive.sourceStateRoot, targetState), null, 2)}\n`);
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

  static async assertOwner(cwd: string, sessionId: string, expected: ExecutionTarget): Promise<void> {
    const manager = new PortableSessionManager(cwd, sessionId);
    const ownership = await readOwnership(manager.#ownershipPath);
    if (ownership.state !== "owned") throw new Error("session handoff is prepared but not committed");
    const sameOwner = ownership.owner.kind === expected.kind
      && (ownership.owner.kind === "local" || ownership.owner.provider === (expected as Extract<ExecutionTarget, { kind: "cloud" }>).provider);
    if (!sameOwner) {
      throw new Error(`session is owned by ${ownership.owner.kind === "local" ? "local" : `cloud/${ownership.owner.provider}`}`);
    }
  }

  async prepare(target: ExecutionTarget, expectedGeneration?: number): Promise<HandoffPreparation> {
    const current = await readOwnership(this.#ownershipPath);
    if (current.state === "prepared") throw new Error("a handoff is already prepared for this session");
    if (expectedGeneration !== undefined && current.generation !== expectedGeneration) {
      throw new Error(`stale ownership generation: expected ${expectedGeneration}, current ${current.generation}`);
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
  }

  async commit(nonce: string): Promise<void> {
    const current = await readOwnership(this.#ownershipPath);
    if (current.state !== "prepared" || current.nonce !== nonce) throw new Error("handoff preparation is stale");
    await atomicJson(this.#ownershipPath, {
      generation: current.generation,
      owner: current.owner,
      state: "owned",
      updatedAt: Date.now(),
    } satisfies OwnershipRecord);
  }

  async abort(nonce: string): Promise<void> {
    const current = await readOwnership(this.#ownershipPath);
    if (current.state !== "prepared" || current.nonce !== nonce) throw new Error("handoff preparation is stale");
    await atomicJson(this.#ownershipPath, {
      generation: current.generation - 1,
      owner: current.previousOwner ?? { kind: "local" },
      state: "owned",
      updatedAt: Date.now(),
    } satisfies OwnershipRecord);
  }

  async export(engineRevision: string, ownershipGeneration: number, pendingCapabilities: PendingCapabilityRequest[] = []): Promise<PortableSessionArchiveV1> {
    const ownership = await readOwnership(this.#ownershipPath);
    if (ownership.state !== "prepared" || ownership.generation !== ownershipGeneration) {
      throw new Error("portable export requires the current prepared ownership generation");
    }
    const files: PortableSessionFileV1[] = [];
    const budget = { bytes: 0 };
    await collectTree(this.#sessionDir, "session", files, budget, (name) => name !== ".lease" && name !== OWNERSHIP_FILE && !name.endsWith(".tmp"));
    const plan = join(this.#state, "plans", `${this.#sessionId}.md`);
    await collectFile(plan, "plan.md", files, budget).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    const tag = orchestrationTag(this.#sessionId);
    await collectTree(join(this.#state, "orchestration", "events", tag), "orchestration/events", files, budget);
    await collectTree(
      join(this.#state, "orchestration", "reports"),
      "orchestration/reports",
      files,
      budget,
      (name) => name.startsWith(`${this.#sessionId}-`),
    );
    try {
      const checkpoints = JSON.parse(await readFile(join(this.#state, "checkpoints.json"), "utf8")) as Array<{ sessionId?: string }>;
      const mine = checkpoints.filter((checkpoint) => checkpoint.sessionId === this.#sessionId);
      if (mine.length) {
        const data = Buffer.from(`${JSON.stringify(mine, null, 2)}\n`);
        files.push({ path: "checkpoints.json", bytes: data.byteLength, sha256: sha256(data), contentBase64: data.toString("base64") });
      }
    } catch {
      // No session-scoped checkpoints is a valid archive.
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

  static async import(targetRoot: string, archive: PortableSessionArchiveV1, expectedEngineRevision: string): Promise<void> {
    if (archive.schemaVersion !== 1 || !isSafeSessionId(archive.sessionId)) throw new Error("unsupported portable archive");
    if (archive.engineRevision !== expectedEngineRevision) throw new Error("engine revision mismatch");
    if (!Number.isSafeInteger(archive.ownershipGeneration) || archive.ownershipGeneration < 1) throw new Error("invalid ownership generation");
    if (canonicalArchiveHash(archive.files) !== archive.archiveSha256) throw new Error("portable archive manifest hash mismatch");
    const cwd = resolve(targetRoot);
    const state = globalStateDir(cwd);
    const manager = new PortableSessionManager(cwd, archive.sessionId);
    const current = await readOwnership(manager.#ownershipPath);
    if (current.generation >= archive.ownershipGeneration) throw new Error("stale imported ownership generation");
    const staging = join(state, `.handoff-import-${archive.sessionId}-${randomUUID()}`);
    try {
      for (const file of archive.files) {
        assertPortablePath(file.path);
        const encoded = Buffer.from(file.contentBase64, "base64");
        if (encoded.byteLength !== file.bytes || sha256(encoded) !== file.sha256) throw new Error(`portable file hash mismatch: ${file.path}`);
        const data = rebaseStructuredFile(file.path, encoded, archive, cwd);
        const out = join(staging, ...file.path.split("/"));
        if (!resolve(out).startsWith(`${resolve(staging)}${sep}`)) throw new Error(`portable path escaped staging: ${file.path}`);
        await mkdir(dirname(out), { recursive: true });
        await writeFile(out, data, { mode: 0o600 });
      }
      const importedSession = join(staging, "session");
      const targetSession = join(state, "sessions", archive.sessionId);
      await mkdir(dirname(targetSession), { recursive: true });
      await rm(targetSession, { recursive: true, force: true });
      await rename(importedSession, targetSession);
      const plan = join(staging, "plan.md");
      try {
        await mkdir(join(state, "plans"), { recursive: true });
        await rename(plan, join(state, "plans", `${archive.sessionId}.md`));
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
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  static async #mergeAuxiliary(state: string, staging: string, sessionId: string): Promise<void> {
    const eventSource = join(staging, "orchestration", "events");
    const eventTarget = join(state, "orchestration", "events", orchestrationTag(sessionId));
    try {
      await mkdir(dirname(eventTarget), { recursive: true });
      await rm(eventTarget, { recursive: true, force: true });
      await rename(eventSource, eventTarget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const reportSource = join(staging, "orchestration", "reports");
    try {
      await mkdir(join(state, "orchestration", "reports"), { recursive: true });
      for (const name of await readdir(reportSource)) {
        await rename(join(reportSource, name), join(state, "orchestration", "reports", basename(name)));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const checkpointSource = join(staging, "checkpoints.json");
    try {
      const incoming = JSON.parse(await readFile(checkpointSource, "utf8")) as Array<{ id: string; sessionId?: string }>;
      let existing: Array<{ id: string; sessionId?: string }> = [];
      try { existing = JSON.parse(await readFile(join(state, "checkpoints.json"), "utf8")); } catch { /* empty */ }
      const byId = new Map(existing.filter((item) => item.sessionId !== sessionId).map((item) => [item.id, item]));
      for (const item of incoming) byId.set(item.id, item);
      await atomicJson(join(state, "checkpoints.json"), [...byId.values()]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
