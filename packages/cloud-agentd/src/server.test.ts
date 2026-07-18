import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  environmentWithoutControlSecrets,
  resolveCloudPath,
  sharedProjectFileMode,
  shouldProxyEngineFrame,
} from "./server.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("cloud control credentials are not inherited by engine or terminal children", () => {
  expect(environmentWithoutControlSecrets({
    PATH: "/usr/bin",
    VIBE_CLOUD_ACCESS_TOKEN: "not-for-workloads",
    VIBE_CLOUD_ACCESS_TOKEN_FILE: "/run/vibe-cloud/access-token",
    VIBE_CLOUD_MODEL_ACCESS_FILE: "/run/vibe-cloud/model-access.json",
    OPTIONAL: undefined,
  })).toEqual({ PATH: "/usr/bin" });
});

test("content-free performance samples remain machine-local", () => {
  expect(shouldProxyEngineFrame({ type: "event", event: { type: "turn-performance" } })).toBe(
    false,
  );
  expect(shouldProxyEngineFrame({ type: "event", event: { type: "assistant-text-delta" } })).toBe(
    true,
  );
});

describe("resolveCloudPath", () => {
  test("accepts a contained path", async () => {
    const root = await temporaryRoot();
    await expect(resolveCloudPath(root, "nested/file.txt")).resolves.toBe(
      join(root, "nested/file.txt"),
    );
  });

  test("rejects the workspace root and traversal", async () => {
    const root = await temporaryRoot();
    await expect(resolveCloudPath(root, ".")).rejects.toThrow("unsafe path");
    await expect(resolveCloudPath(root, "../outside")).rejects.toThrow("unsafe path");
  });

  test("rejects paths through existing symlinks", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(outside, join(root, "escape"));
    await expect(resolveCloudPath(root, "escape/secret.txt")).rejects.toThrow("symlink paths");
  });
});

test("shared project modes preserve owner execute access for the terminal group", () => {
  expect(sharedProjectFileMode(0o700)).toBe(0o770);
  expect(sharedProjectFileMode(0o755)).toBe(0o775);
  expect(sharedProjectFileMode(0o600)).toBe(0o660);
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vibe-cloud-path-"));
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}
