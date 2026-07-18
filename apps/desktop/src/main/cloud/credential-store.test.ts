import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudCredentialStore, type ProtectedStringStorage } from "./credential-store";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CloudCredentialStore", () => {
  it("supports an asynchronous parent-process protected-storage bridge", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-credential-store-"));
    temporaryRoots.push(root);
    const protectedStorage: ProtectedStringStorage = {
      isEncryptionAvailable: () => true,
      encryptString: async (value) => Buffer.from(`sealed:${value}`),
      decryptString: async (value) => value.toString("utf8").replace(/^sealed:/, ""),
    };
    const store = new CloudCredentialStore(join(root, "credentials.json"), protectedStorage);

    await store.set("e2b", { apiKey: "provider-key" });
    await store.setSessionSecret("session", "bearer");
    await store.setSessionEnvironment("session", { OPENAI_API_KEY: "model-key" });
    await store.setBinding("binding", "integration-key");

    await expect(store.get("e2b")).resolves.toEqual({ apiKey: "provider-key" });
    await expect(store.getSessionSecret("session")).resolves.toBe("bearer");
    await expect(store.getSessionEnvironment("session")).resolves.toEqual({ OPENAI_API_KEY: "model-key" });
    await expect(store.getBinding("binding")).resolves.toBe("integration-key");
  });
});
