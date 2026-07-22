import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createId, type Message, type Mode, type ModelUsage, type Task } from "@vibe/shared";
import type { ModelMessage } from "ai";
import type { SourceEntry } from "./source-ledger.ts";
import { ensureStateDir, globalStateDir } from "./state-dir.ts";

/** Current on-disk SessionMeta schema version. Bump when the meta shape changes
 * incompatibly; a loader can then detect + migrate rather than silently misparse
 * an older/newer file. Absent on pre-versioning saves (read as version 0). */
export const SESSION_META_VERSION = 4;

interface SessionCommitManifest {
  version: 1;
  current: string;
  previous?: string;
  files: Record<"meta.json" | "messages.jsonl" | "history.jsonl", string>;
  previousFiles?: Record<"meta.json" | "messages.jsonl" | "history.jsonl", string>;
}

const GENERATION_PRUNE_AGE_MS = 5 * 60 * 1000;

function contentSha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isSafeGeneration(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 200
    && /^[A-Za-z0-9._-]+$/.test(value)
    && value !== "."
    && value !== "..";
}

export interface PersistedTurnBoundary {
  /** Stable identity used by desktop fork/revert operations. */
  id: string;
  /** Exclusive transcript indexes after the completed assistant response. */
  modelEnd: number;
  historyEnd: number;
  completedAt: number;
  origin: "user" | "engine";
}

export interface SessionMeta {
  /** Schema version of this record (see SESSION_META_VERSION); absent = 0. */
  version?: number;
  id: string;
  model: string;
  mode: Mode;
  goal: string | null;
  kind?: "root" | "subagent";
  parentSessionId?: string;
  /** Stable completed user turn in the parent where a root session forked. */
  forkedAtTurnId?: string;
  agentName?: string;
  /** The working task list at the time of the last save. */
  tasks?: Task[];
  /** Cumulative token usage + accrued cost at the time of the last save. The
   * cache-read total is persisted too, so `--resume` keeps a truthful running
   * usage/cost instead of silently zeroing the cached slice. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costUSD?: number;
    /** Non-estimated portion of costUSD (BUG-103). Absent on pre-fix saves. */
    actualCostUSD?: number;
    /** True when any accrued cost came from estimated/base-model pricing. */
    costEstimated?: boolean;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    steps?: number;
    turns?: number;
    providerLatencyMs?: number;
    byModel?: Record<string, ModelUsage>;
  };
  /** The last turn's REAL provider input-token count (context fill), so a resumed
   * session's first compaction check uses the true prior prompt size instead of
   * the overhead-blind estimate. */
  lastInputTokens?: number;
  /** The proactively-recalled context block, so a resumed session keeps the
   * same injected memory instead of silently dropping (or re-deriving) it. */
  recalledContext?: string;
  /** The web-source ledger (numbered `[n]` citations) at the last save, so a
   * resumed session's existing citations still resolve and new sources continue
   * the numbering instead of restarting from [1]. */
  sources?: SourceEntry[];
  /** Mid-turn microcompaction offload records at the last save, so a resumed
   * session knows which tool results are already offloaded to artifacts (their
   * previews are in the persisted messages). Without this, resume rebuilds the
   * offload map empty and prepareStep can't tell which results were already
   * trimmed — the artifact-prune budget also loses track of live files. */
  offloaded?: { callId: string; path: string; toolName: string; fullChars: number }[];
  createdAt: number;
  updatedAt: number;
  /** Optional user-set display title; overrides derived history/goal labels. */
  title?: string;
  /** Completed turn boundaries. Legacy sessions derive deterministic ids. */
  turns?: PersistedTurnBoundary[];
  forkedFrom?: { sessionId: string; turnId: string };
}

export interface SessionTreeNode {
  meta: SessionMeta;
  children: SessionTreeNode[];
}

export interface PersistedSession {
  meta: SessionMeta;
  modelMessages: ModelMessage[];
  history: Message[];
  warnings?: string[];
}

type PersistedUsage = NonNullable<SessionMeta["usage"]>;

function zeroPersistedModelUsage(): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    steps: 0,
    turns: 0,
    providerLatencyMs: 0,
    costUSD: 0,
    actualCostUSD: 0,
  };
}

/** Canonicalize persistence around per-model buckets. A v0-v2 aggregate cannot
 * reveal historical switches, so it is attributed once to the saved model and
 * marked honestly instead of inventing precision. */
function normalizePersistedUsage(
  model: string,
  usage: PersistedUsage,
  derivedTurns: number,
): PersistedUsage {
  const byModel: Record<string, ModelUsage> = {};
  if (usage.byModel && Object.keys(usage.byModel).length) {
    for (const [modelId, value] of Object.entries(usage.byModel)) {
      const inputTokens = Math.max(0, value.inputTokens ?? 0);
      const outputTokens = Math.max(0, value.outputTokens ?? 0);
      const costUSD = Math.max(0, value.costUSD ?? 0);
      const actualCostUSD = Math.min(
        costUSD,
        Math.max(0, value.actualCostUSD ?? (value.costEstimated ? 0 : costUSD)),
      );
      byModel[modelId] = {
        ...zeroPersistedModelUsage(),
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cachedInputTokens: Math.max(0, value.cachedInputTokens ?? 0),
        cacheWriteTokens: Math.max(0, value.cacheWriteTokens ?? 0),
        steps: Math.max(0, Math.trunc(value.steps ?? 0)),
        turns: Math.max(0, Math.trunc(value.turns ?? 0)),
        providerLatencyMs: Math.max(0, value.providerLatencyMs ?? 0),
        costUSD,
        actualCostUSD,
        ...(costUSD > actualCostUSD ? { costEstimated: true } : {}),
        ...(value.legacyAttribution ? { legacyAttribution: true } : {}),
      };
    }
  } else {
    const costUSD = Math.max(0, usage.costUSD ?? 0);
    const actualCostUSD = Math.min(
      costUSD,
      Math.max(0, usage.actualCostUSD ?? (usage.costEstimated ? 0 : costUSD)),
    );
    const inputTokens = Math.max(0, usage.inputTokens ?? 0);
    const outputTokens = Math.max(0, usage.outputTokens ?? 0);
    byModel[model] = {
      ...zeroPersistedModelUsage(),
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cachedInputTokens: Math.max(0, usage.cachedInputTokens ?? 0),
      cacheWriteTokens: Math.max(0, usage.cacheWriteTokens ?? 0),
      steps: Math.max(0, Math.trunc(usage.steps ?? 0)),
      turns: Math.max(0, Math.trunc(usage.turns ?? derivedTurns)),
      providerLatencyMs: Math.max(0, usage.providerLatencyMs ?? 0),
      costUSD,
      actualCostUSD,
      ...(costUSD > actualCostUSD ? { costEstimated: true } : {}),
      legacyAttribution: true,
    };
  }
  const buckets = Object.values(byModel);
  return {
    inputTokens: buckets.reduce((sum, bucket) => sum + bucket.inputTokens, 0),
    outputTokens: buckets.reduce((sum, bucket) => sum + bucket.outputTokens, 0),
    cachedInputTokens: buckets.reduce((sum, bucket) => sum + bucket.cachedInputTokens, 0),
    cacheWriteTokens: buckets.reduce((sum, bucket) => sum + bucket.cacheWriteTokens, 0),
    steps: buckets.reduce((sum, bucket) => sum + bucket.steps, 0),
    turns: buckets.reduce((sum, bucket) => sum + bucket.turns, 0),
    providerLatencyMs: buckets.reduce((sum, bucket) => sum + bucket.providerLatencyMs, 0),
    costUSD: buckets.reduce((sum, bucket) => sum + bucket.costUSD, 0),
    actualCostUSD: buckets.reduce((sum, bucket) => sum + (bucket.actualCostUSD ?? 0), 0),
    ...(buckets.some((bucket) => bucket.costEstimated) ? { costEstimated: true } : {}),
    byModel,
  };
}

/** Tag key for a base64-encoded binary blob in persisted JSONL. Deliberately
 * long + namespaced so a model-generated object can't collide with it and be
 * wrongly revived into a Uint8Array. */
const U8_TAG = "__vibecodr_binary_base64__";

/** Session ids are directory names, never paths. Keep this deliberately
 * format-agnostic for old ids while rejecting traversal and path separators. */
export function isSafeSessionId(id: string): boolean {
  return id.length > 0 && id.length <= 200 && id !== "." && id !== ".." && !/[\\/\0]/.test(id);
}

/**
 * JSON replacer that encodes a `Uint8Array` (an `@image`/file part's bytes) as a
 * tagged base64 string. Without it, `JSON.stringify` turns the typed array into a
 * numeric-keyed object (`{"0":137,…}`) — several× larger AND not reconstructable,
 * so a resumed session hands the provider a broken `image` field it rejects.
 */
function u8Replacer(_key: string, value: unknown): unknown {
  return value instanceof Uint8Array ? { [U8_TAG]: Buffer.from(value).toString("base64") } : value;
}

/** Inverse of {@link u8Replacer}: restore a tagged base64 blob to a `Uint8Array`. */
function u8Reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object") {
    const tag = (value as Record<string, unknown>)[U8_TAG];
    if (typeof tag === "string") return new Uint8Array(Buffer.from(tag, "base64"));
  }
  return value;
}

/**
 * Persists sessions under the project's GLOBAL state dir
 * (`~/.vibe/state/<cwd-hash>/sessions/<id>/`) so runs are resumable without
 * dirtying the project directory (a `.vibe/` in a fresh dir broke scaffolders).
 * `messages.jsonl` holds the authoritative model context; `history.jsonl`
 * holds the UI message log; `meta.json` holds session metadata. Sessions saved
 * by older versions under `<cwd>/.vibe/sessions/` are still readable (legacy
 * fallback on load/list); all writes go to the global dir.
 */
export class SessionStore {
  #base: string;
  /** Read-only fallback: the pre-relocation in-project sessions dir. */
  #legacy: string;
  #cwd: string;
  #ensured = false;
  /** Monotonic per-process counter for unique temp-file names (with pid), so
   * concurrent saves never share a temp path. */
  static #writeSeq = 0;

  constructor(cwd: string) {
    this.#cwd = cwd;
    this.#base = join(globalStateDir(cwd), "sessions");
    this.#legacy = join(cwd, ".vibe", "sessions");
  }

  #dir(id: string): string {
    if (!isSafeSessionId(id)) throw new Error("invalid session id");
    return join(this.#base, id);
  }

  /** The lease file path for a session (a PID-based advisory lock so two
   * terminals resuming the same session get a clear warning instead of silent
   * last-writer-wins data loss). Lives inside the session directory so it's
   * cleaned up with the session and never leaks outside it. */
  #leasePath(id: string): string {
    return join(this.#dir(id), ".lease");
  }

  /** Check whether a process with the given PID is still alive (POSIX signal-0
   * liveness probe). EPERM means the process exists but we can't signal it —
   * alive. ESRCH means dead. */
  static #isPidAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as { code?: string }).code === "EPERM";
    }
  }

  /** Acquire a PID-based lease on a session so two `--continue` terminals on
   * the same session are detected, not silently racing. Returns `{ ok: true }`
   * when the lease was acquired (no prior holder, or the prior holder's process
   * is dead), or `{ ok: false, holderPid }` when a live process already holds it.
   * The caller should warn the user and proceed (the lease is advisory, not
   * blocking — a second terminal CAN still run, it just knows it's racing).
   * Call {@link releaseLease} on graceful exit so the next `--continue` is
   * instant instead of waiting for PID-probe + stale-time. */
  async acquireLease(id: string): Promise<{ ok: true } | { ok: false; holderPid: number }> {
    if (!isSafeSessionId(id)) return { ok: true };
    const leasePath = this.#leasePath(id);
    await mkdir(this.#dir(id), { recursive: true });
    try {
      // Exclusive create (O_CREAT|O_EXCL via flag "wx"): two concurrent
      // `--continue` processes both observing "no live holder" must not both
      // return `{ ok: true }` (a plain read-then-overwrite race). If exclusive
      // create fails, a holder already exists — probe its PID; steal only when
      // dead, re-racing exclusive create after removing the stale file.
      try {
        await writeFile(leasePath, `${process.pid}\n${Date.now()}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
        return { ok: true };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "EEXIST") throw err;
      }
      const existing = await readFile(leasePath, "utf8").catch(() => null);
      if (existing) {
        const pidStr = existing.trim().split("\n")[0];
        const holderPid = pidStr ? Number(pidStr) : NaN;
        if (Number.isFinite(holderPid) && holderPid > 0 && SessionStore.#isPidAlive(holderPid)) {
          return { ok: false, holderPid };
        }
        // Holder dead / invalid PID — remove stale lease and re-acquire exclusively.
        await rm(leasePath, { force: true }).catch(() => {});
      }
      try {
        await writeFile(leasePath, `${process.pid}\n${Date.now()}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
        return { ok: true };
      } catch (err) {
        // Another process won the re-acquire race — treat as held.
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "EEXIST") {
          const again = await readFile(leasePath, "utf8").catch(() => null);
          const pidStr = again?.trim().split("\n")[0];
          const holderPid = pidStr ? Number(pidStr) : NaN;
          if (Number.isFinite(holderPid) && holderPid > 0) return { ok: false, holderPid };
        }
        throw err;
      }
    } catch {
      // A FS error acquiring the lease is non-fatal — proceed without it.
      return { ok: true };
    }
  }

  /** Release the session lease (best-effort — a crash leaves a stale lease
   * that the next `acquireLease` detects via PID-probe and steals). */
  async releaseLease(id: string): Promise<void> {
    if (!isSafeSessionId(id)) return;
    try {
      await rm(this.#leasePath(id), { force: true });
    } catch {
      /* best-effort */
    }
  }

  async #readManifest(dir: string): Promise<SessionCommitManifest | null> {
    try {
      const parsed = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as SessionCommitManifest;
      if (
        parsed.version !== 1
        || !isSafeGeneration(parsed.current)
        || parsed.previous !== undefined && !isSafeGeneration(parsed.previous)
        || !parsed.files
        || !(["meta.json", "messages.jsonl", "history.jsonl"] as const).every((name) =>
          typeof parsed.files[name] === "string" && /^[a-f0-9]{64}$/.test(parsed.files[name])
        )
      ) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async #committedGeneration(
    dir: string,
    names: readonly ("meta.json" | "messages.jsonl" | "history.jsonl")[] = [
      "meta.json",
      "messages.jsonl",
      "history.jsonl",
    ],
  ): Promise<{ dir: string; warnings: string[] } | null> {
    const manifest = await this.#readManifest(dir);
    if (!manifest) return null;
    const warnings: string[] = [];
    for (const generation of [manifest.current, manifest.previous]) {
      if (!generation) continue;
      const generationDir = join(dir, "generations", generation);
      const hashes = generation === manifest.current ? manifest.files : manifest.previousFiles;
      if (!hashes) continue;
      let valid = true;
      for (const name of names) {
        try {
          const content = await readFile(join(generationDir, name), "utf8");
          if (contentSha256(content) !== hashes[name]) {
            valid = false;
            break;
          }
        } catch {
          valid = false;
          break;
        }
      }
      if (valid) {
        if (generation !== manifest.current) {
          warnings.push(`Recovered session from previous committed generation ${generation}`);
        }
        return { dir: generationDir, warnings };
      }
      warnings.push(`Ignored incomplete session generation ${generation}`);
    }
    return null;
  }

  async save(meta: SessionMeta, modelMessages: ModelMessage[], history: Message[]): Promise<void> {
    if (!isSafeSessionId(meta.id)) throw new Error("invalid session id");
    if (!this.#ensured) {
      this.#ensured = true;
      await ensureStateDir(this.#cwd);
    }
    const turns = deriveTurnBoundaries(meta.id, modelMessages, history, meta.turns);
    const normalizedMeta: SessionMeta = {
      ...meta,
      version: SESSION_META_VERSION,
      ...(meta.usage
        ? { usage: normalizePersistedUsage(meta.model, meta.usage, turns.length) }
        : {}),
      turns,
    };
    const dir = this.#dir(meta.id);
    await mkdir(dir, { recursive: true });
    // A PER-WRITE-UNIQUE temp suffix (pid + monotonic counter): two vibe-codr
    // instances resuming the SAME session (two `--continue` terminals in one repo)
    // otherwise both write the FIXED `messages.jsonl.tmp` and their interleaved
    // bytes rename into place as a TORN file — `#readJsonl` then silently drops
    // the unparseable lines, breaking tool-call/tool-result pairing on the next
    // load. A unique temp means every rename installs ONE writer's COMPLETE file
    // (last-writer-wins with a valid file, never a corrupt mix).
    const stamp = `${process.pid}.${SessionStore.#writeSeq++}`;
    const contents = {
      "meta.json": JSON.stringify(normalizedMeta, null, 2),
      "messages.jsonl": modelMessages.map((m) => JSON.stringify(m, u8Replacer)).join("\n"),
      "history.jsonl": history.map((m) => JSON.stringify(m, u8Replacer)).join("\n"),
    } as const;

    // Commit a complete immutable generation, then atomically swing one small
    // manifest to it. A crash before the manifest rename leaves the prior
    // generation authoritative; a crash after it exposes all three new files.
    const previousManifest = await this.#readManifest(dir);
    const generation = `${Date.now().toString(36)}-${stamp}`;
    const generationsDir = join(dir, "generations");
    const generationTmp = join(generationsDir, `${generation}.tmp`);
    const generationDir = join(generationsDir, generation);
    await mkdir(generationsDir, { recursive: true });
    await mkdir(generationTmp, { recursive: false });
    try {
      await Promise.all(
        (Object.entries(contents) as [keyof typeof contents, string][]).map(([name, content]) =>
          Bun.write(join(generationTmp, name), content)
        ),
      );
      await rename(generationTmp, generationDir);
      const files = Object.fromEntries(
        (Object.entries(contents) as [keyof typeof contents, string][]).map(([name, content]) =>
          [name, contentSha256(content)]
        ),
      ) as SessionCommitManifest["files"];
      const manifest: SessionCommitManifest = {
        version: 1,
        current: generation,
        files,
        ...(previousManifest?.current && isSafeGeneration(previousManifest.current)
          ? {
              previous: previousManifest.current,
              previousFiles: previousManifest.files,
            }
          : {}),
      };
      const manifestTmp = join(dir, `manifest.json.${stamp}.tmp`);
      await Bun.write(manifestTmp, JSON.stringify(manifest, null, 2));
      await rename(manifestTmp, join(dir, "manifest.json"));
    } catch (error) {
      await rm(generationTmp, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    const tmp = (name: string) => join(dir, `${name}.${stamp}.tmp`);
    const targets: [string, string, string][] = [
      [tmp("meta.json"), join(dir, "meta.json"), contents["meta.json"]],
      [
        tmp("messages.jsonl"),
        join(dir, "messages.jsonl"),
        contents["messages.jsonl"],
      ],
      [
        tmp("history.jsonl"),
        join(dir, "history.jsonl"),
        contents["history.jsonl"],
      ],
    ];
    // Atomic save with ORDERED renames: write all temp files first, then rename
    // (atomic on POSIX) in a deliberate sequence — messages.jsonl (the
    // authoritative model context) first, history.jsonl (the UI view) next,
    // meta.json LAST. Parallel renames could crash into an arbitrary mix; the
    // ordering turns every crash window into a monotone state: the authoritative
    // transcript is never older than what meta/history claim, so a resumed
    // session at worst shows a slightly stale UI view — never a corrupt seed.
    const byName = (n: string) => targets.find((t) => t[1] === join(dir, n))!;
    // Unique temp names don't self-heal the way the old fixed `.tmp` did (a later
    // save reused that name), so on any write/rename failure clean up our own
    // temps — otherwise an interrupted save leaks orphaned `*.<pid>.<seq>.tmp`
    // files that accumulate forever.
    try {
      await Promise.all(targets.map(([tmpPath, , content]) => Bun.write(tmpPath, content)));
      for (const name of ["messages.jsonl", "history.jsonl", "meta.json"]) {
        const [tmpPath, finalPath] = byName(name);
        await rename(tmpPath, finalPath);
      }
    } catch {
      // The generation manifest above is already authoritative. Root files are
      // a one-release compatibility projection for older readers; failure to
      // refresh them must not report the committed save as lost.
      await Promise.all(
        targets.map(([tmpPath]) => rm(tmpPath, { force: true }).catch(() => undefined)),
      );
    }
    // Preserve a freshly re-read current/previous pair. Young directories are
    // left alone because a concurrent writer may not have committed its
    // manifest yet; a later save collects them once they are safely stale.
    const committed = await this.#readManifest(dir);
    if (committed) {
      const retained = new Set([committed.current, committed.previous].filter(Boolean));
      const entries = await readdir(generationsDir, { withFileTypes: true }).catch(() => []);
      const cutoff = Date.now() - GENERATION_PRUNE_AGE_MS;
      await Promise.all(entries.map(async (entry) => {
        if (!entry.isDirectory() || retained.has(entry.name)) return;
        const path = join(generationsDir, entry.name);
        const info = await stat(path).catch(() => null);
        if (info && info.mtimeMs < cutoff) {
          await rm(path, { recursive: true, force: true }).catch(() => undefined);
        }
      }));
    }
  }

  async load(id: string): Promise<PersistedSession | null> {
    if (!isSafeSessionId(id)) return null;
    // Global dir first; sessions persisted by older versions fall back to the
    // legacy in-project dir (read-only — the next save writes globally).
    for (const dir of [this.#dir(id), join(this.#legacy, id)]) {
      const committed = await this.#committedGeneration(dir);
      const candidates = committed ? [committed.dir, dir] : [dir];
      for (const dataDir of candidates) {
        const metaFile = Bun.file(join(dataDir, "meta.json"));
        if (!(await metaFile.exists())) continue;
        let meta: SessionMeta;
        try {
          meta = (await metaFile.json()) as SessionMeta;
        } catch {
          continue;
        }
        const storedVersion = typeof meta.version === "number" ? meta.version : 0;
        if (storedVersion > SESSION_META_VERSION) {
          throw new Error(
            `Session ${meta.id || id} uses metadata version ${storedVersion}; this build supports up to ${SESSION_META_VERSION}`,
          );
        }
        const modelRead = await this.#readJsonl<ModelMessage>(join(dataDir, "messages.jsonl"));
        const historyRead = await this.#readJsonl<Message>(join(dataDir, "history.jsonl"));
        const warnings = [
          ...(dataDir === committed?.dir ? committed.warnings : []),
          ...modelRead.warnings,
          ...historyRead.warnings,
        ];
        if (storedVersion < SESSION_META_VERSION || !Array.isArray(meta.turns)) {
          const turns = deriveTurnBoundaries(meta.id, modelRead.items, historyRead.items, meta.turns);
          meta = {
            ...meta,
            version: SESSION_META_VERSION,
            ...(meta.usage
              ? { usage: normalizePersistedUsage(meta.model, meta.usage, turns.length) }
              : {}),
            turns,
          };
          await this.save(meta, modelRead.items, historyRead.items).catch(() => undefined);
        }
        return {
          meta,
          modelMessages: modelRead.items,
          history: historyRead.items,
          ...(warnings.length ? { warnings } : {}),
        };
      }
    }
    return null;
  }

  /** Load only a session's UI history (history.jsonl) — recall searches this and
   * doesn't need the much larger authoritative model transcript (messages.jsonl).
   * Returns [] if the session or its history is absent/unreadable. */
  async loadHistory(id: string): Promise<Message[]> {
    const dir = this.#dir(id);
    const committed = await this.#committedGeneration(dir, ["history.jsonl"]);
    const current = await this.#readJsonl<Message>(join(committed?.dir ?? dir, "history.jsonl"));
    if (current.items.length) return current.items;
    return (await this.#readJsonl<Message>(join(this.#legacy, id, "history.jsonl"))).items;
  }

  async #readJsonl<T>(path: string): Promise<{ items: T[]; warnings: string[] }> {
    const file = Bun.file(path);
    if (!(await file.exists())) return { items: [], warnings: [] };
    const text = await file.text();
    const out: T[] = [];
    const warnings: string[] = [];
    let lineNo = 0;
    for (const line of text.split("\n")) {
      lineNo++;
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line, u8Reviver) as T);
      } catch {
        warnings.push(
          `${path}:${lineNo}: corrupt JSONL line; transcript truncated at the last valid entry`,
        );
        break;
      }
    }
    return { items: out, warnings };
  }

  /** All persisted sessions, newest first — the global dir merged with any
   * legacy in-project sessions (deduped by id; global wins). */
  async list(): Promise<SessionMeta[]> {
    const seen = new Map<string, SessionMeta>();
    for (const base of [this.#base, this.#legacy]) {
      let ids: string[];
      try {
        ids = await readdir(base);
      } catch {
        continue;
      }
      for (const id of ids) {
        if (seen.has(id)) continue;
        const sessionDir = join(base, id);
        const committed = await this.#committedGeneration(sessionDir, ["meta.json"]);
        const file = Bun.file(join(committed?.dir ?? sessionDir, "meta.json"));
        // One corrupt session must not break listing/resume for all the others.
        try {
          if (await file.exists()) seen.set(id, (await file.json()) as SessionMeta);
        } catch {
          /* skip corrupt session */
        }
      }
    }
    return [...seen.values()]
      .filter((meta) => meta.kind !== "subagent")
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Id of the most recently updated session, if any. */
  async latestId(): Promise<string | undefined> {
    return (await this.list())[0]?.id;
  }

  /** Root-session ancestry tree containing `id`, cycle-safe and ordered by
   * creation time. Legacy `forkedFrom` remains a parent fallback. */
  async sessionTree(id: string): Promise<SessionTreeNode | null> {
    if (!isSafeSessionId(id)) return null;
    const sessions = await this.list();
    const byId = new Map(sessions.map((meta) => [meta.id, meta]));
    let root: SessionMeta | undefined = byId.get(id);
    if (!root) return null;
    const ascended = new Set<string>();
    while (root) {
      if (ascended.has(root.id)) break;
      ascended.add(root.id);
      const parentId: string | undefined = root.parentSessionId ?? root.forkedFrom?.sessionId;
      const parent: SessionMeta | undefined = parentId ? byId.get(parentId) : undefined;
      if (!parent) break;
      root = parent;
    }
    const build = (meta: SessionMeta, path: Set<string>): SessionTreeNode => {
      const nextPath = new Set(path).add(meta.id);
      const children = sessions
        .filter((candidate) =>
          (candidate.parentSessionId ?? candidate.forkedFrom?.sessionId) === meta.id &&
          !nextPath.has(candidate.id))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .map((child) => build(child, nextPath));
      return { meta: { ...meta }, children };
    };
    if (!root) return null;
    return build(root, new Set());
  }

  /** Persist a user-facing title override on an existing session. */
  async setTitle(id: string, title: string): Promise<boolean> {
    if (!isSafeSessionId(id)) return false;
    const clean = title.replace(/\s+/g, " ").trim();
    if (!clean) return false;
    const loaded = await this.load(id);
    if (!loaded) return false;
    const meta: SessionMeta = {
      ...loaded.meta,
      title: clean.slice(0, 120),
      updatedAt: Date.now(),
      version: SESSION_META_VERSION,
    };
    await this.save(meta, loaded.modelMessages, loaded.history);
    return true;
  }

  /** Copy a completed user turn into a new independently writable session. */
  async fork(id: string, atTurnId: string): Promise<SessionMeta> {
    if (!isSafeSessionId(id) || !atTurnId) throw new Error("session and turn id required");
    const source = await this.load(id);
    if (!source) throw new Error("session not found");
    const sourceTurns =
      source.meta.turns ?? deriveTurnBoundaries(id, source.modelMessages, source.history);
    const boundary = sourceTurns.find((turn) => turn.id === atTurnId);
    if (boundary?.origin !== "user") throw new Error("fork boundary is not a completed user turn");
    let modelMessages = source.modelMessages.slice(0, boundary.modelEnd);
    const history = source.history.slice(0, boundary.historyEnd);
    assertCompleteToolPairs(modelMessages, history);
    const forkId = createId("ses");
    const now = Date.now();
    try {
      const copied = await this.#copyForkArtifacts(
        id,
        forkId,
        source.meta.offloaded,
        modelMessages,
      );
      modelMessages = rewriteOffloadPaths(modelMessages, copied.paths);
      const meta: SessionMeta = {
        version: SESSION_META_VERSION,
        id: forkId,
        model: source.meta.model,
        mode: source.meta.mode,
        goal: source.meta.goal,
        kind: "root",
        tasks: [],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          costUSD: 0,
          actualCostUSD: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          steps: 0,
          turns: 0,
          providerLatencyMs: 0,
          byModel: {
            [source.meta.model]: zeroPersistedModelUsage(),
          },
        },
        ...(source.meta.recalledContext ? { recalledContext: source.meta.recalledContext } : {}),
        ...(copied.records.length ? { offloaded: copied.records } : {}),
        title: `${source.meta.title?.trim() || "Session"} (fork)`.slice(0, 120),
        parentSessionId: id,
        forkedAtTurnId: atTurnId,
        forkedFrom: { sessionId: id, turnId: atTurnId },
        createdAt: now,
        updatedAt: now,
        turns: sourceTurns.filter((turn) => turn.historyEnd <= boundary.historyEnd),
      };
      await this.save(meta, modelMessages, history);
      return (await this.load(forkId))?.meta ?? meta;
    } catch (error) {
      await rm(this.#dir(forkId), { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #copyForkArtifacts(
    sourceId: string,
    forkId: string,
    records: SessionMeta["offloaded"],
    modelMessages: readonly ModelMessage[],
  ): Promise<{
    records: NonNullable<SessionMeta["offloaded"]>;
    paths: ReadonlyMap<string, string>;
  }> {
    if (!records?.length) return { records: [], paths: new Map() };
    const retainedCalls = modelToolResultIds(modelMessages);
    const selected = records.filter((record) => retainedCalls.has(record.callId));
    if (!selected.length) return { records: [], paths: new Map() };
    const allowedRoots = [
      resolve(this.#dir(sourceId), "tool-results"),
      resolve(this.#legacy, sourceId, "tool-results"),
    ];
    const realAllowedRoots = await Promise.all(
      allowedRoots.map((root) => realpath(root).catch(() => root)),
    );
    const destinationRoot = resolve(this.#dir(forkId), "tool-results");
    await mkdir(destinationRoot, { recursive: true });
    const copied: NonNullable<SessionMeta["offloaded"]> = [];
    const paths = new Map<string, string>();
    for (const record of selected) {
      const sourcePath = resolve(record.path);
      if (!allowedRoots.some((root) => isPathWithin(root, sourcePath))) {
        throw new Error(`fork artifact path is outside the source session: ${record.callId}`);
      }
      const realSourcePath = await realpath(sourcePath).catch(() => null);
      if (!realSourcePath) {
        throw new Error(`fork artifact is unavailable: ${record.callId}`);
      }
      if (!realAllowedRoots.some((root) => isPathWithin(root, realSourcePath))) {
        throw new Error(`fork artifact resolves outside the source session: ${record.callId}`);
      }
      const safeCallId = record.callId.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 48);
      const callHash = createHash("sha256").update(record.callId).digest("hex").slice(0, 12);
      const fileName = `${safeCallId}-${callHash}.txt`;
      const destinationPath = join(destinationRoot, fileName);
      await copyFile(realSourcePath, destinationPath);
      paths.set(record.path, destinationPath);
      copied.push({ ...record, path: destinationPath });
    }
    return { records: copied, paths };
  }

  /** Permanently remove a session directory (global + legacy). */
  async delete(id: string): Promise<boolean> {
    if (!isSafeSessionId(id)) return false;
    let removed = false;
    for (const dir of [this.#dir(id), join(this.#legacy, id)]) {
      if (!(await Bun.file(join(dir, "meta.json")).exists())) continue;
      await rm(dir, { recursive: true, force: true });
      removed = true;
    }
    // Child conversations are hidden implementation state owned by the root.
    // Delete the whole descendant closure with the root so durable continuation
    // does not become durable garbage (nested children point at their immediate parent).
    const parents = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      const ids = await readdir(this.#base).catch(() => [] as string[]);
      for (const childId of ids) {
        if (parents.has(childId)) continue;
        try {
          const meta = (await Bun.file(
            join(this.#base, childId, "meta.json"),
          ).json()) as SessionMeta;
          if (
            meta.kind === "subagent" &&
            meta.parentSessionId &&
            parents.has(meta.parentSessionId)
          ) {
            await rm(join(this.#base, childId), { recursive: true, force: true });
            parents.add(childId);
            changed = true;
          }
        } catch {
          /* skip corrupt/unrelated child state */
        }
      }
    }
    // Best-effort: drop the matching saved plan sidecar.
    try {
      await rm(join(globalStateDir(this.#cwd), "plans", `${id}.md`), { force: true });
    } catch {
      /* ignore */
    }
    return removed;
  }

  /** Soft-delete: move the session under `sessions-archive/` (global root). */
  async archive(id: string): Promise<boolean> {
    if (!isSafeSessionId(id)) return false;
    const src = this.#dir(id);
    const legacy = join(this.#legacy, id);
    let from: string | null = null;
    for (const candidate of [src, legacy]) {
      try {
        const file = Bun.file(join(candidate, "meta.json"));
        if (await file.exists()) {
          from = candidate;
          break;
        }
      } catch {
        /* try next */
      }
    }
    if (!from) return false;
    const archiveRoot = join(globalStateDir(this.#cwd), "sessions-archive");
    await mkdir(archiveRoot, { recursive: true });
    const dest = join(archiveRoot, id);
    await rm(dest, { recursive: true, force: true }).catch(() => undefined);
    // rename is atomic on the same filesystem; fall back to copy+rm for a
    // cross-device archive (a legacy in-project session under a different
    // mount than ~/.vibe/state on Linux) so EXDEV never breaks the move.
    try {
      await rename(from, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EXDEV") throw err;
      const { cp } = await import("node:fs/promises");
      await cp(from, dest, { recursive: true });
      await rm(from, { recursive: true, force: true });
    }
    // If we archived the global copy, also drop a legacy twin so list() stays clean.
    if (from === src) {
      await rm(legacy, { recursive: true, force: true }).catch(() => undefined);
    }
    return true;
  }
}

/** Flatten the text used to align compacted model turns with full display history. */
function comparableModelUserText(message: ModelMessage): string {
  const content = message.content;
  if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const value = part as { type?: unknown; text?: unknown };
      return (value.type === "text" || value.type === "reasoning") && typeof value.text === "string"
        ? [value.text]
        : [];
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function comparableHistoryUserText(message: Message): string {
  return message.parts
    .flatMap((part) => (part.type === "text" || part.type === "reasoning" ? [part.text] : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Derive a stable user-turn map without changing the provider-facing message
 * representation. Alignment proceeds newest-first because compaction retains a
 * provider-facing suffix while display history remains complete. */
export function deriveTurnBoundaries(
  sessionId: string,
  modelMessages: readonly ModelMessage[],
  history: readonly Message[],
  prior: readonly PersistedTurnBoundary[] | undefined = undefined,
): PersistedTurnBoundary[] {
  const historyUsers = history
    .map((message, index) =>
      message.role === "user" ? { index, text: comparableHistoryUserText(message) } : null,
    )
    .filter((entry): entry is { index: number; text: string } => entry !== null);
  const modelUsers = modelMessages
    .map((message, index) =>
      message.role === "user" ? { index, text: comparableModelUserText(message) } : null,
    )
    .filter((entry): entry is { index: number; text: string } => entry !== null);
  const aligned: Array<{ modelIndex: number; historyOrdinal: number }> = [];
  let historyCursor = historyUsers.length - 1;
  for (
    let modelOrdinal = modelUsers.length - 1;
    modelOrdinal >= 0 && historyCursor >= 0;
    modelOrdinal -= 1
  ) {
    const modelUser = modelUsers[modelOrdinal]!;
    let matchingOrdinal = -1;
    const containsSummary = modelUser.text.startsWith("[Summary of earlier conversation]");
    if (modelUser.text) {
      for (let candidate = historyCursor; candidate >= 0; candidate -= 1) {
        const historyText = historyUsers[candidate]!.text;
        const exact = historyText === modelUser.text;
        const foldedAfterSummary =
          containsSummary && historyText.length > 0 && modelUser.text.endsWith(` ${historyText}`);
        if (exact || foldedAfterSummary) {
          matchingOrdinal = candidate;
          break;
        }
      }
    }
    // A summary-only synthetic user message has no display-history boundary.
    // A folded summary + retained prompt was matched by suffix above.
    if (containsSummary && matchingOrdinal < 0) continue;
    // Some engine-authored turns deliberately use a shorter display label than
    // their provider prompt. Newest-first ordinal alignment is the safe fallback.
    if (matchingOrdinal < 0) matchingOrdinal = historyCursor;
    aligned.push({ modelIndex: modelUser.index, historyOrdinal: matchingOrdinal });
    historyCursor = matchingOrdinal - 1;
  }
  aligned.reverse();
  const boundaries: PersistedTurnBoundary[] = [];
  for (let turnIndex = 0; turnIndex < aligned.length; turnIndex += 1) {
    const pair = aligned[turnIndex]!;
    const historyStart = historyUsers[pair.historyOrdinal]!.index;
    const historyEnd = historyUsers[pair.historyOrdinal + 1]?.index ?? history.length;
    const modelEnd = aligned[turnIndex + 1]?.modelIndex ?? modelMessages.length;
    if (
      !history.slice(historyStart + 1, historyEnd).some((message) => message.role === "assistant")
    )
      continue;
    const message = history[historyStart]!;
    const metadataTurnId =
      typeof message.metadata?.turnId === "string" ? message.metadata.turnId : undefined;
    const old =
      prior?.find((turn) => turn.historyEnd === historyEnd) ?? prior?.[pair.historyOrdinal];
    boundaries.push({
      id: metadataTurnId ?? old?.id ?? deterministicTurnId(sessionId, pair.historyOrdinal),
      modelEnd,
      historyEnd,
      completedAt: history[historyEnd - 1]?.createdAt ?? message.createdAt,
      origin: message.metadata?.origin === "engine" ? "engine" : "user",
    });
  }
  return boundaries;
}

function modelToolResultIds(messages: readonly ModelMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part?.type === "tool-result" && part.toolCallId) ids.add(part.toolCallId);
    }
  }
  return ids;
}

function rewriteOffloadPaths(
  messages: readonly ModelMessage[],
  paths: ReadonlyMap<string, string>,
): ModelMessage[] {
  if (!paths.size) return [...messages];
  return messages.map((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((part) => {
      const candidate = part as {
        type?: string;
        output?: { type?: string; value?: unknown };
      };
      if (candidate?.type !== "tool-result" || typeof candidate.output?.value !== "string") {
        return part;
      }
      let value = candidate.output.value;
      for (const [sourcePath, destinationPath] of paths) {
        value = value.replaceAll(sourcePath, destinationPath);
      }
      if (value === candidate.output.value) return part;
      changed = true;
      return { ...candidate, output: { ...candidate.output, value } };
    });
    return changed ? ({ ...message, content } as ModelMessage) : message;
  });
}

function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function deterministicTurnId(sessionId: string, completedIndex: number): string {
  return `turn_${createHash("sha256").update(`${sessionId}:${completedIndex}`).digest("hex").slice(0, 20)}`;
}

/** Refuse a fork that cuts through a tool-call/tool-result pair. */
export function assertCompleteToolPairs(
  modelMessages: readonly ModelMessage[],
  history: readonly Message[],
): void {
  const validate = (parts: readonly unknown[]) => {
    const pending = new Set<string>();
    for (const partValue of parts) {
      if (!partValue || typeof partValue !== "object") continue;
      const part = partValue as { type?: unknown; toolCallId?: unknown };
      if (part.type === "tool-call" && typeof part.toolCallId === "string")
        pending.add(part.toolCallId);
      if (part.type === "tool-result" && typeof part.toolCallId === "string") {
        if (!pending.delete(part.toolCallId))
          throw new Error("fork boundary contains an unmatched tool result");
      }
    }
    if (pending.size) throw new Error("fork boundary contains an unmatched tool call");
  };
  const modelParts: unknown[] = [];
  for (const message of modelMessages) {
    if (Array.isArray(message.content)) modelParts.push(...message.content);
  }
  validate(modelParts);
  validate(history.flatMap((message) => message.parts));
}
