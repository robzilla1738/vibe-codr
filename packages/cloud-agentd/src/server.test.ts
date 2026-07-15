import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCloudPath } from "./server.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("resolveCloudPath", () => {
  test("accepts a contained path", async () => {
    const root = await temporaryRoot();
    await expect(resolveCloudPath(root, "nested/file.txt")).resolves.toBe(join(root, "nested/file.txt"));
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

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vibe-cloud-path-"));
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}
