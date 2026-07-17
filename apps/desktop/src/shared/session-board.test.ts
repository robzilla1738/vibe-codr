import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "./protocol";
import {
  DEFAULT_SESSION_BOARD_PREFERENCES,
  automaticSessionBoardStatus,
  cloudAutomaticSessionState,
  filterSessionBoard,
  flattenSessionBoard,
  readSessionBoardPreferences,
  sessionBoardKey,
  writeSessionBoardPreferences,
} from "./session-board";

const projects: ProjectSummary[] = [
  {
    cwd: "/work/alpha",
    name: "alpha",
    updatedAt: 30,
    sessions: [
      { id: "new", title: "Build session board", model: "openai/gpt", mode: "execute", goal: "Ship the manager", createdAt: 10, updatedAt: 30 },
      { id: "plan", title: "Plan release", model: "xai/grok", mode: "plan", goal: null, createdAt: 8, updatedAt: 20 },
    ],
  },
  {
    cwd: "/home/.vibe/chats",
    name: "chats",
    updatedAt: 10,
    sessions: [
      { id: "chat", title: "Explain the diff", model: "openai/gpt", mode: "execute", goal: null, createdAt: 1, updatedAt: 10 },
    ],
  },
];

describe("session board projection", () => {
  it("distinguishes sandbox ownership from actual model activity", () => {
    expect(cloudAutomaticSessionState("running")).toBeNull();
    expect(cloudAutomaticSessionState("starting")).toBe("working");
    expect(cloudAutomaticSessionState("needs-local")).toBe("needs-input");
    expect(cloudAutomaticSessionState("suspended")).toBeNull();
    expect(automaticSessionBoardStatus("needs-input")).toBe("review");
    expect(automaticSessionBoardStatus("done")).toBe("done");
  });

  it("flattens projects and chats while preserving user-managed status", () => {
    const reviewKey = sessionBoardKey("/work/alpha", "plan");
    const items = flattenSessionBoard(projects, "/home/.vibe/chats", { [reviewKey]: "review" });
    expect(items).toHaveLength(3);
    expect(items.find((item) => item.key === reviewKey)?.status).toBe("review");
    expect(items.find((item) => item.session.id === "chat")).toMatchObject({ project: "Chats", isChat: true });
    expect(items.find((item) => item.session.id === "new")?.status).toBe("active");
  });

  it("searches all useful metadata and forces working sessions into Active", () => {
    const items = flattenSessionBoard(projects, "/home/.vibe/chats", {
      [sessionBoardKey("/work/alpha", "new")]: "done",
    });
    const working = new Set([sessionBoardKey("/work/alpha", "new")]);
    const automaticStatuses = new Map([[sessionBoardKey("/work/alpha", "plan"), "review" as const]]);
    expect(filterSessionBoard(items, {
      query: "ship the manager",
      status: "active",
      project: "all",
      mode: "all",
      sort: "updated",
      workingKeys: working,
    }).map((item) => item.session.id)).toEqual(["new"]);
    expect(filterSessionBoard(items, {
      query: "",
      status: "all",
      project: "/work/alpha",
      mode: "plan",
      sort: "oldest",
    }).map((item) => item.session.id)).toEqual(["plan"]);
    expect(filterSessionBoard(items, {
      query: "",
      status: "review",
      project: "all",
      mode: "all",
      sort: "updated",
      automaticStatuses,
    }).map((item) => item.session.id)).toEqual(["plan"]);
  });
});

describe("session board preferences", () => {
  it("round-trips valid preferences and rejects corrupt values", () => {
    let saved = "";
    const storage = {
      getItem: () => saved,
      setItem: (_key: string, value: string) => { saved = value; },
    };
    const preferences = {
      ...DEFAULT_SESSION_BOARD_PREFERENCES,
      view: "list" as const,
      sort: "title" as const,
      statuses: { key: "done" as const },
    };
    writeSessionBoardPreferences(storage, preferences);
    expect(readSessionBoardPreferences(storage)).toEqual(preferences);
    saved = "{not json";
    expect(readSessionBoardPreferences(storage)).toEqual(DEFAULT_SESSION_BOARD_PREFERENCES);
  });
});
