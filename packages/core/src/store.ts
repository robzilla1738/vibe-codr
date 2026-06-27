import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import type { Message, Mode } from "@vibe/shared";

export interface SessionMeta {
  id: string;
  model: string;
  mode: Mode;
  goal: string | null;
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
    await Bun.write(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
    await Bun.write(
      join(dir, "messages.jsonl"),
      modelMessages.map((m) => JSON.stringify(m)).join("\n"),
    );
    await Bun.write(
      join(dir, "history.jsonl"),
      history.map((m) => JSON.stringify(m)).join("\n"),
    );
  }

  async load(id: string): Promise<PersistedSession | null> {
    const dir = this.#dir(id);
    const metaFile = Bun.file(join(dir, "meta.json"));
    if (!(await metaFile.exists())) return null;
    const meta = (await metaFile.json()) as SessionMeta;
    const modelMessages = await this.#readJsonl<ModelMessage>(
      join(dir, "messages.jsonl"),
    );
    const history = await this.#readJsonl<Message>(join(dir, "history.jsonl"));
    return { meta, modelMessages, history };
  }

  async #readJsonl<T>(path: string): Promise<T[]> {
    const file = Bun.file(path);
    if (!(await file.exists())) return [];
    const text = await file.text();
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
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
      if (await file.exists()) metas.push((await file.json()) as SessionMeta);
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Id of the most recently updated session, if any. */
  async latestId(): Promise<string | undefined> {
    return (await this.list())[0]?.id;
  }
}
