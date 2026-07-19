import { mkdir, readdir, rename, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { createId, type Message, type Mode, type Task } from "@vibe/shared";
import { createHash } from "node:crypto";
import type { SourceEntry } from "./source-ledger.ts";
import { ensureStateDir, globalStateDir } from "./state-dir.ts";

/** Current on-disk SessionMeta schema version. Bump when the meta shape changes
 * incompatibly; a loader can then detect + migrate rather than silently misparse
 * an older/newer file. Absent on pre-versioning saves (read as version 0). */
export const SESSION_META_VERSION = 2;

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

export interface PersistedSession {
  meta: SessionMeta;
  modelMessages: ModelMessage[];
  history: Message[];
  warnings?: string[];
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

  async save(meta: SessionMeta, modelMessages: ModelMessage[], history: Message[]): Promise<void> {
    if (!isSafeSessionId(meta.id)) throw new Error("invalid session id");
    if (!this.#ensured) {
      this.#ensured = true;
      await ensureStateDir(this.#cwd);
    }
    const normalizedMeta: SessionMeta = {
      ...meta,
      version: SESSION_META_VERSION,
      turns: deriveTurnBoundaries(meta.id, modelMessages, history, meta.turns),
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
    const tmp = (name: string) => join(dir, `${name}.${stamp}.tmp`);
    const targets: [string, string, string][] = [
      [tmp("meta.json"), join(dir, "meta.json"), JSON.stringify(normalizedMeta, null, 2)],
      [
        tmp("messages.jsonl"),
        join(dir, "messages.jsonl"),
        modelMessages.map((m) => JSON.stringify(m, u8Replacer)).join("\n"),
      ],
      [
        tmp("history.jsonl"),
        join(dir, "history.jsonl"),
        history.map((m) => JSON.stringify(m, u8Replacer)).join("\n"),
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
    } catch (err) {
      // Best-effort: remove any of our unrenamed temps, then re-throw so the
      // caller still learns the save failed.
      await Promise.all(
        targets.map(([tmpPath]) => rm(tmpPath, { force: true }).catch(() => undefined)),
      );
      throw err;
    }
  }

  async load(id: string): Promise<PersistedSession | null> {
    if (!isSafeSessionId(id)) return null;
    // Global dir first; sessions persisted by older versions fall back to the
    // legacy in-project dir (read-only — the next save writes globally).
    for (const dir of [this.#dir(id), join(this.#legacy, id)]) {
      const metaFile = Bun.file(join(dir, "meta.json"));
      if (!(await metaFile.exists())) continue;
      let meta: SessionMeta;
      try {
        meta = (await metaFile.json()) as SessionMeta;
      } catch {
        // A corrupt/partial global meta.json (e.g. a power-loss torn write) must
        // NOT strand an INTACT legacy copy of the same id — `continue` to the
        // legacy root instead of returning null, so load() agrees with list()
        // (which surfaces the legacy copy). Only after BOTH roots fail is the
        // session truly absent.
        continue;
      }
      const modelRead = await this.#readJsonl<ModelMessage>(join(dir, "messages.jsonl"));
      const historyRead = await this.#readJsonl<Message>(join(dir, "history.jsonl"));
      const warnings = [...modelRead.warnings, ...historyRead.warnings];
      if (meta.version !== SESSION_META_VERSION || !Array.isArray(meta.turns)) {
        meta = {
          ...meta,
          version: SESSION_META_VERSION,
          turns: deriveTurnBoundaries(meta.id, modelRead.items, historyRead.items, meta.turns),
        };
        // First load upgrades stable turn identities atomically. Migration is
        // best-effort: a read remains usable even if the disk is read-only.
        await this.save(meta, modelRead.items, historyRead.items).catch(() => undefined);
      }
      return {
        meta,
        modelMessages: modelRead.items,
        history: historyRead.items,
        ...(warnings.length ? { warnings } : {}),
      };
    }
    return null;
  }

  /** Load only a session's UI history (history.jsonl) — recall searches this and
   * doesn't need the much larger authoritative model transcript (messages.jsonl).
   * Returns [] if the session or its history is absent/unreadable. */
  async loadHistory(id: string): Promise<Message[]> {
    const current = await this.#readJsonl<Message>(join(this.#dir(id), "history.jsonl"));
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
        const file = Bun.file(join(base, id, "meta.json"));
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
    const sourceTurns = source.meta.turns ?? deriveTurnBoundaries(id, source.modelMessages, source.history);
    const boundary = sourceTurns.find((turn) => turn.id === atTurnId);
    if (boundary?.origin !== "user") throw new Error("fork boundary is not a completed user turn");
    const modelMessages = source.modelMessages.slice(0, boundary.modelEnd);
    const history = source.history.slice(0, boundary.historyEnd);
    assertCompleteToolPairs(modelMessages, history);
    const forkId = createId("ses");
    const now = Date.now();
    const meta: SessionMeta = {
      version: SESSION_META_VERSION,
      id: forkId,
      model: source.meta.model,
      mode: source.meta.mode,
      goal: source.meta.goal,
      kind: "root",
      tasks: [],
      usage: { inputTokens: 0, outputTokens: 0, costUSD: 0, actualCostUSD: 0 },
      ...(source.meta.recalledContext ? { recalledContext: source.meta.recalledContext } : {}),
      title: `${source.meta.title?.trim() || "Session"} (fork)`.slice(0, 120),
      forkedFrom: { sessionId: id, turnId: atTurnId },
      createdAt: now,
      updatedAt: now,
      turns: sourceTurns.filter((turn) => turn.historyEnd <= boundary.historyEnd),
    };
    try {
      await this.save(meta, modelMessages, history);
      return (await this.load(forkId))?.meta ?? meta;
    } catch (error) {
      await rm(this.#dir(forkId), { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
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
    .map((message, index) => message.role === "user" ? { index, text: comparableHistoryUserText(message) } : null)
    .filter((entry): entry is { index: number; text: string } => entry !== null);
  const modelUsers = modelMessages
    .map((message, index) => message.role === "user"
      ? { index, text: comparableModelUserText(message) }
      : null)
    .filter((entry): entry is { index: number; text: string } => entry !== null);
  const aligned: Array<{ modelIndex: number; historyOrdinal: number }> = [];
  let historyCursor = historyUsers.length - 1;
  for (let modelOrdinal = modelUsers.length - 1; modelOrdinal >= 0 && historyCursor >= 0; modelOrdinal -= 1) {
    const modelUser = modelUsers[modelOrdinal]!;
    if (modelUser.text.startsWith("[Summary of earlier conversation]")) continue;
    let matchingOrdinal = -1;
    if (modelUser.text) {
      for (let candidate = historyCursor; candidate >= 0; candidate -= 1) {
        if (historyUsers[candidate]!.text === modelUser.text) {
          matchingOrdinal = candidate;
          break;
        }
      }
    }
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
    if (!history.slice(historyStart + 1, historyEnd).some((message) => message.role === "assistant")) continue;
    const message = history[historyStart]!;
    const metadataTurnId = typeof message.metadata?.turnId === "string" ? message.metadata.turnId : undefined;
    const old = prior?.find((turn) => turn.historyEnd === historyEnd) ?? prior?.[pair.historyOrdinal];
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
      if (part.type === "tool-call" && typeof part.toolCallId === "string") pending.add(part.toolCallId);
      if (part.type === "tool-result" && typeof part.toolCallId === "string") {
        if (!pending.delete(part.toolCallId)) throw new Error("fork boundary contains an unmatched tool result");
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
