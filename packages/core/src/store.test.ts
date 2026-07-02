import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import type { Message } from "@vibe/shared";
import { SessionStore, type SessionMeta } from "./store.ts";

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
    Array.from({ length: 200 }, (_, i) => ({ role: i % 2 === 0 ? ("user" as const) : ("assistant" as const), content: `${tag}-msg-${i}-${"x".repeat(50)}` }));
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
  const tags = new Set(loaded!.modelMessages.map((m) => String((m as { content: string }).content).split("-")[0]));
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
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image", image: bytes, mediaType: "image/png" }] },
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

test("a corrupt meta.json yields null on load and is skipped by list", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-store-"));
  const store = new SessionStore(cwd);
  const a = fixture();
  await store.save({ ...a.meta, id: "good", updatedAt: 5 }, a.model, a.history);
  // Corrupt a second session's meta.json (simulates a crash mid-write).
  await Bun.write(join(cwd, ".vibe", "sessions", "bad", "meta.json"), "{ not json");

  expect(await store.load("bad")).toBeNull(); // doesn't throw
  const list = await store.list(); // skips the corrupt one, keeps the good one
  expect(list.map((m) => m.id)).toEqual(["good"]);
  expect(await store.latestId()).toBe("good");
});

test("load tolerates a truncated trailing line in messages.jsonl", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-store-"));
  const store = new SessionStore(cwd);
  const a = fixture();
  await store.save(a.meta, a.model, a.history);
  // Append a half-written line (a crash mid-append) — load should skip it.
  const path = join(cwd, ".vibe", "sessions", a.meta.id, "messages.jsonl");
  await Bun.write(path, `${await Bun.file(path).text()}\n{"role":"assistant","cont`);
  const loaded = await store.load(a.meta.id);
  expect(loaded!.modelMessages).toEqual(a.model); // the good lines survive
});

test("save leaves no .tmp files behind", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-store-"));
  const store = new SessionStore(cwd);
  const a = fixture();
  await store.save(a.meta, a.model, a.history);
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(join(cwd, ".vibe", "sessions", a.meta.id));
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
