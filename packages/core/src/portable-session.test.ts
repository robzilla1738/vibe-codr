import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PortableSessionManager } from "./portable-session.ts";
import { globalStateDir } from "./state-dir.ts";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.VIBE_STATE_DIR;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vibe-portable-"));
  roots.push(root);
  process.env.VIBE_STATE_DIR = join(root, "state");
  const source = join(root, "source");
  const target = join(root, "target");
  const sessionId = "session_portable_1";
  const state = globalStateDir(source);
  const session = join(state, "sessions", sessionId);
  await mkdir(session, { recursive: true });
  await writeFile(join(session, "meta.json"), JSON.stringify({ id: sessionId, cwd: source }));
  await writeFile(
    join(session, "history.jsonl"),
    `${JSON.stringify({ id: "m1", metadata: { artifact: join(state, "artifacts", "a.txt") } })}\n`,
  );
  await writeFile(join(session, "messages.jsonl"), `${JSON.stringify({ role: "user", content: "hello" })}\n`);
  return { source, target, sessionId };
}

describe("PortableSessionManager", () => {
  test("round trips engine-owned state across roots with generation and path rebasing", async () => {
    const { source, target, sessionId } = await fixture();
    const sourceManager = new PortableSessionManager(source, sessionId);
    const prepared = await sourceManager.prepare({ kind: "cloud", provider: "vercel" }, 0);
    const archive = await sourceManager.export("engine-rev", prepared.ownershipGeneration);

    expect(archive.executionTarget).toEqual({ kind: "cloud", provider: "vercel" });
    expect(archive.files.map((file) => file.path)).toEqual([
      "session/history.jsonl",
      "session/messages.jsonl",
      "session/meta.json",
    ]);

    await PortableSessionManager.import(target, archive, "engine-rev");
    const targetState = globalStateDir(target);
    const meta = JSON.parse(await readFile(join(targetState, "sessions", sessionId, "meta.json"), "utf8"));
    expect(meta.cwd).toBe(target);
    const history = await readFile(join(targetState, "sessions", sessionId, "history.jsonl"), "utf8");
    expect(history).toContain(targetState);
    expect(history).not.toContain(globalStateDir(source));
  });

  test("rejects stale generations, revision drift, and archive tampering", async () => {
    const { source, target, sessionId } = await fixture();
    const manager = new PortableSessionManager(source, sessionId);
    const prepared = await manager.prepare({ kind: "cloud", provider: "e2b" });
    await expect(manager.prepare({ kind: "local" })).rejects.toThrow("already prepared");
    const archive = await manager.export("engine-rev", prepared.ownershipGeneration);
    await expect(PortableSessionManager.import(target, archive, "different-rev")).rejects.toThrow("revision mismatch");
    const tampered = { ...archive, archiveSha256: "0".repeat(64) };
    await expect(PortableSessionManager.import(target, tampered, "engine-rev")).rejects.toThrow("manifest hash mismatch");
  });

  test("abort restores the prior generation and owner", async () => {
    const { source, sessionId } = await fixture();
    const manager = new PortableSessionManager(source, sessionId);
    const first = await manager.prepare({ kind: "cloud", provider: "e2b" }, 0);
    await manager.abort(first.nonce);
    const second = await manager.prepare({ kind: "cloud", provider: "vercel" }, 0);
    expect(second.ownershipGeneration).toBe(1);
  });
});
