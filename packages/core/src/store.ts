import { readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import type { Message, Mode, Task } from "@vibe/shared";

export interface SessionMeta {
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
  /** The proactively-recalled context block, so a resumed session keeps the
   * same injected memory instead of silently dropping (or re-deriving) it. */
  recalledContext?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PersistedSession {
  meta: SessionMeta;
  modelMessages: ModelMessage[];
  history: Message[];
}

/**
 * Persists sessions under `.vibe/sessions/<id>/` so runs are resumable.
 * `messages.jsonl` holds the authoritative model context; `history.jsonl`
 * holds the UI message log; `meta.json` holds session metadata.
 */
export class SessionStore {
  #base: string;

  constructor(cwd: string) {
    this.#base = join(cwd, ".vibe", "sessions");
  }

  #dir(id: string): string {
    return join(this.#base, id);
  }

  async save(
    meta: SessionMeta,
    modelMessages: ModelMessage[],
    history: Message[],
  ): Promise<void> {
    const dir = this.#dir(meta.id);
    const files: [string, string][] = [
      [join(dir, "meta.json"), JSON.stringify(meta, null, 2)],
      [join(dir, "messages.jsonl"), modelMessages.map((m) => JSON.stringify(m)).join("\n")],
      [join(dir, "history.jsonl"), history.map((m) => JSON.stringify(m)).join("\n")],
    ];
    // Atomic save with ORDERED renames: write all temp files first, then rename
    // (atomic on POSIX) in a deliberate sequence — messages.jsonl (the
    // authoritative model context) first, history.jsonl (the UI view) next,
    // meta.json LAST. Parallel renames could crash into an arbitrary mix; the
    // ordering turns every crash window into a monotone state: the authoritative
    // transcript is never older than what meta/history claim, so a resumed
    // session at worst shows a slightly stale UI view — never a corrupt seed.
    await Promise.all(files.map(([path, content]) => Bun.write(`${path}.tmp`, content)));
    await rename(`${join(dir, "messages.jsonl")}.tmp`, join(dir, "messages.jsonl"));
    await rename(`${join(dir, "history.jsonl")}.tmp`, join(dir, "history.jsonl"));
    await rename(`${join(dir, "meta.json")}.tmp`, join(dir, "meta.json"));
  }

  async load(id: string): Promise<PersistedSession | null> {
    const dir = this.#dir(id);
    const metaFile = Bun.file(join(dir, "meta.json"));
    if (!(await metaFile.exists())) return null;
    let meta: SessionMeta;
    try {
      meta = (await metaFile.json()) as SessionMeta;
    } catch {
      // A corrupt/partial meta.json means the session is unusable — treat it as
      // absent so callers fall back to "start fresh" rather than crashing.
      return null;
    }
    const modelMessages = await this.#readJsonl<ModelMessage>(
      join(dir, "messages.jsonl"),
    );
    const history = await this.#readJsonl<Message>(join(dir, "history.jsonl"));
    return { meta, modelMessages, history };
  }

  /** Load only a session's UI history (history.jsonl) — recall searches this and
   * doesn't need the much larger authoritative model transcript (messages.jsonl).
   * Returns [] if the session or its history is absent/unreadable. */
  async loadHistory(id: string): Promise<Message[]> {
    return this.#readJsonl<Message>(join(this.#dir(id), "history.jsonl"));
  }

  async #readJsonl<T>(path: string): Promise<T[]> {
    const file = Bun.file(path);
    if (!(await file.exists())) return [];
    const text = await file.text();
    const out: T[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      // Skip an unparseable (truncated) trailing line rather than failing load.
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  }

  /** All persisted sessions, newest first. */
  async list(): Promise<SessionMeta[]> {
    let ids: string[];
    try {
      ids = await readdir(this.#base);
    } catch {
      return [];
    }
    const metas: SessionMeta[] = [];
    for (const id of ids) {
      const file = Bun.file(join(this.#dir(id), "meta.json"));
      // One corrupt session must not break listing/resume for all the others.
      try {
        if (await file.exists()) metas.push((await file.json()) as SessionMeta);
      } catch {
        /* skip corrupt session */
      }
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Id of the most recently updated session, if any. */
  async latestId(): Promise<string | undefined> {
    return (await this.list())[0]?.id;
  }
}
