import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { appendOrchestrationEvent, persistTaskReport } from "./build/journal.ts";
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
  await writeFile(
    join(session, "messages.jsonl"),
    `${JSON.stringify({ role: "user", content: "hello" })}\n`,
  );
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
    const meta = JSON.parse(
      await readFile(join(targetState, "sessions", sessionId, "meta.json"), "utf8"),
    );
    expect(meta.cwd).toBe(target);
    const history = await readFile(
      join(targetState, "sessions", sessionId, "history.jsonl"),
      "utf8",
    );
    expect(history).toContain(targetState);
    expect(history).not.toContain(globalStateDir(source));
  });

  test("rejects stale generations, revision drift, and archive tampering", async () => {
    const { source, target, sessionId } = await fixture();
    const manager = new PortableSessionManager(source, sessionId);
    const prepared = await manager.prepare({ kind: "cloud", provider: "e2b" });
    await expect(manager.prepare({ kind: "local" })).rejects.toThrow("already prepared");
    const archive = await manager.export("engine-rev", prepared.ownershipGeneration);
    await expect(PortableSessionManager.import(target, archive, "different-rev")).rejects.toThrow(
      "revision mismatch",
    );
    const tampered = { ...archive, archiveSha256: "0".repeat(64) };
    await expect(PortableSessionManager.import(target, tampered, "engine-rev")).rejects.toThrow(
      "manifest hash mismatch",
    );
  });

  test("abort restores the prior generation and owner", async () => {
    const { source, sessionId } = await fixture();
    const manager = new PortableSessionManager(source, sessionId);
    const first = await manager.prepare({ kind: "cloud", provider: "e2b" }, 0);
    await manager.abort(first.nonce);
    const second = await manager.prepare({ kind: "cloud", provider: "vercel" }, 0);
    expect(second.ownershipGeneration).toBe(1);
  });

  test("recovers an interrupted preparation without relying on the returned nonce", async () => {
    const { source, sessionId } = await fixture();
    const manager = new PortableSessionManager(source, sessionId);
    await manager.prepare({ kind: "cloud", provider: "e2b" }, 0);
    await expect(
      manager.abortInterrupted({ kind: "cloud", provider: "vercel" }, 1),
    ).rejects.toThrow("does not match");
    expect(await manager.abortInterrupted({ kind: "cloud", provider: "e2b" }, 1)).toEqual({
      outcome: "aborted",
      generation: 0,
    });
    await PortableSessionManager.assertOwner(source, sessionId, { kind: "local" });
  });

  test("reports a committed interrupted handoff structurally", async () => {
    const { source, sessionId } = await fixture();
    const manager = new PortableSessionManager(source, sessionId);
    const prepared = await manager.prepare({ kind: "cloud", provider: "e2b" }, 0);
    await manager.commit(prepared.nonce);
    expect(await manager.abortInterrupted({ kind: "cloud", provider: "e2b" }, 1)).toEqual({
      outcome: "already-committed",
      generation: 1,
    });
  });

  test("refuses bootstrap ownership mismatches and prepared generations", async () => {
    const { source, sessionId } = await fixture();
    const manager = new PortableSessionManager(source, sessionId);
    await PortableSessionManager.assertOwner(source, sessionId, { kind: "local" });
    const prepared = await manager.prepare({ kind: "cloud", provider: "e2b" }, 0);
    await expect(
      PortableSessionManager.assertOwner(source, sessionId, { kind: "local" }),
    ).rejects.toThrow("prepared");
    await manager.commit(prepared.nonce);
    await expect(
      PortableSessionManager.assertOwner(source, sessionId, { kind: "local" }),
    ).rejects.toThrow("cloud/e2b");
    await PortableSessionManager.assertOwner(source, sessionId, { kind: "cloud", provider: "e2b" });
    await expect(
      PortableSessionManager.assertOwner(source, sessionId, { kind: "cloud", provider: "vercel" }),
    ).rejects.toThrow("cloud/e2b");
  });

  test("explicitly recovers a provider-confirmed missing cloud owner to the local base", async () => {
    const { source, sessionId } = await fixture();
    const manager = new PortableSessionManager(source, sessionId);
    const prepared = await manager.prepare({ kind: "cloud", provider: "e2b" }, 0);
    await manager.commit(prepared.nonce);
    await expect(manager.recoverLostCloudOwnership("vercel", 1)).rejects.toThrow("does not match");
    await expect(manager.recoverLostCloudOwnership("e2b", 0)).rejects.toThrow("stale ownership");
    expect(await manager.recoverLostCloudOwnership("e2b", 1)).toBe(2);
    await PortableSessionManager.assertOwner(source, sessionId, { kind: "local" });
  });

  test("provisional return can abort to the exact prior local session or commit atomically", async () => {
    const { source, target, sessionId } = await fixture();
    const sourceState = globalStateDir(source);
    const targetState = globalStateDir(target);
    await mkdir(join(sourceState, "plans"), { recursive: true });
    await writeFile(join(sourceState, "plans", `${sessionId}.md`), "local plan\n");
    await writeFile(
      join(sourceState, "checkpoints.json"),
      JSON.stringify([
        { id: "local-checkpoint", sessionId },
        { id: "other-before", sessionId: "another_session" },
      ]),
    );
    const sourceManager = new PortableSessionManager(source, sessionId);
    const outbound = await sourceManager.prepare({ kind: "cloud", provider: "e2b" }, 0);
    const outboundArchive = await sourceManager.export("engine-rev", outbound.ownershipGeneration);
    await sourceManager.commit(outbound.nonce);
    await PortableSessionManager.import(target, outboundArchive, "engine-rev");

    await writeFile(
      join(targetState, "sessions", sessionId, "messages.jsonl"),
      `${JSON.stringify({ role: "assistant", content: "cloud result" })}\n`,
    );
    await writeFile(join(targetState, "plans", `${sessionId}.md`), "cloud plan\n");
    await writeFile(
      join(targetState, "checkpoints.json"),
      JSON.stringify([
        { id: "cloud-checkpoint", sessionId },
        { id: "other-before", sessionId: "another_session" },
      ]),
    );
    const targetManager = new PortableSessionManager(target, sessionId);
    const returning = await targetManager.prepare({ kind: "local" }, 1);
    const returnArchive = await targetManager.export("engine-rev", returning.ownershipGeneration);

    await PortableSessionManager.abortImport(source, sessionId, returning.ownershipGeneration);

    await PortableSessionManager.import(source, returnArchive, "engine-rev", { provisional: true });
    await PortableSessionManager.assertOwner(source, sessionId, { kind: "local" });
    await expect(sourceManager.prepare({ kind: "cloud", provider: "e2b" })).rejects.toThrow(
      "recovery is pending",
    );
    expect(
      await readFile(join(sourceState, "sessions", sessionId, "messages.jsonl"), "utf8"),
    ).toContain("cloud result");
    expect(await readFile(join(sourceState, "plans", `${sessionId}.md`), "utf8")).toBe(
      "cloud plan\n",
    );
    const provisionalCheckpoints = JSON.parse(
      await readFile(join(sourceState, "checkpoints.json"), "utf8"),
    );
    await writeFile(
      join(sourceState, "checkpoints.json"),
      JSON.stringify([
        ...provisionalCheckpoints,
        { id: "other-during-import", sessionId: "another_session" },
      ]),
    );
    await PortableSessionManager.abortImport(source, sessionId, returning.ownershipGeneration);
    expect(
      await readFile(join(sourceState, "sessions", sessionId, "messages.jsonl"), "utf8"),
    ).toContain("hello");
    expect(await readFile(join(sourceState, "plans", `${sessionId}.md`), "utf8")).toBe(
      "local plan\n",
    );
    expect(JSON.parse(await readFile(join(sourceState, "checkpoints.json"), "utf8"))).toEqual([
      { id: "other-before", sessionId: "another_session" },
      { id: "other-during-import", sessionId: "another_session" },
      { id: "local-checkpoint", sessionId },
    ]);
    await PortableSessionManager.assertOwner(source, sessionId, { kind: "cloud", provider: "e2b" });

    await PortableSessionManager.import(source, returnArchive, "engine-rev", { provisional: true });
    await PortableSessionManager.commitImport(source, sessionId, returning.ownershipGeneration);
    await PortableSessionManager.commitImport(source, sessionId, returning.ownershipGeneration);
    expect(
      await readFile(join(sourceState, "sessions", sessionId, "messages.jsonl"), "utf8"),
    ).toContain("cloud result");
    await PortableSessionManager.assertOwner(source, sessionId, { kind: "local" });
    await expect(
      PortableSessionManager.abortImport(source, sessionId, returning.ownershipGeneration),
    ).rejects.toThrow();
  });

  test("blocks overlapping provisional journals and rejects a stale delayed abort", async () => {
    const { source, target, sessionId } = await fixture();
    const sourceManager = new PortableSessionManager(source, sessionId);
    const outbound = await sourceManager.prepare({ kind: "cloud", provider: "vercel" }, 0);
    const outboundArchive = await sourceManager.export("engine-rev", outbound.ownershipGeneration);
    await sourceManager.commit(outbound.nonce);
    await PortableSessionManager.import(target, outboundArchive, "engine-rev");
    const targetManager = new PortableSessionManager(target, sessionId);
    const returning = await targetManager.prepare({ kind: "local" }, 1);
    const generationTwo = await targetManager.export("engine-rev", returning.ownershipGeneration);
    await PortableSessionManager.import(source, generationTwo, "engine-rev", { provisional: true });

    const ownershipPath = join(
      globalStateDir(source),
      "sessions",
      sessionId,
      "handoff-ownership.json",
    );
    await writeFile(
      ownershipPath,
      JSON.stringify({
        generation: 1,
        owner: { kind: "cloud", provider: "vercel" },
        state: "owned",
        updatedAt: Date.now(),
      }),
    );
    await PortableSessionManager.abortImport(source, sessionId, 2);
    await PortableSessionManager.import(source, generationTwo, "engine-rev", { provisional: true });

    const generationThree = { ...generationTwo, ownershipGeneration: 3 };
    await expect(
      PortableSessionManager.import(source, generationThree, "engine-rev", { provisional: true }),
    ).rejects.toThrow("already pending");
    await expect(
      PortableSessionManager.import(source, generationThree, "engine-rev"),
    ).rejects.toThrow("already pending");
    await writeFile(
      ownershipPath,
      JSON.stringify({
        generation: 3,
        owner: { kind: "local" },
        state: "owned",
        updatedAt: Date.now(),
      }),
    );
    await expect(PortableSessionManager.abortImport(source, sessionId, 2)).rejects.toThrow(
      "no longer current",
    );
    const sessionHash = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
    await writeFile(
      join(globalStateDir(source), ".handoff-import-backups", sessionHash, "2", "rollback.json"),
      JSON.stringify({ started: true, reportNames: [] }),
    );
    await PortableSessionManager.abortImport(source, sessionId, 2);
  });

  test("an archive without checkpoints clears only the imported session checkpoints", async () => {
    const { source, target, sessionId } = await fixture();
    const sourceState = globalStateDir(source);
    await writeFile(
      join(sourceState, "checkpoints.json"),
      JSON.stringify([
        { id: "stale-local", sessionId },
        { id: "keep-other", sessionId: "another_session" },
      ]),
    );
    const sourceManager = new PortableSessionManager(source, sessionId);
    const outbound = await sourceManager.prepare({ kind: "cloud", provider: "e2b" }, 0);
    const outboundArchive = await sourceManager.export("engine-rev", outbound.ownershipGeneration);
    await sourceManager.commit(outbound.nonce);
    await PortableSessionManager.import(target, outboundArchive, "engine-rev");
    await rm(join(globalStateDir(target), "checkpoints.json"));
    const targetManager = new PortableSessionManager(target, sessionId);
    const returning = await targetManager.prepare({ kind: "local" }, 1);
    const returnArchive = await targetManager.export("engine-rev", returning.ownershipGeneration);
    await PortableSessionManager.import(source, returnArchive, "engine-rev");
    expect(JSON.parse(await readFile(join(sourceState, "checkpoints.json"), "utf8"))).toEqual([
      { id: "keep-other", sessionId: "another_session" },
    ]);
  });

  test("serializes concurrent imports for one session across generations", async () => {
    const { source, target, sessionId } = await fixture();
    const manager = new PortableSessionManager(source, sessionId);
    const outbound = await manager.prepare({ kind: "cloud", provider: "vercel" }, 0);
    const generationOne = await manager.export("engine-rev", outbound.ownershipGeneration);
    await manager.commit(outbound.nonce);
    const generationTwo = {
      ...generationOne,
      ownershipGeneration: 2,
      executionTarget: { kind: "local" } as const,
    };
    const generationThree = { ...generationTwo, ownershipGeneration: 3 };
    const results = await Promise.allSettled([
      PortableSessionManager.import(target, generationTwo, "engine-rev", { provisional: true }),
      PortableSessionManager.import(target, generationThree, "engine-rev", { provisional: true }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  test("cleans journals interrupted during backup before starting a new import", async () => {
    const { source, target, sessionId } = await fixture();
    const manager = new PortableSessionManager(source, sessionId);
    const prepared = await manager.prepare({ kind: "cloud", provider: "e2b" }, 0);
    const archive = await manager.export("engine-rev", prepared.ownershipGeneration);
    const sessionHash = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
    const journalRoot = join(globalStateDir(target), ".handoff-import-backups", sessionHash);
    await mkdir(join(journalRoot, "1"), { recursive: true });
    await writeFile(
      join(journalRoot, "1", "journal.json"),
      JSON.stringify({
        schemaVersion: 1,
        phase: "backing-up",
        sessionId,
        ownershipGeneration: 1,
      }),
    );
    await mkdir(join(journalRoot, "99"), { recursive: true });
    await PortableSessionManager.assertOwner(target, sessionId, { kind: "local" });
    await PortableSessionManager.import(target, archive, "engine-rev", { provisional: true });
    await PortableSessionManager.abortImport(target, sessionId, 1);
  });

  test("uses collision-proof journal identities and rejects traversal in import actions", async () => {
    const { source, target, sessionId } = await fixture();
    const manager = new PortableSessionManager(source, sessionId);
    const prepared = await manager.prepare({ kind: "cloud", provider: "e2b" }, 0);
    const original = await manager.export("engine-rev", prepared.ownershipGeneration);
    const first = { ...original, sessionId: "foo" };
    const second = { ...original, sessionId: "foo-bar" };
    await PortableSessionManager.import(target, first, "engine-rev", { provisional: true });
    await PortableSessionManager.import(target, second, "engine-rev", { provisional: true });
    await PortableSessionManager.abortImport(target, "foo", 1);
    await PortableSessionManager.abortImport(target, "foo-bar", 1);
    await expect(PortableSessionManager.abortImport(target, "../escape", 1)).rejects.toThrow(
      "invalid session id",
    );
    await expect(PortableSessionManager.commitImport(target, "safe", 0)).rejects.toThrow(
      "invalid ownership generation",
    );
  });

  test("selects reports from durable events without matching session-id prefixes", async () => {
    const { source, target, sessionId } = await fixture();
    const otherSession = `${sessionId}-extra`;
    const mine = persistTaskReport(source, sessionId, "task", "mine")!;
    const other = persistTaskReport(source, otherSession, "task", "other")!;
    for (const [id, reportPath] of [
      [sessionId, mine],
      [otherSession, other],
    ] as const) {
      appendOrchestrationEvent(source, id, {
        type: "task-finished",
        at: 1,
        id: "task",
        objective: "test report selection",
        outcome: "completed",
        attempts: 1,
        reportPath,
      });
    }
    const eventRoot = join(globalStateDir(source), "orchestration", "events");
    for (const directory of await readdir(eventRoot)) {
      await writeFile(join(eventRoot, directory, "truncated.json"), "{not-json");
    }
    const manager = new PortableSessionManager(source, sessionId);
    const prepared = await manager.prepare({ kind: "cloud", provider: "e2b" }, 0);
    const archive = await manager.export("engine-rev", prepared.ownershipGeneration);
    expect(archive.files.map((file) => file.path)).toContain(
      `orchestration/reports/${basename(mine)}`,
    );
    expect(archive.files.map((file) => file.path)).not.toContain(
      `orchestration/reports/${basename(other)}`,
    );

    const targetOther = persistTaskReport(target, otherSession, "task", "target other")!;
    appendOrchestrationEvent(target, otherSession, {
      type: "task-finished",
      at: 1,
      id: "task",
      objective: "preserve unrelated report",
      outcome: "completed",
      attempts: 1,
      reportPath: targetOther,
    });
    await PortableSessionManager.import(target, archive, "engine-rev");
    expect(await readFile(targetOther, "utf8")).toBe("target other");
  });
});
