import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import type { Message, Mode, Task } from "@vibe/shared";
import type { SourceEntry } from "./source-ledger.ts";
import { ensureStateDir, globalStateDir } from "./state-dir.ts";

/** Current on-disk SessionMeta schema version. Bump when the meta shape changes
 * incompatibly; a loader can then detect + migrate rather than silently misparse
 * an older/newer file. Absent on pre-versioning saves (read as version 0). */
export const SESSION_META_VERSION = 1;

export interface SessionMeta {
  /** Schema version of this record (see SESSION_META_VERSION); absent = 0. */
  version?: number;
  id: string;
  model: string;
  mode: Mode;
  goal: string | null;
  /** The working task list at the time of the last save. */
  tasks?: Task[];
  /** Cumulative token usage + accrued cost at the time of the last save. The
   * cache-read total is persisted too, so `--resume` keeps a truthful running
   * usage/cost instead of silently zeroing the cached slice. */
  usage?: { inputTokens: number; outputTokens: number; costUSD?: number; cachedInputTokens?: number };
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
  createdAt: number;
  updatedAt: number;
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
    return join(this.#base, id);
  }

  async save(
    meta: SessionMeta,
    modelMessages: ModelMessage[],
    history: Message[],
  ): Promise<void> {
    if (!this.#ensured) {
      this.#ensured = true;
      await ensureStateDir(this.#cwd);
    }
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
      [tmp("meta.json"), join(dir, "meta.json"), JSON.stringify(meta, null, 2)],
      [tmp("messages.jsonl"), join(dir, "messages.jsonl"), modelMessages.map((m) => JSON.stringify(m, u8Replacer)).join("\n")],
      [tmp("history.jsonl"), join(dir, "history.jsonl"), history.map((m) => JSON.stringify(m, u8Replacer)).join("\n")],
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
      await Promise.all(targets.map(([tmpPath]) => rm(tmpPath, { force: true }).catch(() => undefined)));
      throw err;
    }
  }

  async load(id: string): Promise<PersistedSession | null> {
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
      const modelRead = await this.#readJsonl<ModelMessage>(
        join(dir, "messages.jsonl"),
      );
      const historyRead = await this.#readJsonl<Message>(join(dir, "history.jsonl"));
      const warnings = [...modelRead.warnings, ...historyRead.warnings];
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
        warnings.push(`${path}:${lineNo}: corrupt JSONL line; transcript truncated at the last valid entry`);
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
    return [...seen.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Id of the most recently updated session, if any. */
  async latestId(): Promise<string | undefined> {
    return (await this.list())[0]?.id;
  }
}
