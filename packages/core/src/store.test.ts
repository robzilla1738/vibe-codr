import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import type { Message } from "@vibe/shared";
import { SessionStore, type SessionMeta } from "./store.ts";
import { globalStateDir } from "./state-dir.ts";

// Sessions persist to the per-project GLOBAL state dir — point it at a temp
// root so tests never touch the real ~/.vibe/state.
process.env.VIBE_STATE_DIR ??= mkdtempSync(join(tmpdir(), "vibe-state-"));

/** Where a session's files land for a given project cwd. */
const sessionDir = (cwd: string, id: string) => join(globalStateDir(cwd), "sessions", id);

function fixture(): { meta: SessionMeta; model: ModelMessage[]; history: Message[] } {
  const meta: SessionMeta = {
    id: "ses_abc",
    model: "anthropic/claude-opus-4-8",
    mode: "execute",
    goal: "ship it",
    createdAt: 1,
    updatedAt: 2,
  };
  const model: ModelMessage[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ];
  const history: Message[] = [
    { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }], createdAt: 1 },
    {
      id: "m2",
      role: "assistant",
      parts: [{ type: "text", text: "hi there" }],
      createdAt: 2,
    },
  ];
  return { meta, model, history };
}

test("save then load round-trips a session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-store-"));
  const store = new SessionStore(cwd);
  const { meta, model, history } = fixture();
  await store.save(meta, model, history);

  const loaded = await store.load("ses_abc");
  expect(loaded).not.toBeNull();
  expect(loaded!.meta).toEqual(meta);
  expect(loaded!.modelMessages).toEqual(model);
  expect(loaded!.history).toEqual(history);
});

test("save then load round-trips the working task list", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-store-"));
  const store = new SessionStore(cwd);
  const { meta, model, history } = fixture();
  const withTasks: SessionMeta = {
    ...meta,
    tasks: [
      { id: "task_1", title: "Read the spec", status: "completed" },
      { id: "task_2", title: "Implement it", status: "in_progress" },
    ],
  };
  await store.save(withTasks, model, history);

  const loaded = await store.load(meta.id);
  expect(loaded!.meta.tasks).toEqual(withTasks.tasks);
});

test("save then load round-trips the web-source ledger for resume", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-store-"));
  const store = new SessionStore(cwd);
  const { meta, model, history } = fixture();
  const withSources: SessionMeta = {
    ...meta,
    sources: [
      { index: 1, url: "https://a.example/x", via: "web_search", title: "A" },
      { index: 2, url: "https://b.example/y", via: "webfetch" },
    ],
  };
  await store.save(withSources, model, history);
  const loaded = await store.load(meta.id);
  expect(loaded!.meta.sources).toEqual(withSources.sources);
});

test("latestId returns the most recently updated session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-store-"));
  const store = new SessionStore(cwd);
  const a = fixture();
  await store.save({ ...a.meta, id: "old", updatedAt: 10 }, a.model, a.history);
  await store.save({ ...a.meta, id: "new", updatedAt: 20 }, a.model, a.history);
  expect(await store.latestId()).toBe("new");
  expect(await store.list()).toHaveLength(2);
});

test("concurrent saves to the same session never produce a torn transcript", async () => {
  // Two writers (simulating two `--continue` instances) saving the SAME session
  // at once must each install a COMPLETE messages.jsonl via a unique temp — never
  // a byte-interleaved mix that #readJsonl would silently truncate.
  const cwd = mkdtempSync(join(tmpdir(), "vibe-store-"));
  const store = new SessionStore(cwd);
  const { meta, history } = fixture();
  // Two large, distinct transcripts so a torn interleave would be detectable.
  const big = (tag: string): ModelMessage[] =>
    Array.from({ length: 200 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `${tag}-msg-${i}-${"x".repeat(50)}`,
    }));
  await Promise.all([
    store.save(meta, big("A"), history),
    store.save(meta, big("B"), history),
    store.save(meta, big("A"), history),
    store.save(meta, big("B"), history),
  ]);
  const loaded = await store.load("ses_abc");
  // Whichever writer won, the transcript is COMPLETE (200 messages) and internally
  // consistent (all from ONE writer) — not a truncated/mixed file.
  expect(loaded!.modelMessages).toHaveLength(200);
  const tags = new Set(
    loaded!.modelMessages.map((m) => String((m as { content: string }).content).split("-")[0]),
  );
  expect(tags.size).toBe(1); // every line came from the same writer — no interleave
});

test("an @image message's Uint8Array bytes round-trip through save/load (resumable)", async () => {
  // A Uint8Array would otherwise serialize to a numeric-keyed object and load back
  // as a plain object — a broken `image` field the provider rejects on resume.
  const cwd = mkdtempSync(join(tmpdir(), "vibe-store-"));
  const store = new SessionStore(cwd);
  const { meta, history } = fixture();
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const model: ModelMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", image: bytes, mediaType: "image/png" },
      ],
    },
  ];
  await store.save(meta, model, history);
  const loaded = await store.load(meta.id);
  const part = (loaded!.modelMessages[0]!.content as { type: string; image?: unknown }[])[1]!;
  expect(part.type).toBe("image");
  expect(part.image).toBeInstanceOf(Uint8Array);
  expect([...(part.image as Uint8Array)]).toEqual([...bytes]);
});

test("load returns null for an unknown session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-store-"));
  expect(await new SessionStore(cwd).load("missing")).toBeNull();
});

test("session ids cannot escape their project state directories", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-store-safe-id-"));
  const store = new SessionStore(cwd);
  const a = fixture();
  await expect(store.save({ ...a.meta, id: "../escape" }, a.model, a.history)).rejects.toThrow(
    "invalid session id",
  );
  expect(await store.load("../escape")).toBeNull();
  expect(await store.setTitle("../escape", "bad")).toBe(false);
  expect(await store.delete("../escape")).toBe(false);
  expect(await store.archive("../escape")).toBe(false);
});

test("session mutations distinguish missing records and cover global plus legacy stores", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-store-mutations-"));
  const store = new SessionStore(cwd);
  const a = fixture();

  expect(await store.delete("missing")).toBe(false);
  expect(await store.archive("missing")).toBe(false);
  expect(await store.setTitle("missing", "Title")).toBe(false);

  await store.save(a.meta, a.model, a.history);
  expect(await store.setTitle(a.meta.id, "  Renamed   session  ")).toBe(true);
  expect((await store.load(a.meta.id))?.meta.title).toBe("Renamed session");
  expect(await store.delete(a.meta.id)).toBe(true);
  expect(await store.load(a.meta.id)).toBeNull();

  const legacyId = "legacy-mutation";
  const legacy = join(cwd, ".vibe", "sessions", legacyId);
  await Bun.write(join(legacy, "meta.json"), JSON.stringify({ ...a.meta, id: legacyId }));
  await Bun.write(join(legacy, "messages.jsonl"), "");
  await Bun.write(join(legacy, "history.jsonl"), "");
  expect(await store.archive(legacyId)).toBe(true);
  expect(await store.load(legacyId)).toBeNull();
});

test("a corrupt meta.json yields null on load and is skipped by list", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-store-"));
  const store = new SessionStore(cwd);
  const a = fixture();
  await store.save({ ...a.meta, id: "good", updatedAt: 5 }, a.model, a.history);
  // Corrupt a second session's meta.json (simulates a crash mid-write).
  await Bun.write(join(sessionDir(cwd, "bad"), "meta.json"), "{ not json");

  expect(await store.load("bad")).toBeNull(); // doesn't throw
  const list = await store.list(); // skips the corrupt one, keeps the good one
  expect(list.map((m) => m.id)).toEqual(["good"]);
  expect(await store.latestId()).toBe("good");
});

test("a corrupt GLOBAL meta.json falls back to an intact LEGACY copy (load agrees with list)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-store-legacy-"));
  const store = new SessionStore(cwd);
  const a = fixture();
  const id = "shared-id";
  // Write an intact copy in the LEGACY in-project location.
  const legacyDir = join(cwd, ".vibe", "sessions", id);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(legacyDir, { recursive: true });
  await Bun.write(
    join(legacyDir, "meta.json"),
    JSON.stringify({ ...a.meta, id, goal: "from-legacy" }),
  );
  await Bun.write(
    join(legacyDir, "messages.jsonl"),
    a.model.map((m) => JSON.stringify(m)).join("\n"),
  );
  await Bun.write(
    join(legacyDir, "history.jsonl"),
    a.history.map((m) => JSON.stringify(m)).join("\n"),
  );
  // Corrupt the GLOBAL meta.json for the same id (power-loss torn write).
  await Bun.write(join(sessionDir(cwd, id), "meta.json"), "{ truncated");

  // list() surfaces the id (from legacy) — and load() must NOT strand it.
  expect((await store.list()).some((m) => m.id === id)).toBe(true);
  const loaded = await store.load(id);
  expect(loaded).not.toBeNull();
  expect(loaded!.meta.goal).toBe("from-legacy"); // fell back to the intact legacy copy
});

test("load warns and truncates at a corrupt messages.jsonl line", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-store-"));
  const store = new SessionStore(cwd);
  const a = fixture();
  await store.save(a.meta, a.model, a.history);
  // Append a half-written line followed by a syntactically-valid line. Loading
  // must stop at the corrupt line rather than skipping it and accepting later
  // lines that may have lost their matching tool-call context.
  const path = join(sessionDir(cwd, a.meta.id), "messages.jsonl");
  await Bun.write(
    path,
    `${await Bun.file(path).text()}\n{"role":"assistant","cont\n{"role":"user","content":"after corrupt"}`,
  );
  const loaded = await store.load(a.meta.id);
  expect(loaded!.modelMessages).toEqual(a.model); // the good lines survive
  expect(loaded!.warnings?.[0]).toContain("corrupt JSONL line");
  expect(loaded!.warnings?.[0]).toContain("messages.jsonl");
});

test("save leaves no .tmp files behind", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-store-"));
  const store = new SessionStore(cwd);
  const a = fixture();
  await store.save(a.meta, a.model, a.history);
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(sessionDir(cwd, a.meta.id));
  expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
});

test("meta round-trips the cumulative cache-read total (usage fidelity on --resume)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-store-usage-"));
  const store = new SessionStore(cwd);
  await store.save(
    {
      id: "ses_u",
      model: "anthropic/claude-x",
      mode: "execute",
      goal: null,
      usage: { inputTokens: 1000, outputTokens: 200, costUSD: 0.05, cachedInputTokens: 640 },
      createdAt: 1,
      updatedAt: 2,
    },
    [],
    [],
  );
  const loaded = await store.load("ses_u");
  // The cached-token slice survives persistence, so resumed cost/usage stays truthful.
  expect(loaded?.meta.usage?.cachedInputTokens).toBe(640);
  expect(loaded?.meta.usage?.inputTokens).toBe(1000);
});

test("legacy in-project sessions (<cwd>/.vibe/sessions) are still loadable and listed", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-store-legacy-"));
  const { meta, model, history } = fixture();
  // Simulate a session persisted by a pre-relocation version.
  const legacy = join(cwd, ".vibe", "sessions", meta.id);
  await Bun.write(join(legacy, "meta.json"), JSON.stringify(meta));
  await Bun.write(join(legacy, "messages.jsonl"), model.map((m) => JSON.stringify(m)).join("\n"));
  await Bun.write(join(legacy, "history.jsonl"), history.map((m) => JSON.stringify(m)).join("\n"));

  const store = new SessionStore(cwd);
  const loaded = await store.load(meta.id);
  expect(loaded?.meta.id).toBe(meta.id);
  expect(loaded?.modelMessages).toEqual(model);
  expect((await store.list()).map((m) => m.id)).toEqual([meta.id]);

  // A new save for the SAME id goes to the global dir and wins over legacy.
  await store.save({ ...meta, goal: "updated", updatedAt: 99 }, model, history);
  expect((await store.load(meta.id))?.meta.goal).toBe("updated");
  expect(await store.list()).toHaveLength(1);
});

test("meta round-trips the recalled-context block for --resume fidelity", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-store-recall-"));
  const store = new SessionStore(cwd);
  await store.save(
    {
      id: "ses_r",
      model: "m/x",
      mode: "execute",
      goal: null,
      recalledContext: "- we decided to use bun everywhere",
      createdAt: 1,
      updatedAt: 2,
    },
    [],
    [],
  );
  const loaded = await store.load("ses_r");
  expect(loaded?.meta.recalledContext).toBe("- we decided to use bun everywhere");
});

test("acquireLease: a fresh session acquires the lease (ok:true)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-lease-1-"));
  const store = new SessionStore(cwd);
  const lease = await store.acquireLease("ses_lease1");
  expect(lease.ok).toBe(true);
  // Releasing cleans up the lease file.
  await store.releaseLease("ses_lease1");
  expect(existsSync(join(globalStateDir(cwd), "sessions", "ses_lease1", ".lease"))).toBe(false);
});

test("acquireLease: a live PID holder blocks (ok:false, holderPid returned)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-lease-2-"));
  const store = new SessionStore(cwd);
  const dir = join(globalStateDir(cwd), "sessions", "ses_lease2");
  mkdirSync(dir, { recursive: true });
  // Write a lease with OUR OWN PID — the liveness check will see it as alive.
  writeFileSync(join(dir, ".lease"), `${process.pid}\n${Date.now()}\n`, "utf8");
  const lease = await store.acquireLease("ses_lease2");
  expect(lease.ok).toBe(false);
  if (!lease.ok) expect(lease.holderPid).toBe(process.pid);
});

test("acquireLease: a dead PID holder is stolen (ok:true)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-lease-3-"));
  const store = new SessionStore(cwd);
  const dir = join(globalStateDir(cwd), "sessions", "ses_lease3");
  mkdirSync(dir, { recursive: true });
  // Write a lease with a PID that is almost certainly dead.
  writeFileSync(join(dir, ".lease"), `999999\n${Date.now()}\n`, "utf8");
  const lease = await store.acquireLease("ses_lease3");
  expect(lease.ok).toBe(true);
});

test("releaseLease: a missing lease is a no-op (no throw)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-lease-4-"));
  const store = new SessionStore(cwd);
  await store.releaseLease("nonexistent");
  // No throw = pass
});

test("acquireLease: exclusive create — a second concurrent-style acquire fails when we hold it", async () => {
  // After a successful acquire, a second store against the same session must
  // see our live PID and return ok:false (not both ok:true via read-then-write).
  const cwd = mkdtempSync(join(tmpdir(), "vibe-lease-excl-"));
  const a = new SessionStore(cwd);
  const b = new SessionStore(cwd);
  const first = await a.acquireLease("ses_excl");
  expect(first.ok).toBe(true);
  const second = await b.acquireLease("ses_excl");
  expect(second.ok).toBe(false);
  if (!second.ok) expect(second.holderPid).toBe(process.pid);
  await a.releaseLease("ses_excl");
});

test("meta round-trips the offloaded map for --resume fidelity", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-store-offload-"));
  const store = new SessionStore(cwd);
  const offloaded = [
    { callId: "call_1", path: "/tmp/artifact1.txt", toolName: "read", fullChars: 5000 },
    { callId: "call_2", path: "/tmp/artifact2.txt", toolName: "grep", fullChars: 12000 },
  ];
  await store.save(
    {
      id: "ses_off",
      model: "m/x",
      mode: "execute",
      goal: null,
      offloaded,
      createdAt: 1,
      updatedAt: 2,
    },
    [],
    [],
  );
  const loaded = await store.load("ses_off");
  expect(loaded?.meta.offloaded).toEqual(offloaded);
});

test("durable subagent sessions are loadable by id, hidden from lists, and deleted with root", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-store-children-"));
  const store = new SessionStore(cwd);
  await store.save(
    {
      id: "ses_root",
      model: "m/x",
      mode: "execute",
      goal: null,
      kind: "root",
      createdAt: 1,
      updatedAt: 1,
    },
    [],
    [],
  );
  await store.save(
    {
      id: "sub_child",
      model: "m/x",
      mode: "execute",
      goal: null,
      kind: "subagent",
      parentSessionId: "ses_root",
      createdAt: 2,
      updatedAt: 2,
    },
    [{ role: "user", content: "private context" }],
    [],
  );

  expect((await store.load("sub_child"))?.modelMessages).toHaveLength(1);
  expect((await store.list()).map((meta) => meta.id)).toEqual(["ses_root"]);
  await store.delete("ses_root");
  expect(await store.load("sub_child")).toBeNull();
});
