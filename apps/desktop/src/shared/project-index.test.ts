import { describe, expect, it } from "vitest";
import {
  limitProjectRailProjects,
  limitProjectRailSessions,
  normalizeProjectName,
  normalizeSessionTitle,
  PROJECT_NAME_LIMIT,
  SESSION_TITLE_LIMIT,
} from "./project-index";
import type { ProjectSessionSummary, ProjectSummary } from "./protocol";

describe("project index labels", () => {
  it("normalizes whitespace and matches persisted display limits", () => {
    expect(normalizeProjectName("  My\n project  ")).toBe("My project");
    expect(normalizeSessionTitle("  My\t session  ")).toBe("My session");
    expect(normalizeProjectName("p".repeat(200))).toHaveLength(PROJECT_NAME_LIMIT);
    expect(normalizeSessionTitle("s".repeat(200))).toHaveLength(SESSION_TITLE_LIMIT);
    expect(normalizeProjectName("p".repeat(200)).endsWith("…")).toBe(true);
    expect(normalizeSessionTitle("s".repeat(200)).endsWith("…")).toBe(true);
  });
});

describe("project rail render bounds", () => {
  const session = (id: string): ProjectSessionSummary => ({
    id,
    title: id,
    model: "provider/model",
    mode: "execute",
    goal: null,
    createdAt: 1,
    updatedAt: 1,
  });
  const project = (cwd: string): ProjectSummary => ({
    cwd,
    name: cwd,
    updatedAt: 1,
    sessions: [],
  });

  it("keeps recent rows plus an older active project or session", () => {
    const projects = [project("/a"), project("/b"), project("/active")];
    expect(limitProjectRailProjects(projects, "/active", 2)).toEqual({
      items: [projects[0], projects[2]],
      omitted: 1,
    });

    const sessions = [session("new"), session("middle"), session("active")];
    expect(limitProjectRailSessions(sessions, "active", 2)).toEqual({
      items: [sessions[0], sessions[2]],
      omitted: 1,
    });
  });

  it("does not inject a pinned row that is absent from filtered results", () => {
    const sessions = [session("one"), session("two"), session("three")];
    expect(limitProjectRailSessions(sessions, "not-a-match", 2)).toEqual({
      items: sessions.slice(0, 2),
      omitted: 1,
    });
  });
});
