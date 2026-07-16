import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { CloudSessionCatalogEntry } from "../../shared/cloud";

interface CatalogFileV1 {
  schemaVersion: 1;
  sessions: CloudSessionCatalogEntry[];
}

export class CloudSessionCatalog {
  #writeChain = Promise.resolve();

  constructor(private readonly path: string) {}

  async list(): Promise<CloudSessionCatalogEntry[]> {
    return (await this.#read()).sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(sessionId: string): Promise<CloudSessionCatalogEntry | undefined> {
    return (await this.#read()).sessions.find((entry) => entry.sessionId === sessionId);
  }

  async put(entry: CloudSessionCatalogEntry): Promise<void> {
    await this.#queue(async () => {
      const file = await this.#read();
      const sessions = file.sessions.filter((item) => item.sessionId !== entry.sessionId);
      sessions.push({ ...entry, updatedAt: Date.now() });
      await this.#write({ schemaVersion: 1, sessions });
    });
  }

  async patch(sessionId: string, patch: Partial<Omit<CloudSessionCatalogEntry, "sessionId">>): Promise<CloudSessionCatalogEntry> {
    let updated: CloudSessionCatalogEntry | undefined;
    await this.#queue(async () => {
      const file = await this.#read();
      const index = file.sessions.findIndex((entry) => entry.sessionId === sessionId);
      if (index < 0) throw new Error("Cloud session is not in the local catalog");
      updated = { ...file.sessions[index]!, ...patch, sessionId, updatedAt: Date.now() };
      file.sessions[index] = updated;
      await this.#write(file);
    });
    return updated!;
  }

  async remove(sessionId: string): Promise<void> {
    await this.#queue(async () => {
      const file = await this.#read();
      file.sessions = file.sessions.filter((entry) => entry.sessionId !== sessionId);
      await this.#write(file);
    });
  }

  #queue(work: () => Promise<void>): Promise<void> {
    const run = this.#writeChain.then(work);
    this.#writeChain = run.catch(() => undefined);
    return run;
  }

  async #read(): Promise<CatalogFileV1> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as CatalogFileV1;
      if (value.schemaVersion !== 1 || !Array.isArray(value.sessions)) throw new Error();
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cloud session catalog is corrupt");
      return { schemaVersion: 1, sessions: [] };
    }
  }

  async #write(value: CatalogFileV1): Promise<void> {
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true });
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      const file = await open(tmp, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
        // The catalog is the ownership recovery authority. An atomic rename is
        // insufficient if the replacement never reaches stable storage.
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tmp, this.path);
      renamed = true;
      // Persist the directory entry as well. Some platforms/filesystems reject
      // directory fsync; the fully flushed file + atomic rename remains safe
      // there, so only unsupported-operation errors are ignored.
      let directory: Awaited<ReturnType<typeof open>> | undefined;
      try {
        directory = await open(parent, "r");
        await directory.sync();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
      } finally {
        await directory?.close();
      }
    } finally {
      if (!renamed) await unlink(tmp).catch(() => undefined);
    }
  }
}
