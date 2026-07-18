import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CloudProviderId, ProviderCredentials } from "../../shared/cloud";

export interface ProtectedStringStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer | Promise<Buffer>;
  decryptString(value: Buffer): string | Promise<string>;
}

interface EncryptedCredentialFileV1 {
  schemaVersion: 1;
  values: Record<string, string>;
}

export class CloudCredentialStore {
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly path: string, private readonly protectedStorage?: ProtectedStringStorage) {}

  isAvailable(): boolean {
    return this.protectedStorage?.isEncryptionAvailable() === true;
  }

  async set<P extends CloudProviderId>(provider: P, credentials: NonNullable<ProviderCredentials[P]>): Promise<void> {
    if (!this.isAvailable()) {
      throw new Error("Cloud credentials cannot be saved because OS-protected storage is unavailable");
    }
    await this.#mutate(async (file) => {
      file.values[provider] = (await this.protectedStorage!.encryptString(JSON.stringify(credentials))).toString("base64");
    });
  }

  async get<P extends CloudProviderId>(provider: P): Promise<ProviderCredentials[P] | undefined> {
    if (!this.isAvailable()) return undefined;
    const encoded = (await this.#readCurrent()).values[provider];
    if (!encoded) return undefined;
    try {
      return JSON.parse(await this.protectedStorage!.decryptString(Buffer.from(encoded, "base64"))) as ProviderCredentials[P];
    } catch {
      throw new Error(`${provider} cloud credentials could not be decrypted; reconnect the account`);
    }
  }

  async remove(provider: CloudProviderId): Promise<void> {
    await this.#mutate((file) => { delete file.values[provider]; });
  }

  async setSessionSecret(sessionId: string, value: string): Promise<void> {
    if (!this.isAvailable()) throw new Error("OS-protected storage is unavailable");
    await this.#mutate(async (file) => {
      file.values[`session:${sessionId}`] = (await this.protectedStorage!.encryptString(value)).toString("base64");
    });
  }

  async getSessionSecret(sessionId: string): Promise<string | undefined> {
    if (!this.isAvailable()) return undefined;
    const encoded = (await this.#readCurrent()).values[`session:${sessionId}`];
    return encoded ? await this.protectedStorage!.decryptString(Buffer.from(encoded, "base64")) : undefined;
  }

  async setSessionEnvironment(sessionId: string, environment: Record<string, string>): Promise<void> {
    if (!this.isAvailable()) throw new Error("OS-protected storage is unavailable");
    await this.#mutate(async (file) => {
      file.values[`session-environment:${sessionId}`] = (await this.protectedStorage!.encryptString(JSON.stringify(environment))).toString("base64");
    });
  }

  async getSessionEnvironment(sessionId: string): Promise<Record<string, string> | undefined> {
    if (!this.isAvailable()) return undefined;
    const encoded = (await this.#readCurrent()).values[`session-environment:${sessionId}`];
    if (!encoded) return undefined;
    try {
      const value = JSON.parse(await this.protectedStorage!.decryptString(Buffer.from(encoded, "base64"))) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.values(value).some((item) => typeof item !== "string")) throw new Error();
      return value as Record<string, string>;
    } catch {
      throw new Error("Cloud session model access could not be decrypted; return the session to Local");
    }
  }

  async removeSessionSecret(sessionId: string): Promise<void> {
    await this.#mutate((file) => {
      delete file.values[`session:${sessionId}`];
      delete file.values[`session-environment:${sessionId}`];
    });
  }

  async setBinding(id: string, value: string): Promise<void> {
    if (!this.isAvailable()) throw new Error("OS-protected storage is unavailable");
    await this.#mutate(async (file) => {
      file.values[`binding:${id}`] = (await this.protectedStorage!.encryptString(value)).toString("base64");
    });
  }

  async getBinding(id: string): Promise<string | undefined> {
    if (!this.isAvailable()) return undefined;
    const encoded = (await this.#readCurrent()).values[`binding:${id}`];
    return encoded ? await this.protectedStorage!.decryptString(Buffer.from(encoded, "base64")) : undefined;
  }

  async removeBinding(id: string): Promise<void> {
    await this.#mutate((file) => { delete file.values[`binding:${id}`]; });
  }

  async readiness(): Promise<Record<CloudProviderId, boolean>> {
    if (!this.isAvailable()) return { e2b: false, vercel: false };
    const file = await this.#readCurrent();
    return { e2b: !!file.values.e2b, vercel: !!file.values.vercel };
  }

  async #read(): Promise<EncryptedCredentialFileV1> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as EncryptedCredentialFileV1;
      if (value.schemaVersion !== 1 || !value.values || typeof value.values !== "object") throw new Error();
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Cloud credential store is corrupt; reconnect cloud accounts");
      }
      return { schemaVersion: 1, values: {} };
    }
  }

  async #readCurrent(): Promise<EncryptedCredentialFileV1> {
    await this.#mutationTail;
    return this.#read();
  }

  async #mutate(mutation: (file: EncryptedCredentialFileV1) => void | Promise<void>): Promise<void> {
    const operation = this.#mutationTail.then(async () => {
      const file = await this.#read();
      await mutation(file);
      await this.#write(file);
    });
    this.#mutationTail = operation.catch(() => undefined);
    await operation;
  }

  async #write(value: EncryptedCredentialFileV1): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
