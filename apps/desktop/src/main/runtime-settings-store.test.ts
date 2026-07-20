import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRuntimeSettings, RuntimeSettingsStore } from "./runtime-settings-store";

describe("RuntimeSettingsStore", () => {
  it("defaults absent and invalid capacity to three", async () => {
    const root = join(tmpdir(), `vibe-runtime-settings-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    expect(readRuntimeSettings(join(root, "missing.json"))).toEqual({ capacity: 3 });
    const invalid = join(root, "invalid.json");
    await writeFile(invalid, JSON.stringify({ capacity: 9 }));
    expect(readRuntimeSettings(invalid)).toEqual({ capacity: 3 });
    await writeFile(invalid, JSON.stringify({ capacity: 2.5 }));
    expect(readRuntimeSettings(invalid)).toEqual({ capacity: 3 });
  });

  it("persists a valid capacity atomically", async () => {
    const root = join(tmpdir(), `vibe-runtime-settings-${crypto.randomUUID()}`);
    const store = new RuntimeSettingsStore(root);
    await expect(store.update({ capacity: 8 })).resolves.toEqual({ capacity: 8 });
    expect(new RuntimeSettingsStore(root).get()).toEqual({ capacity: 8 });
  });
});
