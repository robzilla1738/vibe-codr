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

test("latestId returns the most recently updated session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-store-"));
  const store = new SessionStore(cwd);
  const a = fixture();
  await store.save({ ...a.meta, id: "old", updatedAt: 10 }, a.model, a.history);
  await store.save({ ...a.meta, id: "new", updatedAt: 20 }, a.model, a.history);
  expect(await store.latestId()).toBe("new");
  expect(await store.list()).toHaveLength(2);
});

test("load returns null for an unknown session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-store-"));
  expect(await new SessionStore(cwd).load("missing")).toBeNull();
});
