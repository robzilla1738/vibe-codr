import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalStateDir, SessionStore } from "@vibe/core";
import type { Message } from "@vibe/shared";
import { listProjectSummaries, sessionTitle } from "./project-index.ts";

const originalStateDir = process.env.VIBE_STATE_DIR;
let root = "";

function userHistory(text: string): Message[] {
  return [
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text }],
      createdAt: 1,
    },
  ];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vibe-project-index-"));
  process.env.VIBE_STATE_DIR = join(root, "state");
});

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.VIBE_STATE_DIR;
  else process.env.VIBE_STATE_DIR = originalStateDir;
  rmSync(root, { recursive: true, force: true });
});

describe("project index", () => {
  test("derives compact titles with goal and id fallbacks", () => {
    const meta = {
      id: "ses_123456789",
      model: "openai/gpt",
      mode: "execute" as const,
      goal: "Ship the renderer",
      createdAt: 1,
      updatedAt: 2,
    };
    expect(sessionTitle(userHistory("  Refine   the Electron UI  "), meta)).toBe(
      "Refine the Electron UI",
    );
    expect(sessionTitle([], meta)).toBe("Ship the renderer");
    expect(sessionTitle([], { ...meta, goal: null })).toBe("Session ses_1234");
    expect(sessionTitle(userHistory("x".repeat(90)), meta)).toHaveLength(72);
  });

  test("discovers projects, merges sessions, sorts them, and skips corrupt rows", async () => {
    const active = join(root, "active-project");
    const recent = join(root, "recent-project");
    mkdirSync(active, { recursive: true });
    mkdirSync(recent, { recursive: true });

    const activeStore = new SessionStore(active);
    await activeStore.save(
      {
        id: "active-old",
        model: "openai/gpt",
        mode: "execute",
        goal: null,
        createdAt: 1,
        updatedAt: 10,
      },
      [],
      userHistory("Active session"),
    );
    await activeStore.save(
      {
        id: "active-new",
        model: "openai/gpt",
        mode: "plan",
        goal: null,
        createdAt: 2,
        updatedAt: 30,
      },
      [],
      userHistory("Newest active session"),
    );

    const recentStore = new SessionStore(recent);
    await recentStore.save(
      {
        id: "recent",
        model: "anthropic/claude",
        mode: "execute",
        goal: null,
        createdAt: 1,
        updatedAt: 50,
      },
      [],
      userHistory("Recent project task"),
    );

    const badDir = join(globalStateDir(recent), "sessions", "corrupt");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "meta.json"), "{ broken");

    const projects = await listProjectSummaries(active);
    expect(projects.map((project) => project.cwd)).toEqual([recent, active]);
    expect(projects[1]!.sessions.map((session) => session.id)).toEqual([
      "active-new",
      "active-old",
    ]);
    expect(projects[0]!.sessions).toHaveLength(1);
    expect(projects[0]!.sessions[0]!.title).toBe("Recent project task");
  });

  test("keeps an active project with no sessions and ignores missing registrations", async () => {
    const active = join(root, "empty-project");
    mkdirSync(active, { recursive: true });
    const missingState = join(process.env.VIBE_STATE_DIR!, "missing");
    mkdirSync(missingState, { recursive: true });
    writeFileSync(join(missingState, "path"), join(root, "gone"));

    const projects = await listProjectSummaries(active);
    expect(projects).toEqual([{ cwd: active, name: "empty-project", updatedAt: 0, sessions: [] }]);
  });
});
