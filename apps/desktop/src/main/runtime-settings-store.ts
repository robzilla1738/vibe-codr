import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type LocalRuntimeSettings,
  normalizeLocalRuntimeCapacity,
} from "../shared/local-runtime";

const SETTINGS_FILE = "desktop-runtime-settings.json";

export class RuntimeSettingsStore {
  readonly #path: string;
  #settings: LocalRuntimeSettings;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(userDataDir: string) {
    this.#path = join(userDataDir, SETTINGS_FILE);
    this.#settings = readRuntimeSettings(this.#path);
  }

  get(): LocalRuntimeSettings {
    return { ...this.#settings };
  }

  update(input: { capacity: unknown }): Promise<LocalRuntimeSettings> {
    const next = { capacity: normalizeLocalRuntimeCapacity(input.capacity) };
    const operation = this.#writeTail.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temp = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temp, this.#path);
        this.#settings = next;
      } finally {
        await rm(temp, { force: true });
      }
    });
    this.#writeTail = operation.then(() => undefined, () => undefined);
    return operation.then(() => this.get());
  }
}

export function readRuntimeSettings(path: string): LocalRuntimeSettings {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { capacity?: unknown };
    return { capacity: normalizeLocalRuntimeCapacity(parsed?.capacity) };
  } catch {
    return { capacity: normalizeLocalRuntimeCapacity(undefined) };
  }
}
